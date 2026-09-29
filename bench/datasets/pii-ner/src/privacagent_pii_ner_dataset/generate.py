from __future__ import annotations

import random
import hashlib
from datetime import date
import unicodedata

from faker import Faker

from . import hi_values, templates_en, templates_hi
from .render import render
from .schema import Record
from .splits import synthetic_partition

DEFAULT_SEED = 20260215


# Absolute dates: Faker age ranges otherwise depend on the wall clock.
DOB_START = date(1950, 1, 1)
DOB_END = date(2007, 12, 31)


def _value_partition(value: str, seed: int) -> str:
    normalized = unicodedata.normalize("NFC", value).casefold()
    bucket = (
        int.from_bytes(
            hashlib.sha256(f"{seed}:{normalized}".encode()).digest()[:4], "big"
        )
        % 100
    )
    return "train" if bucket < 70 else "val" if bucket < 85 else "test"


def _english_value(factory, split: str, seed: int) -> str:
    for _ in range(10000):
        value = factory()
        if _value_partition(value, seed) == split:
            return value
    raise ValueError("could not sample a split-exclusive synthetic value")


def _hindi_pool(values: tuple[str, ...], split: str, seed: int) -> list[str]:
    # Reserve at least one distinct value per held-out split, even for small pools.
    shuffled = list(values)
    random.Random(seed).shuffle(shuffled)
    n_train = max(1, int(len(shuffled) * 0.7))
    n_val = max(1, int(len(shuffled) * 0.15))
    return {
        "train": shuffled[:n_train],
        "val": shuffled[n_train : n_train + n_val],
        "test": shuffled[n_train + n_val :],
    }[split]


def generate_english(
    seed: int = DEFAULT_SEED, count_per_template: int = 40
) -> list[Record]:
    faker = Faker("en_IN")
    faker.seed_instance(seed)
    records: list[Record] = []

    for template_idx, template in enumerate(templates_en.POSITIVE_TEMPLATES):
        family = f"en_pos_{template_idx}"
        split = synthetic_partition(family, seed)
        for i in range(count_per_template):
            values = {
                "NAME": _english_value(faker.name, split, seed),
                "ADDRESS": _english_value(
                    lambda: faker.address().replace("\n", ", "), split, seed
                ),
                "ORG": _english_value(faker.company, split, seed),
                "LOCATION": _english_value(faker.city, split, seed),
                "DOB": _english_value(
                    lambda: faker.date_between_dates(DOB_START, DOB_END).isoformat(),
                    split,
                    seed,
                ),
            }
            text, entities = render(template, values)
            records.append(
                Record(
                    id=f"{family}_{i}",
                    text=text,
                    lang="en",
                    source="synthetic",
                    family=family,
                    entities=entities,
                )
            )

    for template_idx, template in enumerate(templates_en.NEGATIVE_TEMPLATES):
        family = f"en_neg_{template_idx}"
        records.append(
            Record(
                id=f"{family}_0",
                text=template,
                lang="en",
                source="synthetic",
                family=family,
                entities=(),
            )
        )

    return records


def generate_hindi(
    seed: int = DEFAULT_SEED, count_per_template: int = 32
) -> list[Record]:
    rng = random.Random(seed)
    records: list[Record] = []

    for template_idx, template in enumerate(templates_hi.POSITIVE_TEMPLATES):
        family = f"hi_pos_{template_idx}"
        split = synthetic_partition(family, seed)
        for i in range(count_per_template):
            values = {
                "NAME": rng.choice(_hindi_pool(hi_values.NAMES, split, seed)),
                "ADDRESS": rng.choice(_hindi_pool(hi_values.ADDRESSES, split, seed)),
                "ORG": rng.choice(_hindi_pool(hi_values.ORGS, split, seed)),
                "LOCATION": rng.choice(_hindi_pool(hi_values.LOCATIONS, split, seed)),
                "DOB": rng.choice(_hindi_pool(hi_values.DOBS, split, seed)),
            }
            text, entities = render(template, values)
            records.append(
                Record(
                    id=f"{family}_{i}",
                    text=text,
                    lang="hi",
                    source="synthetic",
                    family=family,
                    entities=entities,
                )
            )

    for template_idx, template in enumerate(templates_hi.NEGATIVE_TEMPLATES):
        family = f"hi_neg_{template_idx}"
        records.append(
            Record(
                id=f"{family}_0",
                text=template,
                lang="hi",
                source="synthetic",
                family=family,
                entities=(),
            )
        )

    return records


def generate_all(seed: int = DEFAULT_SEED) -> list[Record]:
    return generate_english(seed=seed) + generate_hindi(seed=seed)
