from __future__ import annotations

from collections.abc import Mapping, Sequence

IGNORE_INDEX = -100


def align_labels_with_offsets(
    entities: Sequence[tuple[int, int, str]],
    offsets: Sequence[tuple[int, int]],
    label_to_id: Mapping[str, int],
    ignore_index: int = IGNORE_INDEX,
) -> list[int]:
    sorted_entities = sorted(entities, key=lambda e: e[0])
    result: list[int] = []
    prev_entity_idx: int | None = None

    for tok_start, tok_end in offsets:
        if tok_start == tok_end:
            result.append(ignore_index)
            prev_entity_idx = None
            continue

        entity_idx = None
        for i, (e_start, e_end, _label) in enumerate(sorted_entities):
            if tok_start < e_end and e_start < tok_end:
                entity_idx = i
                break

        if entity_idx is None:
            result.append(label_to_id["O"])
            prev_entity_idx = None
        else:
            _e_start, _e_end, e_label = sorted_entities[entity_idx]
            prefix = "I" if entity_idx == prev_entity_idx else "B"
            result.append(label_to_id[f"{prefix}-{e_label}"])
            prev_entity_idx = entity_idx

    return result


def decode_predictions_to_spans(
    offsets: Sequence[tuple[int, int]],
    predicted_label_ids: Sequence[int],
    id_to_label: Mapping[int, str],
    ignore_index: int = IGNORE_INDEX,
) -> list[tuple[int, int, str]]:
    spans: list[tuple[int, int, str]] = []
    open_span: tuple[int, int, str] | None = None

    for (tok_start, tok_end), label_id in zip(offsets, predicted_label_ids):
        if tok_start == tok_end or label_id == ignore_index:
            if open_span is not None:
                spans.append(open_span)
                open_span = None
            continue

        label = id_to_label[label_id]
        if label == "O":
            if open_span is not None:
                spans.append(open_span)
                open_span = None
            continue

        prefix, entity_type = label.split("-", 1)
        if prefix == "B" or open_span is None or open_span[2] != entity_type:
            if open_span is not None:
                spans.append(open_span)
            open_span = (tok_start, tok_end, entity_type)
        else:
            open_span = (open_span[0], tok_end, entity_type)

    if open_span is not None:
        spans.append(open_span)

    return spans
