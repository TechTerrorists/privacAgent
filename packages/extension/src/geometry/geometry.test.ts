import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  assertCurrent,
  clip,
  compose,
  createCapture,
  frameToPage,
  fromBBox,
  GeometryError,
  imageToCrop,
  invert,
  mapPoint,
  mapRect,
  point,
  rect,
  roundOut,
  space,
  toBBox,
  transform,
  type CaptureMetadata,
  type FrameLink,
  type Space,
  type Rect,
} from './index.js';

const identity = { docId: 'd_top', observationId: 1 };
const metadata = (): CaptureMetadata => ({
  identity,
  captureId: 'shot-1',
  scroll: { x: 30, y: 120 },
  layoutViewport: { width: 800, height: 600 },
  visualViewport: { offsetLeft: 0, offsetTop: 0, width: 800, height: 600, scale: 1 },
  capturedViewport: 'layout',
  image: { width: 1200, height: 900 },
  devicePixelRatio: 1.5,
  browserZoom: 1.25,
});
const options = { seed: 29082026, numRuns: 1000 };
const coordinate = fc.double({ min: -1e5, max: 1e5, noNaN: true, noDefaultInfinity: true });
const dimension = fc.double({ min: 0, max: 1e4, noNaN: true, noDefaultInfinity: true });
const scale = fc.double({ min: 0.125, max: 8, noNaN: true, noDefaultInfinity: true });
const boxes = fc.record({ x: coordinate, y: coordinate, width: dimension, height: dimension });
const near = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-7 * Math.max(1, Math.abs(a), Math.abs(b)));
function nearRect(a: Rect<Space>, b: Rect<Space>): void {
  near(a.x, b.x);
  near(a.y, b.y);
  near(a.width, b.width);
  near(a.height, b.height);
}
function link(childDocId = 'child', parentDocId = 'd_top'): FrameLink {
  return {
    identity,
    captureId: 'shot-1',
    childDocId,
    parentDocId,
    childScroll: { x: 5, y: 20 },
    borderBoxOrigin: { x: 100, y: 150 },
    border: { left: 2, top: 4 },
    padding: { left: 3, top: 1 },
    linear: { a: 1.5, b: 0, c: 0, d: 2, perspective: false },
  };
}

