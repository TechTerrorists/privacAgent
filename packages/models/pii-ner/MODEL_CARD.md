# PII NER model card (D-07)

A small token classifier trained from scratch to detect person names,
addresses, person-linked organizations, locations and dates of birth in
English and Hindi page text, for the on-device L3 NER layer. **This is a
real, reproducible training run with real numbers below — not scaffolding.**
It falls well short of the project's ≥98% recall target; that shortfall is
reported explicitly rather than hidden, per this issue's own instructions.

## Why a custom small model, not a fine-tuned public checkpoint

The deliverable asks for "a small locally runnable token classifier" and
explicitly caps the total on-device core-model budget at 40 MB, shared
across every model this project loads (perception, OCR, NER, ...). The
smallest widely-used public multilingual BERT checkpoint,
`distilbert-base-multilingual-cased`, is ~135M parameters (~540 MB fp32,
still well over 100 MB after int8 quantization) — alone larger than the
entire shared budget. There is no widely-used "BERT-tiny" checkpoint that
also covers Devanagari script; English-only tiny checkpoints (e.g.
`bert_uncased_L-2_H-128_A-2`) would silently fail on Hindi text (their
tokenizer has no Devanagari vocabulary).

Given that gap, this model is a **compact BERT-style encoder trained from
scratch** on a WordPiece tokenizer also trained from scratch on this
project's own English+Hindi corpus, sized to fit comfortably inside the
budget (see **Export & size** below). This is a documented trade-off, not
an oversight: revisiting fine-tuned transfer learning is a reasonable
follow-up if the shared 40 MB budget is later reallocated to give NER more
room.

## Base model / tokenizer

| | |
| --- | --- |
| Architecture | `BertForTokenClassification` (`transformers==4.57.6`), trained from scratch — no pretrained checkpoint loaded |
| Hidden size / layers / heads | 128 / 2 / 2 |
| Intermediate size | 512 |
| Max position embeddings | 128 |
| Parameters | 1,438,859 |
| Tokenizer | WordPiece, trained from scratch on the training split (`tokenizers==0.22.2`, vocab size 8,000), case-sensitive, accents/combining marks preserved (`strip_accents=False`, `do_lower_case=False` — see **Known tokenizer pitfall** below) |
| License suitability | No pretrained weights are reused, so no upstream license applies to the model weights. `transformers`/`tokenizers`/`torch`/`onnxruntime` are all Apache-2.0/BSD-family, commercial-use-compatible. |

### Known tokenizer pitfall (fixed, regression-tested)

`tokenizers.normalizers.BertNormalizer` and `transformers.BertTokenizerFast`
both silently re-enable lowercasing and Unicode accent/combining-mark
stripping unless `strip_accents=False` is passed to **both** the normalizer
*and* the `BertTokenizerFast` constructor (the latter's `do_lower_case`
default reconstructs the normalizer on `from_pretrained`, discarding a
custom normalizer embedded in a saved `tokenizer.json` otherwise). Before
this was fixed, Devanagari vowel signs (मात्रा, e.g. the े in "मेरा") were
being silently dropped mid-word. `tests/test_tokenizer.py` regression-tests
this exact bug.

## Training

| | |
| --- | --- |
| Seed | 20260215 (dataset generation, split, and `torch.manual_seed`) |
| Epochs | 10 |
| Batch size | 8 |
| Optimizer | AdamW, lr 7e-4 |
| Max sequence length / stride | 64 / 16 (sliding window for longer input — see `packages/models/pii-ner/tests/test_dataset.py`) |
| Hardware | CPU only (no GPU used or required) |
| Environment | Python 3.12.13, `torch==2.14.0+cpu`, `transformers==4.57.6`, Windows |
| Wall-clock training time | 78.1 seconds |
| Training loss by epoch | 1.086 → 0.501 → 0.210 → 0.118 → 0.079 → 0.063 → 0.061 → 0.044 → 0.049 → 0.037 |

Reproduce with:

```bash
cd bench/datasets/pii-ner
uv run python -m privacagent_pii_ner_dataset.build --seed 20260215 --wikiann-per-lang 900 --out-dir artifacts

cd ../../../packages/models/pii-ner
uv run python -m privacagent_pii_ner_model.train \
  --dataset-dir ../../../bench/datasets/pii-ner/artifacts \
  --out-dir artifacts/run3 --epochs 10 --batch-size 8 --vocab-size 8000 --learning-rate 0.0007
```

Full report (including val metrics, both language breakdowns, and the
baseline comparison in full) is written to
`artifacts/run3/train_report.json` by this command — not committed (see
**Hosting**).

## Dataset

907 → 2,081 train / 373 val / 536 test records after the corpus was widened
(see `bench/datasets/pii-ner/DATASET_CARD.md` for full provenance, license,
and leakage-prevention details). Val is used only for the metrics reported
below as a secondary check — no confidence-threshold tuning was performed
beyond standard argmax decoding, and **the test split was never used for any
tuning decision**, only for the final numbers in this card.

