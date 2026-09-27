/** A-08: pure, observation-bound axis-aligned coordinate transforms. No DOM/API imports. */
import type { BBox } from '@privacagent/protocol';

export type Space = 'page' | 'viewport' | 'image' | 'crop' | 'frame';
export type GeometryErrorCode =
  | 'invalid_geometry'
  | 'space_mismatch'
  | 'stale_context'
  | 'unsupported_transform'
  | 'missing_metadata';
export class GeometryError extends Error {
  constructor(readonly code: GeometryErrorCode) {
    super(code);
    this.name = 'GeometryError';
  }
}

export interface Identity {
  readonly docId: string;
  readonly observationId: number;
}
export interface SpaceRef<S extends Space> {
  readonly kind: S;
  /** Distinguishes captures/crops/frame documents within one observation. */
  readonly id: string;
  readonly identity: Identity;
}
export interface XY {
  readonly x: number;
  readonly y: number;
}
export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface Box extends XY, Size {}
export interface Point<S extends Space> extends XY {
  readonly space: SpaceRef<S>;
}
export interface Rect<S extends Space> extends Box {
  readonly space: SpaceRef<S>;
}
export interface Transform<F extends Space, T extends Space> {
  readonly from: SpaceRef<F>;
  readonly to: SpaceRef<T>;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly translateX: number;
  readonly translateY: number;
}

function fail(code: GeometryErrorCode): never {
  throw new GeometryError(code);
}
function finite(...values: number[]): void {
  if (!values.every(Number.isFinite)) fail('invalid_geometry');
}
function positive(...values: number[]): void {
  finite(...values);
  if (values.some((v) => v <= 0)) fail('invalid_geometry');
}
function nonnegative(...values: number[]): void {
  finite(...values);
  if (values.some((v) => v < 0)) fail('invalid_geometry');
}
function name(value: string): void {
  if (typeof value !== 'string' || value.length === 0) fail('missing_metadata');
}
function sameIdentity(a: Identity, b: Identity): boolean {
  return a.docId === b.docId && a.observationId === b.observationId;
}
function requireSpace(a: SpaceRef<Space>, b: SpaceRef<Space>): void {
  if (!sameIdentity(a.identity, b.identity)) fail('stale_context');
  if (a.kind !== b.kind || a.id !== b.id) fail('space_mismatch');
}

export function space<S extends Space>(kind: S, id: string, identity: Identity): SpaceRef<S> {
  if (!['page', 'viewport', 'image', 'crop', 'frame'].includes(kind)) fail('invalid_geometry');
  if (!identity) fail('missing_metadata');
  name(id);
  name(identity.docId);
  if (!Number.isSafeInteger(identity.observationId) || identity.observationId < 1)
    fail('invalid_geometry');
  return Object.freeze({
    kind,
    id,
    identity: Object.freeze({ docId: identity.docId, observationId: identity.observationId }),
  });
}
export function point<S extends Space>(ref: SpaceRef<S>, x: number, y: number): Point<S> {
  finite(x, y);
  return Object.freeze({ space: space(ref.kind, ref.id, ref.identity), x, y });
}
export function rect<S extends Space>(ref: SpaceRef<S>, box: Box): Rect<S> {
  finite(box.x, box.y, box.x + box.width, box.y + box.height);
  nonnegative(box.width, box.height);
  return Object.freeze({ ...point(ref, box.x, box.y), width: box.width, height: box.height });
}
export function fromBBox<S extends Space>(ref: SpaceRef<S>, bbox: Readonly<BBox>): Rect<S> {
  if (bbox.length !== 4) fail('invalid_geometry');
  return rect(ref, { x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3] });
}
/** Explicit wire boundary; callers choose whether this is page or crop wire geometry. */
export function toBBox(value: Rect<Space>): BBox {
  const checked = rect(value.space, value);
  return [checked.x, checked.y, checked.width, checked.height];
}

