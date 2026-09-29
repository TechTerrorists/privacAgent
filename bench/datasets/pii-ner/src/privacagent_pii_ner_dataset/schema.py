from __future__ import annotations

import json
from dataclasses import dataclass, field

from .labels import ENTITY_TYPES


class InvalidRecordError(ValueError):
    pass


@dataclass(frozen=True)
class Entity:
    start: int
    end: int
    label: str

    def __post_init__(self) -> None:
        if self.label not in ENTITY_TYPES:
            raise InvalidRecordError(f"unknown entity type: {self.label!r}")
        if not (0 <= self.start < self.end):
            raise InvalidRecordError(f"invalid span: start={self.start} end={self.end}")


@dataclass(frozen=True)
class Record:
    id: str
    text: str
    lang: str
    source: str
    family: str
    entities: tuple[Entity, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if self.lang not in ("en", "hi"):
            raise InvalidRecordError(f"unsupported lang: {self.lang!r}")
        if not self.text:
            raise InvalidRecordError("text must be non-empty")
        sorted_entities = sorted(self.entities, key=lambda e: e.start)
        for entity in sorted_entities:
            if entity.end > len(self.text):
                raise InvalidRecordError(
                    f"entity end {entity.end} exceeds text length {len(self.text)} in record {self.id}"
                )
        for a, b in zip(sorted_entities, sorted_entities[1:]):
            if b.start < a.end:
                raise InvalidRecordError(
                    f"overlapping entities in record {self.id}: {a} and {b}"
                )

    def to_json_dict(self) -> dict:
        return {
            "id": self.id,
            "text": self.text,
            "lang": self.lang,
            "source": self.source,
            "family": self.family,
            "entities": [
                {"start": e.start, "end": e.end, "label": e.label} for e in self.entities
            ],
        }

    @staticmethod
    def from_json_dict(data: dict) -> "Record":
        entities = tuple(
            Entity(start=e["start"], end=e["end"], label=e["label"])
            for e in data.get("entities", [])
        )
        return Record(
            id=data["id"],
            text=data["text"],
            lang=data["lang"],
            source=data["source"],
            family=data["family"],
            entities=entities,
        )


def write_jsonl(records: list[Record], path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record.to_json_dict(), ensure_ascii=False))
            f.write("\n")


def read_jsonl(path: str) -> list[Record]:
    records: list[Record] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            records.append(Record.from_json_dict(json.loads(line)))
    return records
