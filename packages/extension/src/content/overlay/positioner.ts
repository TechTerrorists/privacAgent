/**
 * F-02: placement math. Pure functions over viewport rectangles, no DOM access, so the
 * geometry rules are unit-testable without a browser and independent of how a rect was
 * measured.
 *
 * Every function here takes and returns CSS viewport coordinates. Nothing in this file knows
 * about page scroll, image space, or frame-local space; converting into viewport space is
 * A-08's job, and the overlay refuses to guess.
 */
import type { Placement, ViewportRect } from './types.js';

export interface MarkerSize {
  readonly width: number;
  readonly height: number;
}

export interface PlacementRequest {
  readonly placement?: Placement;
  /** Gap between the target edge and the marker. */
  readonly offset?: number;
  readonly size?: MarkerSize;
}

export interface PlacementResult {
  /** Viewport coordinates of the marker's top-left corner. */
  readonly x: number;
  readonly y: number;
  /** The side actually used after flipping; never `auto`. */
  readonly placement: Exclude<Placement, 'auto'>;
  /**
   * True when the marker had to be pulled inside the viewport to stay on screen. The caller
   * gets a clamped position rather than an annotation that hangs off the edge, and the flag
   * lets a later primitive draw a leader line back to the true target.
   */
  readonly clamped: boolean;
}

const DEFAULT_OFFSET = 8;
const DEFAULT_SIZE: MarkerSize = { width: 24, height: 24 };
const EDGE_MARGIN = 4;

function clampPosition(
  value: number,
  extent: number,
  viewportExtent: number,
  margin: number
): number {
  const max = viewportExtent - extent - margin;
  // A marker larger than the viewport, or a negative origin, still has to land on screen.
  if (max < margin) return margin;
  return Math.min(Math.max(value, margin), max);
}

function fits(value: number, extent: number, viewportExtent: number): boolean {
  return value >= EDGE_MARGIN && value + extent <= viewportExtent - EDGE_MARGIN;
}

/**
 * Places a marker relative to its target, flipping to the opposite side when the preferred
 * side has no room and then clamping into the viewport.
 *
 * `auto` prefers `bottom` because guidance below a target reads as "here, and what follows",
 * but flips upward near the bottom edge. Left/right are tried in the same spirit, falling
 * back to bottom before clamping.
 */
export function computePlacement(
  target: ViewportRect,
  viewport: ViewportRect,
  { placement = 'auto', offset = DEFAULT_OFFSET, size = DEFAULT_SIZE }: PlacementRequest = {}
): PlacementResult {
  const preferred: Exclude<Placement, 'auto'> = placement === 'auto' ? 'bottom' : placement;
  const opposite: Record<Exclude<Placement, 'auto'>, Exclude<Placement, 'auto'>> = {
    top: 'bottom',
    bottom: 'top',
    left: 'right',
    right: 'left',
  };
  const fallback: Exclude<Placement, 'auto'> =
    preferred === 'left' || preferred === 'right' ? 'bottom' : 'right';

  const candidates: Exclude<Placement, 'auto'>[] = [preferred, opposite[preferred], fallback];
  for (const side of candidates) {
    const candidate = positionFor(side, target, viewport, offset, size);
    if (
      fits(candidate.x, size.width, viewport.width) &&
      fits(candidate.y, size.height, viewport.height)
    ) {
      return { ...candidate, placement: side, clamped: false };
    }
  }

  // Nothing fits without clamping; use the requested side and keep the marker on screen.
  const chosen = positionFor(preferred, target, viewport, offset, size);
  const x = clampPosition(chosen.x, size.width, viewport.width, EDGE_MARGIN);
  const y = clampPosition(chosen.y, size.height, viewport.height, EDGE_MARGIN);
  return {
    x,
    y,
    placement: preferred,
    clamped: x !== chosen.x || y !== chosen.y,
  };
}

function positionFor(
  side: Exclude<Placement, 'auto'>,
  target: ViewportRect,
  viewport: ViewportRect,
  offset: number,
  size: MarkerSize
): { x: number; y: number } {
  // Centre on the target's cross axis, then bias away from the viewport centre so a marker
  // near a window edge stays nearer the target instead of drifting off screen.
  const centreBias = viewport.width > 0 ? viewport.width / 2 : 0;
  switch (side) {
    case 'top':
      return {
        x: clampPosition(
          target.x + (target.width - size.width) / 2,
          size.width,
          viewport.width,
          EDGE_MARGIN
        ),
        y: target.y - size.height - offset,
      };
    case 'bottom':
      return {
        x: clampPosition(
          target.x + (target.width - size.width) / 2,
          size.width,
          viewport.width,
          EDGE_MARGIN
        ),
        y: target.y + target.height + offset,
      };
    case 'left':
      return {
        x: target.x - size.width - offset,
        y: clampPosition(
          target.y + (target.height - size.height) / 2 - (viewport.height - centreBias) * 0.05,
          size.height,
          viewport.height,
          EDGE_MARGIN
        ),
      };
    case 'right':
      return {
        x: target.x + target.width + offset,
        y: clampPosition(
          target.y + (target.height - size.height) / 2 - (viewport.height - centreBias) * 0.05,
          size.height,
          viewport.height,
          EDGE_MARGIN
        ),
      };
  }
}

/**
 * True when a target is addressable in viewport space at all. Zero-area boxes are the
 * signature of `display: none`, `visibility: hidden` on a collapsed box, or a detached node,
 * so the overlay reports `hidden` rather than pinning a marker to a 0×0 point.
 */
export function isRenderable(rect: ViewportRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * True when the target box is at least partly inside the viewport. A fully off-screen target
 * keeps its annotation suppressed: drawing a marker clamped to an edge would point the user
 * at nothing, and the executor re-observes rather than guessing which control was meant.
 */
export function intersectsViewport(target: ViewportRect, viewport: ViewportRect): boolean {
  return (
    target.x < viewport.width &&
    target.y < viewport.height &&
    target.x + target.width > 0 &&
    target.y + target.height > 0
  );
}
