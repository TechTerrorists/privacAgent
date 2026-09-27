/**
 * Injectable clock (feature D-04).
 *
 * The vault's idle-expiry timers must be deterministic to test — no
 * background polling loop, and no unit test should wait a real 15 minutes.
 * Every timeout the vault schedules goes through this interface, so
 * production code uses {@link createRealClock} and tests use
 * {@link createManualClock}, which controls time and callback firing
 * explicitly rather than racing the wall clock.
 */

export type TimerHandle = number;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The real clock: wall-clock time, real platform timers. Used outside tests. */
export function createRealClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as TimerHandle,
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>),
  };
}

interface ScheduledCallback {
  readonly id: TimerHandle;
  readonly dueAt: number;
  readonly callback: () => void;
  fired: boolean;
}

/**
 * A fully manual clock for deterministic lifecycle tests.
 *
 * `now()` only changes when a test calls `advance`/`set`/`jumpWithoutFiring`
 * — nothing fires on its own. `advance`/`set` fire every callback whose due
 * time falls within the new "now", in due-time order, each at most once.
 * `jumpWithoutFiring` moves time forward **without** running due callbacks —
 * it exists to simulate a suspended worker where wall time passed but no
 * timer callback ran, so a test can prove the vault also checks expiry at
 * access time rather than relying on the timer alone.
 */
export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(timestamp: number): void;
  jumpWithoutFiring(ms: number): void;
}

export function createManualClock(start = 0): ManualClock {
  let now = start;
  let nextId = 1;
  const scheduled = new Map<TimerHandle, ScheduledCallback>();

  function runDue(): void {
    // Snapshot due callbacks first: a callback that itself schedules a new
    // timeout (the vault re-arming its own idle timer) must not be picked
    // up and run again within the same pass.
    const due = [...scheduled.values()]
      .filter((entry) => !entry.fired && entry.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
    for (const entry of due) {
      if (entry.fired) continue;
      entry.fired = true;
      scheduled.delete(entry.id);
      entry.callback();
    }
  }

  return {
    now: () => now,
    setTimeout(callback, ms) {
      const id = nextId++;
      scheduled.set(id, { id, dueAt: now + ms, callback, fired: false });
      return id;
    },
    clearTimeout(handle) {
      scheduled.delete(handle);
    },
    advance(ms) {
      now += ms;
      runDue();
    },
    set(timestamp) {
      now = timestamp;
      runDue();
    },
    jumpWithoutFiring(ms) {
      now += ms;
    },
  };
}
