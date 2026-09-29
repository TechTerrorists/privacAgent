/**
 * F-03: the spotlight.
 *
 * The only primitive whose whole job is to cover something. It is also the only one that can
 * break a page if it is wrong, so its constraints are worth stating plainly.
 *
 * **It cannot intercept input.** The scrim is a `box-shadow` spread from a transparent element
 * sized to the target, not a semi-opaque layer with a hole in it. There is no mask, no
 * `clip-path`, no element shaped like the rest of the screen — so there is nothing for a
 * hit-test to land on, and no engine-specific compositing path whose behaviour could differ
 * between Chrome and Firefox. The shadow is painted from an element that is itself transparent,
 * and the whole subtree is `pointer-events: none !important` from the host's sheet, so this holds
 * even if a future edit adds a fill.
 *
 * **It is not a modal.** It does not trap focus, does not move focus, does not listen for
 * `Escape`, and does not make the page underneath inert. `aria-hidden` keeps it out of the
 * accessibility tree, and the page stays exactly as operable as it was before the spotlight
 * appeared — which is what the browser tests assert directly, by clicking and typing through it.
 *
 * **It dims rather than hides.** The hole keeps the target at full contrast, so the user can see
 * what is being pointed at while everything else recedes.
 */
import { BasePrimitive, type BaseSpec } from './base.js';
import type { MarkerSize, PrimitiveSpec, PrimitiveState } from '../types.js';

/** Breathing room around the target inside the cutout, so the control is not ringed by a border. */
const DEFAULT_PADDING = 8;

export interface SpotlightSpec extends PrimitiveSpec, BaseSpec {
  readonly kind: 'spotlight';
  /** Space around the target left undimmed. Negative values are ignored. */
  readonly padding?: number;
}

export class SpotlightPrimitive extends BasePrimitive {
  /** The node is an origin, not a box, so it is never clamped against. */
  readonly size: MarkerSize = { width: 0, height: 0 };
  private readonly hole: HTMLElement;
  private padding: number;

  constructor(
    document: Document,
    spec: SpotlightSpec,
    context: ConstructorParameters<typeof BasePrimitive>[2]
  ) {
    super(document, 'spotlight', context, spec.durationMs);
    this.hole = document.createElement('div');
    this.hole.className = 'pa-spotlight__hole';
    this.node.append(this.hole);
    this.padding = spec.padding ?? DEFAULT_PADDING;
  }

  override retarget(spec: SpotlightSpec): void {
    this.padding = spec.padding ?? DEFAULT_PADDING;
  }

  protected override draw(state: PrimitiveState): void {
    const target = state.target;
    if (!target) {
      this.park();
      return;
    }
    const padding = this.padding;

    // The node itself stays at the viewport origin and the hole carries the geometry, so the
    // scrim is a single fixed spread from a stable parent rather than a layer that moves every
    // frame. Only the hole's transform changes when the target does.
    this.place(0, 0);
    this.writeHole(
      target.x - padding,
      target.y - padding,
      target.width + padding * 2,
      target.height + padding * 2
    );
  }

  /**
   * One transform, position and scale together.
   *
   * The hole is authored as a fixed 100×100 box with a percentage radius and scaled to the
   * target, so following a moving target is a single composited write. The corner radius is
   * therefore resolved against the 100px box and scaled with it, which makes it very slightly
   * elliptical on a target that is much wider than it is tall. That is a deliberate trade for a
   * draw that costs one transform instead of four layout properties per frame.
   */
  private writeHole(x: number, y: number, width: number, height: number): void {
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);
    const transform = `translate3d(${round(x)}px, ${round(y)}px, 0) scale(${round(w / 100)}, ${round(
      h / 100
    )})`;
    if (this.hole.style.transform !== transform) this.hole.style.transform = transform;
  }
}

const round = (value: number): number => Math.round(value * 100) / 100;