describe('A-08 numerical geometry contracts', () => {
  it('uses measured screenshot size without multiplying DPR/browser zoom twice', () => {
    const c = createCapture(metadata());
    expect(toBBox(mapRect(c.pageToImage, fromBBox(c.page, [40, 140, 20, 10])))).toEqual([
      15, 30, 30, 15,
    ]);
    expect(mapPoint(invert(c.pageToViewport), point(c.viewport, -5, 4))).toMatchObject({
      x: 25,
      y: 124,
    });
  });
  it('maps a panned visual viewport and resized crop independently', () => {
    const c = createCapture({
      ...metadata(),
      capturedViewport: 'visual',
      visualViewport: { offsetLeft: 20, offsetTop: 40, width: 400, height: 300, scale: 2 },
      image: { width: 800, height: 600 },
    });
    expect(mapPoint(c.pageToImage, point(c.page, 50, 160))).toMatchObject({ x: 0, y: 0 });
    const crop = imageToCrop(c, {
      cropId: 'roi',
      region: fromBBox(c.image, [100, 80, 200, 100]),
      output: { width: 100, height: 200 },
    });
    expect(toBBox(mapRect(crop, fromBBox(c.image, [120, 90, 40, 20])))).toEqual([10, 20, 20, 40]);
    expect(mapPoint(invert(compose(c.pageToImage, crop)), point(crop.to, 0, 0))).toMatchObject({
      x: 100,
      y: 200,
    });
  });
  it('accounts for nested borders, padding, nonuniform scale and child scroll', () => {
    const c = createCapture(metadata());
    const leaf = {
      ...link('inner', 'outer'),
      childScroll: { x: 10, y: 4 },
      borderBoxOrigin: { x: 20, y: 30 },
      border: { left: 1, top: 2 },
      padding: { left: 0, top: 0 },
      linear: { a: 2, b: 0, c: 0, d: 3, perspective: false },
    };
    const outer = {
      ...link('outer'),
      childScroll: { x: 7, y: 11 },
      borderBoxOrigin: { x: 100, y: 200 },
      border: { left: 3, top: 4 },
      padding: { left: 0, top: 0 },
      linear: { a: 1.5, b: 0, c: 0, d: 0.5, perspective: false },
    };
    const t = frameToPage(c, [leaf, outer]);
    // Inner page (15,8) -> outer viewport (32,48); outer border inset then
    // scale gives top viewport (152.5,226), plus root scroll (30,120).
    expect(mapPoint(t, point(t.from, 15, 8))).toMatchObject({ x: 182.5, y: 346 });
    expect(toBBox(mapRect(t, fromBBox(t.from, [15, 8, 10, 6])))).toEqual([182.5, 346, 30, 9]);
  });
  it('snapshots metadata and rejects stale/cross-capture/cross-space use', () => {
    const source = metadata();
    const c = createCapture(source);
    (source.scroll as { x: number }).x = 999;
    expect(c.metadata.scroll.x).toBe(30);
    expect(Object.isFrozen(c.metadata.visualViewport)).toBe(true);
    expect(() => assertCurrent(c, { docId: 'new', observationId: 1 })).toThrow('stale_context');
    expect(() => mapPoint(c.pageToImage, point(space('page', 'shot-2', identity), 0, 0))).toThrow(
      'space_mismatch'
    );
    expect(() =>
      mapPoint(
        c.pageToImage,
        point(space('page', 'shot-1', { ...identity, observationId: 2 }), 0, 0)
      )
    ).toThrow('stale_context');
    // Type-checking must reject an image point at a page-input operation.
    function typeContractOnly(): void {
      // @ts-expect-error mismatched coordinate units
      mapPoint(c.pageToImage, point(c.image, 1, 1));
    }
    void typeContractOnly;
  });
  it('preserves negative and zero-area rectangles; clips and rounds only explicitly', () => {
    const c = createCapture(metadata());
    expect(toBBox(mapRect(c.pageToViewport, fromBBox(c.page, [-1, -2, 0, 0])))).toEqual([
      -31, -122, 0, 0,
    ]);
    const r = fromBBox(c.image, [-1.2, 2.4, 3.1, 4.2]);
    expect(toBBox(roundOut(r))).toEqual([-2, 2, 4, 5]);
    expect(toBBox(clip(roundOut(r), fromBBox(c.image, [0, 0, 20, 20]))!)).toEqual([0, 2, 2, 5]);
    expect(clip(r, fromBBox(c.image, [10, 10, 1, 1]))).toBeNull();
    expect(roundOut(fromBBox(c.image, [0.5, 0.5, 0, 0]))).toMatchObject({ width: 0, height: 0 });
  });
  it('keeps large finite positions until raster integer precision would be unsafe', () => {
    const c = createCapture(metadata());
    expect(mapPoint(c.pageToViewport, point(c.page, 1e12, -1e12)).x).toBe(1e12 - 30);
    expect(() => roundOut(fromBBox(c.image, [1e20, 0, 2, 2]))).toThrow('invalid_geometry');
    expect(() => transform(c.page, c.image, Infinity)).toThrow('invalid_geometry');
  });
  it.each([NaN, Infinity, -Infinity, -1])('rejects invalid width %s', (width) => {
    const c = createCapture(metadata());
    expect(() => fromBBox(c.page, [0, 0, width, 1])).toThrow(GeometryError);
  });
  it('rejects invalid, incomplete, stale or unsupported transform metadata', () => {
    const c = createCapture(metadata());
    expect(() => createCapture({ ...metadata(), image: { width: 0, height: 1 } })).toThrow(
      'invalid_geometry'
    );
    expect(() => createCapture({ ...metadata(), devicePixelRatio: NaN })).toThrow(
      'invalid_geometry'
    );
    expect(() => createCapture({} as CaptureMetadata)).toThrow('missing_metadata');
    expect(() => frameToPage(c, [])).toThrow('missing_metadata');
    expect(() => frameToPage(c, [link('child', 'unrelated')])).toThrow('missing_metadata');
    expect(() => frameToPage(c, [{ ...link(), captureId: 'old' }])).toThrow('stale_context');
    for (const linear of [
      { a: 0, b: 0, c: 0, d: 1, perspective: false },
      { a: -1, b: 0, c: 0, d: 1, perspective: false },
      { a: 1, b: 0.1, c: 0, d: 1, perspective: false },
      { a: 1, b: 0, c: 0, d: 1, perspective: true },
    ]) {
      expect(() => frameToPage(c, [{ ...link(), linear }])).toThrow('unsupported_transform');
    }
    expect(() =>
      imageToCrop(c, {
        cropId: 'x',
        region: fromBBox(c.image, [-1, 0, 10, 10]),
        output: { width: 10, height: 10 },
      })
    ).toThrow('invalid_geometry');
    expect(() =>
      imageToCrop(c, {
        cropId: 'x',
        region: fromBBox(c.image, [0, 0, 0, 10]),
        output: { width: 10, height: 10 },
      })
    ).toThrow('invalid_geometry');
  });
});

