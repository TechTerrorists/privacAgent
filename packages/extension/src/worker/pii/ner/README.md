# Worker-local NER (D-08)

Runs D-07's exported tiny BERT token-classifier through C-02's ONNX runtime,
entirely on-device: tokenize the raw text with a from-scratch WordPiece
implementation (never a network fetch, never a remote tokenizer), run the
model, decode BIO labels into entity spans, and gate whether any of that may
ever count as real detector coverage.

**The gate matters more than the pipeline.** This model's real, measured
recall is far below the ≥98% target the PRD requires before a detector may
grant coverage or permit unchecked free text. Every finding this module
produces is therefore `synthetic: true`, unconditionally, regardless of how
confident a given prediction looks — see "Quality blocker" below before
changing that.

## Why Transformers.js is not a dependency here

CLAUDE.md names Transformers.js for NER tokenization, but `@huggingface/transformers`
bundles its own `onnxruntime-node`/`onnxruntime-web` copy and pipeline
machinery — installing it pulled in ~30 extra packages (`onnxruntime-node`,
`protobufjs`, ...), which would duplicate C-02's own runtime and blow the
40 MB core model budget, and its `pipeline()` API bypasses C-02 entirely
(exactly the "competing implementation" the issue warns against). This
module instead implements the specific, well-specified algorithm D-07's
tokenizer actually is — WordPiece over a fixed vocab, `BertNormalizer`,
`BertPreTokenizer` — from scratch, and runs the model through C-02's
`OnnxRuntime` directly. `parity.test.ts` (below) is the evidence that this
was the right tradeoff: it is not a hand-wave, it is a byte-for-byte match
against Python's real `BertTokenizerFast` on the real exported vocabulary.

## Files

- `vocab.ts` — parses `vocab.txt` (`parseVocab`) or a pre-split token array
  (`parseVocabTokens`, for a JSON-imported vocab with no `node:fs`).
- `normalize.ts` — `normalizeBert`: mirrors `tokenizer.json`'s
  `BertNormalizer(clean_text=true, handle_chinese_chars=true,
strip_accents=false, lowercase=false)`, tracking every normalized UTF-16
  character back to its original `[start, end)` UTF-16 span.
- `pretokenize.ts` — `preTokenizeBert`: mirrors `BertPreTokenizer` (split on
  whitespace, split punctuation into its own tokens), on the normalized
  string.
