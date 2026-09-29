import json

from privacagent_pii_ner_dataset.labels import LABEL_TO_ID

from privacagent_pii_ner_model.export_onnx import export
from privacagent_pii_ner_model.model import build_model
from privacagent_pii_ner_model.parity import check_parity
from privacagent_pii_ner_model.tokenizer import train_tokenizer

TRAIN_TEXTS = [
    "Contact Priya Sharma for details.",
    "मेरा नाम अनिल शर्मा है।",
    "This is unrelated filler text.",
    "यह असंबंधित पाठ है।",
] * 10


def _build_tiny_model_dir(tmp_path):
    model_dir = tmp_path / "model"
    tokenizer = train_tokenizer(TRAIN_TEXTS, vocab_size=300, save_dir=str(model_dir))
    model = build_model(vocab_size=tokenizer.vocab_size)
    model.save_pretrained(str(model_dir))
    tokenizer.save_pretrained(str(model_dir))
    with open(model_dir / "label_map.json", "w", encoding="utf-8") as f:
        json.dump(LABEL_TO_ID, f)
    return str(model_dir)


def test_onnx_export_contract_shapes_and_names(tmp_path):
    model_dir = _build_tiny_model_dir(tmp_path)
    out_dir = str(tmp_path / "export")

    manifest = export(model_dir, out_dir, max_length=16)

    assert manifest["input_names"] == ["input_ids", "attention_mask"]
    assert manifest["output_names"] == ["logits"]
    assert manifest["opset"] == 17
    assert manifest["artifacts"]["fp32_onnx"]["size_bytes"] > 0
    assert manifest["artifacts"]["quantized_onnx"]["size_bytes"] > 0
    assert len(manifest["artifacts"]["fp32_onnx"]["sha256"]) == 64
    assert (
        manifest["artifacts"]["quantized_onnx"]["size_bytes"]
        < manifest["artifacts"]["fp32_onnx"]["size_bytes"]
    )


def test_native_and_onnx_predictions_agree_on_a_fixture_set(tmp_path):
    model_dir = _build_tiny_model_dir(tmp_path)
    out_dir = str(tmp_path / "export")
    export(model_dir, out_dir, max_length=16)

    fixture_texts = [
        "Contact Priya Sharma for details.",
        "मेरा नाम अनिल शर्मा है।",
    ]
    report = check_parity(
        model_dir,
        out_dir + "/model.onnx",
        fixture_texts,
        max_length=16,
    )
    assert report["num_examples"] == 2
    assert report["label_agreement_rate"] == 1.0
    assert report["max_abs_logit_diff"] < 1e-3
