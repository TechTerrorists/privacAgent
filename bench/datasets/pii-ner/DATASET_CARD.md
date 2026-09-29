# PII NER dataset (D-07)

Reproducible English/Hindi dataset for the on-device PII NER detector (L3),
built from two sources combined at a fixed seed.

## Composition

| Source | Records | Provenance | License | Redistribution |
| --- | --- | --- | --- | --- |
| Synthetic (English) | ~280 | Faker `en_IN` locale filled into 18 hand-written positive templates + 10 negative templates | N/A (generated, no real personal data) | Freely redistributable — code + committed small fixture sample only |
| Synthetic (Hindi) | ~226 | 18 hand-reviewed Hindi templates + a curated, hand-written pool of fictitious Devanagari names/addresses/organizations/locations/dates (`hi_values.py`) filled in by a seeded RNG + 10 negative templates | N/A (generated, no real personal data) | Freely redistributable — code + committed small fixture sample only |
| WikiAnn (`en`, `hi` configs) | up to 400/lang (configurable via `--wikiann-per-lang`) | `unimelb-nlp/wikiann` on the Hugging Face Hub — silver-standard NER tags automatically derived from Wikipedia hyperlinks (Pan et al. 2017, "Cross-lingual Name Tagging and Linking for 282 Languages", ACL) | CC BY-SA 3.0 | Permitted with attribution; **not committed to this repository** — downloaded on demand via `datasets.load_dataset`, pinned by dataset id + config + slice size in `corpus.py` |

Every synthetic value (names, addresses, organizations, phone-free-text dates)
is fabricated. No real personal records are generated or committed.
WikiAnn's own license permits redistribution, but this repository still does
not commit it — corpus records are downloaded fresh at build/train time and
never persisted to Git, per the project's rule against committing bulk
external data.

**WikiAnn is a silver-standard corpus**: its NER tags come from an automatic
Wikipedia-hyperlink heuristic, not human annotation, and are measurably
noisier than the hand-reviewed synthetic templates (e.g. some geographic
features get tagged `ORG` instead of `LOC` upstream). This is a real,
documented limitation of that slice of the training data, not a bug in the
conversion code in `corpus.py` (verified directly against the raw
`unimelb-nlp/wikiann` tag sequence).

## Label taxonomy — mapping to D-01/E-01

| NER entity | E-01 `PiiClass` |
| --- | --- |
| `NAME` | `name` |
| `ADDRESS` | `address` |
| `ORG` | `organization` |
| `LOCATION` | `location` |
| `DOB` | `dob` |

No new taxonomy is invented — every entity type maps onto an existing E-01
`PiiClass` value (`labels.py`). Token tags use standard BIO
(`O`, `B-<TYPE>`, `I-<TYPE>`), 11 labels total (`build_label_list`).

## Span and offset semantics

- Every `Entity.start`/`Entity.end` is a **UTF-16 code-unit offset into the
  original record `text`**, end-exclusive — the same convention as D-01's
  `TextSpan`. `test_schema.py` asserts this holds across a non-BMP emoji
  (surrogate pair) and Devanagari combining vowel signs (मात्रा) placed
  immediately before an entity, with no separating space in either case.
- `Record.__post_init__` (`schema.py`) rejects any entity whose span exceeds
  the text length or overlaps another entity in the same record — this is
  enforced at construction, not just checked later by a validator that could
  be skipped.
- Tokenizer subword alignment (mapping these character spans onto a model's
  wordpiece/BPE token boundaries, including truncation and long-input
  windowing) is `packages/models/pii-ner`'s concern
  (`tokenize_align.py`), not this package's — this package only guarantees
  the character-level spans are correct and internally consistent.

## Splits and leakage prevention

`splits.py` groups every record into a **family** before splitting:

- Each synthetic template (positive or negative) is its own family — so the
  same template filled with different names never appears in more than one
  split.
- Each WikiAnn language slice is chunked into families of 25 consecutive
  records (`corpus.py`'s `family_chunk_size`) — large enough to avoid
  creating hundreds of one-record families, small enough that no single
  family dominates a split disproportionately.

Splitting shuffles **families**, not individual records, into train
(70%)/val (15%)/test (15%) by family count, then exact-text deduplication
runs first (`deduplicate`) so a duplicate string can never land in two
splits. `assert_no_leakage` checks both family-id and exact-text overlap
across all three splits and raises if either occurs; `test_splits.py` runs
this on a real generated dataset, not a hand-constructed one.

The test split is not truly "frozen" as a checked-in file (WikiAnn isn't
committed), but it **is** deterministic: the same `--seed` always regenerates
byte-identical splits, which is the reproducibility property that matters
here — see `MODEL_CARD.md` for the exact seed used for the reported numbers.

## Reproducing the dataset

```bash
cd bench/datasets/pii-ner
uv run python -m privacagent_pii_ner_dataset.build --seed 20260215 --wikiann-per-lang 400 --out-dir artifacts
```

Writes `artifacts/{train,val,test}.jsonl` and `artifacts/stats.json` (support
counts by split/lang/label — see that file for exact figures on a given
run). `artifacts/` is git-ignored; nothing this command produces is
committed. The committed `fixtures/sample_records.jsonl` (30 synthetic-only
records, no WikiAnn) is a small, stable sample for tests and for anyone
reviewing the schema without running a build.

## Secure handling of source data

- WikiAnn is fetched through the Hugging Face `datasets` library's own cache
  (`~/.cache/huggingface` by default) — this repository never copies it
  elsewhere.
- To remove it: delete that cache directory, or run
  `uv run python -c "from datasets import config; import shutil; shutil.rmtree(config.HF_DATASETS_CACHE, ignore_errors=True)"`.
- Nothing in this package logs record text or writes it outside the
  `--out-dir` the caller specifies.
