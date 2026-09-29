import { describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => {
  const mockBrowser = {
    runtime: {
      id: 'mock-extension-id',
      getURL: (path: string) => `chrome-extension://mock-extension-id/${path}`,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    tabs: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    windows: {
      getCurrent: vi.fn().mockResolvedValue({ id: 101 }),
    },
    sidebarAction: {
      open: vi.fn().mockResolvedValue(undefined),
      setPanel: vi.fn().mockResolvedValue(undefined),
    },
  };
  return {
    default: mockBrowser,
    ...mockBrowser,
  };
});

import {
  MessageBus,
  MessageBusError,
  MessageErrorCode,
  type EndpointAddress,
  type MessageEnvelope,
  type Transport,
} from '../messaging/index.js';
import {
  createStoragePolicyStore,
  type PolicyStorageAreaLike,
} from '../worker/pii/policy/store.js';
import { guardEgress, registerPolicyHandlers } from './policyGuard.js';

class InMemoryTransport implements Transport {
  public peer?: InMemoryTransport;
  private listeners = new Set<(envelope: MessageEnvelope, sender?: EndpointAddress) => void>();
  public disposed = false;

  async send(envelope: MessageEnvelope): Promise<void> {
    if (this.disposed) {
      throw new MessageBusError(MessageErrorCode.DISCONNECTED);
    }
    if (!this.peer || this.peer.disposed) {
      throw new MessageBusError(MessageErrorCode.RECEIVER_NOT_FOUND);
    }
    setTimeout(() => {
      if (typeof this.peer?.deliver === 'function') {
        this.peer.deliver(envelope);
      }
    }, 5);
  }

  deliver(envelope: MessageEnvelope, sender: EndpointAddress = envelope.source): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(envelope, sender);
  }

  onMessage(listener: (envelope: MessageEnvelope, sender?: EndpointAddress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

function createConnectedBusPair(addrA: EndpointAddress, addrB: EndpointAddress) {
  const transA = new InMemoryTransport();
  const transB = new InMemoryTransport();
  transA.peer = transB;
  transB.peer = transA;
  const busA = new MessageBus(addrA, transA);
  const busB = new MessageBus(addrB, transB);
  return { busA, busB };
}

function createMemoryArea(): PolicyStorageAreaLike {
  const data = new Map<string, unknown>();
  return {
    async get(key) {
      return data.has(key) ? { [key]: data.get(key) } : {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

const ORIGIN = 'https://example.test';
const BACKGROUND: EndpointAddress = { context: 'background' };
const UI: EndpointAddress = { context: 'ui' };
const CONTENT: EndpointAddress = { context: 'content', tabId: 1 };

describe('background policy guard message-bus contract', () => {
  it('serves policy:get and applies writes issued from the ui context', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    const { busA: backgroundBus, busB: uiBus } = createConnectedBusPair(BACKGROUND, UI);
    registerPolicyHandlers(backgroundBus, store);

    const setResult = await uiBus.send(
      'policy:setAlwaysRedactSelectors',
      { origin: ORIGIN, selectors: ['.sensitive'] },
      BACKGROUND
    );
    expect(setResult).toEqual({ ok: true });

    const policy = await uiBus.send('policy:get', { origin: ORIGIN }, BACKGROUND);
    expect(policy.alwaysRedactSelectors).toEqual(['.sensitive']);
  });

  it('rejects a write from a source not in allowedSources', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    const { busA: backgroundBus, busB: workerBus } = createConnectedBusPair(BACKGROUND, {
      context: 'worker',
    });
    registerPolicyHandlers(backgroundBus, store);

    await expect(
      workerBus.send('policy:setNeverSend', { origin: ORIGIN, value: true }, BACKGROUND)
    ).rejects.toThrow();
  });

  it('accepts writes from the content context', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    const { busA: backgroundBus, busB: contentBus } = createConnectedBusPair(BACKGROUND, CONTENT);
    registerPolicyHandlers(backgroundBus, store);

    const result = await contentBus.send(
      'policy:setNeverSend',
      { origin: ORIGIN, value: true },
      BACKGROUND
    );
    expect(result).toEqual({ ok: true });
  });

  it('guardEgress reflects a stored neverSend policy without exposing raw contents', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    await store.setNeverSend(ORIGIN, true);
    expect(await guardEgress(store, ORIGIN)).toEqual({ allowed: false });
    expect(await guardEgress(store, 'https://other.test')).toEqual({ allowed: true });
  });

  it('unregister stops the handlers from responding', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    const { busA: backgroundBus, busB: uiBus } = createConnectedBusPair(BACKGROUND, UI);
    const unregister = registerPolicyHandlers(backgroundBus, store);
    unregister();

    await expect(uiBus.send('policy:get', { origin: ORIGIN }, BACKGROUND)).rejects.toThrow();
  });
});
