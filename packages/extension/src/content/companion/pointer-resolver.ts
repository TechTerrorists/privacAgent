/**
 * F-08: pointer tracking and the companion's target resolution.
 *
 * The companion follows the cursor, so it cannot use F-02's registry-backed resolver — there is no
 * element to look up. But it is still an annotation, and being an annotation is what buys it
 * F-02's placement, viewport clamping, and the heartbeat-then-stops lifecycle. So rather than a
 * second rendering path, the companion is a synthetic target: the pointer is reported as a 1x1
 * rectangle at the cursor, and F-02's positioner does the rest.
 *
 * That reframing is most of this feature. "Follow the pointer" stops being a positioning problem
 * and becomes a *resolution* problem, and the positioning half is already written, tested, and
 * handles the viewport edges.
 *
 * ## The listener exists only while the companion is enabled
 *
 * `start`/`stop` are the whole of the pointer's lifecycle. Nothing here polls, and there is no
 * timeout: the cache is updated by a single passive `pointermove` listener. `stop()` must remove
 * the listener *and* forget the position, so a re-enable never briefly draws a companion at
 * wherever the pointer was when it was last switched off.
 */
import { COMPANION_ELEMENT_ID } from './types.js';
import type { DocumentId } from '@privacagent/protocol';
import type {
  OverlayAnchor,
  ResolveResult,
  TargetResolver,
  ViewportRect,
} from '../overlay/types.js';

export interface PointerSample {
  readonly x: number;
  readonly y: number;
}

/**
 * A cached cursor position, in the same CSS viewport coordinates F-02's rectangles use.
 *
 * `pointermove`'s `clientX`/`clientY` are already viewport-relative, which is why the companion
 * needs no conversion: no scroll offset is added or removed, so a scrolled page moves the page
 * under a stationary cursor and the companion stays on the cursor.
 */
export interface PointerSource {
  /** `null` until the pointer has been seen at least once. Deliberately not a default position. */
  current(): PointerSample | null;
  /** Attaches the listener. Calls `onMove` per event. Idempotent. */
  start(onMove: () => void): void;
  /** Detaches the listener and clears the cache. Idempotent. */
  stop(): void;
  readonly isTracking: boolean;
}

/**
 * The pointer is sampled in **client** coordinates, and the only correction needed is for a zoomed
 * or pinch-zoomed viewport, where `clientX` is in CSS pixels of the layout viewport while the
 * visual viewport may show a different region. Dividing by the scale keeps the companion on the
 * physical cursor instead of letting it drift toward the top-left as the user zooms in.
 */
export function createPointerSource(win: Window): PointerSource {
  let sample: PointerSample | null = null;
  let tracking = false;
  /**
   * The listener's only way out. Held rather than closed over, because `start` may be called
   * again after a `stop`, and a second `start` has to replace this rather than add a second
   * listener.
   */
  let onMove_: (() => void) | null = null;

  const onPointerMove = (event: PointerEvent): void => {
    const scale = win.visualViewport?.scale ?? 1;
    // A non-finite coordinate means a synthetic or malformed event; caching it would put the
    // companion somewhere arbitrary and `NaN` propagates through placement into a dead marker.
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    sample = {
      x: scale > 0 ? event.clientX / scale : event.clientX,
      y: scale > 0 ? event.clientY / scale : event.clientY,
    };
    // The move itself. Without this the layer would only re-measure on its heartbeat, which is the
    // right cadence for a target that drifts on its own and far too slow for a cursor: the
    // companion would trail the pointer by a quarter of a second, which reads as lag rather than
    // as following.
    onMove_?.();
  };

  return {
    current: () => sample,
    get isTracking() {
      return tracking;
    },
    start(onMove) {
      onMove_ = onMove;
      if (tracking) return;
      tracking = true;
      // `passive: true` because the listener only writes to a local variable. Nothing here reads
      // layout, so there is nothing that could be improved by being allowed to block scrolling,
      // and everything to lose by appearing to.
      win.addEventListener('pointermove', onPointerMove, { passive: true });
      // Fires once on attach so an annotation that already exists re-measures immediately,
      // rather than sitting at its last position until the user happens to move the mouse.
      onMove();
    },
    stop() {
      if (!tracking) return;
      tracking = false;
      onMove_ = null;
      win.removeEventListener('pointermove', onPointerMove);
      // Forget the position too: a re-enable must not draw at a stale coordinate before the
      // first real movement arrives.
      sample = null;
    },
  };
}

/** Size of the synthetic rectangle. Nonzero, because a zero-area rect is not renderable. */
const POINTER_RECT_SIZE = 1;

/**
 * Wraps the layer's existing resolver so the companion's synthetic anchor is answered from the
 * pointer cache and everything else falls straight through to the registry.
 *
 * There is no fallback for the companion anchor. If the pointer has not been seen, the result is
 * `missing`, which F-02 treats as "do not draw, and tell the caller" — rather than inventing a
 * position at the origin or the centre of the screen, which is what a default would do and is
 * exactly the failure this feature must not ship.
 */
export function createCompanionResolver(
  base: TargetResolver,
  pointer: PointerSource
): TargetResolver {
  return {
    currentDocId: (): DocumentId | null => base.currentDocId(),

    resolve(anchor: OverlayAnchor): ResolveResult {
      if (anchor.element_id !== COMPANION_ELEMENT_ID) return base.resolve(anchor);

      const sample = pointer.current();
      if (sample === null) {
        return { status: 'missing' };
      }
      const rect: ViewportRect = {
        x: sample.x,
        y: sample.y,
        width: POINTER_RECT_SIZE,
        height: POINTER_RECT_SIZE,
      };
      // `element: null` is correct and not a gap: the pointer is not an element, so nothing is
      // observed and there is no node for F-02 to attach a ResizeObserver to.
      return { status: 'ok', rect, element: null };
    },
  };
}
