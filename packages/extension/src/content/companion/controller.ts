/**
 * F-08: the companion controller.
 *
 * The only stateful part of the feature, and it owns exactly three things: whether the companion is
 * enabled, the current machine state, and the pointer subscription. It owns **no** task state — it
 * cannot start a run, decide a mode, or infer that a task exists. Every transition arrives as an
 * event from an injected provider, goes through the reducer in `reducer.ts`, and comes out as a
 * state to draw.
 *
 * ## Why enabling is a teardown
 *
 * `setEnabled(false)` removes the annotation. That single call is what satisfies the whole of the
 * "disabled means nothing exists" requirement, and it does so without this module having to know
 * how F-02's lifecycle works: F-02 stops its listeners and its heartbeat when the last annotation
 * goes away, so removing ours stops the layer, and `pointer.stop()` removes the only listener F-08
 * itself ever added.
 *
 * That is the reason this is a thin wrapper rather than a hand-rolled overlay. A hand-rolled one
 * would have to re-derive all of that and would be one forgetful `removeEventListener` away from
 * leaking a page-wide pointer listener.
 */
import { createPointerSource, type PointerSource } from './pointer-resolver.js';
import { companionSpec } from './primitive.js';
import { INITIAL_MACHINE, reduceCompanion, toSnapshot, type CompanionMachine } from './reducer.js';
import {
  companionAnchor,
  type CompanionEvent,
  type CompanionPresentationAdapter,
  type CompanionSnapshot,
} from './types.js';
import type { OverlayHandle, TargetResolver } from '../overlay/types.js';

/**
 * Where the character sits relative to the 1x1 pointer rectangle F-02 resolves. Below and to the
 * right is where the user's hand is not, and it is the quadrant F-02's positioner flips away from
 * automatically when the cursor nears the bottom or right edge.
 */
const COMPANION_PLACEMENT = 'bottom' as const;

/** Gap between the cursor and the character. Comfortably clear of the real pointer. */
const COMPANION_OFFSET = 16;

export interface CompanionControllerOptions {
  /** The layer's existing handle. The companion is one annotation on it, not a new layer. */
  readonly overlay: OverlayHandle;
  /**
   * The layer's resolver, used for exactly one thing: the live document generation the companion's
   * anchor is minted with. F-02 refuses to draw an anchor whose `doc_id` is not the current one,
   * so a companion that hardcoded a document id would resolve to `stale` and never appear. Reading
   * it per draw rather than once at construction is what lets the companion survive a navigation
   * that advances the generation while the tab stays alive.
   */
  readonly resolver: TargetResolver;
  /**
   * Pointer source. Injectable so unit tests and the gallery can drive a position without a real
   * cursor. Defaults to a `pointermove` listener on `window`.
   */
  readonly pointer?: PointerSource;
  /** Where the state is coming from. Defaults to the honest unavailable provider. */
  readonly adapter?: CompanionPresentationAdapter;
  /** Notified after every accepted state, for the side panel and for tests. */
  readonly onChange?: (snapshot: CompanionSnapshot) => void;
}

export interface CompanionController {
  /**
   * Turns the companion on or off. Turning it on immediately shows the current state; turning it
   * off removes the annotation and the pointer listener with no transition and no lingering frame.
   */
  setEnabled(enabled: boolean): void;
  readonly isEnabled: boolean;
  /** Current state, as the side panel and tests see it. */
  snapshot(): CompanionSnapshot;
  /**
   * The companion's annotation id, or `null` while disabled. F-02's `positionOf` is documented as
   * the only way to read a marker's position from outside a closed shadow root, so exposing the id
   * is what lets a caller (or a test) ask where the character actually ended up.
   */
  anchorId(): string | null;
  /** Delivers an event. Exposed so a test or a future provider can drive the layer directly. */
  accept(event: CompanionEvent): void;
  /**
   * Unsubscribes, stops tracking and removes the annotation. Idempotent, and the only way to
   * release the provider subscription.
   */
  dispose(): void;
  readonly isDisposed: boolean;
}

export function createCompanionController(
  options: CompanionControllerOptions
): CompanionController {
  const { overlay, onChange } = options;
  const adapter = options.adapter;
  const pointer =
    options.pointer ??
    // The default source needs the window the layer was built on. Read off the overlay's own
    // document so there is exactly one window in play, and a test that injected a window into
    // F-02 does not silently get a different one here.
    createPointerSource(overlay.host?.ownerDocument?.defaultView ?? window);

  let machine: CompanionMachine = INITIAL_MACHINE;
  let enabled = false;
  let disposed = false;
  let anchorId: string | null = null;
  let unsubscribe: (() => void) | null = null;

  /**
   * The annotation is created lazily and only when enabled, and is written to on every accepted
   * state change. `overlay.update` on an existing anchor is F-02's re-point path, so a state
   * change reuses the same annotation instead of churning the registry.
   */
  function draw(): void {
    if (disposed || !enabled) return;
    const anchor = companionAnchor(options.resolver.currentDocId());
    // No current document means the generation has been retired — a navigation, or a session being
    // torn down. Withdrawing is the only honest option: re-pointing at a retired generation would
    // be drawn as `stale` and is exactly the "stale marker left on screen" F-02 exists to prevent.
    if (anchor === null) {
      if (anchorId !== null) {
        overlay.remove(anchorId);
        anchorId = null;
      }
      return;
    }
    anchorId = overlay.update(anchor, {
      primitive: companionSpec(machine.state),
      placement: COMPANION_PLACEMENT,
      offset: COMPANION_OFFSET,
    });
  }

  function accept(event: CompanionEvent): void {
    if (disposed) return;
    const next = reduceCompanion(machine, event, {
      providerAvailable: adapter?.available ?? false,
    });
    // A rejected event returns an equal-but-for-the-rejection-record machine. Still notify: the
    // distinction between "nothing arrived" and "something arrived and was refused" is the whole
    // point of the identity rules, and it has to be observable from outside.
    machine = next;
    if (enabled) draw();
    onChange?.(toSnapshot(machine));
  }

  function setEnabled(next: boolean): void {
    if (disposed || enabled === next) return;
    enabled = next;

    if (next) {
      // Subscribe before drawing, so a provider that delivers synchronously on subscribe cannot
      // be missed for the first frame.
      unsubscribe = adapter?.subscribe(accept) ?? null;
      // The pointer starts on enable, not at construction: a disabled companion has no listener
      // on the page at all, which is the behaviour the settings toggle is required to produce.
      pointer.start(() => {
        // Pointer movement is a geometry change, and F-02 already coalesces re-measures into its
        // own scheduler. Routing through `refresh()` rather than calling `update` is what keeps
        // this to one frame per burst of pointer events.
        overlay.refresh();
      });
      draw();
    } else {
      unsubscribe?.();
      unsubscribe = null;
      pointer.stop();
      if (anchorId !== null) {
        overlay.remove(anchorId);
        anchorId = null;
      }
    }
  }

  return {
    setEnabled,
    get isEnabled() {
      return enabled;
    },
    get isDisposed() {
      return disposed;
    },
    snapshot: () => toSnapshot(machine),
    anchorId: () => anchorId,
    accept,
    dispose() {
      if (disposed) return;
      setEnabled(false);
      disposed = true;
    },
  };
}
