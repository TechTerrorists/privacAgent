/** F-02: placement math, with no DOM involved. */
import { describe, expect, it } from 'vitest';
import { computePlacement, intersectsViewport, isRenderable } from './positioner.js';
import type { ViewportRect } from './types.js';

const VIEWPORT: ViewportRect = { x: 0, y: 0, width: 1000, height: 800 };
const SIZE = { width: 24, height: 24 };
const rect = (x: number, y: number, width = 100, height = 20): ViewportRect => ({
  x,
  y,
  width,
  height,
});

describe('computePlacement', () => {
  it('prefers below the target for auto placement', () => {
    const result = computePlacement(rect(400, 400), VIEWPORT, { size: SIZE });
    expect(result.placement).toBe('bottom');
    expect(result.y).toBe(400 + 20 + 8);
    expect(result.x).toBe(400 + (100 - 24) / 2);
    expect(result.clamped).toBe(false);
  });

  it('honours an explicit side', () => {
    expect(
      computePlacement(rect(400, 400), VIEWPORT, { placement: 'top', size: SIZE }).placement
    ).toBe('top');
    expect(
      computePlacement(rect(400, 400), VIEWPORT, { placement: 'left', size: SIZE }).placement
    ).toBe('left');
  });

  it('flips above the target when there is no room below', () => {
    const result = computePlacement(rect(400, 780), VIEWPORT, { size: SIZE });
    expect(result.placement).toBe('top');
    expect(result.y).toBe(780 - 24 - 8);
  });

  it('flips to the opposite side rather than clamping when the target is in a corner', () => {
    const result = computePlacement(rect(0, 0, 10, 10), VIEWPORT, { size: SIZE });
    expect(result.clamped).toBe(false);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
  });

  it('parks a marker at the margin when it is larger than the viewport', () => {
    const tiny: ViewportRect = { x: 0, y: 0, width: 20, height: 20 };
    const result = computePlacement(rect(0, 0, 400, 400), tiny, { size: SIZE });
    // Nothing can fit a 24px marker in a 20px viewport; the origin is the only sane choice.
    expect(result.clamped).toBe(true);
    expect(result.x).toBe(4);
    expect(result.y).toBe(4);
  });

  it('respects a custom offset', () => {
    expect(computePlacement(rect(400, 400), VIEWPORT, { offset: 20, size: SIZE }).y).toBe(
      400 + 20 + 20
    );
  });
});

describe('isRenderable', () => {
  it('rejects zero-area and non-finite boxes', () => {
    expect(isRenderable(rect(10, 10, 50, 20))).toBe(true);
    expect(isRenderable(rect(10, 10, 0, 20))).toBe(false);
    expect(isRenderable(rect(10, 10, 50, 0))).toBe(false);
    expect(isRenderable({ x: Number.NaN, y: 0, width: 5, height: 5 })).toBe(false);
  });
});

describe('intersectsViewport', () => {
  it('detects a fully off-screen target', () => {
    expect(intersectsViewport(rect(400, 400), VIEWPORT)).toBe(true);
    expect(intersectsViewport(rect(-500, 400), VIEWPORT)).toBe(false);
    expect(intersectsViewport(rect(400, 2000), VIEWPORT)).toBe(false);
  });

  it('counts a partially visible target as on screen', () => {
    expect(intersectsViewport(rect(-50, 400, 100, 20), VIEWPORT)).toBe(true);
  });
});
