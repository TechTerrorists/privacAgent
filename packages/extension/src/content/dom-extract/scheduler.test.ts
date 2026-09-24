import { describe, expect, it, vi } from 'vitest';
import { createIdleScheduler, runInChunks } from './scheduler.js';
import type { WorkDeadline, WorkScheduler } from './scheduler.js';

function clock() {
  let time = 0;
  const callbacks = new Map<number, (deadline: WorkDeadline) => void>();
  let id = 0;
  const scheduler: WorkScheduler = {
    now: () => time,
    request(callback) {
      const handle = ++id;
      callbacks.set(handle, callback);
      return () => {
        callbacks.delete(handle);
      };
    },
  };
  return {
    scheduler,
    callbacks,
    advance(ms: number) {
      time += ms;
    },
    tick(deadline: WorkDeadline = { didTimeout: false, timeRemaining: () => 50 }) {
      const entry = callbacks.entries().next().value;
      if (!entry) throw new Error('No scheduled work');
      const [handle, callback] = entry;
      callbacks.delete(handle);
      callback(deadline);
    },
  };
}

describe('B-02 scheduling', () => {
  it('does not start synchronously and resumes at the 8 ms limit', async () => {
    const c = clock();
    let visited = 0;
    const result = runInChunks(
      () => {
        c.advance(2);
        return ++visited < 10;
      },
      { scheduler: c.scheduler }
    );
    expect(visited).toBe(0);
    c.tick();
    expect(visited).toBe(4);
    c.tick();
    expect(visited).toBe(8);
    c.tick();
    expect(await result).toMatchObject({
      status: 'complete',
      metrics: { chunks: 3, activeMs: 20, longestChunkMs: 8, workUnits: 10 },
    });
    expect(c.callbacks.size).toBe(0);
  });

  it('respects an exhausted idle deadline and makes bounded progress on timeout', async () => {
    const c = clock();
    let visited = 0;
    const result = runInChunks(() => ++visited < 5, {
      scheduler: c.scheduler,
      maxUnitsPerChunk: 2,
    });
    c.tick({ didTimeout: false, timeRemaining: () => 0 });
    expect(visited).toBe(0);
    c.tick({ didTimeout: true, timeRemaining: () => 0 });
    expect(visited).toBe(2);
    c.tick();
    expect(visited).toBe(4);
    c.tick();
    expect((await result).status).toBe('complete');
  });

  it('stops inside a chunk when the idle deadline is exhausted', async () => {
    const c = clock();
    let visited = 0;
    const result = runInChunks(() => ++visited < 3, { scheduler: c.scheduler });
    c.tick({ didTimeout: false, timeRemaining: () => (visited === 0 ? 1 : 0) });
    expect(visited).toBe(1);
    c.tick();
    expect((await result).status).toBe('complete');
  });

  it.each([true, false])('cancels queued work (before start: %s)', async (beforeStart) => {
    const c = clock();
    const controller = new AbortController();
    const work = vi.fn(() => true);
    if (beforeStart) controller.abort();
    const result = runInChunks(work, {
      scheduler: c.scheduler,
      signal: controller.signal,
      maxUnitsPerChunk: 1,
    });
    if (!beforeStart) {
      c.tick();
      controller.abort();
    }
    expect((await result).status).toBe('cancelled');
    expect(c.callbacks.size).toBe(0);
    expect(work).toHaveBeenCalledTimes(beforeStart ? 0 : 1);
  });

  it('returns a payload-free failure and stops scheduling', async () => {
    const c = clock();
    const result = runInChunks(
      () => {
        throw new Error('PRIVATE_PAGE_DATA');
      },
      { scheduler: c.scheduler }
    );
    c.tick();
    expect(await result).toMatchObject({ status: 'error' });
    expect(JSON.stringify(await result)).not.toContain('PRIVATE_PAGE_DATA');
    expect(c.callbacks.size).toBe(0);
  });

  it('stops stale observations', async () => {
    const c = clock();
    const result = runInChunks(() => 'stale', { scheduler: c.scheduler });
    c.tick();
    expect((await result).status).toBe('stale');
    expect(c.callbacks.size).toBe(0);
  });

  it.each([0, -1, 9, NaN, Infinity])('rejects invalid budget %s', (budgetMs) => {
    expect(() => runInChunks(() => false, { scheduler: clock().scheduler, budgetMs })).toThrow(
      RangeError
    );
  });

  it('uses a cancellable timer fallback and forwards the native idle timeout', () => {
    const clearTimeout = vi.fn();
    const cancelIdle = vi.fn();
    const callbacks: (() => void)[] = [];
    const fake = {
      performance: { now: () => 12 },
      setTimeout: vi.fn((callback: () => void) => {
        callbacks.push(callback);
        return 4;
      }),
      clearTimeout,
    };
    const scheduler = createIdleScheduler(fake as unknown as Window);
    const onWork = vi.fn();
    const cancel = scheduler.request(onWork);
    expect(onWork).not.toHaveBeenCalled();
    callbacks[0]!();
    expect(onWork.mock.calls[0]![0].didTimeout).toBe(true);
    cancel();
    expect(clearTimeout).toHaveBeenCalledWith(4);
    const native = { ...fake, requestIdleCallback: vi.fn(() => 5), cancelIdleCallback: cancelIdle };
    createIdleScheduler(native as unknown as Window).request(onWork)();
    expect(native.requestIdleCallback).toHaveBeenCalledWith(onWork, { timeout: 100 });
    expect(cancelIdle).toHaveBeenCalledWith(5);
  });
});