## Results (held-out test set, never used for tuning)

**Baseline** (always predicts `O` — no entity, the trivial "no signal"
comparator): 0.000 precision/recall/F1 on every class, by construction.

**Trained model — overall (micro/macro), by class:**

| Class | Precision | Recall | F1 | Support |
| --- | ---: | ---: | ---: | ---: |
| NAME | 0.227 | 0.476 | 0.307 | 397 |
| ADDRESS | 0.004 | 0.014 | 0.006 | 219 |
| ORG | 0.046 | 0.317 | 0.080 | 142 |
| LOCATION | 0.049 | 0.229 | 0.081 | 166 |
| DOB | 0.247 | 0.342 | 0.287 | 111 |
| **micro avg** | **0.090** | **0.302** | **0.139** | 1035 |
| macro avg | 0.115 | 0.276 | 0.152 | 1035 |

**By language:**

| Lang | Class | Precision | Recall | F1 | Support |
| --- | --- | ---: | ---: | ---: | ---: |
| en | NAME | 0.155 | 0.319 | 0.209 | 251 |
| en | ADDRESS | 0.000 | 0.000 | 0.000 | 160 |
| en | ORG | 0.005 | 0.056 | 0.009 | 72 |
| en | LOCATION | 0.029 | 0.152 | 0.049 | 112 |
| en | DOB | 0.089 | 0.138 | 0.108 | 80 |
| **en micro avg** | | **0.043** | **0.166** | **0.068** | 675 |
| hi | NAME | 0.343 | 0.747 | 0.470 | 146 |
| hi | ADDRESS | 0.018 | 0.051 | 0.027 | 59 |
| hi | ORG | 0.244 | 0.586 | 0.345 | 70 |
| hi | LOCATION | 0.111 | 0.389 | 0.173 | 54 |
| hi | DOB | 0.871 | 0.871 | 0.871 | 31 |
| **hi micro avg** | | **0.231** | **0.558** | **0.327** | 360 |

Val overall micro (secondary check, not used to pick these numbers):
precision 0.148, recall 0.369, F1 0.212, support 566.

### Target shortfall — reported honestly

**This model does not meet the project's ≥98% recall target, on any class,
in either language.** Overall test recall is 30.2%, roughly 3x the 0%
baseline but far short of the goal. Root cause, diagnosed directly from the
numbers above, not guessed:

- **Training loss reaches near-zero (0.037) while test recall stays at
  30%** — the classic signature of memorizing a small, from-scratch
  vocabulary/encoder rather than learning generalizable patterns. This is
  the direct cost of the from-scratch design decision above: a fine-tuned
  pretrained encoder would bring in far more general language knowledge
  than 2,081 training sentences can teach from a cold start.
- **English underperforms Hindi substantially** (16.6% vs 55.8% test
  recall) even though English has more support. English entity values come
  from Faker (thousands of distinct names/addresses/companies), while
  Hindi's curated value pools (`hi_values.py`) are deliberately small (8–12
  values per slot) — the model has an easier time recognizing a value it
  has literally seen before. This gap would very likely narrow with a
  larger, more diverse Hindi value pool or (better) real Hindi corpus data
  beyond the WikiAnn slice.
- **ADDRESS recall (1.4%) is the weakest class by far** — multi-word spans
  with the most surface-form diversity (house numbers, street names, PIN
  codes) and the least support relative to their span length. This is the
  class most likely to need either more training data or a
  pattern-assist from D-02's `worker/pii/l2` address-adjacent signals
  (D-02 does not currently detect addresses, so this is a real gap, not a
  redundancy).

**This model must not be advertised as complete PII detector coverage.**
D-08's integration must treat NER as one contributing signal among D-01's
detector layers, not a sufficient one on its own — consistent with how
D-02's L2 layer is already documented (a miss from one layer is not
evidence of safety).

## Export & size

| | FP32 ONNX | Quantized ONNX (dynamic, int8 weights) |
| --- | ---: | ---: |
| Size | 5,803,637 bytes (5.53 MiB) | 1,535,301 bytes (1.46 MiB) |
| SHA-256 | `d65863b6f669a8410a100e9e3fa7b0f66f4ce48a997b3c5512ee86d60803d166` | `3e4e6f527cf6a140814dc2875f1a870cfa29de471d3fe4a4f1936efca29a1df4` |

- Opset: 17. Inputs: `input_ids`, `attention_mask` (both `int64[batch,
  sequence]`, dynamic on both axes). Output: `logits`
  (`float32[batch, sequence, 11]`, 11 = `len(LABEL_LIST)`).
- **1.46 MiB quantized** is a small fraction of the shared 40 MB core-model
  budget — this model does not need to (and should not) consume the whole
  budget; the remaining ~38.5 MB stays available for perception/OCR/other
  models per this issue's explicit instruction.
