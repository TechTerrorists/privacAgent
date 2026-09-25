# Worker inference API (C-01)

The interface the on-device vision models are called through, plus a
deterministic fake so other lanes can integrate before any model exists.

**Feature-list acceptance:** `runDetector`, `runOCR`, `runFaces`, `runIcons`
interface with fake outputs other lanes can call.

This feature ships **no machine learning**. Real ONNX execution and backend
selection are C-02; the trained detector, OCR, face and icon models arrive in
C-05 through C-09.

## Using it

```ts
import { getInferenceApi, countsAsDetectorCoverage } from '../worker/inference/index.js';

const api = getInferenceApi();
const result = await api.runOCR({ width: 512, height: 512, frame: 'crop' });

if (result.status === 'ok') {
  for (const line of result.items) console.debug(line.words.length);
}

// Ask this before treating anything as safe to transmit.
const scanned = countsAsDetectorCoverage(result);
```

`perceiveRegion` in `example.ts` is a minimal end-to-end consumer.

## The three-way result

Every operation returns one of three statuses. The distinction between the last
two is the point of this module:

| Status        | Meaning                                          | Counts as coverage?   |
| ------------- | ------------------------------------------------ | --------------------- |
| `ok`          | Ran, found ≥ 1 item. `items` is never empty.     | Yes, if not synthetic |
| `empty`       | Ran to completion, found nothing.                | Yes, if not synthetic |
| `unavailable` | **Could not run.** The input was never examined. | Never                 |

`empty` and `unavailable` are separate types rather than an empty array,
because they have opposite consequences. D-10 enters restricted egress mode
when a detector is unavailable, and the Egress Guard rejects any field lacking
a record that a detector scanned it (PRD §10.2). If both arrived as an empty
list, restricted egress would silently never fire — and every test would still
pass.

Use `countsAsDetectorCoverage`, `requiresRestrictedEgress` and
`unavailableReason` from `coverage.ts` rather than matching on `status` by
hand, so the rule stays in one place.

## Synthetic results never establish coverage

Every fake result carries `synthetic: true`, and `countsAsDetectorCoverage`
returns `false` for all of them — including ordinary-looking ones. A
development build therefore cannot assemble a payload that appears fully
scanned. Fake OCR also emits a fixed vocabulary (`SYNTHETIC`, `FAKE`, `SAMPLE`,
`PLACEHOLDER`) that no real page would produce, so fixture noise is never
mistaken for a genuine PII detection during integration.

## Geometry and ranges

- Boxes are E-01 `BBox` tuples, `[x, y, w, h]`, so anything that later becomes
  part of a Screen State needs no reshaping.
- Boxes are returned in the **frame of the input**: `image` (device px, origin
  at the top-left of the screenshot) or `crop`. Never page or viewport
  coordinates — converting to the page frame is A-08's job, applied by C-06.
- A `region` restricts inference to a sub-area; returned boxes stay in the
  image's frame, and are guaranteed to sit inside that region. Regions may be
  **fractional** — `getBoundingClientRect` returns fractional CSS px and the
  image frame scales those by DPR — and boxes hold inside them regardless.
  Coordinates are emitted at 2dp.
- **A line box is the hull of its words.** Every word box sits inside the box
  of the line that owns it, which D-12 alignment and C-13 line-crop
  classification both rely on.
- Confidence is `0..1` inclusive. Downstream thresholds already depend on this:
  C-11 escalates below 0.6, the §6.8 crop allowlist needs icons ≥ 0.8, and OCR
  regions below 0.7 mean character confidence are masked.
- `meanCharConfidence` is the mean over a line's **characters**, not over its
  per-word means, so a long word weighs more than a short one. The §6.8 masking
  rule keys on this value, and a mis-weighted mean lands lines on the wrong
  side of the 0.7 threshold.
- OCR returns per-word boxes and per-character confidences from the outset,
  because C-13 (script identification) and D-12 (span-to-pixel alignment)
  consume them.

## OCR output is privacy evidence

`runOCR` results must be scanned for PII independently and **must not** be
merged into interaction-map element names. PRD §6.1 keeps DOM text, DOM
attribute values and OCR text as separate evidence for exactly this reason: an
image button whose DOM label reads "Profile" may render a person's name in
pixels, and folding the two together destroys the evidence redaction needs.

## Determinism

The same input yields byte-identical output on every run, every machine and
both build targets. Everything derives from an FNV-1a hash of the input's
_identity_ — operation, frame, dimensions, region — feeding an xorshift32 PRNG.
Confidences are computed as integers and divided by a fixed denominator rather
than accumulated in floating point, so values stay exactly representable.

Nothing in the derivation path may use `Math.random`, `Date.now`,
`crypto.getRandomValues`, or iteration over a collection with unfixed order.
The test suite enforces this by calling each operation twice and asserting
byte-equality, and by checking that two engine instances agree.

The fake never reads pixels. `InferenceImage.bitmap` is ignored and never
retained — which is exactly why the whole surface runs under Node in Vitest,
where `ImageBitmap` does not exist.

> **Fixture output is a stable contract, not an implementation detail.** Other
> lanes assert against it, and a golden snapshot is committed. Changing the
> derivation function breaks those suites, so treat it as an API change.

## Fixtures

Derivation always produces `ok`, so the other two outcomes are selected
explicitly rather than by finding an input that happens to hash into them:

```ts
await api.runOCR(image, { fixture: 'empty' }); // ran, found nothing
await api.runOCR(image, { fixture: 'unavailable' }); // could not run
```

`fixtures.ts` also exports canonical input sizes matching PRD §5.1 —
`FIXTURE_VIEWPORT` (640×640), `FIXTURE_CROP` (512×512), `FIXTURE_FACE_TILE`
(128×128) and `FIXTURE_ICON` (64×64).

Real engines ignore `fixture`.

## How C-02 replaces the fake

The active engine lives behind a registry, so no caller changes:

```ts
import { setInferenceApi } from './index.js';

setInferenceApi(createOnnxInferenceApi(session)); // C-02, after backend selection
```

`getInferenceApi()` returns the fake until that call happens. Tests that swap
the engine must call `resetInferenceApi()` afterwards, since the registry is
module-level state.

A real engine must keep the same guarantees: no network client, no raw-image
persistence, no payload logging, and `synthetic: false` only when it genuinely
examined pixels.

## Boundaries

| Concern                                        | Owner                  |
| ---------------------------------------------- | ---------------------- |
| ONNX runtime, backend selection, session cache | C-02                   |
| Trained detector / OCR / face / icon models    | C-05, C-07, C-08, C-09 |
| Image → page coordinate conversion             | A-08, applied by C-06  |
| Cross-context transport                        | A-03                   |
| Worker hosting and lifecycle                   | A-04                   |

Inference must never run on the page main thread.
