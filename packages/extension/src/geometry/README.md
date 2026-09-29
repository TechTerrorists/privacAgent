# Coordinate transforms (A-08)

This is a pure geometry library. It reads no DOM, browser API, global scroll/DPR,
model output or network state. The caller measures a coherent observation and
constructs a frozen context. Capture (A-07), frame access (A-09), model preprocessing
(C-06), masks (D-12/D-13) and overlay rendering (F-02) keep their own responsibilities.
No existing wire schema or inference output has changed.

## Spaces and identity

| Space      | Origin and units                                                                        |
| ---------- | --------------------------------------------------------------------------------------- |
| `page`     | Top document origin, CSS pixels. E-01 element BBoxes use this.                          |
| `viewport` | Top **layout** viewport origin, CSS pixels (`getBoundingClientRect`).                   |
| `image`    | Actual screenshot top-left, raster pixels.                                              |
| `crop`     | Resized crop top-left, crop/output raster pixels.                                       |
| `frame`    | Child **document/page** origin, local CSS pixels (child client rect plus child scroll). |

Points/rectangles carry a `SpaceRef` with a kind, context ID and top observation
`{docId, observationId}`. All rectangles use `[x,y,width,height]`, with right/bottom
at `x+width`/`y+height`. Negative/offscreen origins and zero extents are valid;
negative dimensions, nonfinite numbers and invalid scales are not. Geometry remains
floating point until an explicit raster operation. `-0` and `0` are geometrically
equivalent. IEEE-754 precision limits apply; round trips use numerical tolerances,
not bit-for-bit equality at extreme magnitudes.

`space`, `point`, `rect`, `fromBBox`, and `transform` construct validated, frozen
values. The exported interfaces are local contracts, **not runtime validators for
arbitrary JSON**: parse incoming messages before supplying metadata. Context
factories validate required metadata and finite geometry. Transforms reject
mismatched space IDs/observations, including at runtime after TS types are erased.
Two `image` spaces from different captures cannot be interchanged. Frame/crop IDs
are scoped to their capture. IDs must identify immutable measurements: never reuse
a capture ID for changed metadata or a crop ID for a different crop in that capture.

`assertCurrent(capture, currentIdentity)` detects a changed doc/observation. It
cannot detect an unreported scroll, DOM mutation or a caller reusing identity.
Callers must re-observe if geometry changes between DOM measurement and capture,
as required by the PRD. A successful transform does not authorize execution or
vault resolution; B-15 and D-09 still make those checks.

## Capture metadata and zoom

Pass `createCapture` the top identity, unique capture ID, scroll offsets, layout
viewport dimensions, visual viewport offset/dimensions/scale, **actual screenshot
pixel dimensions**, recorded DPR and browser zoom, and an explicit choice of what
was captured (`layout` or `visual`). Never infer screenshot scale from DPR alone.

For each axis:

- Page → layout viewport: `v = p - scroll`.
- Layout screenshot: `image = v * imageSize / layoutViewportSize`.
- Visual screenshot: `image = (v - visualOffset) * imageSize / visualViewportSize`.

Browser/page zoom may already change DPR and CSS geometry. DPR, browser zoom and
visual scale are retained as metadata, **not extra multipliers**. Actual per-axis
ratios account for screenshot resampling and integer pixel dimensions. The caller
must declare which viewport its capture API covers; this module cannot determine
that from image dimensions. Desktop browser zoom and pinch/visual zoom are different.
Viewport offsets and dimensions are expressed in layout CSS pixels even when pinched.

The factory copies known scalar metadata and freezes nested records. Later scroll,
resize or mutation of the input object never changes an earlier transform. Metadata
is serializable and contains no DOM references. The module does not acquire a
screenshot or supply a browser measurement helper that could mix acquisition times.

```ts
import {
  createCapture,
  fromBBox,
  mapRect,
  invert,
  toBBox,
  compose,
  imageToCrop,
} from './geometry/index.js';

const capture = createCapture({
  identity: { docId: 'doc-1', observationId: 1 },
  captureId: 'capture-1',
  scroll: { x: 0, y: 100 },
  layoutViewport: { width: 800, height: 600 },
  visualViewport: { offsetLeft: 0, offsetTop: 0, width: 800, height: 600, scale: 1 },
  capturedViewport: 'layout',
  image: { width: 1200, height: 900 },
  devicePixelRatio: 1.5,
  browserZoom: 1,
});

// B-02/B-01: a client rect measured in this same observation becomes a wire page box.
const domRect = fromBBox(capture.viewport, [20, 30, 100, 40]);
const wirePageBox = toBBox(mapRect(invert(capture.pageToViewport), domRect));
// F-02: reverse that conversion, then pass x/y/width/height to its viewport renderer.
const overlayBox = mapRect(capture.pageToViewport, fromBBox(capture.page, wirePageBox));

// C-01 intentionally emits image/crop coordinates, NOT page boxes.
const detection = fromBBox(capture.image, [30, 45, 150, 60]);
const pageDetection = mapRect(invert(capture.pageToImage), detection);
const cropTransform = imageToCrop(capture, {
  cropId: 'roi-1',
  region: fromBBox(capture.image, [20, 40, 200, 100]),
  output: { width: 100, height: 50 },
});
const cropDetection = fromBBox(cropTransform.to, [5, 5, 30, 10]);
const cropToPage = compose(invert(cropTransform), invert(capture.pageToImage));
const pageCropDetection = mapRect(cropToPage, cropDetection);
```