- Reproduce: `uv run python -m privacagent_pii_ner_model.export_onnx --model-dir artifacts/run3/model --out-dir artifacts/run3/export`.

### Native vs. ONNX parity (measured on the 30-record committed fixture set)

| Comparison | Max abs. logit diff | Label agreement |
| --- | ---: | ---: |
| PyTorch (native) vs. FP32 ONNX | 4.29e-06 | 100.0% (643/643 tokens) |
| PyTorch (native) vs. quantized ONNX | 0.250 | 100.0% (643/643 tokens) |

Quantization introduces measurable numeric drift (0.25 max logit diff) but
**zero observed prediction (argmax) disagreement** on this fixture set —
the accuracy loss from int8 quantization is real but did not change any
predicted label here. Reproduce:
`uv run python -m privacagent_pii_ner_model.parity --model-dir artifacts/run3/model --onnx-path artifacts/run3/export/model.quant.onnx --fixtures ../../../bench/datasets/pii-ner/fixtures/sample_records.jsonl`.

### Measured CPU latency (quantized ONNX, `onnxruntime` `CPUExecutionProvider`)

Single sequence, 64 tokens, 50 runs after 5 warmup runs, this development
machine (not a guaranteed SLA):

| | |
| --- | --- |
| Mean | 0.486 ms |
| Median | 0.487 ms |
| p95 | 0.540 ms |

## Long-input windowing and truncation

Sequences longer than `max_length` (64 tokens) are split into overlapping
windows (`stride=16`) via the tokenizer's native `return_overflowing_tokens`
support (`dataset.py`'s `encode_record`) — offsets in every window remain
relative to the **original** text, never reset to zero for window 2+.
`tests/test_dataset.py::test_long_text_windows_preserve_original_text_offsets`
verifies this directly on a synthetic long input, including that an entity
spanning a window boundary is still recoverable from at least one window.
This repository does not implement duplicate-prediction merging across
overlapping windows for live inference — D-08 needs a policy for that
before enabling multi-window inference in production (documented as a gap,
not silently resolved).

## D-08 handoff

- **Artifacts**: `packages/models/pii-ner/artifacts/run3/export/model.onnx`
  (fp32) and `model.quant.onnx` (quantized) — see checksums above. **Not
  committed to Git** (see **Hosting**).
- **Tokenizer**: `packages/models/pii-ner/artifacts/run3/export/tokenizer/`
  (a standard `BertTokenizerFast` save — `tokenizer.json`,
  `tokenizer_config.json`, `vocab.txt`, `special_tokens_map.json`).
- **Label map**: `LABEL_LIST/LABEL_TO_ID/ID_TO_LABEL` in
  `bench/datasets/pii-ner/src/privacagent_pii_ner_dataset/labels.py`
  (BIO scheme, 11 labels) plus `ENTITY_TO_PII_CLASS` for the D-01/E-01
  `PiiClass` mapping — import this module rather than hand-copying the map.
- **Decoding contract**: `packages/models/pii-ner/src/privacagent_pii_ner_model/align.py`'s
  `decode_predictions_to_spans(offsets, predicted_label_ids, id_to_label)` —
  pure, dependency-free, directly portable to the worker's TS runtime as a
  reference for the equivalent JS decoder C-02/D-08 will need.
- **Thresholds**: none beyond standard argmax — no confidence cutoff is
  applied in this model's own inference path. If D-08 wants to add a
  minimum-confidence gate (e.g. to trade recall for precision, or vice
  versa), tune it against the **val** split's logits, never test.
- **Windowing contract**: `max_length=64`, `stride=16`; see **Long-input
  windowing** above for what is and is not handled today.
- **Examples**: the committed
  `bench/datasets/pii-ner/fixtures/sample_records.jsonl` (30 synthetic
  English/Hindi records with gold spans) is the shared fixture set this
  card's parity numbers were measured against — reuse it for any C-02/D-08
  runtime contract test rather than inventing a new one.
- **Limitations**: see **Target shortfall** above in full; the short
  version is recall is far below target, English underperforms Hindi, and
  ADDRESS is the weakest class — do not treat a clean NER pass as proof a
  page has no PII.
- **No cloud NER fallback.** Every number in this card comes from local
  CPU inference; nothing here calls out to a network service, and D-08's
  integration must not add one.

## Hosting

Per this issue's instruction, trained weights and ONNX exports are **not
committed to Git** — only code, the dataset/model cards, small fixtures,
and hash manifests are. `artifacts/` (both packages) is git-ignored. The
binaries above (`model.onnx`, `model.quant.onnx`, `tokenizer/`) currently
exist only on the machine this training run was executed on; publishing
them to durable, appropriately-hashed hosting (e.g. a Hugging Face Hub
model repo under the project's org, or a GitHub Release asset on this PR)
requires org credentials this environment does not have, and is the
concrete next step before D-08 can depend on a URL rather than a local
path. The checksums in this card are what any future upload must match.