export function transform<F extends Space, T extends Space>(
  from: SpaceRef<F>,
  to: SpaceRef<T>,
  scaleX = 1,
  scaleY = 1,
  translateX = 0,
  translateY = 0
): Transform<F, T> {
  if (!sameIdentity(from.identity, to.identity)) fail('stale_context');
  positive(scaleX, scaleY);
  finite(translateX, translateY);
  return Object.freeze({
    from: space(from.kind, from.id, from.identity),
    to: space(to.kind, to.id, to.identity),
    scaleX,
    scaleY,
    translateX,
    translateY,
  });
}
/** Apply first, then second. Space/observation mismatches are rejected, never inferred. */
export function compose<A extends Space, B extends Space, C extends Space>(
  first: Transform<A, B>,
  second: Transform<NoInfer<B>, C>
): Transform<A, C> {
  requireSpace(first.to, second.from);
  return transform(
    first.from,
    second.to,
    first.scaleX * second.scaleX,
    first.scaleY * second.scaleY,
    first.translateX * second.scaleX + second.translateX,
    first.translateY * second.scaleY + second.translateY
  );
}
export function invert<A extends Space, B extends Space>(t: Transform<A, B>): Transform<B, A> {
  return transform(
    t.to,
    t.from,
    1 / t.scaleX,
    1 / t.scaleY,
    -t.translateX / t.scaleX,
    -t.translateY / t.scaleY
  );
}
export function mapPoint<A extends Space, B extends Space>(
  t: Transform<A, B>,
  value: Point<NoInfer<A>>
): Point<B> {
  requireSpace(value.space, t.from);
  return point(t.to, value.x * t.scaleX + t.translateX, value.y * t.scaleY + t.translateY);
}
export function mapRect<A extends Space, B extends Space>(
  t: Transform<A, B>,
  value: Rect<NoInfer<A>>
): Rect<B> {
  const input = rect(value.space, value);
  const p = mapPoint(t, input);
  return rect(t.to, {
    x: p.x,
    y: p.y,
    width: input.width * t.scaleX,
    height: input.height * t.scaleY,
  });
}

export interface CaptureMetadata {
  readonly identity: Identity;
  readonly captureId: string;
  readonly scroll: XY;
  readonly layoutViewport: Size;
  /** Visual viewport extent in layout CSS px; offsets relative to layout viewport. */
  readonly visualViewport: Size & {
    readonly offsetLeft: number;
    readonly offsetTop: number;
    readonly scale: number;
  };
  /** Caller states which viewport the actual screenshot covers. */
  readonly capturedViewport: 'layout' | 'visual';
  readonly image: Size;
  /** Recorded for diagnostics/coherence. Scaling uses actual image dimensions instead. */
  readonly devicePixelRatio: number;
  readonly browserZoom: number;
}
export interface Capture {
  readonly metadata: CaptureMetadata;
  readonly page: SpaceRef<'page'>;
  readonly viewport: SpaceRef<'viewport'>;
  readonly image: SpaceRef<'image'>;
  readonly pageToViewport: Transform<'page', 'viewport'>;
  readonly viewportToImage: Transform<'viewport', 'image'>;
  readonly pageToImage: Transform<'page', 'image'>;
}

