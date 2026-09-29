# DOM/OCR span-to-pixel alignment (D-12)

Maps a character span inside a piece of recorded privacy evidence — a DOM
element's text, or an OCR line — back to the actual on-screen pixels it came
from, so D-13 can paint an opaque mask over exactly (or, when uncertain,
conservatively more than) the sensitive glyphs. **Every path that cannot
positively confirm alignment returns a whole-line/whole-block fallback or a
withhold recommendation — never a narrower guessed rectangle.** That rule is
the actual acceptance bar this module is graded against, not a nicety.

## Files

- `types.ts` — the shared contract: `EvidenceSpan` (source text snapshot +
  char span + doc/observation identity, so staleness is checkable),
  `AlignedRegion`/`AlignmentResult` (bounded regions plus
  `AlignmentProvenance`: `'exact_span' | 'whole_line' | 'whole_block'`, and
  every rejection reason both evidence sources can produce).
- `graphemes.ts` — `expandToGraphemeBoundaries`: widens a span outward
  (never narrows) to the nearest `Intl.Segmenter` grapheme-cluster boundary,
  so a span that cuts into a Devanagari matra/conjunct, an emoji ZWJ
  sequence, or a surrogate pair never produces a Range that splits a glyph.
- `ocr.ts` — `recoverWordOffsets`/`alignOcrSpan`/`alignOcrSpanToRegions`:
  maps a span to C-01's `OcrWord` boxes. `OcrCharacter` carries no box of its
  own (only per-character confidence), so a partial-character match inside a
  word can only ever be represented as that word's _whole_ box — there is no
  narrower geometry to fall back to, which is exactly what "a partial-word
  match masks the whole affected word" means in practice. Word offsets
  within `line.text` are recovered by sequential substring search, in order;
  any word that can't be found where expected, a mean confidence below 0.7
  (§6.8), an out-of-range span, or a span with no overlapping word all fall
  back to the line's own bbox — the module never invents a location for
  evidence it can't place.
- `dom-range.ts` — `alignDomSpan`: walks an element's text nodes (crossing
  into open shadow roots, since shadow DOM is not a separate coordinate
  space — only actual `<iframe>` boundaries are), locates the span,
  grapheme-expands it, builds a `Range`, and calls `getClientRects()`
  (handles multiline wrapping natively — one rect per visual line). Every
  rect is converted to **page space** via A-08's geometry: same-document
  rects go through `capture.pageToViewport`; cross-frame rects go through
  `frameToPage` with a caller-supplied `FrameLink[]` chain.

## The staleness check that actually matters

Before touching layout at all, `alignDomSpan` reconstructs the element's
full text from its text nodes and compares it **exactly** against
`evidence.sourceText`. Any difference — the element was mutated, its
children were replaced, a different generation is live — rejects with
`text_mismatch` rather than computing a `Range` against text that no longer
matches what was recorded. This one check is what "reject ... layout changes
between capture and alignment rather than trusting obsolete rectangles"
resolves to concretely: no timestamp comparison, no generation heuristic,
just "does the text still say what we think it says."

## Consumer example

```ts
import { alignDomSpan } from './content/align/dom-range.js';

const result = alignDomSpan(
  element, // a live Element, e.g. resolved via B-05's ElementRegistry
  { docId, observationId, elementId, sourceText: element.textContent!, span: { start, end } },
  { topDocument: document, capture, fallback: 'whole_block' }
);

if (result.status === 'ok' || result.status === 'fallback') {
  for (const region of result.regions) {
    // region.rect is Rect<'page'>; D-13 rasterizes it into an opaque mask.
  }
} else {
  // result.status === 'withhold' — do not mask at a guessed location; escalate or drop the frame.
}
```

```ts
import { alignOcrSpanToRegions } from './content/align/ocr.js';

const result = alignOcrSpanToRegions(ocrLine, { start, end }, imageSpace);
```

## What is real here and what depends on a prerequisite that doesn't exist yet

Real: grapheme-boundary widening (`graphemes.test.ts`, exercises real
Unicode combining marks and astral emoji), OCR word-offset recovery and
fallback behavior (`ocr.test.ts`, covers mismatched text, partial words, low
confidence, out-of-range spans, no-overlap), and DOM range construction,
staleness rejection, and shadow-DOM text walking (`dom-range.test.ts`,
happy-dom). **Real multiline wrapping, real shadow-DOM layout, real
staleness rejection against a live mutation, and real scroll-consistent
page-space output are verified in an actual Chromium browser**
(`tests/align.spec.ts`) — happy-dom implements `Range`/`TreeWalker`
reasonably but not layout, so `getClientRects()` there is meaningless; only
a real browser can prove the geometry is right.

Not built, and explicitly out of this module's scope:

- **B-16** (normalization/tokenizer offset mapping) doesn't exist as a
  module. This package needs no cross-normalization mapping of its own: DOM
  alignment operates directly on live `Text` node data (never normalized),
  and OCR alignment operates directly on C-07's own returned `line.text`. If
  a caller's `EvidenceSpan.span` was computed against some _other_
  normalized representation (e.g. after D-08's tokenizer normalization),
  converting that span back to this module's expected raw-text coordinates
  is the caller's job — exactly the boundary D-08's own README documents on
  its side.
- **C-07** (the real OCR model) doesn't exist yet — only C-01's `OcrLine`
  contract does. `ocr.ts` is written and tested against that contract
  directly with synthetic fixtures; it will work unchanged once C-07 ships
  real OCR, the same relationship D-02/D-03/D-08 have to their own
  not-yet-built upstream models.
- **A-09** (frame measurement) doesn't exist. `alignDomSpan` accepts an
  optional, already-measured `FrameLink[]` and correctly rejects with
  `frame_measurement_missing` when a cross-frame element needs one and none
  is supplied — proven in both `dom-range.test.ts` and, for the geometry math
  itself, by A-08's own `frameToPage`. Producing that chain from a live
  frame tree is A-09's job.
- **B-01/B-02** (DOM text extraction) don't exist yet, so there is no
  production caller that actually constructs an `EvidenceSpan` from a real
  element today. `sourceText` is documented here as "this element's
  flattened text-node content" — whatever produces spans for this module to
  align must record evidence text the same way, or every alignment will
  correctly (safely) reject as stale.

## Boundaries

| Concern                                                      | Owner                      |
| ------------------------------------------------------------ | -------------------------- |
| Coordinate transforms (viewport/page/image/crop/frame)       | A-08 (`geometry/`)         |
| Frame measurement (border box, scroll, linear transform)     | A-09 (not built yet)       |
| Element identity/staleness (doc/frame/shadow scope)          | B-05 (`element-registry/`) |
| DOM text extraction / accessible name & value computation    | B-01/B-02 (not built yet)  |
| Normalized/tokenizer offset mapping                          | B-16 (not built yet)       |
| OCR recognition (real word/character boxes)                  | C-07 (not built yet)       |
| This module: span→region mapping, conservative fallback      | D-12 (this package)        |
| Opaque-fill rasterization of the regions this module returns | D-13                       |
| Coverage verification of masked regions                      | D-11, D-14                 |
