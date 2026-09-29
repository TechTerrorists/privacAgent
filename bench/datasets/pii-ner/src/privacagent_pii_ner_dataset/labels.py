from __future__ import annotations

ENTITY_TYPES: tuple[str, ...] = ("NAME", "ADDRESS", "ORG", "LOCATION", "DOB")

ENTITY_TO_PII_CLASS: dict[str, str] = {
    "NAME": "name",
    "ADDRESS": "address",
    "ORG": "organization",
    "LOCATION": "location",
    "DOB": "dob",
}

OUTSIDE_LABEL = "O"


def build_label_list() -> list[str]:
    labels = [OUTSIDE_LABEL]
    for entity in ENTITY_TYPES:
        labels.append(f"B-{entity}")
        labels.append(f"I-{entity}")
    return labels


LABEL_LIST: list[str] = build_label_list()
LABEL_TO_ID: dict[str, int] = {label: i for i, label in enumerate(LABEL_LIST)}
ID_TO_LABEL: dict[int, str] = {i: label for label, i in LABEL_TO_ID.items()}


def entity_type_from_label(label: str) -> str | None:
    if label == OUTSIDE_LABEL:
        return None
    return label.split("-", 1)[1]


def pii_class_for_label(label: str) -> str | None:
    entity = entity_type_from_label(label)
    if entity is None:
        return None
    return ENTITY_TO_PII_CLASS[entity]
