/**
 * F-08: the companion as an F-03-shaped primitive.
 *
 * Implements F-02's {@link OverlayPrimitive} against the same contract F-03's seven primitives do,
 * which is what lets the companion be drawn by the layer's existing renderer inside the existing
 * closed shadow root. Nothing here creates a host, a shadow root, a frame loop, or a listener:
 * the core mounts the node, schedules the frames, and disposes everything.
 *
 * The character geometry and stylesheet live in `character.ts`; this file is only the glue that
 * hands the core a node and a `retarget`.
 */
import { COMPANION_SIZE, buildCharacter } from './character.js';
import type { CompanionState } from './types.js';
import type {
  MarkerSize,
  OverlayPrimitive,
  PrimitiveContext,
  PrimitiveSpec,
  PrimitiveState,
} from '../overlay/types.js';

/** Wire kind. Local to the extension: it is a `PrimitiveSpec.kind`, never a protocol kind. */
export const COMPANION_KIND = 'companion';

export interface CompanionSpec extends PrimitiveSpec {
  readonly kind: typeof COMPANION_KIND;
  readonly state: CompanionState;
  /**
   * The character's own box.
   *
   * It has to be on the *spec*, not only on the primitive instance: the core clamps an annotation
   * against `spec.size` when it places it, and a companion whose 28 px box was unknown there would
   * be positioned as if it were the core's default dot and hang off the edge of the screen.
   */
  readonly size: MarkerSize;
}

/** Builds a spec for the companion. Keeps the `kind` string in one place. */
export function companionSpec(state: CompanionState): CompanionSpec {
  return { kind: COMPANION_KIND, state, size: { ...COMPANION_SIZE } };
}

export class CompanionPrimitive implements OverlayPrimitive {
  readonly node: HTMLElement;
  readonly size: MarkerSize = { width: COMPANION_SIZE.width, height: COMPANION_SIZE.height };

  private readonly document: Document;
  private state: CompanionState;
  private released = false;
  /**
   * The element the core is currently translating. Tracked so a state change can swap the
   * character without the core needing to know: the wrapper keeps its `transform` and only its
   * contents are replaced, which is why a transition does not make the companion jump.
   */
  private glyph: SVGSVGElement | null = null;

  constructor(
    document: Document,
    spec: PrimitiveSpec,
    private readonly context: PrimitiveContext
  ) {
    this.document = document;
    this.state = (spec as CompanionSpec).state;

    // A wrapper, not the SVG itself, because the core writes `transform` on the node it is given
    // and an `<svg>` root is the wrong element to also be rebuilding on every state change.
    const node = document.createElement('div');
    node.className = 'pa-companion';
    // The data attribute both drives the CSS animations and is what tests read to assert the
    // visible state, since the shadow root is closed and page script cannot look inside.
    node.dataset.state = this.state;
    this.node = node;
    this.renderGlyph();
  }

  /**
   * Writes the frame: the one place the character's position comes from.
   *
   * F-02's core measures, places and clamps, then hands the result over in `state.placement`; the
   * primitive's whole job is to write that one transform. Parking off screen for a status that is
   * not `visible` is F-02's rule rather than this file's, and it is what keeps a character from
   * being left on screen pointing at a target that has gone.
   */
  update(state: PrimitiveState): void {
    if (this.released) return;
    const placement = state.placement;
    if (state.status !== 'visible' || placement === null) {
      this.park();
      return;
    }
    this.place(placement.x, placement.y);
    this.setOpacity(1);
  }

  /** Off screen, not merely hidden: a stale transform left in place is a marker pointing at nothing. */
  private park(): void {
    this.writeTransform('translate3d(-10000px, -10000px, 0)');
    this.setOpacity(0);
  }

  /** Rounded to whole pixels: sub-pixel transforms cost the same and read as jitter. */
  private place(x: number, y: number): void {
    this.writeTransform(
      `translate3d(${Math.round(x * 100) / 100}px, ${Math.round(y * 100) / 100}px, 0)`
    );
  }

  /** The single write path, and the only one. Transform and opacity, never layout properties. */
  private writeTransform(transform: string): void {
    if (this.node.style.transform !== transform) this.node.style.transform = transform;
  }

  private setOpacity(value: number): void {
    const next = String(value);
    if (this.node.style.opacity !== next) this.node.style.opacity = next;
  }

  /**
   * Nothing to measure: the character's box is fixed at 28x28 in `character.ts` and reported by
   * `size`, so the core clamps it correctly without ever reading `offsetWidth` back.
   */
  attach(): void {
    // Intentionally empty, see comment above.
  }

  retarget(spec: PrimitiveSpec): void {
    const next = (spec as CompanionSpec).state;
    if (next === this.state) return;
    this.state = next;
    this.node.dataset.state = next;
    this.renderGlyph();
    // Reduced motion is read live, per F-02's contract, and used to make a state change
    // instantaneous rather than cross-fading. The stylesheet already disables the loops under
    // the same preference; this covers the transition itself.
    if (this.context.prefersReducedMotion()) {
      this.node.style.opacity = '1';
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    // Drop the child before the node goes, and clear the stylesheet-owned inline opacity, so a
    // disposed companion leaves no detached-but-retained node behind for the page to trip over.
    this.glyph?.remove();
    this.glyph = null;
    this.node.replaceChildren();
    this.node.removeAttribute('data-state');
  }

  private renderGlyph(): void {
    const next = buildCharacter(this.document, this.state);
    this.glyph?.remove();
    this.node.append(next);
    this.glyph = next;
  }
}
