import { describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => {
  const mockBrowser = {
    runtime: {
      id: 'mock-extension-id',
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
  DEFAULT_TIMEOUT_MS,
  ExtensionTransport,
  HostRelay,
  MessageBus,
  MessageBusError,
  MessageErrorCode,
  WorkerTransport,
  assertTransportable,
  installStubHandlers,
  isMessageEnvelope,
  type EndpointAddress,
  type MessageEnvelope,
  type Transport,
} from './index.js';

/** In-memory transport pair for testing cross-bus communication */
class InMemoryTransport implements Transport {
  public peer?: InMemoryTransport;
  private listeners = new Set<(envelope: MessageEnvelope, sender?: EndpointAddress) => void>();
  public disposed = false;

  async send(envelope: MessageEnvelope): Promise<void> {
    if (this.disposed) {
      throw new MessageBusError(MessageErrorCode.DISCONNECTED, 'Transport disposed');
    }
    if (!this.peer || this.peer.disposed) {
      throw new MessageBusError(MessageErrorCode.RECEIVER_NOT_FOUND, 'Peer disconnected');
    }
    // Simulate async tick like a real transport
    setTimeout(() => {
      if (typeof this.peer?.deliver === 'function') {
        this.peer.deliver(envelope);
      }
    }, 5);
  }

  deliver(envelope: MessageEnvelope): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      listener(envelope, envelope.source);
    }
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

function createConnectedBusPair(
  addrA: EndpointAddress,
  addrB: EndpointAddress
): { busA: MessageBus; busB: MessageBus; transA: InMemoryTransport; transB: InMemoryTransport } {
  const transA = new InMemoryTransport();
  const transB = new InMemoryTransport();
  transA.peer = transB;
  transB.peer = transA;

  const busA = new MessageBus(addrA, transA);
  const busB = new MessageBus(addrB, transB);

  return { busA, busB, transA, transB };
}

describe('Typed Message Bus (A-03)', () => {
  describe('Happy path request and response', () => {
    it('dispatches typed request and resolves matching response', async () => {
      const { busA, busB } = createConnectedBusPair(
        { context: 'background' },
        { context: 'content', tabId: 10 }
      );

      busB.registerHandler('ping', (req, source) => {
        expect(source.context).toBe('background');
        return {
          timestamp: Date.now(),
          echo: req.echo,
          context: 'content',
        };
      });

      const res = await busA.send(
        'ping',
        { timestamp: 12345, echo: 'hello' },
        { context: 'content', tabId: 10 }
      );

      expect(res.echo).toBe('hello');
      expect(res.context).toBe('content');

      busA.dispose();
      busB.dispose();
    });
  });

  describe('Concurrent & Out-of-Order Correlation', () => {
    it('correctly matches multiple in-flight concurrent requests to their caller', async () => {
      const { busA, busB } = createConnectedBusPair(
        { context: 'background' },
        { context: 'worker' }
      );

      busB.registerHandler('inference:runDetector', async (req) => {
        // Delay responses inversely to input width to test out-of-order resolution
        const delay = req.width === 100 ? 30 : 5;
        await new Promise((r) => setTimeout(r, delay));
        return {
          status: 'ok',
          synthetic: true,
          itemCount: req.width,
          durationMs: delay,
        };
      });

      // Call 1 has delay 30ms, Call 2 has delay 5ms
      const p1 = busA.send(
        'inference:runDetector',
        { width: 100, height: 100, frame: 'image' },
        { context: 'worker' }
      );
      const p2 = busA.send(
        'inference:runDetector',
        { width: 200, height: 200, frame: 'image' },
        { context: 'worker' }
      );

      const [res1, res2] = await Promise.all([p1, p2]);
      expect(res1.itemCount).toBe(100);
      expect(res2.itemCount).toBe(200);

      busA.dispose();
      busB.dispose();
    });
  });

  describe('Timeouts & Missing Receivers', () => {
    it('defines standard DEFAULT_TIMEOUT_MS constant (5,000ms)', () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(5000);
    });

    it('rejects with TIMEOUT if receiver does not reply within timeoutMs', async () => {
      const transA = new InMemoryTransport();
      // Transport with no peer (silent drop)
      transA.peer = {
        send: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      } as unknown as InMemoryTransport;

      const busA = new MessageBus({ context: 'background' }, transA);

      await expect(
        busA.send('ping', { timestamp: 1 }, { context: 'content', tabId: 99 }, { timeoutMs: 30 })
      ).rejects.toThrowError(/TIMEOUT/);

      busA.dispose();
    });

    it('rejects immediately when transport fails to send', async () => {
      const failingTransport: Transport = {
        send: vi.fn().mockRejectedValue(new Error('Tab closed')),
        onMessage: vi.fn().mockReturnValue(() => {}),
        dispose: vi.fn(),
      };

      const bus = new MessageBus({ context: 'background' }, failingTransport);

      await expect(
        bus.send('ping', { timestamp: 1 }, { context: 'content', tabId: 99 })
      ).rejects.toThrowError(/RECEIVER_NOT_FOUND/);

      bus.dispose();
    });
  });

  describe('Unsupported operations & Handler failures', () => {
    it('returns UNSUPPORTED_OPERATION when target has no handler', async () => {
      const { busA, busB } = createConnectedBusPair(
        { context: 'background' },
        { context: 'content', tabId: 5 }
      );

      // busB registers NO handler
      await expect(
        busA.send('dom:walk', {}, { context: 'content', tabId: 5 }, { timeoutMs: 100 })
      ).rejects.toThrowError(/UNSUPPORTED_OPERATION/);

      busA.dispose();
      busB.dispose();
    });

    it('returns HANDLER_ERROR when handler throws an exception', async () => {
      const { busA, busB } = createConnectedBusPair(
        { context: 'background' },
        { context: 'worker' }
      );

      busB.registerHandler('dom:walk', () => {
        throw new Error('Database locked');
      });

      await expect(
        busA.send('dom:walk', {}, { context: 'worker' }, { timeoutMs: 100 })
      ).rejects.toThrowError(/HANDLER_ERROR/);

      busA.dispose();
      busB.dispose();
    });
  });

  describe('Peer verification and late response protection', () => {
    it('drops response if source does not match expected destination', async () => {
      const transA = new InMemoryTransport();
      transA.peer = new InMemoryTransport();
      const busA = new MessageBus({ context: 'background' }, transA);

      const sendPromise = busA.send(
        'ping',
        { timestamp: 1 },
        { context: 'content', tabId: 10, frameId: 0 },
        { timeoutMs: 60 }
      );

      // Inject malicious or spoofed response from a different frame (frame 1 instead of 0)
      setTimeout(() => {
        const pendingKey = Array.from(
          (busA as unknown as { pending: Map<string, { id: string }> }).pending.keys()
        )[0];
        if (pendingKey) {
          transA.deliver({
            id: pendingKey,
            type: 'response',
            operation: 'ping',
            payload: { timestamp: 1, context: 'content' },
            source: { context: 'content', tabId: 10, frameId: 1 }, // Wrong frame
            destination: { context: 'background' },
            timestamp: Date.now(),
          });
        }
      }, 10);

      // Because spoofed reply was ignored, the pending request times out
      await expect(sendPromise).rejects.toThrowError(/TIMEOUT/);

      busA.dispose();
    });

    it('safely ignores late or duplicate responses without throwing', async () => {
      const { busA, transB } = createConnectedBusPair(
        { context: 'background' },
        { context: 'worker' }
      );

      // Deliver duplicate response with an unknown/already-settled ID
      expect(() => {
        transB.deliver({
          id: 'non-existent-id',
          type: 'response',
          operation: 'ping',
          payload: {},
          source: { context: 'worker' },
          destination: { context: 'background' },
          timestamp: Date.now(),
        });
      }).not.toThrow();

      busA.dispose();
    });
  });

  describe('Disposal and Cleanup (A-04 lifecycle integration)', () => {
    it('cancels pending requests with DISCONNECTED on dispose', async () => {
      const transA = new InMemoryTransport();
      const busA = new MessageBus({ context: 'background' }, transA);

      const p = busA.send(
        'ping',
        { timestamp: 1 },
        { context: 'content', tabId: 10 },
        { timeoutMs: 10_000 }
      );

      busA.dispose();

      await expect(p).rejects.toThrowError(/DISCONNECTED/);
    });

    it('prevents sending on a disposed bus', async () => {
      const trans = new InMemoryTransport();
      const bus = new MessageBus({ context: 'background' }, trans);
      bus.dispose();

      await expect(
        bus.send('ping', { timestamp: 1 }, { context: 'background' })
      ).rejects.toThrowError(/DISCONNECTED/);
    });
  });

  describe('Validation & Payload Safety', () => {
    it('rejects DOM nodes from crossing message boundaries', () => {
      const fakeNode = { nodeType: 1, tagName: 'DIV' };
      expect(() => assertTransportable(fakeNode)).toThrowError(/DOM nodes cannot be transported/);
    });

    it('rejects functions and symbols from payloads', () => {
      expect(() => assertTransportable({ fn: () => {} })).toThrowError(/unsupported data type/);
      expect(() => assertTransportable({ s: Symbol('test') })).toThrowError(
        /unsupported data type/
      );
    });

    it('validates envelope structure correctly', () => {
      expect(
        isMessageEnvelope({
          id: 'test-1',
          type: 'request',
          operation: 'ping',
          source: { context: 'background' },
          destination: { context: 'worker' },
          timestamp: Date.now(),
          payload: {},
        })
      ).toBe(true);

      expect(isMessageEnvelope({ invalid: true })).toBe(false);
    });
  });

  describe('HostRelay (Extension <-> Worker bridging)', () => {
    it('relays worker-destined messages into the worker and worker replies back', async () => {
      const extTransHost = new InMemoryTransport();
      const extTransClient = new InMemoryTransport();
      extTransHost.peer = extTransClient;
      extTransClient.peer = extTransHost;

      const workerTransHost = new InMemoryTransport();
      const workerTransWorker = new InMemoryTransport();
      workerTransHost.peer = workerTransWorker;
      workerTransWorker.peer = workerTransHost;

      // HostRelay runs in offscreen/background host
      const relay = new HostRelay(extTransHost, workerTransHost);

      const clientBus = new MessageBus({ context: 'background' }, extTransClient);
      const workerBus = new MessageBus({ context: 'worker' }, workerTransWorker);

      // Worker registers handler
      workerBus.registerHandler('inference:runOCR', () => ({
        status: 'ok',
        synthetic: true,
        itemCount: 7,
        durationMs: 10,
      }));

      // Background client dispatches request to worker
      const res = await clientBus.send(
        'inference:runOCR',
        { width: 300, height: 300, frame: 'crop' },
        { context: 'worker' }
      );

      expect(res.status).toBe('ok');
      expect(res.itemCount).toBe(7);

      relay.dispose();
      clientBus.dispose();
      workerBus.dispose();
    });
  });

  describe('WorkerTransport and transfer lists', () => {
    it('supports transfer lists for transferable objects', async () => {
      const fakeWorker = {
        postMessage: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as Worker;

      const transport = new WorkerTransport(fakeWorker);
      const buffer = new ArrayBuffer(16);

      const envelope: MessageEnvelope = {
        id: 'w-1',
        type: 'request',
        operation: 'ping',
        payload: { buffer },
        source: { context: 'background' },
        destination: { context: 'worker' },
        timestamp: Date.now(),
      };

      await transport.send(envelope, { transfer: [buffer] });

      expect(fakeWorker.postMessage).toHaveBeenCalledWith(envelope, [buffer]);

      transport.dispose();
    });
  });

  describe('ExtensionTransport routing and sender authentication', () => {
    it('dispatches to tabs.sendMessage with frameId when destination is content', async () => {
      const transport = new ExtensionTransport();
      const envelope: MessageEnvelope = {
        id: 'e-1',
        type: 'request',
        operation: 'ping',
        payload: { timestamp: 1 },
        source: { context: 'background' },
        destination: { context: 'content', tabId: 42, frameId: 2 },
        timestamp: Date.now(),
      };

      await transport.send(envelope);

      const { platform } = await import('../platform/index.js');
      expect(platform.browser.tabs.sendMessage).toHaveBeenCalledWith(42, envelope, { frameId: 2 });

      transport.dispose();
    });

    it('rejects sending to content without tabId', async () => {
      const transport = new ExtensionTransport();
      const envelope: MessageEnvelope = {
        id: 'e-2',
        type: 'request',
        operation: 'ping',
        payload: { timestamp: 1 },
        source: { context: 'background' },
        destination: { context: 'content' }, // Missing tabId
        timestamp: Date.now(),
      };

      await expect(transport.send(envelope)).rejects.toThrowError(/without a valid tabId/);
      transport.dispose();
    });
  });

  describe('Deterministic Stub Handlers', () => {
    it('installs all stubs and returns reproducible outputs', async () => {
      const { busA, busB } = createConnectedBusPair(
        { context: 'background' },
        { context: 'worker' }
      );

      const removeStubs = installStubHandlers(busB);

      const pingRes = await busA.send('ping', { timestamp: 1 }, { context: 'worker' });
      expect(pingRes.context).toBe('worker');

      const infRes = await busA.send(
        'inference:runDetector',
        { width: 512, height: 512, frame: 'image' },
        { context: 'worker' }
      );
      expect(infRes.status).toBe('ok');
      expect(infRes.synthetic).toBe(true);
      expect(infRes.itemCount).toBeGreaterThan(0);

      const walkRes = await busA.send('dom:walk', {}, { context: 'worker' });
      expect(walkRes.docId).toBe('doc_synth_01');
      expect(walkRes.elementCount).toBe(42);

      removeStubs();
      busA.dispose();
      busB.dispose();
    });
  });
});
