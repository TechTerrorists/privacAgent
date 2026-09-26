import browser from 'webextension-polyfill';
import { ExtensionTransport, WorkerTransport, HostRelay, MessageBus } from '../messaging/index.js';

const WORKER_URL = browser.runtime.getURL('src/host/ml-worker.js');

const worker = new Worker(WORKER_URL);
const workerTransport = new WorkerTransport(worker);

const offscreenUrl = browser.runtime.getURL('src/host/offscreen.html');

const peers = {
  extensionPeers: {
    [offscreenUrl]: { context: 'offscreen' as const },
  },
  workerRelayUrls: [offscreenUrl],
};

const extensionTransport = new ExtensionTransport({ context: 'offscreen' }, peers);
const _relay = new HostRelay(extensionTransport, workerTransport);

const bus = new MessageBus({ context: 'offscreen' }, extensionTransport);

async function waitForWorker(): Promise<void> {
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await bus.send('ping', { timestamp: Date.now() }, { context: 'worker' }, { timeoutMs: 3000 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('Worker failed to respond after startup');
}

waitForWorker()
  .then(() => {
    void browser.runtime.sendMessage({ type: 'privacagent:host:ready' });
  })
  .catch(() => {
    void browser.runtime.sendMessage({
      type: 'privacagent:host:error',
      reason: 'Worker startup failed',
    });
  });
