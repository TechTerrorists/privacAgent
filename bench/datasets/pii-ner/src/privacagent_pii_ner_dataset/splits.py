from __future__ import annotations

import random
import unicodedata
from itertools import combinations
from functools import lru_cache
import re
from dataclasses import dataclass

from .schema import Record

TRAIN_FRACTION = 0.7
VAL_FRACTION = 0.15


@dataclass(frozen=True)
class DatasetSplits:
    train: list[Record]
    val: list[Record]
    test: list[Record]


def deduplicate(records: list[Record]) -> list[Record]:
    seen: set[str] = set()
    out: list[Record] = []
    for record in records:
        key = record.text.strip()
        if key in seen:
            continue
        seen.add(key)
        out.append(record)
    return out


@lru_cache(maxsize=32)
def _template_partitions(kind: str, seed: int) -> dict[int, str]:
    from . import templates_en, templates_hi

    attribute = "POSITIVE_TEMPLATES" if kind == "pos" else "NEGATIVE_TEMPLATES"
    templates = getattr(templates_en, attribute)
    if len(templates) != len(getattr(templates_hi, attribute)):
        raise ValueError("translated template families must stay aligned")
    indices = list(range(len(templates)))
    rng = random.Random(f"{seed}:{kind}")
    n_train = int(len(indices) * TRAIN_FRACTION)
    n_val = max(1, int(len(indices) * VAL_FRACTION))
    labels = [set(re.findall(r"\{(\w+)\}", text)) for text in templates]
    required = set().union(*labels)
    # Stratify using annotations only; never model predictions or test scores.
    for _ in range(10000):
        rng.shuffle(indices)
        groups = (
            indices[:n_train],
            indices[n_train : n_train + n_val],
            indices[n_train + n_val :],
        )
        if all(
            set().union(*(labels[i] for i in group)) == required for group in groups
        ):
            return {
                i: split
                for split, group in zip(("train", "val", "test"), groups)
                for i in group
            }
    raise ValueError("cannot give every split all synthetic labels")


def synthetic_partition(family: str, seed: int) -> str:
    # English/Hindi translations of one template belong to the same split.
    _, kind, index = family.split("_")
    return _template_partitions(kind, seed)[int(index)]


def split_by_family(records: list[Record], seed: int) -> DatasetSplits:
    records = deduplicate(records)
    families = sorted({r.family for r in records})
    random.Random(seed).shuffle(families)
    fallback = {
        family: (
            "train"
            if i < int(len(families) * TRAIN_FRACTION)
            else (
                "val"
                if i < int(len(families) * (TRAIN_FRACTION + VAL_FRACTION))
                else "test"
            )
        )
        for i, family in enumerate(families)
    }
    groups: dict[str, list[Record]] = {"train": [], "val": [], "test": []}
    for record in records:
        if record.source == "synthetic" and record.family.startswith(
            ("en_pos_", "hi_pos_", "en_neg_", "hi_neg_")
        ):
            split = synthetic_partition(record.family, seed)
        elif record.source == "wikiann":
            # Preserve the corpus's official split; arbitrary row chunks are not families.
            split = {"train": "train", "validation": "val", "test": "test"}[
                record.family.rsplit("_", 1)[1]
            ]
        else:
            split = fallback[record.family]
        groups[split].append(record)
    return DatasetSplits(**groups)


def assert_no_leakage(splits: DatasetSplits) -> None:
    train_families = {r.family for r in splits.train}
    val_families = {r.family for r in splits.val}
    test_families = {r.family for r in splits.test}

    if train_families & val_families:
        raise AssertionError(
            f"family leakage train/val: {train_families & val_families}"
        )
    if train_families & test_families:
        raise AssertionError(
            f"family leakage train/test: {train_families & test_families}"
        )
    if val_families & test_families:
        raise AssertionError(f"family leakage val/test: {val_families & test_families}")

    train_texts = {r.text.strip() for r in splits.train}
    val_texts = {r.text.strip() for r in splits.val}
    test_texts = {r.text.strip() for r in splits.test}

    if train_texts & val_texts:
        raise AssertionError("exact-text leakage between train and val")
    if train_texts & test_texts:
        raise AssertionError("exact-text leakage between train and test")
    if val_texts & test_texts:
        raise AssertionError("exact-text leakage between val and test")

    # Full-sentence deduplication cannot catch a name reused in another template.
    synthetic_values = []
    for records in (splits.train, splits.val, splits.test):
        synthetic_values.append(
            {
                unicodedata.normalize("NFC", r.text[e.start : e.end]).casefold()
                for r in records
                if r.source == "synthetic"
                for e in r.entities
            }
        )
    for left, right in combinations(synthetic_values, 2):
        if left & right:
            raise AssertionError("synthetic entity leakage between splits")
