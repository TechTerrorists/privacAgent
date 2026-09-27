# PII NER model card (D-07, corrected evaluation)

This experimental local model does **not** meet the ≥98% recall target and must
not count as complete detector coverage. Restricted egress remains required.
The prior PR metrics and hashes are superseded: their data leaked synthetic
entities across splits and their evaluator counted overlapping windows separately.

## Model and training

Compact BERT token classifier, trained from scratch (not a pretrained fine-tune):
2 layers, hidden size 128, 2 heads, intermediate size 512, 128 positions,
8,000-token WordPiece vocabulary, 1,438,859 parameters. Case and combining marks
are preserved. This keeps the bundle small but does not supply pretrained
multilingual knowledge. Fine-tuning a suitable pretrained model remains a D-07
requirement gap; this release is an integration artifact, not production approval.

The corrected run uses seed 20260215, 10 epochs, batch 8, AdamW learning rate
0.0007, max length 64, stride 16, CPU only with one BLAS/OpenMP thread.
No test-score-based threshold or checkpoint selection was performed.
The baseline predicts `O` for every token. Exact environment, epoch losses,
record counts and validation/test metrics are committed in `reports/train_report.json`.

Training took 42.51 seconds; 1585 train, 841 validation and 938 test records.

## Evaluation contract and results

Token predictions in overlapping windows are stitched by original offsets:
choose the occurrence with most context on each side; ties keep the earlier
window. BIO decoding runs once on the stitched tokens. Each gold original-text
span is counted once. A true positive requires identical start, end and label;
partial coverage is a false positive and false negative. Macro averages include
all five classes, including classes with zero support. Zero denominators score zero.
Python spans use code points; `spans_to_utf16` converts final original-text spans
for the browser. Do not use code-point indices as DOM/JavaScript indices.

| Language | Class     | Precision | Recall |     F1 | Support |
| -------- | --------- | --------: | -----: | -----: | ------: |
| all      | NAME      |    0.0483 | 0.1467 | 0.0726 |     593 |
| all      | ADDRESS   |    0.0341 | 0.1196 | 0.0530 |      92 |
| all      | ORG       |    0.0273 | 0.1144 | 0.0441 |     367 |
| all      | LOCATION  |    0.0480 | 0.1511 | 0.0728 |     364 |
| all      | DOB       |    0.0000 | 0.0000 | 0.0000 |      46 |
| all      | micro avg |    0.0399 | 0.1334 | 0.0615 |    1462 |
| en       | NAME      |    0.0382 | 0.1031 | 0.0558 |     417 |
| en       | ADDRESS   |    0.0362 | 0.1375 | 0.0573 |      80 |
| en       | ORG       |    0.0169 | 0.0756 | 0.0277 |     238 |
| en       | LOCATION  |    0.0335 | 0.1250 | 0.0528 |     208 |
| en       | DOB       |    0.0000 | 0.0000 | 0.0000 |      40 |
| en       | micro avg |    0.0293 | 0.0997 | 0.0453 |     983 |
| hi       | NAME      |    0.0649 | 0.2500 | 0.1030 |     176 |
| hi       | ADDRESS   |    0.0000 | 0.0000 | 0.0000 |      12 |
| hi       | ORG       |    0.0505 | 0.1860 | 0.0795 |     129 |
| hi       | LOCATION  |    0.0782 | 0.1859 | 0.1101 |     156 |
| hi       | DOB       |    0.0000 | 0.0000 | 0.0000 |       6 |
| hi       | micro avg |    0.0628 | 0.2025 | 0.0959 |     479 |

Quantized held-out recall: 0.1354 (native 0.1334);
F1: 0.0625 (native 0.0615). Full class/language metrics
are in `reports/quantized_test_metrics.json`. Scores describe this limited corpus;
WikiAnn does not provide source-site family metadata, and the Hindi synthetic
pools remain small. Short/long names, diverse addresses and unseen contextual
entities remain false-negative risks; a clean prediction cannot authorize egress.

## Export and handoff

ONNX opset 17; inputs `input_ids`, `attention_mask` int64 `[batch, sequence]`;
output `logits` float32 `[batch, sequence, 11]`. Supported workflow: batch 1,
64 tokens/window, stride 16. Position limit is 128; dynamic axes do not remove it.
Dynamic QUInt8 weight quantization is optional; FP32 is the parity reference.
The bundle includes both ONNX files, tokenizer files, label map, export manifest,
frozen dataset manifest and metrics-only reports. Every runtime file has size
and SHA-256 in `export_manifest.json`; the bundle is pinned in `artifact_manifest.json`.
No training/test text or native corpus records are included.

FP32 parity on the 30 synthetic fixtures: 100% labels and UTF-16 spans.
Quantized parity: 99.6923% labels and 93.3333% per-record UTF-16 span agreement;
quantization changes predictions, so it is not an exact substitute. See the
committed parity reports. CI also covers long windows and emoji offsets.

Quantized CPU inference, 100 measured iterations after 10 warmups, one thread,
batch 1 / 64 tokens: p50 0.291 ms, p95 0.296 ms.
This excludes tokenization, downloads and browser overhead. No browser inference
latency or production recall claim is made. D-08 owns runtime integration.

The versioned GitHub prerelease `d07-ner-pr58-v2` provides the bundle.
Use its pinned URL and hash in `artifact_manifest.json`, verify the archive,
then verify each exported file before loading. Do not substitute another model
under these hashes. No cloud NER fallback is permitted.

## Reproduction

Run from repository root, after verifying the frozen dataset as described in
`bench/datasets/pii-ner/DATASET_CARD.md`:

```bash
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 \
uv run --locked python -m privacagent_pii_ner_model.train \
  --dataset-dir bench/datasets/pii-ner/artifacts/frozen \
  --out-dir packages/models/pii-ner/artifacts/run \
  --epochs 10 --batch-size 8 --vocab-size 8000 --learning-rate 0.0007
uv run --locked python -m privacagent_pii_ner_model.export_onnx \
  --model-dir packages/models/pii-ner/artifacts/run/model \
  --out-dir packages/models/pii-ner/artifacts/run/export
uv run --locked python -m privacagent_pii_ner_model.parity \
  --model-dir packages/models/pii-ner/artifacts/run/model \
  --onnx-path packages/models/pii-ner/artifacts/run/export/model.onnx \
  --fixtures bench/datasets/pii-ner/fixtures/sample_records.jsonl
```

Dataset bytes are pinned and verified; training/ONNX bytes may vary across
platforms or kernels. Retrieve the published bundle for the exact evaluated
artifacts rather than assuming retraining reproduces binary hashes.
