import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HostManager } from './host-manager.js';
import { transition, canAcceptWork, isTerminal } from './state-machine.js';
import { MessageBus, MessageErrorCode } from '../messaging/index.js';
import type { MessageHandler } from '../messaging/types.js';
import { platform } from '../platform/index.js';

const mockPlatformName = vi.hoisted(() => ({ value: 'chrome' }));

vi.mock('../platform/index.js', () => ({
  platform: {
    get name() {
      return mockPlatformName.value;
    },
    browser: {
      alarms: {
        create: vi.fn(),
        clear: vi.fn(),
        onAlarm: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://mock-id/${path}`),
      },
    },
    createOffscreenDocument: vi.fn().mockResolvedValue(undefined),
    closeOffscreenDocument: vi.fn().mockResolvedValue(undefined),
    hasOffscreenDocument: vi.fn().mockResolvedValue(false),
  },
}));

describe('State Machine', () => {
  it('transitions through standard lifecycle correctly', () => {
    expect(transition('idle', 'ACQUIRE')).toBe('starting');
    expect(transition('starting', 'WORKER_READY')).toBe('ready');
    expect(transition('ready', 'ACQUIRE')).toBe('active');
    expect(transition('active', 'RELEASE')).toBe('releasing');
    expect(transition('releasing', 'IDLE_TIMEOUT')).toBe('idle');
  });

  it('handles concurrent acquires and acquire while releasing', () => {
    expect(transition('active', 'ACQUIRE')).toBe('active');
    expect(transition('releasing', 'ACQUIRE')).toBe('active');
  });

  it('handles error and dispose transitions', () => {
    expect(transition('starting', 'ERROR')).toBe('idle');
    expect(transition('active', 'DISPOSE')).toBe('disposed');
    expect(transition('releasing', 'DISPOSE')).toBe('disposed');
    expect(transition('idle', 'DISPOSE')).toBe('disposed');
  });

  it('determines if state can accept work', () => {
    expect(canAcceptWork('idle')).toBe(false);
    expect(canAcceptWork('starting')).toBe(false);
    expect(canAcceptWork('ready')).toBe(true);
    expect(canAcceptWork('active')).toBe(true);
    expect(canAcceptWork('releasing')).toBe(false);
    expect(canAcceptWork('disposed')).toBe(false);
  });

  it('determines if state is terminal', () => {
    expect(isTerminal('disposed')).toBe(true);
    expect(isTerminal('idle')).toBe(false);
    expect(isTerminal('active')).toBe(false);
  });
});

