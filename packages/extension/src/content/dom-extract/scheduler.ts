/** B-02: cooperative scheduling; never log work inputs or thrown page errors. */
export interface WorkDeadline {
  didTimeout: boolean;
  timeRemaining(): number;
}

export interface WorkScheduler {
  now(): number;
  /** Must invoke asynchronously, at most once; returns a cancellation function. */
  request(callback: (deadline: WorkDeadline) => void): () => void;
}

export interface WalkMetrics {
  chunks: number;
  workUnits: number;
  activeMs: number;
  elapsedMs: number;
  longestChunkMs: number;
}

export type WorkStatus = 'complete' | 'cancelled' | 'stale' | 'error';

export interface SchedulingOptions {
  signal?: AbortSignal;
  scheduler: WorkScheduler;
  /** May lower, never raise, the 8 ms budget. */
  budgetMs?: number;
  /** Also bounds work when the clock has low resolution. */
  maxUnitsPerChunk?: number;
}

export function createIdleScheduler(win: Window): WorkScheduler {
  return {
    now: () => win.performance.now(),
    request(callback) {
      if (typeof win.requestIdleCallback === 'function') {
        const id = win.requestIdleCallback(callback, { timeout: 100 });
        return () => win.cancelIdleCallback(id);
      }
      const id = win.setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 0);
      return () => win.clearTimeout(id);
    },
  };
}

/** Each step performs ONE bounded unit, returning false when all work is done. */
export function runInChunks(
  step: () => boolean | 'stale',
  { scheduler, signal, budgetMs = 8, maxUnitsPerChunk = 4096 }: SchedulingOptions
): Promise<{ status: WorkStatus; metrics: WalkMetrics }> {
  if (
    !Number.isFinite(budgetMs) ||
    budgetMs <= 0 ||
    budgetMs > 8 ||
    !Number.isInteger(maxUnitsPerChunk) ||
    maxUnitsPerChunk <= 0
  ) {
    throw new RangeError('Invalid DOM walker scheduling options');
  }
  const start = scheduler.now();
  const metrics: WalkMetrics = {
    chunks: 0,
    workUnits: 0,
    activeMs: 0,
    elapsedMs: 0,
    longestChunkMs: 0,
  };
  return new Promise((resolve) => {
    let settled = false;
    let cancelPending: (() => void) | undefined;
    const finish = (status: WorkStatus) => {
      if (settled) return;
      settled = true;
      cancelPending?.();
      cancelPending = undefined;
      signal?.removeEventListener('abort', abort);
      metrics.elapsedMs = scheduler.now() - start;
      resolve({ status, metrics });
    };
    const abort = () => finish('cancelled');
    const enqueue = () => {
      try {
        cancelPending = scheduler.request(run);
      } catch {
        finish('error');
      }
    };
    const run = (deadline: WorkDeadline) => {
      cancelPending = undefined;
      if (settled) return;
      const chunkStart = scheduler.now();
      metrics.chunks++;
      let status: WorkStatus | undefined;
      try {
        for (let units = 0; units < maxUnitsPerChunk; units++) {
          if (signal?.aborted) {
            status = 'cancelled';
            break;
          }
          if (
            scheduler.now() - chunkStart >= budgetMs ||
            (!deadline.didTimeout && deadline.timeRemaining() <= 0)
          )
            break;
          const more = step();
          metrics.workUnits++;
          if (more === 'stale') {
            status = 'stale';
            break;
          }
          if (!more) {
            status = 'complete';
            break;
          }
        }
      } catch {
        status = 'error';
      }
      const duration = scheduler.now() - chunkStart;
      metrics.activeMs += duration;
      metrics.longestChunkMs = Math.max(metrics.longestChunkMs, duration);
      if (status) finish(status);
      else if (!settled) enqueue();
    };
    if (signal?.aborted) {
      finish('cancelled');
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    enqueue();
  });
}
