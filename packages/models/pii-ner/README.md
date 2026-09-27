# Local PII NER model (D-07)

Training, original-span evaluation, ONNX export and tokenizer handoff for the
experimental English/Hindi token classifier. See `MODEL_CARD.md` for current
results, limitations and repository-root reproduction commands, and
`../../../bench/datasets/pii-ner/DATASET_CARD.md` for data preparation.

- `artifact_manifest.json`: versioned downloadable bundle URL, size and SHA-256.
- `export_manifest.json`: per-file hashes, shapes, offsets and window contract.
- `reports/`: metrics-only training, quantization, parity and latency results.
- `align.py`: BIO decoding and checked code-point-to-UTF-16 conversion.
- `evaluate.py`: original-document span evaluation after window stitching.

The model is not approved detector coverage. Its low recall must not weaken
restricted egress. D-08 owns worker integration and C-02 owns runtime sessions.
Bulk artifacts remain outside Git; the small manifests and reports are committed.

```bash
uv run --locked pytest bench/datasets/pii-ner/tests packages/models/pii-ner/tests
```

Tests train tiny in-memory models and do not download corpora or require a GPU.

Download the release bundle using its URL (or `gh release download
 d07-ner-pr58-v2 --repo TechTerrorists/privacAgent --pattern pii-ner-d07-v2.zip`
for authenticated repository access). Compare its SHA-256 and size against the
committed `artifact_manifest.json` before extracting it. Then verify the
extracted runtime files against the committed manifest:

```bash
uv run --locked python -m privacagent_pii_ner_model.verify_bundle \
  --directory packages/models/pii-ner/artifacts/downloaded \
  --manifest packages/models/pii-ner/export_manifest.json
```
