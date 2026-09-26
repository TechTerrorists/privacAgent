import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeWorkerResponse } from '../src/worker/runtime/worker.js';
import type { RuntimeDiagnostics } from '../src/worker/runtime/types.js';

/**
 * Real ONNX execution inside a real extension (feature C-02).
 *
 * This is the test that actually establishes the acceptance criteria. The unit
 * tests prove the ladder's *logic* with stubs; only this proves that ONNX
 * Runtime initializes, that the packaged WASM loads under MV3's CSP, that the
 * offscreen document is cross-origin isolated, and that a graph produces the
 * right numbers in a dedicated worker.
 *
 * Chromium only. Playwright's extension support is Chromium-only, and Firefox
 * extension verification needs a `web-ext` + Selenium harness that does not
 * exist yet (PRD §12.3). Firefox runtime coverage is explicitly deferred.
 */

const EXTENSION_PATH = fileURLToPath(new URL('../dist/chrome', import.meta.url));
const MODEL_PATH = fileURLToPath(
  new URL('../src/worker/runtime/testdata/linear.onnx', import.meta.url)
);

/** Matches tools/generate-test-model.py: Y = [2,2,2,2] * X + [1,2,3,4]. */
const PROBE_INPUT = [1, 2, 3, 4];
const EXPECTED_OUTPUT = [3, 6, 9, 12];

/**
 * Opt-in WebGPU coverage: `PA_WEBGPU=1 pnpm exec playwright test onnx-runtime`.
 *
 * Off by default because headless Chromium on Linux exposes no GPU process, so
 * CI would only ever record `no_adapter`. On a machine with a GPU this covers
 * the top rung of the ladder, which nothing else can.
 */
const USE_GPU = process.env.PA_WEBGPU === '1';

const GPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
  '--ignore-gpu-blocklist',
];

declare global {
  interface Window {
    privacagentRuntimeHost?: {
      call(request: Record<string, unknown>): Promise<RuntimeWorkerResponse>;
      terminate(): void;
      crossOriginIsolated: boolean;
    };
  }
}

let context: BrowserContext;
let profileDir: string;
let extensionId: string;

test.beforeAll(async () => {
  test.skip(
    test.info().project.name !== 'chromium',
    'Playwright can only load extensions in Chromium; Firefox needs the web-ext harness (deferred).'
  );

  profileDir = await mkdtemp(join(tmpdir(), 'privacagent-ort-'));
  context = await chromium.launchPersistentContext(profileDir, {
    channel: process.env.PA_BROWSER_CHANNEL ?? 'chromium',
    // WebGPU needs a real GPU process, which headless Chromium on Linux does
    // not provide. CI stays headless and covers the WASM rungs; a developer
    // with a GPU opts in to cover the top rung (see the README).
    headless: !USE_GPU,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      ...(USE_GPU ? GPU_ARGS : []),
    ],
  });

  // The background service worker's URL carries the generated extension id.
  const background: Worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(background.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  if (profileDir) await rm(profileDir, { recursive: true, force: true });
});

/** Opens the offscreen host page directly, as the extension itself would. */
async function openHost() {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(`chrome-extension://${extensionId}/src/offscreen/runtime-host.html`);
  await page.waitForFunction(() => window.privacagentRuntimeHost !== undefined);
  return { page, errors };
}

test('the offscreen host is cross-origin isolated', async () => {
  const { page } = await openHost();

  // This is the prerequisite for threaded WASM, and the reason the COOP/COEP
  // manifest keys exist. Without it the ladder can only reach single-threaded.
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
  expect(isolated).toBe(true);

  const sharedMemory = await page.evaluate(() => typeof SharedArrayBuffer === 'function');
  expect(sharedMemory).toBe(true);

  await page.close();
});

test('the worker inherits isolation from the host page', async () => {
  const { page } = await openHost();

  // A dedicated worker created from an isolated page is itself isolated.
  // Asserted rather than assumed, since the whole threading path depends on it.
  const isolated = await page.evaluate(async () => {
    const source = 'self.postMessage(self.crossOriginIsolated === true)';
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const probe = new Worker(url, { type: 'module' });
    return await new Promise<boolean>((resolve) => {
      probe.addEventListener('message', (event: MessageEvent<boolean>) => {
        probe.terminate();
        URL.revokeObjectURL(url);
        resolve(event.data);
      });
    });
  });

  expect(isolated).toBe(true);
  await page.close();
});

