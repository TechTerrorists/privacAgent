from __future__ import annotations

from collections import Counter

from .schema import InvalidRecordError, Record


def validate_records(records: list[Record]) -> None:
    seen_ids: set[str] = set()
    for record in records:
        if record.id in seen_ids:
            raise InvalidRecordError(f"duplicate record id: {record.id}")
        seen_ids.add(record.id)
        for entity in record.entities:
            span_text = record.text[entity.start : entity.end]
            if not span_text.strip():
                raise InvalidRecordError(
                    f"empty/whitespace entity span in record {record.id}: {entity}"
                )


def support_report(records: list[Record]) -> dict:
    report: dict = {
        "total_records": len(records),
        "by_lang": dict(Counter(r.lang for r in records)),
        "by_source": dict(Counter(r.source for r in records)),
        "entities_by_label": dict(
            Counter(e.label for r in records for e in r.entities)
        ),
        "entities_by_label_and_lang": {},
    }
    per_label_lang: Counter = Counter()
    for record in records:
        for entity in record.entities:
            per_label_lang[(entity.label, record.lang)] += 1
    report["entities_by_label_and_lang"] = {
        f"{label}/{lang}": count for (label, lang), count in per_label_lang.items()
    }
    return report
