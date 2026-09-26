/**
 * F-02: frame scheduling for overlay tracking.
 *
 * Position updates must land in one batch per frame. Two failure modes matter and both are
 * avoided here: writing a transform per scroll event, which thrashes style and layout, and
 * leaving a requestAnimationFrame loop running after the last annotation is removed, which
 * the PRD's "~0% idle CPU" rule forbids.
 */
import type { FrameScheduler } from './types.js';

export function createFrameScheduler(win: Window): FrameScheduler {
  return {
    now: () => win.performance.now(),
    request(callback) {
      const id = win.requestAnimationFrame((timestamp) => callback(timestamp));
      return () => win.cancelAnimationFrame(id);
    },
  };
}

/**
 * Coalesces many "geometry may have changed" signals into a single frame callback.
 *
 * Scroll events, resize events, `ResizeObserver` callbacks, and heartbeat ticks can all fire
 * far more often than the display refreshes, and several of them can fire in the same tick.
 * Every one of them calls `schedule`, and the overlay still measures at most one frame per
 * animation frame.
 *
 * The loop is deliberately *not* self-perpetuating. A running rAF loop would track movement
 * perfectly, but at the cost of 60 frames a second while an annotation is on screen, against
 * the PRD's "~0% idle CPU, no background polling" rule. Tracking is therefore event-driven
 * with a slow heartbeat (see `HEARTBEAT_MS`) for the one case no event covers: an element
 * that moves because something *else* reflowed, which fires no scroll, resize, or
 * `ResizeObserver` callback. `dispose` cancels the pending frame so nothing is left queued.
 */
export class FrameCoalescer {
  private readonly scheduler: FrameScheduler;
  private readonly subscribers = new Set<() => void>();
  private cancelPending: (() => void) | undefined;

  constructor(scheduler: FrameScheduler) {
    this.scheduler = scheduler;
  }

  /** True while a frame is queued, which is also the overlay's "loop is live" state. */
  get isRunning(): boolean {
    return this.cancelPending !== undefined;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Requests a frame. Repeated calls inside one frame collapse into a single callback. */
  schedule(subscriber: () => void): void {
    this.subscribers.add(subscriber);
    if (this.cancelPending) return;
    this.cancelPending = this.scheduler.request(this.run);
  }

  unsubscribe(subscriber: () => void): void {
    this.subscribers.delete(subscriber);
  }

  /** Cancels the pending frame and drops every subscriber. Safe to call more than once. */
  dispose(): void {
    this.cancelPending?.();
    this.cancelPending = undefined;
    this.subscribers.clear();
  }

  private run = (): void => {
    this.cancelPending = undefined;
    // Snapshot: a subscriber may unsubscribe while the frame is being serviced.
    for (const subscriber of [...this.subscribers]) subscriber();
  };
}

/**
 * How often an active annotation re-measures with no event to go on. A CSS transition, a
 * collapsing accordion, or a sibling pushing the target down all move a box without firing
 * scroll, resize, or `ResizeObserver`; the heartbeat is what makes "follows layout changes"
 * true rather than best-effort. 400 ms is well under the ~1 s step-latency budget while
 * costing roughly two measurements a second instead of sixty.
 */
export const HEARTBEAT_MS = 400;

/** Serves frames synchronously from a test-controlled clock. */
export function createManualFrameScheduler(
  clock = { time: 0 }
): FrameScheduler & { advance(ms: number): void; flush(): number } {
  const callbacks = new Map<number, (timestamp: number) => void>();
  let nextId = 1;
  return {
    now: () => clock.time,
    request(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return () => callbacks.delete(id);
    },
    advance(ms) {
      clock.time += ms;
      this.flush();
    },
    flush() {
      let count = 0;
      // One frame serves everything queued for it; anything scheduled during the flush lands
      // in the next frame, exactly as a real rAF would behave.
      const queued = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of queued) {
        callback(clock.time);
        count++;
      }
      return count;
    },
  };
}
