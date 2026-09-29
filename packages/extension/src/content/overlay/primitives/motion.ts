/**
 * F-03: the glide driver — the only animated thing in this layer.
 *
 * It is deliberately a *client of* F-02's scheduling rather than a new one. Frames come from
 * `PrimitiveContext.requestFrame`, which is the core's existing `FrameCoalescer` over the core's
 * existing injected `FrameScheduler`. There is no second interval, no second coalescer and no
 * second frame source anywhere in F-03; if the core is disposed, these frames stop with it.
 *
 * Two properties matter more than the easing:
 *
 * - **It is not a loop.** A glide subscribes when it starts moving and unsubscribes on the frame
 *   it arrives. An annotation that has settled queues no frames at all, so an idle overlay with a
 *   visible pointer costs the same as one with no pointer — the PRD's "~0% idle CPU" rule, and
 *   asserted in the tests rather than assumed.
 * - **It obeys the motion preference at the moment it would animate.** Checked per glide, not
 *   cached at construction, because the preference can change while the tab is open. Under
 *   `reduce` the transition is replaced by a single write, so there is no frame to queue at all,
 *   rather than a shorter animation that still moves.
 */
import type { PrimitiveContext } from '../types.js';

const DEFAULT_DURATION_MS = 180;

/** Below this the glide is not worth animating; the jump is indistinguishable from the motion. */
const MIN_DISTANCE_PX = 2;

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

const NOOP = (): void => {};

/** Keeps a caller from asking for a 10-second glide that outlives the guidance it belongs to. */
function clampDuration(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_DURATION_MS;
  return Math.min(Math.max(requested, 0), 600);
}

export interface GlideOptions {
  /** Total travel time. Clamped to 0–600 ms. */
  readonly durationMs?: number;
}

type Write = (x: number, y: number) => void;

export class Glide {
  private x = 0;
  private y = 0;
  private hasPosition = false;

  private fromX = 0;
  private fromY = 0;
  private toX = 0;
  private toY = 0;
  private startedAt = 0;
  private duration = DEFAULT_DURATION_MS;
  private write: Write = NOOP;
  private cancelFrame: (() => void) | null = null;
  /**
   * Bumped by every `cancel`/`release`. A frame callback that was already in flight when a
   * cancel ran must not re-arm itself, and this is what stops it: the callback captures the
   * counter when it subscribes and bails if it has moved on. Without it, cancelling a glide from
   * inside its own write would silently restart the loop it was trying to stop.
   */
  private generation = 0;

  /** True while a transition is in flight. The tests use this to prove frames really stop. */
  get isAnimating(): boolean {
    return this.cancelFrame !== null;
  }

  /** Current interpolated position, which lags the target while a transition is in flight. */
  get position(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  constructor(
    private readonly context: PrimitiveContext,
    private readonly options: GlideOptions = {}
  ) {}

  /**
   * Moves to a point, animating if motion is allowed and the distance warrants it.
   *
   * `write` must be a single `transform`/`opacity` update. That is the rule that keeps a glide
   * off the layout and paint path, and it is why the signature takes a callback rather than a
   * target node: the primitive decides what its own transform looks like.
   */
  moveTo(x: number, y: number, write: Write): void {
    this.write = write;

    if (!this.hasPosition) {
      // First sighting: there is nowhere to glide from. Jumping straight to the target is both
      // correct and cheaper than animating in from an arbitrary origin.
      this.cancel();
      this.settle(x, y);
      return;
    }

    // Already travelling to this exact point, because a tick re-issued the destination the glide
    // is still catching up with. This case is not a retarget and must not touch the clock.
    //
    // It is also the difference between a glide and an infinite loop. The tick runs every frame
    // while the overlay is animating, and while the pointer lags its target the distance check
    // below does not fire, so without this guard each tick would restart the transition from the
    // current position and reset `startedAt`. `progress` would then be ~0 on every frame, the
    // transition would re-arm forever, and a pointer that had moved once would spin at the
    // display rate for the rest of the page's life — the "~0% idle CPU" budget, gone.
    if (this.cancelFrame !== null && x === this.toX && y === this.toY) return;

    if (Math.hypot(x - this.x, y - this.y) < MIN_DISTANCE_PX) return;

    if (this.context.prefersReducedMotion()) {
      this.cancel();
      this.settle(x, y);
      return;
    }

    // A new target mid-flight restarts from where the pointer is now, rather than snapping back
    // to the previous origin, which would read as a stutter while following a moving target.
    this.fromX = this.x;
    this.fromY = this.y;
    this.toX = x;
    this.toY = y;
    this.startedAt = -1;
    this.duration = clampDuration(this.options.durationMs);

    // Already animating: the running transition re-reads `toX`/`toY` on its next frame, so a
    // retarget costs no extra subscription and no frame is dropped.
    if (this.cancelFrame) return;
    this.cancelFrame = this.context.requestFrame(this.step);
  }

  /** Stops any transition in flight and leaves the pointer where it is. Idempotent. */
  cancel(): void {
    this.generation++;
    this.cancelFrame?.();
    this.cancelFrame = null;
  }

  /**
   * Releases the frame subscription for good. Distinct from `cancel`: a released glide belongs
   * to an annotation that is gone, and must not be resurrected by a late frame or a retarget.
   */
  release(): void {
    this.cancel();
    this.hasPosition = false;
    this.write = NOOP;
  }

  private settle(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.hasPosition = true;
    this.write(x, y);
  }

  /**
   * `timestamp` is the frame's own clock, not `Date.now()`: the manual scheduler in the unit
   * tests and a real rAF both hand the callback the time the frame is being presented, which is
   * what keeps a glide deterministic under test.
   *
   * One request per frame, re-armed here rather than held open. Holding a subscription open would
   * mean the coalescer had to loop, and a coalescer that loops is a perpetual rAF loop for an
   * overlay that is merely sitting there.
   */
  private step = (timestamp: number): void => {
    // The subscription is dropped first, so the final frame is also the last one.
    this.cancelFrame = null;
    const generation = this.generation;

    if (this.startedAt < 0) this.startedAt = timestamp;
    const progress = this.duration <= 0 ? 1 : (timestamp - this.startedAt) / this.duration;

    if (progress < 1) {
      const eased = easeOutCubic(progress);
      this.x = this.fromX + (this.toX - this.fromX) * eased;
      this.y = this.fromY + (this.toY - this.fromY) * eased;
      this.write(this.x, this.y);
    } else {
      this.settle(this.toX, this.toY);
    }

    // A cancel or release during the write above must not be undone by a fresh subscription.
    if (progress < 1 && generation === this.generation) {
      this.cancelFrame = this.context.requestFrame(this.step);
    }
  };
}
