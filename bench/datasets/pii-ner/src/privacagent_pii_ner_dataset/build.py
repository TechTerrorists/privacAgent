from __future__ import annotations

import argparse
import json
import os

from .corpus import load_wikiann
from .generate import DEFAULT_SEED, generate_all
from .schema import write_jsonl
from .splits import assert_no_leakage, split_by_family
from .validate import support_report, validate_records


def build(
    seed: int = DEFAULT_SEED,
    wikiann_per_lang: int = 400,
    out_dir: str = "artifacts",
) -> dict:
    synthetic = generate_all(seed=seed)
    wikiann_en = load_wikiann("en", wikiann_per_lang)
    wikiann_hi = load_wikiann("hi", wikiann_per_lang)

    all_records = synthetic + wikiann_en + wikiann_hi
    validate_records(all_records)

    splits = split_by_family(all_records, seed=seed)
    assert_no_leakage(splits)

    os.makedirs(out_dir, exist_ok=True)
    write_jsonl(splits.train, os.path.join(out_dir, "train.jsonl"))
    write_jsonl(splits.val, os.path.join(out_dir, "val.jsonl"))
    write_jsonl(splits.test, os.path.join(out_dir, "test.jsonl"))

    report = {
        "seed": seed,
        "wikiann_per_lang": wikiann_per_lang,
        "total": support_report(all_records),
        "train": support_report(splits.train),
        "val": support_report(splits.val),
        "test": support_report(splits.test),
    }
    with open(os.path.join(out_dir, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--wikiann-per-lang", type=int, default=400)
    parser.add_argument("--out-dir", type=str, default="artifacts")
    args = parser.parse_args()

    report = build(seed=args.seed, wikiann_per_lang=args.wikiann_per_lang, out_dir=args.out_dir)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