- `wordpiece.ts` — `wordpieceTokenize`: greedy longest-match WordPiece
  splitting (`##` continuation prefix, 100-char word limit, same as
  `tokenizer.json`'s `model` block), falling back to `[UNK]` exactly where
  the reference implementation does.
- `tokenizer.ts` — `tokenizeWindows`: orchestrates the three passes above
  into content tokens with original-text UTF-16 spans, then splits into
  overlapping `[CLS] ... [SEP]` windows (`maxWindowTokens - 2` capacity,
  `stride` overlap) for text longer than the model's window.
- `labels.ts` — `decodeBioSpans`: BIO decoding (mirrors D-07's
  `align.py::decode_predictions_to_spans` — a zero-width token closes the
  open span, a mismatched `I-` starts a fresh one rather than merging into
  the wrong entity) and `entityTypeToPiiClass` (`NAME→name`,
  `ADDRESS→address`, `ORG→organization`, `LOCATION→location`, `DOB→dob`;
  anything else → `'other'`, never invented).
- `model.ts` — `runNerWindow`: builds `int64` `input_ids`/`attention_mask`
  tensors, calls C-02's `OnnxRuntime.run`, argmaxes each token's logits.
  Never throws — a runtime failure or unexpected output shape comes back as
  a typed `{ status: 'error', reason }`, so it cannot be mistaken for "ran
  and found nothing".
- `capability.ts` — `RUN3_NER_CAPABILITY` (real measured quality) and
  `meetsCoverageThreshold` (the gate).
- `engine.ts` — `runNerScan`: ties the above together for one piece of text —
  tokenize into windows, run each window, decode, merge overlapping windows'
  spans (reusing D-05's `mergeOverlappingSpans`, which already implements
  "never lose coverage, never mislabel a widened span"), and mark every
  resulting span `synthetic` per the capability gate.

## Consumer example

```ts
import { createLayeredPiiEngine } from '../layered.js';
import { RUN3_NER_CAPABILITY } from './ner/capability.js';

const engine = createLayeredPiiEngine({
  ner: {
    runtime, // a live, initialized `OnnxRuntime` (C-02)
    model: { id: 'privacagent-pii-ner', version: 'run3', bytes: modelBytes },
    vocab, // `parseVocab(vocabTxt)` or `parseVocabTokens(vocabJson)`
    labelToId, // D-07's label_map.json, parsed
    capability: RUN3_NER_CAPABILITY,
  },
});

const result = await engine.scanText({
  evidence: 'dom_text',
  text: 'Contact person@example.com or +14155550100 for help',
  location: { kind: 'text_context_entry', index: 0 },
});
```

`ner` is optional on `createLayeredPiiEngine`'s options and strictly
additive: its spans are unioned into the exact same span-composition L2
already drives (`layered.ts`), so it can only ever mask more text, never
remove or downgrade what L1/L2 already protect. A failed, cancelled, or
absent NER pass behaves identically to no NER at all — `ner-integration.test.ts`
asserts this directly by comparing a failing-NER run against a no-NER run on
the same input.

## Why `value` fields don't get NER's spans directly

`layered.ts` (D-05) only ever mints a real placeholder for a `value` field
when exactly one, unambiguous match covers the _entire_ value — a
`RedactedElement.value` must be a single exact `Placeholder` token
(`protocol.schema.json`), which has no wire representation for "part of this
value was a name." A NER span landing in a value field simply becomes one
more match in that same all-or-nothing decision: if it doesn't yield a sole,
full-span, unambiguous match, the whole value is withheld wholesale, exactly
as it already was before this module existed. `ner-integration.test.ts`
covers this directly. `name`/`text_context` carry no such constraint, so
those fields _do_ get NER's spans substituted in place.

## Normalization and offset units (B-16 is not a module yet)

B-16 doesn't exist as a separate module in this repository, so this package
implements exactly the offset bookkeeping D-08 needs and no more: every
tokenizer stage tracks its output back to the **original UTF-16 string** —
the same unit every other span in this codebase (`TextSpan`,
`FindingLocation.span`) already uses. D-07's Python training pipeline indexes
by Unicode **code point**, which is a real, different unit for any
character outside the Basic Multilingual Plane (most emoji); that
distinction only matters when comparing this module's output against a
Python reference, which is exactly what `parity.test.ts` does — it converts
Python's code-point offsets to UTF-16 before comparing, rather than
asserting raw equality and getting lucky on ASCII-only fixtures. Production
inference never touches a Python offset at all: the browser tokenizes the
live JS string directly, so its offsets are correct UTF-16 units from the
first pass, with no cross-language conversion step to get wrong.

## Window stitching

A text longer than one window gets tokenized into overlapping windows
(`tokenizeWindows`); tokens in the overlap region get predicted twice, once
by each window. `engine.ts` decodes each window's spans independently in
_original-text_ coordinates, then merges every window's spans through the
same `mergeOverlappingSpans` D-05 built for combining detector findings:
overlapping same-class predictions from two windows collapse into one span
covering their union; overlapping predictions that _disagree_ on class
become `ambiguous` (masked as `'other'`, never guessed). Coverage is never
lost this way — the union of two overlapping windows' opinions about a token
is always at least as protective as either one alone.

## Quality blocker (record, do not paper over)

D-07's `run3` export is real end-to-end infrastructure with an honestly bad
model: `packages/models/pii-ner/MODEL_CARD.md` and `train_report.json`
report 30.2% overall test micro recall on the fp32 torch model — nowhere
near the ≥98% target. This session re-measured the model this package
actually loads — `model.quant.onnx`, the _quantized_ export, not fp32 — on
the same held-out test set, using a new `onnx_model_predict_fn` added to
`packages/models/pii-ner/src/privacagent_pii_ner_model/evaluate.py`
(mirroring its existing `torch_model_predict_fn`) run against the real
`test.jsonl`:

```json
{ "precision": 0.0901, "recall": 0.3024, "f1-score": 0.1389, "support": 1035 }
```

(saved at `packages/models/pii-ner/artifacts/run3/quantized_onnx_test_recall.json`)
— quantization did not measurably change the recall here. The D-08 issue
separately states a "corrected" figure of 13.34% for this same artifact; this
reproduction does not confirm that lower number, so both figures are recorded
in `capability.ts`'s `measurementSource` rather than silently picking one.
Either number is far short of 98%, so the conclusion is identical regardless
of which is authoritative: **this model grants no real detector coverage**.
`RUN3_NER_CAPABILITY.measuredMicroRecall` carries the reproduced 0.3024, and
`meetsCoverageThreshold` returns `false` for it — every finding `engine.ts`
produces is `synthetic: true` unconditionally as a result. Raising that
requires a model that actually clears the bar, tracked as D-07's own
unfulfilled quality acceptance item, not a change to this module's gate.

## What is real here and what is not

Real: the tokenizer (byte-for-byte parity with Python's `BertTokenizerFast`
on the actual exported vocabulary, `parity.test.ts`), the BIO decode
algorithm (mirrors D-07's own reference implementation, `labels.test.ts`),
window splitting and stitching (`tokenizer.test.ts`, `engine.test.ts`), the
ONNX execution path including the new `int64` tensor support in
`worker/runtime` (`model.test.ts`, `runtime.test.ts`'s int64 round-trip),
and the measured recall figure (freshly reproduced against the actual
quantized artifact, not copied from an old report). Not yet real: a browser
Playwright test actually loading `model.quant.onnx` inside a live extension
worker — C-02's own `tests/onnx-runtime.spec.ts` already establishes that a
real model executes correctly in that environment for arbitrary graphs
(including `int64` inputs, per this session's addition), so this module
relies on that existing evidence rather than duplicating it; a NER-specific
browser spec is real integration work still open. A-13 (verified model
download/cache) and B-16 (a dedicated normalization/offset-mapping module)
do not exist yet; this module supplies exactly the offset bookkeeping it
needs directly rather than waiting on either, consistent with D-03's
approach to a missing B-03.

## Boundaries

| Concern                                                    | Owner                   |
| ---------------------------------------------------------- | ----------------------- |
| Model/tokenizer/label training and export                  | D-07                    |
| ONNX execution, backend ladder, session cache, tensor type | C-02 (`worker/runtime`) |
| Tokenization, window stitching, BIO decode, coverage gate  | D-08 (this package)     |
| Model download, integrity verification, IndexedDB caching  | A-13 (not built yet)    |
| Restricted egress enforcement when coverage is denied      | D-10                    |
| Final outbound scan, fail-closed enforcement               | D-11 (Egress Guard)     |
| Span-aware substitution this module's findings feed into   | D-05 (`../redact.ts`)   |