export function createCapture(input: CaptureMetadata): Capture {
  if (
    !input?.identity ||
    !input.scroll ||
    !input.layoutViewport ||
    !input.visualViewport ||
    !input.image
  )
    fail('missing_metadata');
  name(input.captureId);
  finite(
    input.scroll.x,
    input.scroll.y,
    input.visualViewport.offsetLeft,
    input.visualViewport.offsetTop
  );
  positive(
    input.layoutViewport.width,
    input.layoutViewport.height,
    input.visualViewport.width,
    input.visualViewport.height,
    input.visualViewport.scale,
    input.devicePixelRatio,
    input.browserZoom
  );
  if (!Number.isSafeInteger(input.image.width) || !Number.isSafeInteger(input.image.height))
    fail('invalid_geometry');
  positive(input.image.width, input.image.height);
  if (input.capturedViewport !== 'layout' && input.capturedViewport !== 'visual')
    fail('missing_metadata');
  // Copy all nested input; neither mutation nor later globals can alter this capture.
  const metadata: CaptureMetadata = Object.freeze({
    captureId: input.captureId,
    capturedViewport: input.capturedViewport,
    devicePixelRatio: input.devicePixelRatio,
    browserZoom: input.browserZoom,
    identity: Object.freeze({
      docId: input.identity.docId,
      observationId: input.identity.observationId,
    }),
    scroll: Object.freeze({ x: input.scroll.x, y: input.scroll.y }),
    layoutViewport: Object.freeze({
      width: input.layoutViewport.width,
      height: input.layoutViewport.height,
    }),
    visualViewport: Object.freeze({
      width: input.visualViewport.width,
      height: input.visualViewport.height,
      offsetLeft: input.visualViewport.offsetLeft,
      offsetTop: input.visualViewport.offsetTop,
      scale: input.visualViewport.scale,
    }),
    image: Object.freeze({ width: input.image.width, height: input.image.height }),
  });
  const page = space('page', input.captureId, input.identity);
  const viewport = space('viewport', input.captureId, input.identity);
  const image = space('image', input.captureId, input.identity);
  const pageToViewport = transform(page, viewport, 1, 1, -input.scroll.x, -input.scroll.y);
  const visual = input.capturedViewport === 'visual';
  const extent = visual ? input.visualViewport : input.layoutViewport;
  const sx = input.image.width / extent.width,
    sy = input.image.height / extent.height;
  const viewportToImage = transform(
    viewport,
    image,
    sx,
    sy,
    visual ? -input.visualViewport.offsetLeft * sx : 0,
    visual ? -input.visualViewport.offsetTop * sy : 0
  );
  return Object.freeze({
    metadata,
    page,
    viewport,
    image,
    pageToViewport,
    viewportToImage,
    pageToImage: compose(pageToViewport, viewportToImage),
  });
}
/** Pure freshness gate. Caller must supply current identity and recapture on mismatch. */
export function assertCurrent(capture: Capture, current: Identity): void {
  if (!sameIdentity(capture.metadata.identity, current)) fail('stale_context');
}

export interface CropMetadata {
  readonly cropId: string;
  readonly region: Rect<'image'>;
  readonly output: Size;
}
export function imageToCrop(capture: Capture, input: CropMetadata): Transform<'image', 'crop'> {
  if (!input?.region?.space || !input.output) fail('missing_metadata');
  requireSpace(input.region.space, capture.image);
  const r = rect(input.region.space, input.region);
  positive(r.width, r.height, input.output.width, input.output.height);
  if (!Number.isSafeInteger(input.output.width) || !Number.isSafeInteger(input.output.height))
    fail('invalid_geometry');
  if (
    r.x < 0 ||
    r.y < 0 ||
    r.x + r.width > capture.metadata.image.width ||
    r.y + r.height > capture.metadata.image.height
  )
    fail('invalid_geometry');
  const sx = input.output.width / r.width,
    sy = input.output.height / r.height;
  // Include capture identity in the crop namespace; a crop ID alone is not global.
  const crop = space(
    'crop',
    JSON.stringify([capture.metadata.captureId, input.cropId]),
    capture.metadata.identity
  );
  name(input.cropId);
  return transform(capture.image, crop, sx, sy, -r.x * sx, -r.y * sy);
}

