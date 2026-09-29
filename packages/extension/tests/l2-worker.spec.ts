import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let bundleSource: string;

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/worker/pii/l2/index.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'privacAgentL2',
    platform: 'browser',
    write: false,
    footer: {
      js: 'if (typeof self !== "undefined") { self.privacAgentL2 = privacAgentL2; }',
    },
  });
  bundleSource = result.outputFiles[0]!.text;
});

test.beforeEach(async ({ page }) => {
  await page.route('http://l2-worker.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head></head><body><h1>D-02 Worker Smoke</h1></body></html>',
    })
  );
  await page.goto('http://l2-worker.test/');
});

const WORKER_HARNESS = `
  var l2 = self.privacAgentL2;
  self.onmessage = function (event) {
    var msg = event.data;
    var result = l2.scanText(msg.text, msg.evidence);
    self.postMessage({ type: 'result', result: result });
  };
`;

test('a real Worker detects a canary email and never echoes the raw value in any message', async ({
  page,
}) => {
  const CANARY = 'CANARY-L2-WORKER-EMAIL@example.test';

  const messages = await page.evaluate(
    async ({ script, harness, canary }) => {
      const workerScript = `${script}\n${harness}`;
      const blob = new Blob([workerScript], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      const worker = new Worker(workerUrl);

      const received: unknown[] = [];
      const done = new Promise<void>((resolve) => {
        worker.onmessage = (event) => {
          received.push(event.data);
          resolve();
        };
      });

      worker.postMessage({ text: `contact ${canary} for help`, evidence: 'dom_text' });
      await done;

      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      return received;
    },
    { script: bundleSource, harness: WORKER_HARNESS, canary: CANARY }
  );

  expect(JSON.stringify(messages)).not.toContain(CANARY);

  const [response] = messages as [{ type: string; result: { status: string; matches: unknown[] } }];
  expect(response.result.status).toBe('ok');
  expect(response.result.matches).toEqual([
    {
      ruleId: 'email',
      piiClass: 'email',
      verified: true,
      evidence: 'dom_text',
      span: { start: 8, end: 8 + CANARY.length },
    },
  ]);
});

test('a real Worker reports unavailable for oversized input rather than run unbounded', async ({
  page,
}) => {
  const messages = await page.evaluate(
    async ({ script, harness }) => {
      const workerScript = `${script}\n${harness}`;
      const blob = new Blob([workerScript], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      const worker = new Worker(workerUrl);

      const received: unknown[] = [];
      const done = new Promise<void>((resolve) => {
        worker.onmessage = (event) => {
          received.push(event.data);
          resolve();
        };
      });

      worker.postMessage({ text: 'a'.repeat(20_001), evidence: 'dom_text' });
      await done;

      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      return received;
    },
    { script: bundleSource, harness: WORKER_HARNESS }
  );

  const [response] = messages as [{ type: string; result: unknown }];
  expect(response.result).toEqual({ status: 'unavailable', reason: 'input_too_large' });
});