The unused variables above show separate consumer handoffs, not a new pipeline.
`toBBox` is the deliberate tuple boundary: only convert a **page** rect to a wire
element box, or a **crop** rect to crop-local protocol geometry. No implicit clamp
or rounding is performed. Crop metadata must describe a positive, in-image region
and positive integer output dimensions; padded/out-of-image crops need an explicit
preprocessing transform instead. `transform`, `compose(first, second)` and `invert`
provide hooks for later axis-aligned preprocessing; A-08 implements no NMS/letterboxing.

## Nested frames

`frameToPage(capture, links)` takes a **leaf-first** chain ending at the captured top
document. Each link identifies its child/parent document, top observation/capture,
child scroll, measured border-box origin in the parent's layout viewport, unscaled
left/top border and padding, and the effective linear transform `{a,b,c,d,perspective}`.

For each link:

```
parentPage = parentScroll + borderBoxOrigin
             + axisScale * (border + padding + childPage - childScroll)
```

`parentScroll` comes from the next link's child scroll, or the top capture scroll.
Every adjacent document must match; missing chains, cycles and stale metadata fail.
The transform consumes frame-local **page** coordinates. For a child DOM client rect,
add that child's scroll first. Convert the result to top viewport with
`compose(frameToPage(capture, links), capture.pageToViewport)` for an F-02 consumer.

Supported: positive axis-aligned scale and translation, including nesting,
nonuniform scale, borders, padding and transform-origin translation represented by
the measured border-box origin. The effective scale includes all transformed
ancestors **within the parent document**. Parent-frame scaling is applied by its own
link, once. CSS zoom may be included in the measured effective scale too.

Unsupported: rotation, skew, reflection, zero scale or perspective. Nonzero `b`/`c`,
nonpositive `a`/`d` or a perspective flag fails with `unsupported_transform`. A-09
must inspect transforms up the ancestor chain: a bounding-box size ratio alone
cannot prove absence of rotation/perspective. This library trusts that explicit
measurement contract and never accesses frame DOM, bypasses cross-origin access or
manufactures offsets. It transforms coordinates, not visibility: clipped/occluded
frame contents still require the caller's visibility checks.

## Rounding, clipping and errors

`roundOut(imageOrCropRect)` floors left/top and ceils right/bottom for conservative
raster coverage. It refuses unsafe integer bounds; zero-width/height stays zero.
It does not add anti-alias dilation or perform a privacy classification.
`clip(rect, bounds)` explicitly intersects in one identical space; disjoint,
edge-only or zero-area intersections return `null`. General transforms never clip.
For a raster mask: convert → outward round → clip to integer image bounds. These
lossy operations have containment tests, not inverse-round-trip promises.

`GeometryError.code` is one of `invalid_geometry`, `space_mismatch`, `stale_context`,
`unsupported_transform`, `missing_metadata`. Messages contain only the code, not
page/capture content. Overflow/invalid inverse scales fail instead of emitting NaN.
Do not catch these errors and execute guessed coordinates: recapture or report the
unsupported path.

## Verification

- `pnpm exec vitest run packages/extension/src/geometry/geometry.test.ts`
  runs numerical examples and fast-check properties (seed **29082026**, 1,000 cases
  per property, with automatic counterexample shrinking). A failure prints the seed
  and replay path. Covers point/rectangle inverses, identity/composition, crop/frame
  mapping, conservative raster coverage, negative/fractional/zero geometry, invalid
  metadata, stale contexts and large finite positions.
- `pnpm exec playwright test packages/extension/tests/geometry.spec.ts`
  saves screenshots and compares known colored target pixels with production-library
  transforms. Chromium/Firefox cover DPR 1, 1.5 and 2, scrolled nested same-origin
  frames with border/padding/nonuniform scale, fractional geometry and viewport
  resize. Earlier captures are checked after scroll/resize to prove immutability.
  Pixel comparisons allow rasterization/antialias error; exact algebra is tested separately.
- Chromium also tests real visual-viewport pinch scaling via CDP. The equivalent
  Firefox test is explicitly skipped because Playwright lacks that control. Firefox
  pinch zoom and native browser toolbar zoom are **not verified**; synthetic tests
  cover their declared metadata math. DPR is emulated, not a claim about physical displays.

Root lint/typecheck/tests/format/build and Firefox extension lint remain required.
No GPU, model, account, permission grant or screenshot service is needed for these tests.

Screenshot comparisons allow one raster pixel at each top-level edge and 1.5 CSS
pixels (converted to image pixels) at each nested-frame edge. Nested frame documents
are rasterized separately, so compositor snapping can accumulate under fractional
ancestor scaling. This is a browser-test tolerance, not rounding performed by the
library or a guarantee for privacy masks. Masks still need detector/alignment margins
as well as outward raster rounding. Pure geometry tests retain floating-point tolerances.
