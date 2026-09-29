from __future__ import annotations

import random
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


def split_by_family(records: list[Record], seed: int) -> DatasetSplits:
    records = deduplicate(records)

    families: dict[str, list[Record]] = {}
    for record in records:
        families.setdefault(record.family, []).append(record)

    family_ids = sorted(families.keys())
    rng = random.Random(seed)
    rng.shuffle(family_ids)

    n_train = int(len(family_ids) * TRAIN_FRACTION)
    n_val = int(len(family_ids) * VAL_FRACTION)

    train_families = set(family_ids[:n_train])
    val_families = set(family_ids[n_train : n_train + n_val])
    test_families = set(family_ids[n_train + n_val :])

    train: list[Record] = []
    val: list[Record] = []
    test: list[Record] = []
    for family_id, family_records in families.items():
        if family_id in train_families:
            train.extend(family_records)
        elif family_id in val_families:
            val.extend(family_records)
        else:
            test.extend(family_records)

    return DatasetSplits(train=train, val=val, test=test)


def assert_no_leakage(splits: DatasetSplits) -> None:
    train_families = {r.family for r in splits.train}
    val_families = {r.family for r in splits.val}
    test_families = {r.family for r in splits.test}

    if train_families & val_families:
        raise AssertionError(f"family leakage train/val: {train_families & val_families}")
    if train_families & test_families:
        raise AssertionError(f"family leakage train/test: {train_families & test_families}")
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
