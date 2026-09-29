from __future__ import annotations

import re

from .schema import Entity

_PLACEHOLDER_RE = re.compile(r"\{(NAME|ADDRESS|ORG|LOCATION|DOB)\}")


def render(template: str, values: dict[str, str]) -> tuple[str, tuple[Entity, ...]]:
    parts: list[str] = []
    entities: list[Entity] = []
    cursor = 0
    offset = 0

    for match in _PLACEHOLDER_RE.finditer(template):
        literal = template[cursor : match.start()]
        parts.append(literal)
        offset += len(literal)

        entity_type = match.group(1)
        value = values[entity_type]
        parts.append(value)
        entities.append(Entity(start=offset, end=offset + len(value), label=entity_type))
        offset += len(value)

        cursor = match.end()

    parts.append(template[cursor:])
    text = "".join(parts)
    return text, tuple(entities)