describe('HostManager', () => {
  const handlers = new Map<string, MessageHandler>();
  let manager: HostManager;
  let bus: MessageBus;
  let alarmListener: ((alarm: { name: string }) => void) | undefined;

  const getHostSignal = (): MessageHandler => {
    const handler = handlers.get('host:signal');
    if (!handler) throw new Error('host:signal handler not registered');
    return handler;
  };

  const getStartupParams = (): { generation: number; startupToken: string } => {
    const call = vi.mocked(platform.createOffscreenDocument).mock.calls.at(-1);
    if (!call) throw new Error('createOffscreenDocument was not called');
    const url = new URL(call[0].url, 'chrome-extension://mock-id/');
    const generation = Number.parseInt(url.searchParams.get('generation') ?? '', 10);
    const startupToken = url.searchParams.get('startupToken') ?? '';
    return { generation, startupToken };
  };

  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(platform.createOffscreenDocument).mockReset().mockResolvedValue(undefined);
    vi.mocked(platform.hasOffscreenDocument).mockReset().mockResolvedValue(false);
    vi.mocked(platform.closeOffscreenDocument).mockResolvedValue(undefined);
    handlers.clear();
    vi.useFakeTimers();

    vi.mocked(platform.browser.alarms.onAlarm.addListener).mockImplementation((handler) => {
      alarmListener = handler as (alarm: { name: string }) => void;
    });
    vi.mocked(platform.browser.alarms.onAlarm.removeListener).mockImplementation(() => {});

    bus = {
      registerHandler: vi.fn((operation, handler) => {
        handlers.set(operation as string, handler as MessageHandler);
        return () => {
          handlers.delete(operation as string);
        };
      }),
      send: vi.fn().mockResolvedValue({ timestamp: Date.now(), echo: 'ok', context: 'worker' }),
    } as unknown as MessageBus;

    manager = new HostManager(bus);
  });

  afterEach(async () => {
    vi.mocked(platform.closeOffscreenDocument).mockResolvedValue(undefined);
    manager.dispose();
    await flush();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mockPlatformName.value = 'chrome';
  });

  it('rejects stale or unauthenticated startup signals', async () => {
    const acquire = manager.acquire('consumer');
    await flush();
    const { generation, startupToken } = getStartupParams();

    await expect(
      getHostSignal()({ event: 'ready', generation, startupToken }, { context: 'background' })
    ).resolves.toEqual({ accepted: false });

    await expect(
      getHostSignal()(
        { event: 'ready', generation: generation + 1, startupToken },
        { context: 'offscreen' }
      )
    ).resolves.toEqual({ accepted: false });

    await expect(
      getHostSignal()({ event: 'ready', generation, startupToken }, { context: 'offscreen' })
    ).resolves.toEqual({ accepted: true });

    const lease = await acquire;
    expect(lease.generation).toBe(1);
    expect(manager.getInfo().state).toBe('active');
  });

  it('reconciles existing offscreen host before startup', async () => {
    vi.mocked(platform.hasOffscreenDocument).mockResolvedValue(true);

    const acquire = manager.acquire('consumer');
    await flush();
    expect(platform.closeOffscreenDocument).toHaveBeenCalledTimes(1);
    expect(platform.createOffscreenDocument).toHaveBeenCalledTimes(1);

    const { generation, startupToken } = getStartupParams();
    await getHostSignal()({ event: 'ready', generation, startupToken }, { context: 'offscreen' });
    await expect(acquire).resolves.toMatchObject({ generation: 1 });
  });

  it('keeps releasing state until async idle teardown has completed', async () => {
    let resolveClose: (() => void) | undefined;
    vi.mocked(platform.closeOffscreenDocument).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        })
    );

    const firstAcquire = manager.acquire('consumer-1');
    await flush();
    const startupOne = getStartupParams();
    await getHostSignal()(
      { event: 'ready', generation: startupOne.generation, startupToken: startupOne.startupToken },
      { context: 'offscreen' }
    );
    const firstLease = await firstAcquire;
    await manager.release(firstLease.leaseId);
    expect(manager.getInfo().state).toBe('releasing');

    alarmListener?.({ name: 'privacagent:host:idle' });
    await flush();
    expect(manager.getInfo().state).toBe('releasing');

    const secondAcquire = manager.acquire('consumer-2');
    resolveClose?.();
    await flush();

    const startupTwo = getStartupParams();
    await getHostSignal()(
      { event: 'ready', generation: startupTwo.generation, startupToken: startupTwo.startupToken },
      { context: 'offscreen' }
    );
    const secondLease = await secondAcquire;
    expect(secondLease.generation).toBe(2);
    expect(manager.getInfo().state).toBe('active');
  });

  it('rejects pending acquire when disposed during startup', async () => {
    const acquire = manager.acquire('consumer');
    manager.dispose();
    await expect(acquire).rejects.toMatchObject({ code: MessageErrorCode.HANDLER_ERROR });
  });

  const acquireReady = async () => {
    const pending = manager.acquire('consumer');
    await flush();
    const identity = getStartupParams();
    await getHostSignal()({ event: 'ready', ...identity }, { context: 'offscreen' });
    return { lease: await pending, identity };
  };

  it('cleans up every idle cycle and still disposes the replacement host', async () => {
    for (let cycle = 1; cycle <= 3; cycle++) {
      const { lease } = await acquireReady();
      expect(lease.generation).toBe(cycle);
      await manager.release(lease.leaseId);
      alarmListener?.({ name: 'privacagent:host:idle' });
      await flush();
      expect(manager.getInfo().state).toBe('idle');
      expect(platform.closeOffscreenDocument).toHaveBeenCalledTimes(cycle);
    }
    await acquireReady();
    manager.dispose();
    await flush();
    expect(platform.closeOffscreenDocument).toHaveBeenCalledTimes(4);
  });

  it('recovers from authenticated active-host loss and rejects old host signals', async () => {
    const { identity } = await acquireReady();
    await expect(
      getHostSignal()(
        { event: 'error', ...identity, startupToken: 'wrong' },
        { context: 'offscreen' }
      )
    ).resolves.toEqual({ accepted: false });
    expect(manager.getInfo().activeLeases).toBe(1);
    await expect(
      getHostSignal()({ event: 'error', ...identity }, { context: 'offscreen' })
    ).resolves.toEqual({ accepted: true });
    await flush();
    expect(manager.getInfo()).toMatchObject({ state: 'idle', activeLeases: 0 });
    const { lease } = await acquireReady();
    expect(lease.generation).toBe(2);
    await expect(
      getHostSignal()({ event: 'error', ...identity }, { context: 'offscreen' })
    ).resolves.toEqual({ accepted: false });
    expect(manager.getInfo().state).toBe('active');
  });

  it('runs all hooks and closes the host even when hooks throw or reject', async () => {
    const nextHook = vi.fn();
    manager.registerTeardownHook(() => {
      throw new Error('sync failure');
    });
    manager.registerTeardownHook(() => Promise.reject(new Error('async failure')));
    manager.registerTeardownHook(nextHook);
    const { lease } = await acquireReady();
    await manager.release(lease.leaseId);
    alarmListener?.({ name: 'privacagent:host:idle' });
    await flush();
    expect(nextHook).toHaveBeenCalledOnce();
    expect(platform.closeOffscreenDocument).toHaveBeenCalledOnce();
    expect(manager.getInfo().state).toBe('idle');
  });

  it('waits for timed-out creation and cleanup before creating a replacement', async () => {
    let finishCreation!: () => void;
    vi.mocked(platform.createOffscreenDocument).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCreation = resolve;
        })
    );
    const first = manager.acquire('first');
    const rejected = expect(first).rejects.toMatchObject({ code: MessageErrorCode.HANDLER_ERROR });
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    const second = manager.acquire('second');
    await flush();
    expect(platform.createOffscreenDocument).toHaveBeenCalledTimes(1);
    expect(platform.closeOffscreenDocument).not.toHaveBeenCalled();
    finishCreation();
    await flush();
    expect(platform.closeOffscreenDocument).toHaveBeenCalledOnce();
    expect(platform.createOffscreenDocument).toHaveBeenCalledTimes(2);
    await getHostSignal()({ event: 'ready', ...getStartupParams() }, { context: 'offscreen' });
    await expect(second).resolves.toMatchObject({ generation: 2 });
  });

  it('does not create a document after disposal during the existence check', async () => {
    let finishCheck!: (exists: boolean) => void;
    vi.mocked(platform.hasOffscreenDocument).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishCheck = resolve;
        })
    );
    const pending = manager.acquire('consumer');
    const rejected = expect(pending).rejects.toMatchObject({
      code: MessageErrorCode.HANDLER_ERROR,
    });
    manager.dispose();
    finishCheck(false);
    await rejected;
    await flush();
    expect(platform.createOffscreenDocument).not.toHaveBeenCalled();
    expect(platform.closeOffscreenDocument).toHaveBeenCalledOnce();
  });

  it('does not grant a lease if disposal occurs during its health check', async () => {
    const pending = manager.acquire('consumer');
    const rejected = expect(pending).rejects.toMatchObject({ code: MessageErrorCode.DISCONNECTED });
    await flush();
    let finishPing!: () => void;
    vi.mocked(bus.send).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPing = () => resolve({ timestamp: 0, echo: 'ok', context: 'worker' });
        })
    );
    await getHostSignal()({ event: 'ready', ...getStartupParams() }, { context: 'offscreen' });
    await flush();
    manager.dispose();
    finishPing();
    await rejected;
    expect(manager.getInfo().activeLeases).toBe(0);
  });

  it('rejects acquire cleanly when the Firefox Worker constructor throws', async () => {
    mockPlatformName.value = 'firefox';
    vi.stubGlobal(
      'Worker',
      vi.fn(function () {
        throw new Error('constructor failed');
      })
    );
    const rejected = expect(manager.acquire('consumer')).rejects.toMatchObject({
      code: MessageErrorCode.HANDLER_ERROR,
    });
    await flush();
    await rejected;
    expect(manager.getInfo()).toMatchObject({ state: 'idle', activeLeases: 0 });
  });

  it('starts Firefox worker in module mode and uses local worker handshake', async () => {
    mockPlatformName.value = 'firefox';

    const fakeWorker = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const workerCtor = vi.fn(function () {
      return fakeWorker;
    });
    vi.stubGlobal('Worker', workerCtor as unknown as typeof Worker);

    const sendSpy = vi
      .spyOn(MessageBus.prototype, 'send')
      .mockResolvedValue({ timestamp: Date.now(), echo: 'ok', context: 'worker' } as never);

    const lease = await manager.acquire('firefox-consumer');

    expect(workerCtor).toHaveBeenCalledWith('chrome-extension://mock-id/src/host/ml-worker.js', {
      type: 'module',
    });
    expect(sendSpy).toHaveBeenCalled();
    expect(lease.generation).toBe(1);

    const errorListener = fakeWorker.addEventListener.mock.calls.find(
      (call) => call[0] === 'error'
    )?.[1] as (() => void) | undefined;
    expect(errorListener).toBeDefined();
    errorListener?.();
    await flush();
    expect(fakeWorker.terminate).toHaveBeenCalledOnce();
    expect(manager.getInfo()).toMatchObject({ state: 'idle', activeLeases: 0 });
    await expect(manager.acquire('replacement')).resolves.toMatchObject({ generation: 2 });
    manager.dispose();
    await flush();
    expect(fakeWorker.terminate).toHaveBeenCalledTimes(2);
    sendSpy.mockRestore();
  });
});