export interface FrameLink {
  readonly identity: Identity;
  readonly captureId: string;
  readonly childDocId: string;
  readonly parentDocId: string;
  /** Child document's layout scroll; frame-local inputs are child PAGE CSS px. */
  readonly childScroll: XY;
  /** Measured border-box top-left in the parent's layout viewport CSS px. */
  readonly borderBoxOrigin: XY;
  /** Unscaled CSS inset from border-box edge to the embedded content viewport. */
  readonly border: { readonly left: number; readonly top: number };
  readonly padding: { readonly left: number; readonly top: number };
  /** Effective linear transform including ancestors. Translation is in borderBoxOrigin.
   * A-09 must inspect all ancestors; a bounding-box ratio alone cannot detect rotation. */
  readonly linear: {
    readonly a: number;
    readonly b: number;
    readonly c: number;
    readonly d: number;
    readonly perspective: boolean;
  };
}
/** Leaf-first ancestry, ending in the captured top document. No frame DOM access. */
export function frameToPage(
  capture: Capture,
  links: readonly FrameLink[]
): Transform<'frame', 'page'> {
  if (!Array.isArray(links)) fail('missing_metadata');
  const leaf = links[0];
  if (!leaf) fail('missing_metadata');
  const visited = new Set<string>();
  let sx = 1,
    sy = 1,
    tx = 0,
    ty = 0;
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    if (
      !link?.identity ||
      !link.childScroll ||
      !link.borderBoxOrigin ||
      !link.border ||
      !link.padding ||
      !link.linear
    )
      fail('missing_metadata');
    if (
      !sameIdentity(link.identity, capture.metadata.identity) ||
      link.captureId !== capture.metadata.captureId
    )
      fail('stale_context');
    name(link.childDocId);
    name(link.parentDocId);
    if (visited.has(link.childDocId) || link.childDocId === capture.metadata.identity.docId)
      fail('invalid_geometry');
    visited.add(link.childDocId);
    const expectedParent = links[i + 1]?.childDocId ?? capture.metadata.identity.docId;
    if (link.parentDocId !== expectedParent) fail('missing_metadata');
    finite(
      link.childScroll.x,
      link.childScroll.y,
      link.borderBoxOrigin.x,
      link.borderBoxOrigin.y,
      link.linear.a,
      link.linear.b,
      link.linear.c,
      link.linear.d
    );
    nonnegative(link.border.left, link.border.top, link.padding.left, link.padding.top);
    if (
      link.linear.perspective !== false ||
      link.linear.b !== 0 ||
      link.linear.c !== 0 ||
      link.linear.a <= 0 ||
      link.linear.d <= 0
    )
      fail('unsupported_transform');
    const { a, d } = link.linear;
    // Page(child) -> viewport(child) -> viewport(parent). The next link's
    // childScroll subtraction requires parent PAGE coordinates, so add it here.
    const parentScroll = links[i + 1]?.childScroll ?? capture.metadata.scroll;
    tx =
      (tx - link.childScroll.x + link.border.left + link.padding.left) * a +
      link.borderBoxOrigin.x +
      parentScroll.x;
    ty =
      (ty - link.childScroll.y + link.border.top + link.padding.top) * d +
      link.borderBoxOrigin.y +
      parentScroll.y;
    sx *= a;
    sy *= d;
  }
  return transform(
    space(
      'frame',
      JSON.stringify([capture.metadata.captureId, leaf.childDocId]),
      capture.metadata.identity
    ),
    capture.page,
    sx,
    sy,
    tx,
    ty
  );
}

/** Explicit lossy intersection. Edge-only/zero-area intersections return null. */
export function clip<S extends Space>(value: Rect<S>, bounds: Rect<NoInfer<S>>): Rect<S> | null {
  requireSpace(value.space, bounds.space);
  rect(value.space, value);
  rect(bounds.space, bounds);
  const x = Math.max(value.x, bounds.x),
    y = Math.max(value.y, bounds.y);
  const right = Math.min(value.x + value.width, bounds.x + bounds.width),
    bottom = Math.min(value.y + value.height, bounds.y + bounds.height);
  return right <= x || bottom <= y
    ? null
    : rect(value.space, { x, y, width: right - x, height: bottom - y });
}
/** Raster-only outward rounding. Never rounds intermediate CSS geometry. Empty stays empty. */
export function roundOut<S extends 'image' | 'crop'>(value: Rect<S>): Rect<S> {
  if (value.space.kind !== 'image' && value.space.kind !== 'crop') fail('space_mismatch');
  rect(value.space, value);
  const x = Math.floor(value.x),
    y = Math.floor(value.y);
  const right = value.width === 0 ? x : Math.ceil(value.x + value.width);
  const bottom = value.height === 0 ? y : Math.ceil(value.y + value.height);
  if (![x, y, right, bottom, right - x, bottom - y].every(Number.isSafeInteger))
    fail('invalid_geometry');
  return rect(value.space, { x, y, width: right - x, height: bottom - y });
}
