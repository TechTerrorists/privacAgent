/**
 * F-03: shared plumbing for the primitives.
 *
 * Everything the seven primitives have in common lives here, and it is small on purpose. Each
 * primitive's whole job is "given a measured box, write one transform". What they share is:
 *
 * - a node that is inert by construction (`aria-hidden`, no tabindex, no interactive element),
 *   so a primitive cannot become reachable by keyboard or announced by a screen reader;
 * - parking off screen instead of leaving a stale transform behind;
 * - a glide that is released with the annotation.
 *
 * What they do not share is a registry, a shadow root, or a frame loop. Those are F-02's, and a
 * primitive that needed one would be a signal that the seam is in the wrong place.
 */
import type { MarkerSize, OverlayPrimitive, PrimitiveSpec, PrimitiveState } from '../types.js';
import { Glide } from './motion.js';

/** Parked off screen rather than removed, so a hidden marker cannot flash if the sheet is overridden. */
const PARKED = 'translate3d(-10000px, -10000px, 0)';

/** Smallest useful arrow head, so a target adjacent to its marker still shows a direction. */
export const MIN_ARROW_LENGTH = 18;

export abstract class BasePrimitive implements OverlayPrimitive {
  readonly node: HTMLElement;
  abstract readonly size: MarkerSize;

  protected readonly glide: Glide;
  private released = false;

  constructor(
    document: Document,
    protected readonly kind: string,
    context: ConstructorParameters<typeof Glide>[0],
    durationMs?: number
  ) {
    this.node = document.createElement('div');
    this.node.className = `pa pa-${kind}`;
    // Decorative by contract. The overlay is guidance drawn *beside* a control the page already
    // exposes, so it adds no role, no name and no focusable stop. Without this, every primitive
    // on screen would be an unlabelled node in the accessibility tree, re-announced whenever the
    // status flipped.
    this.node.setAttribute('aria-hidden', 'true');
    this.glide = new Glide(context, durationMs === undefined ? {} : { durationMs });
  }

  update(state: PrimitiveState): void {
    if (this.released) return;
    // The status the core hands over is the single decision, read from the state rather than
    // from the node's own `data-status`. The attribute exists for the stylesheet's display
    // rules; reading it back here would mean a primitive whose visibility depended on a
    // stylesheet-consistent string rather than on the resolver's answer.
    if (state.status !== 'visible') {
      // Stop first, then park. A glide left running against a target that is no longer there
      // would keep queueing frames for a primitive the user cannot see.
      this.glide.cancel();
      this.park();
      return;
    }
    this.draw(state);
  }

  retarget(_spec: PrimitiveSpec): void {}

  attach(): void {}

  release(): void {
    if (this.released) return;
    this.released = true;
    this.glide.release();
    this.node.remove();
  }

  protected get isReleased(): boolean {
    return this.released;
  }

  /** Per-kind drawing. Only ever called for a `visible` target with a non-null box. */
  protected abstract draw(state: PrimitiveState): void;

  protected park(): void {
    if (this.node.style.transform !== PARKED) this.node.style.transform = PARKED;
  }

  /** The single write path. Transform only — no width, no height, no margin, no top/left. */
  protected place(x: number, y: number): void {
    this.writeTransform(`translate3d(${round(x)}px, ${round(y)}px, 0)`);
  }

  protected writeTransform(transform: string): void {
    if (this.node.style.transform !== transform) this.node.style.transform = transform;
  }

  protected setOpacity(value: number): void {
    const next = String(value);
    if (this.node.style.opacity !== next) this.node.style.opacity = next;
  }

  /**
   * Writes width/height off the transform, never as layout properties.
   *
   * `scale` on a 1px authored box is the trick that lets a ring follow a target of any size
   * without the primitive owning a measuring step of its own. The core's read phase has already
   * measured the target; a primitive that wanted its own box would have to read again in the
   * write phase, which is exactly the interleaving that phase exists to prevent.
   */
  protected placeScaled(x: number, y: number, width: number, height: number, extra = ''): void {
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);
    this.writeTransform(
      `translate3d(${round(x)}px, ${round(y)}px, 0) scale(${round(w)}, ${round(h)})${extra}`
    );
  }
}

/** Rounds to whole pixels: sub-pixel transforms cost the same and read as jitter on a slow frame. */
const round = (value: number): number => Math.round(value * 100) / 100;

/** Shared options every primitive spec accepts. */
export interface BaseSpec {
  /** Glide travel time in ms. 0 disables the transition without disabling the primitive. */
  readonly durationMs?: number;
}
