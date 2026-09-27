import browser from 'webextension-polyfill';
import { ExtensionTransport, WorkerTransport, HostRelay, MessageBus } from '../messaging/index.js';

const WORKER_URL = browser.runtime.getURL('src/host/ml-worker.js');

const worker = new Worker(WORKER_URL, { type: 'module' });
const workerTransport = new WorkerTransport(worker);

const offscreenUrl = browser.runtime.getURL('src/host/offscreen.html');
const backgroundUrls = [
  browser.runtime.getURL('src/background/index.js'),
  browser.runtime.getURL('service-worker-loader.js'),
  browser.runtime.getURL('_generated_background_page.html'),
];

const peers = {
  extensionPeers: {
    [offscreenUrl]: { context: 'offscreen' as const },
    ...Object.fromEntries(backgroundUrls.map((url) => [url, { context: 'background' as const }])),
  },
  workerRelayUrls: [offscreenUrl],
};

const extensionTransport = new ExtensionTransport({ context: 'offscreen' }, peers);
const _relay = new HostRelay(extensionTransport, workerTransport);

const bus = new MessageBus({ context: 'offscreen' }, extensionTransport);
const workerBus = new MessageBus({ context: 'offscreen' }, workerTransport);

const params = new URL(globalThis.location.href).searchParams;
const generation = Number.parseInt(params.get('generation') ?? '', 10);
const startupToken = params.get('startupToken') ?? '';

async function sendHostSignal(event: 'ready' | 'error'): Promise<void> {
  if (!Number.isFinite(generation) || startupToken.length === 0) {
    return;
  }
  await bus
    .send(
      'host:signal',
      { event, generation, startupToken },
      { context: 'background' },
      { timeoutMs: 3000 }
    )
    .catch(() => {});
}

async function waitForWorker(): Promise<void> {
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await workerBus.send(
        'ping',
        { timestamp: Date.now() },
        { context: 'worker' },
        { timeoutMs: 3000 }
      );
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('Worker failed to respond after startup');
}

waitForWorker()
  .then(() => {
    void sendHostSignal('ready');
  })
  .catch(() => {
    void sendHostSignal('error');
  });

worker.addEventListener('error', () => {
  void sendHostSignal('error');
});
worker.addEventListener('messageerror', () => {
  void sendHostSignal('error');
});
