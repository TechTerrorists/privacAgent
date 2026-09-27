import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HostManager } from './host-manager.js';
import { transition, canAcceptWork, isTerminal } from './state-machine.js';
import { MessageBus } from '../messaging/index.js';
import type { MessageHandler } from '../messaging/types.js';
import { platform } from '../platform/index.js';

vi.mock('../platform/index.js', () => ({
  platform: {
    name: 'chrome',
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
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    vi.clearAllMocks();
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

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects stale or unauthenticated startup signals', async () => {
    const acquire = manager.acquire('consumer');
    const { generation, startupToken } = getStartupParams();

    await expect(
      getHostSignal()(
        { event: 'ready', generation, startupToken },
        { context: 'background' }
      )
    ).resolves.toEqual({ accepted: false });

    await expect(
      getHostSignal()(
        { event: 'ready', generation: generation + 1, startupToken },
        { context: 'offscreen' }
      )
    ).resolves.toEqual({ accepted: false });

    await expect(
      getHostSignal()(
        { event: 'ready', generation, startupToken },
        { context: 'offscreen' }
      )
    ).resolves.toEqual({ accepted: true });

    const lease = await acquire;
    expect(lease.generation).toBe(1);
    expect(manager.getInfo().state).toBe('active');
  });

  it('reconciles existing offscreen host before startup', async () => {
    vi.mocked(platform.hasOffscreenDocument).mockResolvedValue(true);

    const acquire = manager.acquire('consumer');
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
    await expect(acquire).rejects.toThrow('Host startup failed');
  });

  it('starts Firefox worker in module mode and uses local worker handshake', async () => {
    platform.name = 'firefox';

    const fakeWorker = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const workerCtor = vi.fn(() => fakeWorker);
    vi.stubGlobal('Worker', workerCtor as unknown as typeof Worker);

    const sendSpy = vi
      .spyOn(MessageBus.prototype, 'send')
      .mockResolvedValue({ timestamp: Date.now(), echo: 'ok', context: 'worker' } as never);

    const lease = await manager.acquire('firefox-consumer');

    expect(workerCtor).toHaveBeenCalledWith(
      'chrome-extension://mock-id/src/host/ml-worker.js',
      { type: 'module' }
    );
    expect(sendSpy).toHaveBeenCalled();
    expect(lease.generation).toBe(1);

    sendSpy.mockRestore();
    platform.name = 'chrome';
  });
});
