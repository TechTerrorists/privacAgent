# PII NER dataset (D-07)

Seeded English/Hindi data for local NER experiments. Version 2 supersedes the
original PR dataset and its leaked-entity evaluation. No corpus records are
committed; the small synthetic fixture set remains available for tests.

## Sources and reproducibility

- English: Faker `en_IN`, version locked in `uv.lock`. Dates are sampled from
  1950-01-01 through 2007-12-31, independent of the wall clock and locale.
- Hindi: reviewed templates and small fixed Devanagari value pools. The pools
  are intentionally limited and do not represent the diversity of real pages.
- WikiAnn: `unimelb-nlp/wikiann`, revision
  `f0a3be6dc5564c0cc4150bb660144800a1f539d4`, English and Hindi, first 400 rows
  of each official train/validation/test split. Source: Pan et al. (2017),
  _Cross-lingual Name Tagging and Linking for 282 Languages_, ACL.
  License: CC BY-SA 3.0, derived from Wikipedia. Preserve source attribution
  and applicable share-alike terms if redistributing corpus derivatives.
  Tags are silver-standard hyperlink annotations, not reviewed PII ground truth.

`dataset_manifest.json` freezes seed, revision, slice size and SHA-256 hashes
of all three prepared JSONL files. JSONL uses UTF-8 and LF on every platform.
Use the locked dependencies and verify the manifest before training:

```bash
# From repository root
uv run --locked python -m privacagent_pii_ner_dataset.build \
  --seed 20260215 --wikiann-per-lang 400 \
  --out-dir bench/datasets/pii-ner/artifacts/frozen \
  --verify-manifest bench/datasets/pii-ner/dataset_manifest.json
```

A mismatch fails the command. Do not silently replace the frozen manifest to
accommodate changed data; create a new dataset version and evaluation instead.
The build also emits metrics-only `stats.json` with language/class support.

## Split policy

Translated English/Hindi templates share one family and split. The seeded
family allocation ensures all five labels appear in every synthetic split.
English values are assigned to disjoint pools by a seeded hash of NFC/casefolded
values; Hindi pools are shuffled and partitioned before filling templates.
The validator rejects cross-split synthetic entity reuse, family reuse and
exact-text duplicates. It checks actual entity substrings, not only sentences.

WikiAnn retains its official splits; arbitrary groups of adjacent rows are no
longer called site families. WikiAnn does not expose source-site family metadata
in this adapter, so this corpus is not proof of site-family generalization.
Synthetic templates are the controlled family-disjoint benchmark. Full-text
duplicates across the combined dataset are removed deterministically.

## Labels and offsets

`NAME`, `ADDRESS`, `ORG`, `LOCATION`, `DOB` map to D-01/E-01 classes through
`labels.py`. BIO tagging uses 11 labels including `O`.

Dataset `Entity.start/end` are half-open **Unicode code-point** offsets into
original Python text, matching Hugging Face tokenizer offsets. They are not
JavaScript offsets. No normalization is applied to stored text or spans.
Validation rejects overlapping/out-of-bounds annotations.

For D-08, decode and stitch original-text spans first, then call the reference
`spans_to_utf16` in the model's `align.py` exactly once at the browser boundary.
It maps code points to UTF-16 code units without stripping combining marks.
Regression tests verify emoji before Hindi entities through actual UTF-16 slicing.
B-16 still owns normalization-to-original index mapping.

## Local handling

External corpus downloads use the Hugging Face cache; prepared records stay in
the chosen local output directory. Neither is uploaded with the model bundle.
Remove the output directory and the relevant WikiAnn cache when finished.
Do not log or commit downloaded personal-record examples.
