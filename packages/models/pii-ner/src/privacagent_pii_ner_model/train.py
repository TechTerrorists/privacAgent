from __future__ import annotations

import argparse
import json
import os
import platform
import random
import sys
import time

import torch
import transformers
from torch.utils.data import DataLoader

from privacagent_pii_ner_dataset.labels import LABEL_TO_ID
from privacagent_pii_ner_dataset.schema import read_jsonl

from .dataset import PiiNerDataset
from .evaluate import baseline_predict_fn, evaluate, torch_model_predict_fn
from .model import build_model, count_parameters
from .tokenizer import train_tokenizer

DEFAULT_SEED = 20260215
DEFAULT_VOCAB_SIZE = 8000
DEFAULT_EPOCHS = 3
DEFAULT_BATCH_SIZE = 8
DEFAULT_LEARNING_RATE = 5e-4
DEFAULT_MAX_LENGTH = 64
DEFAULT_STRIDE = 16


def set_seed(seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)


def _to_jsonable(value):
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_jsonable(v) for v in value]
    if hasattr(value, "item") and callable(value.item):
        return value.item()
    return value


def train(
    dataset_dir: str,
    out_dir: str,
    seed: int = DEFAULT_SEED,
    vocab_size: int = DEFAULT_VOCAB_SIZE,
    epochs: int = DEFAULT_EPOCHS,
    batch_size: int = DEFAULT_BATCH_SIZE,
    learning_rate: float = DEFAULT_LEARNING_RATE,
    max_length: int = DEFAULT_MAX_LENGTH,
    stride: int = DEFAULT_STRIDE,
) -> dict:
    set_seed(seed)
    start_time = time.time()

    train_records = read_jsonl(os.path.join(dataset_dir, "train.jsonl"))
    val_records = read_jsonl(os.path.join(dataset_dir, "val.jsonl"))
    test_records = read_jsonl(os.path.join(dataset_dir, "test.jsonl"))

    os.makedirs(out_dir, exist_ok=True)
    tokenizer_dir = os.path.join(out_dir, "tokenizer")
    tokenizer = train_tokenizer(
        [r.text for r in train_records], vocab_size=vocab_size, save_dir=tokenizer_dir
    )

    model = build_model(vocab_size=tokenizer.vocab_size)

    train_dataset = PiiNerDataset(tokenizer, train_records, max_length=max_length, stride=stride)
    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)

    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate)

    device = torch.device("cpu")
    model.to(device)

    epoch_losses: list[float] = []
    for epoch in range(epochs):
        model.train()
        total_loss = 0.0
        num_batches = 0
        for batch in train_loader:
            optimizer.zero_grad()
            outputs = model(
                input_ids=batch["input_ids"].to(device),
                attention_mask=batch["attention_mask"].to(device),
                labels=batch["labels"].to(device),
            )
            loss = outputs.loss
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
            num_batches += 1
        epoch_losses.append(total_loss / max(num_batches, 1))

    training_seconds = time.time() - start_time

    model_dir = os.path.join(out_dir, "model")
    os.makedirs(model_dir, exist_ok=True)
    model.save_pretrained(model_dir)
    tokenizer.save_pretrained(model_dir)
    with open(os.path.join(model_dir, "label_map.json"), "w", encoding="utf-8") as f:
        json.dump(LABEL_TO_ID, f, ensure_ascii=False, indent=2)

    trained_predict_fn = torch_model_predict_fn(model)
    baseline_fn = baseline_predict_fn()

    val_metrics = evaluate(trained_predict_fn, tokenizer, val_records, max_length, stride)
    test_metrics_trained = evaluate(
        trained_predict_fn, tokenizer, test_records, max_length, stride
    )
    test_metrics_baseline = evaluate(baseline_fn, tokenizer, test_records, max_length, stride)

    report = {
        "seed": seed,
        "vocab_size": tokenizer.vocab_size,
        "epochs": epochs,
        "batch_size": batch_size,
        "learning_rate": learning_rate,
        "max_length": max_length,
        "stride": stride,
        "num_parameters": count_parameters(model),
        "training_seconds": training_seconds,
        "epoch_losses": epoch_losses,
        "environment": {
            "python": sys.version,
            "platform": platform.platform(),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
        },
        "val_metrics_trained": val_metrics,
        "test_metrics_trained": test_metrics_trained,
        "test_metrics_baseline": test_metrics_baseline,
        "train_records": len(train_records),
        "val_records": len(val_records),
        "test_records": len(test_records),
    }
    with open(os.path.join(out_dir, "train_report.json"), "w", encoding="utf-8") as f:
        json.dump(_to_jsonable(report), f, ensure_ascii=False, indent=2)

    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-dir", type=str, required=True)
    parser.add_argument("--out-dir", type=str, default="artifacts/run")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--vocab-size", type=int, default=DEFAULT_VOCAB_SIZE)
    parser.add_argument("--epochs", type=int, default=DEFAULT_EPOCHS)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--learning-rate", type=float, default=DEFAULT_LEARNING_RATE)
    parser.add_argument("--max-length", type=int, default=DEFAULT_MAX_LENGTH)
    parser.add_argument("--stride", type=int, default=DEFAULT_STRIDE)
    args = parser.parse_args()

    report = train(
        dataset_dir=args.dataset_dir,
        out_dir=args.out_dir,
        seed=args.seed,
        vocab_size=args.vocab_size,
        epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        max_length=args.max_length,
        stride=args.stride,
    )
    print(json.dumps({k: v for k, v in report.items() if k not in ("val_metrics_trained", "test_metrics_trained", "test_metrics_baseline")}, indent=2))


if __name__ == "__main__":
    main()
