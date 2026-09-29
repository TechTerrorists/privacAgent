from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import onnx
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import BertForTokenClassification

from .tokenizer import load_tokenizer

DEFAULT_MAX_LENGTH = 64
OPSET_VERSION = 17


class _LogitsOnly(torch.nn.Module):
    def __init__(self, model: BertForTokenClassification) -> None:
        super().__init__()
        self.model = model

    def forward(
        self, input_ids: torch.Tensor, attention_mask: torch.Tensor
    ) -> torch.Tensor:
        return self.model(
            input_ids=input_ids, attention_mask=attention_mask, return_dict=False
        )[0]


def sha256_of_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def export(
    model_dir: str,
    out_dir: str,
    max_length: int = DEFAULT_MAX_LENGTH,
    opset: int = OPSET_VERSION,
) -> dict:
    os.makedirs(out_dir, exist_ok=True)

    model = BertForTokenClassification.from_pretrained(model_dir)
    model.eval()
    wrapper = _LogitsOnly(model)

    dummy_input_ids = torch.zeros((1, max_length), dtype=torch.long)
    dummy_attention_mask = torch.ones((1, max_length), dtype=torch.long)

    fp32_path = os.path.join(out_dir, "model.onnx")
    torch.onnx.export(
        wrapper,
        (dummy_input_ids, dummy_attention_mask),
        fp32_path,
        input_names=["input_ids", "attention_mask"],
        output_names=["logits"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
            "logits": {0: "batch", 1: "sequence"},
        },
        opset_version=opset,
        dynamo=False,
    )

    onnx_model = onnx.load(fp32_path)
    onnx.checker.check_model(onnx_model)

    quantized_path = os.path.join(out_dir, "model.quant.onnx")
    quantize_dynamic(fp32_path, quantized_path, weight_type=QuantType.QUInt8)

    tokenizer_dir = os.path.join(out_dir, "tokenizer")
    tokenizer = load_tokenizer(model_dir)
    tokenizer.save_pretrained(tokenizer_dir)

    from privacagent_pii_ner_dataset.labels import LABEL_TO_ID

    (Path(out_dir) / "label_map.json").write_text(
        json.dumps(LABEL_TO_ID, indent=2) + "\n"
    )
    files = sorted(
        p
        for p in Path(out_dir).rglob("*")
        if p.is_file()
        and (
            p.parent.name == "tokenizer"
            or p.name in ("model.onnx", "model.quant.onnx", "label_map.json")
        )
    )
    manifest = {
        "format_version": 1,
        "detector_coverage_validated": False,
        "python_offset_unit": "unicode_code_point",
        "browser_offset_unit": "utf16_code_unit",
        "window_merge": "max_context_token_then_decode_bio",
        "files": {
            str(p.relative_to(out_dir)): {
                "sha256": sha256_of_file(str(p)),
                "size_bytes": p.stat().st_size,
            }
            for p in files
        },
        "opset": opset,
        "max_length": max_length,
        "input_names": ["input_ids", "attention_mask"],
        "output_names": ["logits"],
        "dynamic_axes": ["batch", "sequence"],
        "artifacts": {
            "fp32_onnx": {
                "path": "model.onnx",
                "size_bytes": os.path.getsize(fp32_path),
                "sha256": sha256_of_file(fp32_path),
            },
            "quantized_onnx": {
                "path": "model.quant.onnx",
                "size_bytes": os.path.getsize(quantized_path),
                "sha256": sha256_of_file(quantized_path),
            },
        },
    }
    with open(
        os.path.join(out_dir, "export_manifest.json"), "w", encoding="utf-8"
    ) as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=str, required=True)
    parser.add_argument("--out-dir", type=str, required=True)
    parser.add_argument("--max-length", type=int, default=DEFAULT_MAX_LENGTH)
    parser.add_argument("--opset", type=int, default=OPSET_VERSION)
    args = parser.parse_args()

    manifest = export(args.model_dir, args.out_dir, args.max_length, args.opset)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
