/**
 * F-03: the shapes that are drawn around or beside a target rather than over it.
 *
 * Pointer, circle, underline, badge and arrow all take the same shape: read the measured box,
 * write one transform. They differ only in which of `placement` and `target` they position from,
 * and that distinction is worth stating once, because it is the difference between a decoration
 * that follows an element and one that points at it.
 *
 * - **Marker-relative** (pointer, badge, and F-02's label): positioned at the core's clamped
 *   `placement`, so it is subject to viewport edge flipping exactly as the core's marker is.
 * - **Target-relative** (circle, underline): positioned on the target's own box, so it stays on
 *   the control when the control is near an edge and the marker would otherwise be pushed away.
 * - **Bridge** (arrow): starts at the marker and points back at the target, which is what makes a
 *   clamped or edge-flipped marker still legible.
 */
import { MIN_ARROW_LENGTH, BasePrimitive, type BaseSpec } from './base.js';
import type { MarkerSize, OverlayPrimitive, PrimitiveSpec, PrimitiveState } from '../types.js';
import { setLabel } from './text.js';

const POINTER_SIZE = { width: 14, height: 14 } as const;
const BADGE_SIZE = { width: 18, height: 18 } as const;

/** Padding between a ring and the control it surrounds. */
const RING_PADDING = 4;

/** How far under a target the underline sits, and how thick it is. */
const UNDERLINE_GAP = 2;
const UNDERLINE_THICKNESS = 3;

/** Widest ordinal a badge will render; beyond this the number stops being a step count. */
const MAX_BADGE_INDEX = 999;

// ---------------------------------------------------------------------- pointer

export interface PointerSpec extends PrimitiveSpec, BaseSpec {
  readonly kind: 'pointer';
}

/** A dot that glides to the placed position. The one primitive whose motion is the point. */
export class PointerPrimitive extends BasePrimitive {
  readonly size: MarkerSize = POINTER_SIZE;

  constructor(
    document: Document,
    spec: PointerSpec,
    context: ConstructorParameters<typeof BasePrimitive>[2]
  ) {
    super(document, 'pointer', context, spec.durationMs);
  }

  protected override draw(state: PrimitiveState): void {
    // Through the glide, not straight to `place`: a pointer that teleports on every scroll event
    // is the exact "no animation" case the glide exists to avoid, and the glide's first sighting
    // is already an immediate jump, so nothing is lost on the frame it appears.
    if (!state.placement) {
      this.park();
      return;
    }
    this.glide.moveTo(state.placement.x, state.placement.y, (x, y) => this.place(x, y));
  }
}

// ---------------------------------------------------------------------- circle

export interface CircleSpec extends PrimitiveSpec, BaseSpec {
  readonly kind: 'circle';
  /** Extra space outside the target box. Negative values are ignored. */
  readonly padding?: number;
}

/** A ring around the target's own box. */
export class CirclePrimitive extends BasePrimitive {
  readonly size: MarkerSize = POINTER_SIZE;
  private padding: number;

  constructor(
    document: Document,
    spec: CircleSpec,
    context: ConstructorParameters<typeof BasePrimitive>[2]
  ) {
    super(document, 'circle', context, spec.durationMs);
    this.padding = spec.padding ?? RING_PADDING;
  }

  override retarget(spec: CircleSpec): void {
    this.padding = spec.padding ?? RING_PADDING;
  }

  protected override draw(state: PrimitiveState): void {
    const target = state.target;
    if (!target) {
      this.park();
      return;
    }
    // Target-relative, so the ring stays on the control at the viewport edge instead of being
    // pushed inward by the marker's own clamping.
    this.placeScaled(
      target.x - this.padding,
      target.y - this.padding,
      target.width + this.padding * 2,
      target.height + this.padding * 2
    );
  }
}

// ---------------------------------------------------------------------- underline

export interface UnderlineSpec extends PrimitiveSpec, BaseSpec {
  readonly kind: 'underline';
  /** Distance below the target's bottom edge. */
  readonly gap?: number;
}

/** A rule under the target. Optional in the ticket; included because it is the same
 * target-relative path as the ring, and adding a seventh kind on top of an existing renderer
 * shape is exactly the case that should not need a new mechanism. */
export class UnderlinePrimitive extends BasePrimitive {
  readonly size: MarkerSize = { width: 1, height: UNDERLINE_THICKNESS };
  private gap: number;

  constructor(
    document: Document,
    spec: UnderlineSpec,
    context: ConstructorParameters<typeof BasePrimitive>[2]
  ) {
    super(document, 'underline', context, spec.durationMs);
    this.gap = spec.gap ?? UNDERLINE_GAP;
  }

  override retarget(spec: UnderlineSpec): void {
    this.gap = spec.gap ?? UNDERLINE_GAP;
  }

