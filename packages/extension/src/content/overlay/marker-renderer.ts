/**
 * F-02: the default renderer — the plain dot marker the core shipped with.
 *
 * It lives here rather than inline in the controller so the controller has exactly one draw
 * path. F-03's renderer is a different implementation of the same three-method interface,
 * selected by `OverlayOptions.renderer`; nothing else in the core changes between them, which
 * is the point: one host, one registry, one frame loop, two ways to draw.
 *
 * The behaviour here is deliberately identical to what the controller did inline before, so
 * F-02's own tests and the overlay's documented visual contract are unchanged.
 */
import { MARKER_SIZE } from './host.js';
import type {
  OverlayPrimitive,
  OverlayRenderer,
  PrimitiveContext,
  PrimitiveSpec,
  PrimitiveState,
} from './types.js';

/** The core's own spec. F-02 knows this one because it is F-02's default renderer. */
export interface MarkerSpec extends PrimitiveSpec {
  readonly kind: 'marker';
  /** Untrusted, bounded text. Written with `textContent`, never parsed. */
  readonly label?: string;
}

export const MARKER_SPEC: MarkerSpec = { kind: 'marker' };

/** Parked off screen rather than removed, so a stale marker cannot flash if the sheet is overridden. */
const PARKED = 'translate3d(-10000px, -10000px, 0)';

class MarkerPrimitive implements OverlayPrimitive {
  readonly node: HTMLElement;
  readonly size = MARKER_SIZE;
  private readonly label: HTMLElement;
  private released = false;

  constructor(document: Document, spec: MarkerSpec, _context: PrimitiveContext) {
    this.node = document.createElement('div');
    const dot = document.createElement('div');
    this.label = document.createElement('div');
    dot.className = 'dot';
    this.label.className = 'label';
    this.node.className = 'marker';
    // The closed root keeps this out of the page tree, but not out of the accessibility tree.
    // The overlay is guidance drawn beside a control the page already exposes, so it carries no
    // semantics of its own and must not be announced alongside the control it points at.
    this.node.setAttribute('aria-hidden', 'true');
    this.node.append(dot, this.label);
    this.applyLabel(spec.label ?? '');
  }

  update(state: PrimitiveState): void {
    if (this.released) return;
    // The controller owns `data-status`, which is what the sheet's display rules key off.
    const transform =
      state.status === 'visible' && state.placement
        ? `translate3d(${state.placement.x}px, ${state.placement.y}px, 0)`
        : PARKED;
    if (this.node.style.transform !== transform) this.node.style.transform = transform;
  }

  retarget(spec: MarkerSpec): void {
    if (this.released) return;
    this.applyLabel(spec.label ?? '');
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.node.remove();
  }

  private applyLabel(text: string): void {
    // `textContent` assignment, never `innerHTML`: a label is data, and there is no path in
    // this layer that turns a string into markup.
    if (this.label.textContent !== text) this.label.textContent = text;
    const shown = text ? 'block' : 'none';
    if (this.label.style.display !== shown) this.label.style.display = shown;
  }
}

export const markerRenderer: OverlayRenderer = {
  install() {
    // F-02's sheet is mounted with the host itself; nothing extra to install.
  },
  create(document, spec, context) {
    return new MarkerPrimitive(document, spec as MarkerSpec, context);
  },
  canReuse() {
    // The marker's shape never changes with its spec, so the node is always reusable.
    return true;
  },
};
