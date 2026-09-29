from __future__ import annotations

import argparse
import json

import numpy as np
import onnxruntime as ort
import torch
from transformers import BertForTokenClassification, BertTokenizerFast

from .export_onnx import DEFAULT_MAX_LENGTH


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

    for text in texts:
        encoding = tokenizer(
            text,
            truncation=True,
            max_length=max_length,
            padding="max_length",
            return_tensors="pt",
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

        torch_labels = torch_logits.argmax(axis=-1)[0]
        onnx_labels = onnx_logits.argmax(axis=-1)[0]
        mask = encoding["attention_mask"][0].numpy().astype(bool)
        label_agreement += int((torch_labels[mask] == onnx_labels[mask]).sum())
        total_tokens += int(mask.sum())

    return {
        "num_examples": len(texts),
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
