import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

/**
 * D-04 real-worker lifecycle test.
 *
 * The vault's own unit tests (`worker/vault/vault.test.ts`) exercise the
 * `VaultApi` in-process with a manual clock — that proves the logic is
 * correct, but not that the boundary this module documents (worker-memory
 * only, cross-thread communication carrying nothing but placeholders and
 * non-sensitive identifiers) actually holds across a real thread boundary.
 * This file proves that: it bundles the vault module, runs it inside a
 * genuine `Worker` in a real browser page (same pattern as
 * `message-bus.spec.ts`), and drives it purely through `postMessage` — the
 * same channel A-04's production host will eventually use.
 *
 * Production A-04 integration (subscribing this call pattern to real
 * `tabs.onRemoved` / task-end messages) remains deferred; see
 * `worker/vault/testHost.ts` and its README section.
 */

let bundleSource: string;

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/worker/vault/index.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'privacAgentVault',
    platform: 'browser',
    write: false,
    footer: {
      js: 'if (typeof self !== "undefined") { self.privacAgentVault = privacAgentVault; }',
    },
  });
  bundleSource = result.outputFiles[0]!.text;
});

test.beforeEach(async ({ page }) => {
  await page.route('http://vault-worker.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head></head><body><h1>D-04 Worker Smoke</h1></body></html>',
    })
  );
  await page.goto('http://vault-worker.test/');
});

/** The harness that runs *inside* the real Worker, driven only by postMessage. */
const WORKER_HARNESS = `
  var vaultLib = self.privacAgentVault;
  var vault = vaultLib.createVault();
  var host = vaultLib.createTestLifecycleHost(vault);

  self.onmessage = function (event) {
    var msg = event.data;
    if (msg.type === 'createScope') {
      vault.createScope({ scopeId: msg.scopeId, taskId: msg.taskId, ownerTabId: msg.tabId });
      self.postMessage({ type: 'ack', for: msg.type });
    } else if (msg.type === 'intern') {
      var result = vault.intern(msg.scopeId, {
        piiClass: msg.piiClass,
        value: msg.value,
        binding: {
          taskId: msg.taskId,
          origin: 'https://example.test',
          docId: 'd1',
          allowedTargets: ['e1'],
          operations: ['type'],
        },
      });
      self.postMessage({ type: 'interned', result: result });
    } else if (msg.type === 'hasScope') {
      self.postMessage({ type: 'hasScope', scopeId: msg.scopeId, value: vault.hasScope(msg.scopeId) });
    } else if (msg.type === 'taskEnded') {
      host.emitTaskEnded(msg.scopeId);
      self.postMessage({ type: 'ack', for: msg.type });
    } else if (msg.type === 'tabClosed') {
      host.emitTabClosed(msg.tabId);
      self.postMessage({ type: 'ack', for: msg.type });
    }
  };
`;

test('a real Worker interns a canary value without ever echoing it, and honors task-end', async ({
  page,
}) => {
  const CANARY = 'CANARY-VAULT-WORKER-991122';

  const messages = await page.evaluate(
    async ({ script, harness, canary }) => {
      const workerScript = `${script}\n${harness}`;
      const blob = new Blob([workerScript], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      const worker = new Worker(workerUrl);

      const received: unknown[] = [];
      const done = new Promise<void>((resolve) => {
        let count = 0;
        worker.onmessage = (event) => {
          received.push(event.data);
          count += 1;
          if (count === 4) resolve();
        };
      });

      worker.postMessage({
        type: 'createScope',
        scopeId: 's_worker',
        taskId: 't_worker',
        tabId: 'tab_worker',
      });
      worker.postMessage({
        type: 'intern',
        scopeId: 's_worker',
        taskId: 't_worker',
        piiClass: 'email',
        value: canary,
      });
      worker.postMessage({ type: 'hasScope', scopeId: 's_worker' });
      worker.postMessage({ type: 'taskEnded', scopeId: 's_worker' });

      await done;

      // One more round trip, after the lifecycle event, to observe the
      // post-invalidation state.
      const after = await new Promise((resolve) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.postMessage({ type: 'hasScope', scopeId: 's_worker' });
      });
      received.push(after);

      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      return received;
    },
    { script: bundleSource, harness: WORKER_HARNESS, canary: CANARY }
  );

  // No message the worker ever posted back — across creation, interning,
  // status checks, and the lifecycle event — contains the raw canary value.
  expect(JSON.stringify(messages)).not.toContain(CANARY);

  const [ackCreate, interned, hasScopeBefore, ackTaskEnded, hasScopeAfter] = messages as [
    { type: string },
    { type: string; result: { outcome: string; placeholder: string } },
    { type: string; value: boolean },
    { type: string },
    { type: string; value: boolean },
  ];

  expect(ackCreate).toEqual({ type: 'ack', for: 'createScope' });
  expect(interned.result).toEqual({ outcome: 'ok', placeholder: '{{EMAIL_1}}' });
  expect(hasScopeBefore.value).toBe(true);
  expect(ackTaskEnded).toEqual({ type: 'ack', for: 'taskEnded' });
  expect(hasScopeAfter.value).toBe(false);
});

test('a real Worker invalidates every scope owned by a tab when that tab closes', async ({
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
        let count = 0;
        worker.onmessage = (event) => {
          received.push(event.data);
          count += 1;
          if (count === 5) resolve();
        };
      });

      worker.postMessage({
        type: 'createScope',
        scopeId: 's_a',
        taskId: 't_a',
        tabId: 'tab_shared',
      });
      worker.postMessage({
        type: 'createScope',
        scopeId: 's_b',
        taskId: 't_b',
        tabId: 'tab_other',
      });
      worker.postMessage({ type: 'tabClosed', tabId: 'tab_shared' });
      worker.postMessage({ type: 'hasScope', scopeId: 's_a' });
      worker.postMessage({ type: 'hasScope', scopeId: 's_b' });

      await done;
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      return received;
    },
    { script: bundleSource, harness: WORKER_HARNESS }
  );

  const [, , ackTabClosed, hasScopeA, hasScopeB] = messages as [
    unknown,
    unknown,
    { type: string },
    { type: string; value: boolean },
    { type: string; value: boolean },
  ];

  expect(ackTabClosed).toEqual({ type: 'ack', for: 'tabClosed' });
  expect(hasScopeA.value).toBe(false); // owned by the closed tab
  expect(hasScopeB.value).toBe(true); // owned by a different tab, untouched
});
