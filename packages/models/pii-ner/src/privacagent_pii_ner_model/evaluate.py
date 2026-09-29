from __future__ import annotations

from collections import Counter
from collections.abc import Callable

import torch

from privacagent_pii_ner_dataset.labels import ENTITY_TYPES, ID_TO_LABEL, LABEL_TO_ID
from privacagent_pii_ner_dataset.schema import Record

from .align import decode_predictions_to_spans
from .dataset import encode_record

PredictFn = Callable[[list[int], list[int]], list[int]]


def torch_model_predict_fn(model) -> PredictFn:
    model.eval()

    def predict(input_ids: list[int], attention_mask: list[int]) -> list[int]:
        with torch.no_grad():
            logits = model(
                input_ids=torch.tensor([input_ids]),
                attention_mask=torch.tensor([attention_mask]),
            ).logits
        return logits.argmax(dim=-1)[0].tolist()

    return predict


def baseline_predict_fn() -> PredictFn:
    outside_id = LABEL_TO_ID["O"]

    def predict(input_ids: list[int], attention_mask: list[int]) -> list[int]:
        return [outside_id] * len(input_ids)

    return predict


def predict_spans(
    predict_fn: PredictFn,
    tokenizer,
    record: Record,
    max_length: int = 64,
    stride: int = 16,
) -> list[tuple[int, int, str]]:
    """One prediction per original token; prefer the most central window occurrence.

    Ties keep the earlier window. Decode BIO only after stitching tokens, so
    overlapping windows neither duplicate entities nor create partial gold spans.
    All returned offsets remain Python code points until spans_to_utf16 is called.
    """
    tokens: dict[tuple[int, int], tuple[int, int]] = {}
    for window in encode_record(
        tokenizer, record, max_length=max_length, stride=stride
    ):
        predictions = predict_fn(window["input_ids"], window["attention_mask"])
        if len(predictions) != len(window["offset_mapping"]):
            raise ValueError("prediction length differs from token count")
        real = [
            (tuple(offset), label)
            for offset, label in zip(window["offset_mapping"], predictions)
            if offset[0] != offset[1]
        ]
        for index, (offset, label) in enumerate(real):
            if label not in ID_TO_LABEL:
                raise ValueError("invalid predicted label")
            score = min(index, len(real) - 1 - index)
            if offset not in tokens or score > tokens[offset][0]:
                tokens[offset] = (score, label)
    offsets = sorted(tokens)
    return decode_predictions_to_spans(
        offsets, [tokens[o][1] for o in offsets], ID_TO_LABEL
    )


def _report(counts: dict[str, Counter]) -> dict:
    def metrics(tp, fp, fn):
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        return {
            "precision": precision,
            "recall": recall,
            "f1-score": (
                2 * precision * recall / (precision + recall)
                if precision + recall
                else 0.0
            ),
            "support": tp + fn,
        }

    report = {
        label: metrics(counts[label]["tp"], counts[label]["fp"], counts[label]["fn"])
        for label in ENTITY_TYPES
    }
    total = sum(counts.values(), Counter())
    report["micro avg"] = metrics(total["tp"], total["fp"], total["fn"])
    report["macro avg"] = {
        key: sum(report[label][key] for label in ENTITY_TYPES) / len(ENTITY_TYPES)
        for key in ("precision", "recall", "f1-score")
    }
    report["macro avg"]["support"] = total["tp"] + total["fn"]
    return report


def evaluate(
    predict_fn: PredictFn,
    tokenizer,
    records: list[Record],
    max_length: int = 64,
    stride: int = 16,
) -> dict:
    overall = {label: Counter() for label in ENTITY_TYPES}
    by_lang: dict[str, dict[str, Counter]] = {}
    for record in records:
        gold = {(e.start, e.end, e.label) for e in record.entities}
        predicted = set(
            predict_spans(predict_fn, tokenizer, record, max_length, stride)
        )
        lang_counts = by_lang.setdefault(
            record.lang, {label: Counter() for label in ENTITY_TYPES}
        )
        for kind, spans in (
            ("tp", gold & predicted),
            ("fp", predicted - gold),
            ("fn", gold - predicted),
        ):
            for _, _, label in spans:
                overall[label][kind] += 1
                lang_counts[label][kind] += 1
    return {
        "matching": "exact_original_code_point_span_and_label",
        "overall": _report(overall),
        "by_lang": {lang: _report(counts) for lang, counts in by_lang.items()},
    }
