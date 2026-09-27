# PII NER training, export and evaluation (D-07)

Trains a small from-scratch token classifier for English/Hindi PII NER
(name, address, person-linked organization, location, date of birth),
exports it to ONNX, quantizes it, and reports metrics-only evaluation
against a held-out test set. See `MODEL_CARD.md` for full results,
reproduction commands, checksums and the D-08 handoff. See
`../../../bench/datasets/pii-ner/DATASET_CARD.md` for the dataset this
trains on.

## Layout

| File | Purpose |
| --- | --- |
| `tokenizer.py` | Trains a from-scratch WordPiece tokenizer covering both scripts |
| `model.py` | Builds the small `BertForTokenClassification` config |
| `align.py` | Pure functions: char-span ↔ token-label alignment, both directions |
| `dataset.py` | Tokenizes + aligns records into training examples, with long-input windowing |
| `train.py` | CLI: trains, evaluates (baseline + trained, val + test), saves everything |
| `evaluate.py` | seqeval-based per-class/per-lang precision/recall/F1 |
| `export_onnx.py` | ONNX export (opset 17) + dynamic int8 quantization + checksums |
| `parity.py` | Native vs. ONNX prediction/logit comparison on a fixture set |

## Running it yourself

```bash
# 1. Build the dataset (see bench/datasets/pii-ner)
cd bench/datasets/pii-ner
uv run python -m privacagent_pii_ner_dataset.build --out-dir artifacts

# 2. Train
cd ../../../packages/models/pii-ner
uv run python -m privacagent_pii_ner_model.train --dataset-dir ../../../bench/datasets/pii-ner/artifacts --out-dir artifacts/run1

# 3. Export + quantize
uv run python -m privacagent_pii_ner_model.export_onnx --model-dir artifacts/run1/model --out-dir artifacts/run1/export

# 4. Check native/ONNX parity on the committed fixture set
uv run python -m privacagent_pii_ner_model.parity \
  --model-dir artifacts/run1/model \
  --onnx-path artifacts/run1/export/model.onnx \
  --fixtures ../../../bench/datasets/pii-ner/fixtures/sample_records.jsonl
```

Everything under `artifacts/` is git-ignored — nothing this produces is
committed (see `MODEL_CARD.md`'s **Hosting** section).

On a memory-constrained machine, set `OMP_NUM_THREADS=1`,
`OPENBLAS_NUM_THREADS=1` and `MKL_NUM_THREADS=1` before running `train.py`
— multi-threaded BLAS allocations were the only real failure mode
encountered while producing the numbers in `MODEL_CARD.md`, not model size.

## Tests

`pytest packages/models/pii-ner/tests` (also wired into the root
`pnpm test` / `uv run pytest` via `pyproject.toml`'s `testpaths`) runs in
a few seconds, with **no GPU and no download** — it trains a tiny
tokenizer and a tiny randomly-initialized model on a handful of in-memory
sentences purely to exercise the alignment, dataset-windowing and ONNX
export/parity *contracts* (shapes, names, opset, offset correctness). It
does not depend on, and does not reproduce, the real training run reported
in `MODEL_CARD.md` — that run's exact commands are documented there
separately, per this issue's own instruction to keep CI decoupled from full
training/corpus downloads.
