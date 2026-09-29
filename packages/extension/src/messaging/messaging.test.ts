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
  matchesEndpoint,
  normalizeEndpoint,
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
      throw new MessageBusError(MessageErrorCode.DISCONNECTED);
    }
    if (!this.peer || this.peer.disposed) {
      throw new MessageBusError(MessageErrorCode.RECEIVER_NOT_FOUND);
    }
    // Simulate async tick like a real transport
    setTimeout(() => {
      if (typeof this.peer?.deliver === 'function') {
        this.peer.deliver(envelope);
      }
    }, 5);
  }

  deliver(envelope: MessageEnvelope, sender: EndpointAddress = envelope.source): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      listener(envelope, sender);
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

function createConnectedBusPair(addrA: EndpointAddress, addrB: EndpointAddress) {
  const transA = new InMemoryTransport();
  const transB = new InMemoryTransport();
  transA.peer = transB;
  transB.peer = transA;

  const busA = new MessageBus(addrA, transA);
  const busB = new MessageBus(addrB, transB);

  return { busA, busB, transA, transB };
}

describe('Typed Message Bus (A-03)', () => {
  describe('Basic Request / Response cycle', () => {
    it('successfully sends a request and receives a correlated response', async () => {
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

      const response = await busA.send(
        'ping',
        { timestamp: 12345, echo: 'hello-world' },
        { context: 'content', tabId: 10 }
      );

      expect(response.echo).toBe('hello-world');
      expect(response.context).toBe('content');

      busA.dispose();
      busB.dispose();
    });

    it('rejects sending requests when bus is disposed', async () => {
      const { busA, busB } = createConnectedBusPair(
        { context: 'background' },
        { context: 'content', tabId: 10 }
      );

      busA.dispose();

      await expect(
        busA.send('ping', { timestamp: 1 }, { context: 'content', tabId: 10 })
      ).rejects.toThrowError(/DISCONNECTED/);

      busB.dispose();
    });
  });

  describe('Concurrency & Out-of-Order resolution', () => {
    it('resolves concurrent requests to correct callers even with delayed replies', async () => {
      const { busA, busB } = createConnectedBusPair(
        { context: 'background' },
        { context: 'worker' }
      );

      busB.registerHandler('inference:runDetector', async (req) => {
        const delay = req.width === 100 ? 25 : 5;
        await new Promise((r) => setTimeout(r, delay));
        return {
          status: 'ok',
          synthetic: true,
          itemCount: req.width,
          durationMs: delay,
        };
      });

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
        send: vi.fn().mockRejectedValue(new Error('Connection lost')),
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

  describe('Runtime Schema & Payload Validation', () => {
    it('rejects invalid ping request payload with MALFORMED_MESSAGE before reaching handler', async () => {
      const { busA, busB } = createConnectedBusPair(
        { context: 'background' },
        { context: 'content', tabId: 10 }
      );

      const handlerSpy = vi.fn().mockReturnValue({
        timestamp: Date.now(),
        context: 'content',
      });
      busB.registerHandler('ping', handlerSpy);

      // Invalid ping: timestamp is not a number
      await expect(
        busA.send(
          'ping',
          { timestamp: 'invalid-timestamp' as unknown as number },
          { context: 'content', tabId: 10 },
          { timeoutMs: 200 }
        )
      ).rejects.toThrowError(/MALFORMED_MESSAGE/);

      // Handler must never have been called with invalid data
      expect(handlerSpy).not.toHaveBeenCalled();

      busA.dispose();
      busB.dispose();
    });

    it('rejects invalid response payload with MALFORMED_MESSAGE', async () => {
      const { busA, busB } = createConnectedBusPair(
        { context: 'background' },
        { context: 'worker' }
      );

      // Handler returns invalid response shape (synthetic is missing / not true)
      busB.registerHandler('inference:runDetector', () => {
        return {
          status: 'ok',
          synthetic: false as unknown as true,
          itemCount: 1,
          durationMs: 5,
        };
      });

      await expect(
        busA.send(
          'inference:runDetector',
          { width: 100, height: 100, frame: 'image' },
          { context: 'worker' },
          { timeoutMs: 200 }
        )
      ).rejects.toThrowError(/MALFORMED_MESSAGE/);

      busA.dispose();
      busB.dispose();
    });
  });

  describe('Frame ID Normalization and Destination Filtering', () => {
    it('normalizes omitted frameId to 0 for content endpoints', () => {
      const addr = normalizeEndpoint({ context: 'content', tabId: 5 });
      expect(addr.frameId).toBe(0);

      const bgAddr = normalizeEndpoint({ context: 'background' });
      expect(bgAddr.frameId).toBeUndefined();
    });

    it('matches content endpoint omitting frameId with frameId 0', () => {
      expect(
        matchesEndpoint(
          { context: 'content', tabId: 5, frameId: 0 },
          { context: 'content', tabId: 5 }
        )
      ).toBe(true);

      expect(
        matchesEndpoint(
          { context: 'content', tabId: 5, frameId: 1 },
          { context: 'content', tabId: 5 }
        )
      ).toBe(false);
    });
  });

  describe('Privacy & Error Sanitization (No sensitive text leaks)', () => {
    it('never leaks arbitrary exception strings, emails, tokens, or URLs in errors', async () => {
      const { busA, busB } = createConnectedBusPair(
        { context: 'background' },
        { context: 'worker' }
      );

      busB.registerHandler('dom:walk', () => {
        throw new Error(
          'Critical failure for user john.doe@example.com with token=secret123 at https://internal.corp/secret'
        );
      });

      try {
        await busA.send('dom:walk', {}, { context: 'worker' }, { timeoutMs: 200 });
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MessageBusError);
        const busErr = err as MessageBusError;
        expect(busErr.code).toBe(MessageErrorCode.HANDLER_ERROR);
        // Error message must use fixed diagnostic text and NOT leak sensitive strings
        expect(busErr.message).not.toContain('john.doe@example.com');
        expect(busErr.message).not.toContain('secret123');
        expect(busErr.message).not.toContain('https://internal.corp');
        expect(busErr.message).toBe(
          '[HANDLER_ERROR] Message handler threw an exception during execution'
        );
      }

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
        { timeoutMs: 50 }
      );

      // Fake response from wrong frame (frameId: 1 instead of 0)
      const wrongFrameEnvelope: MessageEnvelope = {
        id: (busA as unknown as { pending: Map<string, { id: string }> }).pending.keys().next()
          .value!,
        type: 'response',
        operation: 'ping',
        payload: { timestamp: 2, context: 'content' },
        source: { context: 'content', tabId: 10, frameId: 1 },
        destination: { context: 'background' },
        timestamp: Date.now(),
      };

      transA.deliver(wrongFrameEnvelope);

      // Should time out because wrong-frame response was safely dropped
      await expect(sendPromise).rejects.toThrowError(/TIMEOUT/);

      busA.dispose();
    });

    it('safely ignores late or duplicate responses without crashing', () => {
      const trans = new InMemoryTransport();
      const bus = new MessageBus({ context: 'background' }, trans);

      const orphanEnvelope: MessageEnvelope = {
        id: 'non-existent-id',
        type: 'response',
        operation: 'ping',
        payload: { timestamp: 123, context: 'content' },
        source: { context: 'content', tabId: 1 },
        destination: { context: 'background' },
        timestamp: Date.now(),
      };

      expect(() => trans.deliver(orphanEnvelope)).not.toThrow();
      bus.dispose();
    });
  });

  describe('Disposal lifecycle (A-04 integration)', () => {
    it('aborts all pending requests with DISCONNECTED when bus is disposed', async () => {
      const trans = new InMemoryTransport();
      const bus = new MessageBus({ context: 'background' }, trans);

      const p1 = bus.send('ping', { timestamp: 1 }, { context: 'worker' }, { timeoutMs: 5000 });
      const p2 = bus.send('ping', { timestamp: 2 }, { context: 'worker' }, { timeoutMs: 5000 });

      bus.dispose();

      await expect(p1).rejects.toThrowError(/DISCONNECTED/);
      await expect(p2).rejects.toThrowError(/DISCONNECTED/);
    });

    it('unregisters handlers cleanly via returned unsubscribe function', async () => {
      const { busA, busB } = createConnectedBusPair(
        { context: 'background' },
        { context: 'worker' }
      );

      const unsub = busB.registerHandler('ping', () => ({
        timestamp: 1,
        context: 'worker',
      }));

      const res = await busA.send('ping', { timestamp: 1 }, { context: 'worker' });
      expect(res.context).toBe('worker');

      unsub();

      await expect(
        busA.send('ping', { timestamp: 1 }, { context: 'worker' }, { timeoutMs: 100 })
      ).rejects.toThrowError(/UNSUPPORTED_OPERATION/);

      busA.dispose();
      busB.dispose();
    });
  });

  describe('Non-serializable payload rejection (DOM nodes, functions, symbols)', () => {
    it('rejects sending DOM nodes in payloads', async () => {
      const trans = new InMemoryTransport();
      const bus = new MessageBus({ context: 'background' }, trans);

      const fakeDomNode = {
        nodeType: 1,
        tagName: 'DIV',
        ownerDocument: {},
      };

      await expect(
        bus.send('ping', { timestamp: 1, node: fakeDomNode } as unknown as { timestamp: number }, {
          context: 'worker',
        })
      ).rejects.toThrowError(/UNSUPPORTED_PAYLOAD/);

      bus.dispose();
    });

    it('rejects functions and symbols from payloads', () => {
      expect(() => assertTransportable({ fn: () => {} })).toThrowError(/UNSUPPORTED_PAYLOAD/);
      expect(() => assertTransportable({ sym: Symbol('test') })).toThrowError(
        /UNSUPPORTED_PAYLOAD/
      );
    });

    it('validates envelope structure correctly', () => {
      expect(isMessageEnvelope(null)).toBe(false);
      expect(isMessageEnvelope({})).toBe(false);
      expect(
        isMessageEnvelope({
          id: '1',
          type: 'request',
          operation: 'ping',
          timestamp: Date.now(),
          source: { context: 'background' },
          destination: { context: 'worker' },
        })
      ).toBe(true);
    });
  });

  describe('HostRelay (Extension <-> Worker bridging)', () => {
    it('relays worker-destined messages into the worker and worker replies back', async () => {
      const extensionTransport = new InMemoryTransport();
      const workerPeer = new InMemoryTransport();
      extensionTransport.peer = new InMemoryTransport();

      const relay = new HostRelay(extensionTransport, workerPeer);

      const clientBus = new MessageBus({ context: 'background' }, extensionTransport.peer);
      extensionTransport.peer.peer = extensionTransport;

      const workerBus = new MessageBus({ context: 'worker' }, workerPeer);
      workerPeer.peer = workerPeer;

      workerBus.registerHandler('ping', (req) => ({
        timestamp: req.timestamp + 100,
        context: 'worker',
      }));

      const workerSide = new InMemoryTransport();
      workerSide.peer = workerPeer;
      workerPeer.peer = workerSide;
      workerBus.dispose();
      const responder = new MessageBus({ context: 'worker' }, workerSide);
      responder.registerHandler('ping', (req) => ({
        timestamp: req.timestamp + 100,
        context: 'worker',
      }));
      const response = await clientBus.send('ping', { timestamp: 23 }, { context: 'worker' });
      expect(response.timestamp).toBe(123);
      relay.dispose();
      clientBus.dispose();
      responder.dispose();
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
      const transport = new ExtensionTransport({ context: 'background' });
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

    it('normalizes omitted frameId to 0 when sending to content', async () => {
      const transport = new ExtensionTransport({ context: 'background' });
      const envelope: MessageEnvelope = {
        id: 'e-1-norm',
        type: 'request',
        operation: 'ping',
        payload: { timestamp: 1 },
        source: { context: 'background' },
        destination: { context: 'content', tabId: 42 }, // omitted frameId
        timestamp: Date.now(),
      };

      await transport.send(envelope);

      const { platform } = await import('../platform/index.js');
      expect(platform.browser.tabs.sendMessage).toHaveBeenCalledWith(42, envelope, { frameId: 0 });

      transport.dispose();
    });

    it('rejects sending to content without tabId', async () => {
      const transport = new ExtensionTransport({ context: 'background' });
      const envelope: MessageEnvelope = {
        id: 'e-2',
        type: 'request',
        operation: 'ping',
        payload: { timestamp: 1 },
        source: { context: 'background' },
        destination: { context: 'content' }, // Missing tabId
        timestamp: Date.now(),
      };

      await expect(transport.send(envelope)).rejects.toMatchObject({ code: 'MALFORMED_MESSAGE' });
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

describe('A-03 review regressions', () => {
  it.each([NaN, Infinity, -1, 0, 2_147_483_648])(
    'rejects invalid timeout %s before dispatch',
    async (timeoutMs) => {
      const transport = new InMemoryTransport();
      const spy = vi.spyOn(transport, 'send');
      const bus = new MessageBus({ context: 'background' }, transport);
      await expect(
        bus.send('ping', { timestamp: 1 }, { context: 'worker' }, { timeoutMs })
      ).rejects.toMatchObject({ code: 'MALFORMED_MESSAGE' });
      expect(spy).not.toHaveBeenCalled();
      bus.dispose();
    }
  );

  it('ignores wrong operation/destination and malformed errors without losing pending state', async () => {
    const transport = new InMemoryTransport();
    const bus = new MessageBus({ context: 'background' }, transport);
    let request: MessageEnvelope | undefined;
    vi.spyOn(transport, 'send').mockImplementation(async (env) => {
      request = env;
    });
    const pending = bus.send('ping', { timestamp: 1 }, { context: 'worker' });
    const reply = {
      ...request!,
      type: 'response' as const,
      source: { context: 'worker' as const },
      destination: { context: 'background' as const },
      payload: { timestamp: 2, context: 'worker' },
    };
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    transport.deliver({ ...reply, operation: 'dom:walk' });
    transport.deliver({ ...reply, destination: { context: 'ui' } });
    transport.deliver({ ...reply, type: 'error', error: undefined } as unknown as MessageEnvelope);
    transport.deliver({
      ...reply,
      type: 'error',
      error: { code: 'private@example.test', message: 'raw' },
    } as unknown as MessageEnvelope);
    await Promise.resolve();
    expect(settled).toBe(false);
    transport.deliver(reply);
    await expect(pending).resolves.toMatchObject({ timestamp: 2 });
    bus.dispose();
  });

  it('rejects malformed envelopes before invoking a handler', async () => {
    const transport = new InMemoryTransport();
    const bus = new MessageBus({ context: 'background' }, transport);
    const handler = vi.fn();
    bus.registerHandler('ping', handler);
    transport.deliver({
      type: 'request',
      operation: 'ping',
      destination: { context: 'background' },
      source: { context: 'content', tabId: 4 },
      payload: { timestamp: 1 },
    } as MessageEnvelope);
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    bus.dispose();
  });

  it('enforces allowed sender roles with a bounded reply', async () => {
    const { busA, busB } = createConnectedBusPair(
      { context: 'content', tabId: 4 },
      { context: 'background' }
    );
    const handler = vi.fn(() => ({ timestamp: 1, context: 'background' as const }));
    busB.registerHandler('ping', handler, { allowedSources: ['ui'] });
    await expect(
      busA.send('ping', { timestamp: 1 }, { context: 'background' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(handler).not.toHaveBeenCalled();
    busA.dispose();
    busB.dispose();
  });

  it('never serializes custom or mutated error diagnostics', async () => {
    const { busA, busB, transB } = createConnectedBusPair(
      { context: 'background' },
      { context: 'worker' }
    );
    const spy = vi.spyOn(transB, 'send');
    busB.registerHandler('ping', () => {
      const err = new MessageBusError(MessageErrorCode.HANDLER_ERROR, 'private@example.test');
      err.message = 'private@example.test';
      throw err;
    });
    await expect(busA.send('ping', { timestamp: 1 }, { context: 'worker' })).rejects.toMatchObject({
      code: 'HANDLER_ERROR',
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('private@example.test');
    busA.dispose();
    busB.dispose();
  });

  it('authenticates extension URL peers and content metadata before dispatch', async () => {
    const { platform } = await import('../platform/index.js');
    const transport = new ExtensionTransport(
      { context: 'background' },
      { extensionPeers: { 'chrome-extension://mock-extension-id/ui.html': { context: 'ui' } } }
    );
    const listener = vi.fn();
    transport.onMessage(listener);
    const receive = vi.mocked(platform.browser.runtime.onMessage.addListener).mock.calls.at(-1)![0];
    const env = {
      id: 'auth',
      operation: 'ping',
      type: 'request' as const,
      source: { context: 'content' as const, tabId: 4, frameId: 0 },
      destination: { context: 'background' as const },
      timestamp: 1,
      payload: { timestamp: 1 },
    };
    receive(
      env,
      {
        id: 'mock-extension-id',
        tab: { id: 4 } as never,
        frameId: 0,
        url: 'https://example.test/',
      },
      () => {}
    );
    expect(listener).toHaveBeenCalledTimes(1);
    receive(
      { ...env, source: { context: 'background' } },
      { id: 'mock-extension-id', tab: { id: 4 } as never, url: 'https://example.test/' },
      () => {}
    );
    receive(env, { id: 'other-extension' }, () => {});
    expect(listener).toHaveBeenCalledTimes(1);
    receive(
      { ...env, source: { context: 'ui' } },
      {
        id: 'mock-extension-id',
        url: 'chrome-extension://mock-extension-id/ui.html',
        tab: { id: 5 } as never,
      },
      () => {}
    );
    expect(listener).toHaveBeenCalledTimes(2);
    transport.dispose();
  });

  it('returns a bounded failure if the relay cannot forward to its worker', async () => {
    const client = new InMemoryTransport();
    const host = new InMemoryTransport();
    client.peer = host;
    host.peer = client;
    const worker = new InMemoryTransport();
    const relay = new HostRelay(host, worker);
    const bus = new MessageBus({ context: 'ui' }, client);
    await expect(bus.send('ping', { timestamp: 1 }, { context: 'worker' })).rejects.toMatchObject({
      code: 'DISCONNECTED',
    });
    relay.dispose();
    bus.dispose();
  });

  it('consumes reverse relay failures and rejects forged worker origins', async () => {
    const host = new InMemoryTransport();
    const worker = new InMemoryTransport();
    const send = vi.spyOn(host, 'send').mockRejectedValue(new Error('disconnected'));
    const relay = new HostRelay(host, worker);
    const env: MessageEnvelope = {
      id: 'reply',
      type: 'response',
      operation: 'ping',
      source: { context: 'worker' },
      destination: { context: 'ui' },
      timestamp: 1,
      payload: { timestamp: 1, context: 'worker' },
    };
    worker.deliver(env);
    worker.deliver({ ...env, source: { context: 'background' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    relay.dispose();
  });
});

it('does not dispatch or reply to a forged source even with a valid payload', async () => {
  const transport = new InMemoryTransport();
  const send = vi.spyOn(transport, 'send').mockResolvedValue();
  const bus = new MessageBus({ context: 'background' }, transport);
  const handler = vi.fn(() => ({ timestamp: 1, context: 'background' as const }));
  bus.registerHandler('ping', handler);
  const source: EndpointAddress = { context: 'content', tabId: 8, frameId: 2 };
  const request: MessageEnvelope = {
    id: 'spoof',
    type: 'request',
    operation: 'ping',
    source: { context: 'content', tabId: 9, frameId: 0 },
    destination: { context: 'background' },
    timestamp: 1,
    payload: { timestamp: 1 },
  };
  transport.deliver(request, source);
  await Promise.resolve();
  expect(handler).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  transport.deliver({ ...request, source }, source);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(handler).toHaveBeenCalledWith({ timestamp: 1 }, source);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ destination: source }));
  bus.dispose();
});

it('relay preserves authenticated frame identity and rejects claimed identities', async () => {
  const extension = new InMemoryTransport();
  const worker = new InMemoryTransport();
  const forward = vi.spyOn(worker, 'send').mockResolvedValue();
  const relay = new HostRelay(extension, worker);
  const source: EndpointAddress = { context: 'content', tabId: 8, frameId: 2 };
  const request: MessageEnvelope = {
    id: 'relay',
    type: 'request',
    operation: 'ping',
    source,
    destination: { context: 'worker' },
    timestamp: 1,
    payload: { timestamp: 1 },
  };
  extension.deliver({ ...request, source: { context: 'background' } }, source);
  expect(forward).not.toHaveBeenCalled();
  extension.deliver(request, source);
  expect(forward).toHaveBeenCalledWith(expect.objectContaining({ source }));
  relay.dispose();
});
