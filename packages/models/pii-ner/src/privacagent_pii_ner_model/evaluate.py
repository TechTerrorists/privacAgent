from __future__ import annotations

from collections.abc import Callable

import torch
from seqeval.metrics import classification_report

from privacagent_pii_ner_dataset.labels import ID_TO_LABEL, LABEL_TO_ID
from privacagent_pii_ner_dataset.schema import Record

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


def onnx_model_predict_fn(onnx_path: str) -> PredictFn:
    import numpy as np
    import onnxruntime as ort

    session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])

    def predict(input_ids: list[int], attention_mask: list[int]) -> list[int]:
        logits = session.run(
            ["logits"],
            {
                "input_ids": np.array([input_ids], dtype=np.int64),
                "attention_mask": np.array([attention_mask], dtype=np.int64),
            },
        )[0]
        return logits.argmax(axis=-1)[0].tolist()

    return predict


def baseline_predict_fn() -> PredictFn:
    outside_id = LABEL_TO_ID["O"]

    def predict(input_ids: list[int], attention_mask: list[int]) -> list[int]:
        return [outside_id] * len(input_ids)

    return predict


def evaluate(
    predict_fn: PredictFn,
    tokenizer,
    records: list[Record],
    max_length: int = 64,
    stride: int = 16,
) -> dict:
    all_gold: list[list[str]] = []
    all_pred: list[list[str]] = []
    by_lang_gold: dict[str, list[list[str]]] = {}
    by_lang_pred: dict[str, list[list[str]]] = {}

    for record in records:
        windows = encode_record(tokenizer, record, max_length=max_length, stride=stride)
        for window in windows:
            pred_ids = predict_fn(window["input_ids"], window["attention_mask"])
            gold_tags: list[str] = []
            pred_tags: list[str] = []
            for gold_id, pred_id in zip(window["labels"], pred_ids):
                if gold_id == -100:
                    continue
                gold_tags.append(ID_TO_LABEL[gold_id])
                pred_tags.append(ID_TO_LABEL[pred_id])
            if not gold_tags:
                continue
            all_gold.append(gold_tags)
            all_pred.append(pred_tags)
            by_lang_gold.setdefault(record.lang, []).append(gold_tags)
            by_lang_pred.setdefault(record.lang, []).append(pred_tags)

    overall = classification_report(all_gold, all_pred, output_dict=True, zero_division=0)
    by_lang = {
        lang: classification_report(
            by_lang_gold[lang], by_lang_pred[lang], output_dict=True, zero_division=0
        )
        for lang in by_lang_gold
    }
    return {"overall": overall, "by_lang": by_lang}
