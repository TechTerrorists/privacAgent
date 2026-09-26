import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
interface PrivacAgentMessaging {
  MessageBus: new (
    endpoint: { context: string; tabId?: number; frameId?: number },
    transport: unknown
  ) => {
    send<T = Record<string, unknown>>(
      op: string,
      payload: unknown,
      destination: { context: string; tabId?: number; frameId?: number },
      options?: { timeoutMs?: number }
    ): Promise<T>;
    dispose(): void;
  };
  WorkerTransport: new (target: unknown) => {
    dispose(): void;
  };
  installStubHandlers: (bus: unknown) => () => void;
}

declare global {
  interface Window {
    privacAgentMessaging: PrivacAgentMessaging;
  }
}

let bundleSource: string;

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/messaging/index.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'privacAgentMessaging',
    platform: 'browser',
    write: false,
    define: {
      __BROWSER__: '"chrome"',
    },
    plugins: [
      {
        name: 'mock-polyfill',
        setup(b) {
          b.onResolve({ filter: /^webextension-polyfill$/ }, () => ({
            path: 'webextension-polyfill',
            namespace: 'mock-polyfill',
          }));
          b.onLoad({ filter: /.*/, namespace: 'mock-polyfill' }, () => ({
            contents:
              'export default { runtime: { sendMessage: () => Promise.resolve(), onMessage: { addListener: () => {}, removeListener: () => {} } } };',
            loader: 'js',
          }));
        },
      },
    ],
    footer: {
      js: 'if (typeof window !== "undefined") { window.privacAgentMessaging = privacAgentMessaging; }',
    },
  });
  bundleSource = result.outputFiles[0]!.text;
});

test.beforeEach(async ({ page }) => {
  await page.route('http://messaging.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head></head><body><h1>A-03 Smoke</h1></body></html>',
    })
  );
  await page.goto('http://messaging.test/');
  await page.addScriptTag({ content: bundleSource });
});

test('real Web Worker round trip with typed MessageBus', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { MessageBus, WorkerTransport } = window.privacAgentMessaging;

    // Worker code running a deterministic stub responder
    const workerScript = `
      self.onmessage = function(e) {
        var msg = e.data;
        if (msg && msg.type === 'request') {
          self.postMessage({
            id: msg.id,
            type: 'response',
            operation: msg.operation,
            payload: {
              status: 'ok',
              synthetic: true,
              itemCount: 42,
              durationMs: 12
            },
            source: { context: 'worker' },
            destination: msg.source,
            timestamp: Date.now()
          });
        }
      };
    `;

    const blob = new Blob([workerScript], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);

    const transport = new WorkerTransport(worker);
    const bus = new MessageBus({ context: 'background' }, transport);

    try {
      const response = await bus.send<{ status: string; itemCount: number }>(
        'inference:runDetector',
        { width: 512, height: 512, frame: 'image' },
        { context: 'worker' },
        { timeoutMs: 5000 }
      );
      return {
        success: true,
        response,
      };
    } finally {
      bus.dispose();
      transport.dispose();
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    }
  });

  expect(result.success).toBe(true);
  expect(result.response.status).toBe('ok');
  expect(result.response.itemCount).toBe(42);
});

test('real MessageChannel / MessagePort round trip between two buses', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { MessageBus, WorkerTransport, installStubHandlers } = window.privacAgentMessaging;

    const channel = new MessageChannel();

    const clientTransport = new WorkerTransport(channel.port1);
    const serverTransport = new WorkerTransport(channel.port2);

    const clientBus = new MessageBus({ context: 'ui' }, clientTransport);
    const serverBus = new MessageBus({ context: 'background' }, serverTransport);

    const uninstallStubs = installStubHandlers(serverBus);

    try {
      const pingRes = await clientBus.send<{ echo: string; context: string }>(
        'ping',
        { timestamp: 9999, echo: 'smoke-test' },
        { context: 'background' },
        { timeoutMs: 3000 }
      );

      const walkRes = await clientBus.send<{ docId: string; elementCount: number }>(
        'dom:walk',
        { docId: 'doc_browser_01' },
        { context: 'background' },
        { timeoutMs: 3000 }
      );

      return {
        pingEcho: pingRes.echo,
        pingContext: pingRes.context,
        walkDocId: walkRes.docId,
        walkElements: walkRes.elementCount,
      };
    } finally {
      uninstallStubs();
      clientBus.dispose();
      serverBus.dispose();
    }
  });

  expect(result.pingEcho).toBe('smoke-test');
  expect(result.pingContext).toBe('background');
  expect(result.walkDocId).toBe('doc_browser_01');
  expect(result.walkElements).toBe(42);
});
