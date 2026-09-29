from __future__ import annotations

from privacagent_pii_ner_dataset.labels import LABEL_TO_ID
from privacagent_pii_ner_dataset.schema import Record
import torch
from torch.utils.data import Dataset

from .align import align_labels_with_offsets

DEFAULT_MAX_LENGTH = 64
DEFAULT_STRIDE = 16


def encode_record(
    tokenizer,
    record: Record,
    max_length: int = DEFAULT_MAX_LENGTH,
    stride: int = DEFAULT_STRIDE,
) -> list[dict]:
    encoding = tokenizer(
        record.text,
        truncation=True,
        max_length=max_length,
        stride=stride,
        return_overflowing_tokens=True,
        return_offsets_mapping=True,
        padding="max_length",
    )

    entities = [(e.start, e.end, e.label) for e in record.entities]
    windows: list[dict] = []
    num_windows = len(encoding["input_ids"])
    for i in range(num_windows):
        offsets = [tuple(pair) for pair in encoding["offset_mapping"][i]]
        labels = align_labels_with_offsets(entities, offsets, LABEL_TO_ID)
        windows.append(
            {
                "input_ids": encoding["input_ids"][i],
                "attention_mask": encoding["attention_mask"][i],
                "labels": labels,
                "offset_mapping": offsets,
                "record_id": record.id,
            }
        )
    return windows


class PiiNerDataset(Dataset):
    def __init__(
        self,
        tokenizer,
        records: list[Record],
        max_length: int = DEFAULT_MAX_LENGTH,
        stride: int = DEFAULT_STRIDE,
    ) -> None:
        self.examples: list[dict] = []
        for record in records:
            self.examples.extend(
                encode_record(tokenizer, record, max_length=max_length, stride=stride)
            )

    def __len__(self) -> int:
        return len(self.examples)

    def __getitem__(self, idx: int) -> dict:
        example = self.examples[idx]
        return {
            "input_ids": torch.tensor(example["input_ids"], dtype=torch.long),
            "attention_mask": torch.tensor(example["attention_mask"], dtype=torch.long),
            "labels": torch.tensor(example["labels"], dtype=torch.long),
        }
