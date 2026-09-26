import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HostManager } from './host-manager.js';
import { transition, canAcceptWork, isTerminal } from './state-machine.js';
import type { MessageBus } from '../messaging/index.js';
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
        },
      },
      runtime: {
        onMessage: {
          addListener: vi.fn(),
        },
        getURL: vi.fn().mockReturnValue('worker.js'),
      },
    },
    createOffscreenDocument: vi.fn().mockResolvedValue(undefined),
    closeOffscreenDocument: vi.fn().mockResolvedValue(undefined),
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
  let bus: MessageBus;
  let manager: HostManager;

  function emitWorkerReady(): void {
    const onMessageCalls = vi.mocked(platform.browser.runtime.onMessage.addListener).mock.calls;
    const msgHandler = onMessageCalls[onMessageCalls.length - 1]?.[0];
    if (msgHandler) {
      (msgHandler as (msg: unknown) => void)({ type: 'privacagent:host:ready' });
    }
  }

  function emitIdleAlarm(): void {
    const onAlarmCalls = vi.mocked(platform.browser.alarms.onAlarm.addListener).mock.calls;
    const alarmHandler = onAlarmCalls[onAlarmCalls.length - 1]?.[0];
    if (alarmHandler) {
      alarmHandler({ name: 'privacagent:host:idle', scheduledTime: Date.now() });
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    bus = {
      registerHandler: vi.fn(),
    } as unknown as MessageBus;
    manager = new HostManager(bus);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('acquires and releases a host with idle timeout cleanup', async () => {
    const acquirePromise = manager.acquire('test1');
    emitWorkerReady();

    const { leaseId, generation } = await acquirePromise;
    expect(leaseId).toBeDefined();
    expect(generation).toBe(1);
    expect(manager.getInfo().state).toBe('active');
    expect(manager.getInfo().activeLeases).toBe(1);

    const res = await manager.release(leaseId);
    expect(res.released).toBe(true);
    expect(res.remainingLeases).toBe(0);
    expect(manager.getInfo().state).toBe('releasing');

    // Verify 10-minute idle alarm was set
    expect(platform.browser.alarms.create).toHaveBeenCalledWith('privacagent:host:idle', {
      delayInMinutes: 10,
    });

    emitIdleAlarm();

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.getInfo().state).toBe('idle');
  });

  it('manages concurrent leases without tearing down active host', async () => {
    const acquire1 = manager.acquire('consumer-A');
    const acquire2 = manager.acquire('consumer-B');
    emitWorkerReady();

    const [res1, res2] = await Promise.all([acquire1, acquire2]);
    expect(res1.generation).toBe(1);
    expect(res2.generation).toBe(1);
    expect(res1.leaseId).not.toBe(res2.leaseId);
    expect(manager.getInfo().activeLeases).toBe(2);
    expect(manager.getInfo().state).toBe('active');

    // Releasing 1 lease leaves host active
    const rel1 = await manager.release(res1.leaseId);
    expect(rel1.released).toBe(true);
    expect(rel1.remainingLeases).toBe(1);
    expect(manager.getInfo().state).toBe('active');

    // Releasing second lease moves to releasing
    const rel2 = await manager.release(res2.leaseId);
    expect(rel2.released).toBe(true);
    expect(rel2.remainingLeases).toBe(0);
    expect(manager.getInfo().state).toBe('releasing');
  });

  it('increments generation when host is re-created after idle release', async () => {
    const acquire1 = manager.acquire('consumer-1');
    emitWorkerReady();
    const res1 = await acquire1;
    expect(res1.generation).toBe(1);

    await manager.release(res1.leaseId);

    emitIdleAlarm();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.getInfo().state).toBe('idle');

    // Second acquire creates host with generation 2
    const acquire2 = manager.acquire('consumer-2');
    emitWorkerReady();
    const res2 = await acquire2;
    expect(res2.generation).toBe(2);
  });

  it('cancels idle alarm if new consumer acquires during releasing state', async () => {
    const acquire1 = manager.acquire('c1');
    emitWorkerReady();
    const res1 = await acquire1;
    await manager.release(res1.leaseId);
    expect(manager.getInfo().state).toBe('releasing');

    // New consumer acquires while releasing
    const res2 = await manager.acquire('c2');
    expect(res2.generation).toBe(1);
    expect(manager.getInfo().state).toBe('active');
    expect(platform.browser.alarms.clear).toHaveBeenCalledWith('privacagent:host:idle');
  });

  it('returns released false for unknown lease ID', async () => {
    const res = await manager.release('non-existent-lease');
    expect(res.released).toBe(false);
    expect(res.remainingLeases).toBe(0);
  });

  it('rejects acquire once disposed', async () => {
    manager.dispose();
    expect(manager.getInfo().state).toBe('disposed');
    await expect(manager.acquire('consumer-x')).rejects.toThrow('DISCONNECTED');
  });
});