test('ONNX Runtime initializes and reports the backend it actually used', async () => {
  const { page, errors } = await openHost();
  const model = [...readFileSync(MODEL_PATH)];

  const response = await page.evaluate(async (bytes) => {
    const buffer = new Uint8Array(bytes).buffer;
    return await window.privacagentRuntimeHost!.call({ kind: 'initialize', probeModel: buffer });
  }, model);

  expect(response.ok, `initialize failed: ${JSON.stringify(response)}`).toBe(true);

  const diagnostics = (response as { diagnostics: RuntimeDiagnostics }).diagnostics;

  // Logged before any assertion so the attempt log is always visible, which is
  // what makes a backend failure diagnosable rather than just red.
  console.log('[C-02] backend coverage:', JSON.stringify(diagnostics, null, 2));

  expect(
    diagnostics.status,
    `no backend initialized: ${JSON.stringify(diagnostics.attempts)}`
  ).toBe('ready');
  // Whatever it reports, it must have *executed* on it — selection only marks a
  // backend `selected` after the probe model has run.
  expect(['webgpu', 'wasm-threaded', 'wasm']).toContain(diagnostics.backend);

  const selected = diagnostics.attempts.find((attempt) => attempt.outcome === 'selected');
  expect(selected?.backend).toBe(diagnostics.backend);

  // The CSP permits wasm-unsafe-eval only. Any `unsafe-eval` use would surface
  // here as a CSP violation rather than passing silently.
  expect(errors.filter((message) => /Content Security Policy/i.test(message))).toEqual([]);

  await page.close();
});

test('a model produces the expected numbers in a real worker', async () => {
  const { page } = await openHost();
  const model = [...readFileSync(MODEL_PATH)];

  const output = await page.evaluate(
    async ({ bytes, input }) => {
      const host = window.privacagentRuntimeHost!;
      const buffer = new Uint8Array(bytes).buffer;

      const init = await host.call({ kind: 'initialize', probeModel: buffer });
      if (!init.ok) return { failed: init };

      const run = await host.call({
        kind: 'run',
        model: { id: 'linear', version: '1', bytes: new Uint8Array(bytes).buffer },
        feeds: { input: { data: new Float32Array(input), dims: [1, 4] } },
      });
      if (!run.ok) return { failed: run };

      const outputs = (run as { outputs: Record<string, { data: Float32Array }> }).outputs;
      return { data: Array.from(outputs.output!.data) };
    },
    { bytes: model, input: PROBE_INPUT }
  );

  expect(output.failed, `run failed: ${JSON.stringify(output.failed)}`).toBeUndefined();
  // Real arithmetic from a real graph, not a mock.
  expect(output.data).toEqual(EXPECTED_OUTPUT);

  await page.close();
});

test('single-threaded WASM works as the portable baseline', async () => {
  // Forced, because it is otherwise unreachable: this machine has threads, so
  // the ladder never descends to it. It is the rung Firefox always lands on
  // (bugzilla 1673477) and the one the degraded-device suite depends on, so it
  // has to be exercised deliberately rather than assumed.
  const { page } = await openHost();
  const model = [...readFileSync(MODEL_PATH)];

  const result = await page.evaluate(
    async ({ bytes, input }) => {
      const host = window.privacagentRuntimeHost!;
      const init = await host.call({
        kind: 'initialize',
        probeModel: new Uint8Array(bytes).buffer,
        backendOrder: ['wasm'],
      });
      if (!init.ok) return { failed: init };

      const run = await host.call({
        kind: 'run',
        model: { id: 'linear', version: '1', bytes: new Uint8Array(bytes).buffer },
        feeds: { input: { data: new Float32Array(input), dims: [1, 4] } },
      });
      if (!run.ok) return { failed: run };

      return {
        diagnostics: (init as { diagnostics: RuntimeDiagnostics }).diagnostics,
        data: Array.from(
          (run as { outputs: Record<string, { data: Float32Array }> }).outputs.output!.data
        ),
      };
    },
    { bytes: model, input: PROBE_INPUT }
  );

  expect(result.failed, `baseline run failed: ${JSON.stringify(result.failed)}`).toBeUndefined();
  expect(result.diagnostics!.backend).toBe('wasm');
  expect(result.diagnostics!.threads).toBe(1);
  // Same arithmetic, no threads, no GPU.
  expect(result.data).toEqual(EXPECTED_OUTPUT);

  await page.close();
});

test('sessions are reused and released on disposal', async () => {
  const { page } = await openHost();
  const model = [...readFileSync(MODEL_PATH)];

  const counts = await page.evaluate(async (bytes) => {
    const host = window.privacagentRuntimeHost!;
    const buffer = () => new Uint8Array(bytes).buffer;

    await host.call({ kind: 'initialize', probeModel: buffer() });

    const feeds = { input: { data: new Float32Array([1, 2, 3, 4]), dims: [1, 4] } };
    const model = { id: 'linear', version: '1', bytes: buffer() };

    await host.call({ kind: 'run', model, feeds });
    await host.call({ kind: 'run', model, feeds });
    const afterRuns = await host.call({ kind: 'diagnostics' });

    const afterDispose = await host.call({ kind: 'dispose' });
    return {
      sessions: (afterRuns as { diagnostics: RuntimeDiagnostics }).diagnostics.sessionCount,
      disposed: (afterDispose as { diagnostics: RuntimeDiagnostics }).diagnostics.sessionCount,
    };
  }, model);

  // Two runs of the same model compile once.
  expect(counts.sessions).toBe(1);
  expect(counts.disposed).toBe(0);

  await page.close();
});