  protected override draw(state: PrimitiveState): void {
    const target = state.target;
    if (!target) {
      this.park();
      return;
    }
    this.placeScaled(target.x, target.y + target.height + this.gap, target.width, 1);
  }
}

// ---------------------------------------------------------------------- badge

export interface BadgeSpec extends PrimitiveSpec, BaseSpec {
  readonly kind: 'badge';
  /** Step number. Clamped to 1–999; a non-finite value renders nothing. */
  readonly index: number;
}

/** A numbered step marker. Its text is an ordinal, not caller text — see `renderOrdinal`. */
export class BadgePrimitive extends BasePrimitive {
  readonly size: MarkerSize = BADGE_SIZE;
  private readonly text: HTMLElement;

  constructor(
    document: Document,
    spec: BadgeSpec,
    context: ConstructorParameters<typeof BasePrimitive>[2]
  ) {
    super(document, 'badge', context, spec.durationMs);
    this.text = document.createElement('span');
    this.node.append(this.text);
    this.renderOrdinal(spec.index);
  }

  override retarget(spec: BadgeSpec): void {
    this.renderOrdinal(spec.index);
  }

  protected override draw(state: PrimitiveState): void {
    if (!state.placement) {
      this.park();
      return;
    }
    this.glide.moveTo(state.placement.x, state.placement.y, (x, y) => this.place(x, y));
  }

  /**
   * The ordinal is derived, not supplied: a badge shows a step number, so there is no string for
   * a caller to inject. `sanitizeLabel` still runs, because the clamp is the behaviour worth
   * having and duplicating the bound here would be a second place for it to drift.
   */
  private renderOrdinal(index: number): void {
    if (typeof index !== 'number' || !Number.isFinite(index)) {
      this.text.textContent = '';
      return;
    }
    const clamped = Math.min(Math.max(Math.trunc(index), 1), MAX_BADGE_INDEX);
    setLabel(this.text, clamped);
  }
}

// ---------------------------------------------------------------------- arrow

export interface ArrowSpec extends PrimitiveSpec, BaseSpec {
  readonly kind: 'arrow';
  /** Draws from the marker toward the target rather than the reverse. Defaults to true. */
  readonly fromMarker?: boolean;
}

/**
 * A shaft and head bridging the marker back to the target.
 *
 * This is the primitive that earns the core's `clamped` flag: when the placement flips at a
 * viewport edge, the marker is no longer adjacent to its control, and without a bridge the user
 * is left looking at a dot that does not obviously belong to anything.
 */
export class ArrowPrimitive extends BasePrimitive {
  /** The node spans the viewport, because the shaft is scaled to the measured length. */
  readonly size: MarkerSize = { width: 1, height: 1 };
  private readonly shaft: HTMLElement;
  private readonly head: HTMLElement;
  private fromMarker: boolean;

  constructor(
    document: Document,
    spec: ArrowSpec,
    context: ConstructorParameters<typeof BasePrimitive>[2]
  ) {
    super(document, 'arrow', context, spec.durationMs);
    this.shaft = document.createElement('div');
    this.shaft.className = 'pa-arrow__shaft';
    this.head = document.createElement('div');
    this.head.className = 'pa-arrow__head';
    this.node.append(this.shaft, this.head);
    this.fromMarker = spec.fromMarker ?? true;
  }

  override retarget(spec: ArrowSpec): void {
    this.fromMarker = spec.fromMarker ?? true;
  }

  protected override draw(state: PrimitiveState): void {
    const target = state.target;
    const placement = state.placement;
    if (!target || !placement) {
      this.park();
      return;
    }
    const targetCentre = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    const from = this.fromMarker ? placement : targetCentre;
    const to = this.fromMarker ? targetCentre : placement;

    // Never zero: a degenerate scaleX(0) collapses the shaft and the rotation becomes undefined.
    const length = Math.max(Math.hypot(to.x - from.x, to.y - from.y), MIN_ARROW_LENGTH);
    const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;

    // The rotation is folded into the node's own transform rather than applied to a child, so
    // the whole primitive moves, rotates and scales in one composited write. The node's zero size
    // comes from the stylesheet, not from here, so following a target writes transforms only.
    this.writeTransform(`translate3d(${r(from.x)}px, ${r(from.y)}px, 0) rotate(${r(angle)}deg)`);
    this.shaft.style.transform = `scaleX(${r(length)})`;
    // The head sits at the far end and is not scaled, or it would stretch with the shaft.
    this.head.style.transform = `translateX(${r(length)}px) rotate(0deg)`;
  }
}

const r = (value: number): number => Math.round(value * 100) / 100;

/** Type guard used by the renderer, kept here so every kind's spec lives with its primitive. */
export type ShapePrimitive = OverlayPrimitive;
