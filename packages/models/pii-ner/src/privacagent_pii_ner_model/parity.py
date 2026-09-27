from __future__ import annotations

import argparse
import json

import numpy as np
import onnxruntime as ort
import torch
from transformers import BertForTokenClassification, BertTokenizerFast

from .export_onnx import DEFAULT_MAX_LENGTH
from .evaluate import predict_spans, torch_model_predict_fn
from .align import spans_to_utf16
from privacagent_pii_ner_dataset.schema import Record


def check_parity(
    model_dir: str,
    onnx_path: str,
    texts: list[str],
    max_length: int = DEFAULT_MAX_LENGTH,
) -> dict:
    tokenizer = BertTokenizerFast.from_pretrained(model_dir)
    model = BertForTokenClassification.from_pretrained(model_dir)
    model.eval()

    session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])

    max_abs_diff = 0.0
    label_agreement = 0
    total_tokens = 0

    span_agreement = 0
    native_predict = torch_model_predict_fn(model)
    for index, text in enumerate(texts):
        encoding = tokenizer(
            text,
            truncation=True,
            max_length=max_length,
            padding="max_length",
            return_tensors="pt",
            stride=min(16, max_length - 3),
            return_overflowing_tokens=True,
            return_special_tokens_mask=True,
        )
        with torch.no_grad():
            torch_logits = model(
                input_ids=encoding["input_ids"],
                attention_mask=encoding["attention_mask"],
            ).logits.numpy()

        onnx_logits = session.run(
            ["logits"],
            {
                "input_ids": encoding["input_ids"].numpy(),
                "attention_mask": encoding["attention_mask"].numpy(),
            },
        )[0]

        diff = float(np.max(np.abs(torch_logits - onnx_logits)))
        max_abs_diff = max(max_abs_diff, diff)

        torch_labels = torch_logits.argmax(axis=-1)
        onnx_labels = onnx_logits.argmax(axis=-1)
        mask = encoding["attention_mask"].numpy().astype(bool) & ~encoding[
            "special_tokens_mask"
        ].numpy().astype(bool)
        label_agreement += int((torch_labels[mask] == onnx_labels[mask]).sum())
        total_tokens += int(mask.sum())

        def exported_predict(ids, mask):
            return (
                session.run(
                    ["logits"],
                    {
                        "input_ids": np.array([ids], dtype=np.int64),
                        "attention_mask": np.array([mask], dtype=np.int64),
                    },
                )[0]
                .argmax(axis=-1)[0]
                .tolist()
            )

        record = Record(str(index), text, "en", "fixture", "parity")
        native_spans = spans_to_utf16(
            text,
            predict_spans(
                native_predict, tokenizer, record, max_length, min(16, max_length - 3)
            ),
        )
        exported_spans = spans_to_utf16(
            text,
            predict_spans(
                exported_predict, tokenizer, record, max_length, min(16, max_length - 3)
            ),
        )
        span_agreement += native_spans == exported_spans

    return {
        "num_examples": len(texts),
        "utf16_span_agreement_rate": span_agreement / len(texts) if texts else 1.0,
        "max_abs_logit_diff": max_abs_diff,
        "label_agreement_rate": label_agreement / total_tokens if total_tokens else 1.0,
        "total_tokens_compared": total_tokens,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=str, required=True)
    parser.add_argument("--onnx-path", type=str, required=True)
    parser.add_argument("--fixtures", type=str, required=True)
    args = parser.parse_args()

    from privacagent_pii_ner_dataset.schema import read_jsonl

    records = read_jsonl(args.fixtures)
    texts = [r.text for r in records]
    report = check_parity(args.model_dir, args.onnx_path, texts)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