describe('A-08 seeded properties (fast-check shrinks failures)', () => {
  it('point/rectangle round trips for invertible scale/translation', () => {
    fc.assert(
      fc.property(boxes, scale, scale, coordinate, coordinate, (b, sx, sy, tx, ty) => {
        const a = space('page', 'a', identity),
          z = space('image', 'z', identity);
        const t = transform(a, z, sx, sy, tx, ty),
          back = invert(t);
        const p = mapPoint(back, mapPoint(t, point(a, b.x, b.y)));
        near(p.x, b.x);
        near(p.y, b.y);
        nearRect(mapRect(back, mapRect(t, rect(a, b))), rect(a, b));
      }),
      options
    );
  });
  it('composition equals sequential mapping and identity preserves geometry', () => {
    fc.assert(
      fc.property(boxes, scale, scale, coordinate, (b, s1, s2, offset) => {
        const a = space('page', 'a', identity),
          mid = space('viewport', 'mid', identity),
          z = space('image', 'z', identity);
        const first = transform(a, mid, s1, s2, offset, -offset),
          second = transform(mid, z, s2, s1, 12.3, -8.9);
        nearRect(
          mapRect(compose(first, second), rect(a, b)),
          mapRect(second, mapRect(first, rect(a, b)))
        );
        nearRect(mapRect(transform(a, a), rect(a, b)), rect(a, b));
      }),
      options
    );
  });
  it('outward raster bounds contain the original nonempty rectangle within one pixel per edge', () => {
    fc.assert(
      fc.property(boxes, (b) => {
        const r = rect(space('image', 'x', identity), b),
          out = roundOut(r);
        expect(out.x).toBeLessThanOrEqual(r.x);
        expect(out.y).toBeLessThanOrEqual(r.y);
        if (r.width > 0) {
          expect(out.x + out.width).toBeGreaterThanOrEqual(r.x + r.width);
          expect(out.x + out.width - (r.x + r.width)).toBeLessThan(1.00000001);
        }
        if (r.height > 0) {
          expect(out.y + out.height).toBeGreaterThanOrEqual(r.y + r.height);
          expect(out.y + out.height - (r.y + r.height)).toBeLessThan(1.00000001);
        }
        expect(r.x - out.x).toBeLessThan(1.00000001);
        expect(r.y - out.y).toBeLessThan(1.00000001);
      }),
      options
    );
  });
  it('crop edges and interior map into resized crop and round trip', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 2000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (w, h, out, u) => {
          const c = createCapture({ ...metadata(), image: { width: 2000, height: 1000 } });
          const t = imageToCrop(c, {
            cropId: 'crop',
            region: fromBBox(c.image, [10, 20, w, h]),
            output: { width: out, height: out },
          });
          const r = mapPoint(t, point(c.image, 10 + w * u, 20 + h * u));
          near(r.x, out * u);
          near(r.y, out * u);
          expect(r.x).toBeGreaterThanOrEqual(-1e-8);
          expect(r.x).toBeLessThanOrEqual(out + 1e-8);
          const back = mapPoint(invert(t), r);
          near(back.x, 10 + w * u);
          near(back.y, 20 + h * u);
        }
      ),
      options
    );
  });
  it('nested frame transforms agree with independent viewport nesting', () => {
    fc.assert(
      fc.property(coordinate, coordinate, scale, scale, coordinate, (x, y, s1, s2, scroll) => {
        const c = createCapture(metadata());
        const inner = {
          ...link('inner', 'outer'),
          linear: { a: s1, b: 0, c: 0, d: s1, perspective: false },
          childScroll: { x: scroll, y: scroll },
        };
        const outer = {
          ...link('outer'),
          linear: { a: s2, b: 0, c: 0, d: s2, perspective: false },
        };
        const t = frameToPage(c, [inner, outer]);
        const p = mapPoint(t, point(t.from, x, y));
        const innerX = 100 + (5 + x - scroll) * s1,
          innerY = 150 + (5 + y - scroll) * s1;
        near(p.x, 30 + 100 + (5 + innerX) * s2);
        near(p.y, 120 + 150 + (5 + innerY) * s2);
        const back = mapPoint(invert(t), p);
        near(back.x, x);
        near(back.y, y);
      }),
      options
    );
  });
});
