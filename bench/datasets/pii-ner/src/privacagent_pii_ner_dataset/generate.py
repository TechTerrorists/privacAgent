from __future__ import annotations

import random

from faker import Faker

from . import hi_values, templates_en, templates_hi
from .render import render
from .schema import Record

DEFAULT_SEED = 20260215


def generate_english(seed: int = DEFAULT_SEED, count_per_template: int = 40) -> list[Record]:
    faker = Faker("en_IN")
    faker.seed_instance(seed)
    records: list[Record] = []

    for template_idx, template in enumerate(templates_en.POSITIVE_TEMPLATES):
        family = f"en_pos_{template_idx}"
        for i in range(count_per_template):
            values = {
                "NAME": faker.name(),
                "ADDRESS": faker.address().replace("\n", ", "),
                "ORG": faker.company(),
                "LOCATION": faker.city(),
                "DOB": faker.date_of_birth(minimum_age=18, maximum_age=75).strftime(
                    "%d %B %Y"
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


def generate_hindi(seed: int = DEFAULT_SEED, count_per_template: int = 32) -> list[Record]:
    rng = random.Random(seed)
    records: list[Record] = []

    for template_idx, template in enumerate(templates_hi.POSITIVE_TEMPLATES):
        family = f"hi_pos_{template_idx}"
        for i in range(count_per_template):
            values = {
                "NAME": rng.choice(hi_values.NAMES),
                "ADDRESS": rng.choice(hi_values.ADDRESSES),
                "ORG": rng.choice(hi_values.ORGS),
                "LOCATION": rng.choice(hi_values.LOCATIONS),
                "DOB": rng.choice(hi_values.DOBS),
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
