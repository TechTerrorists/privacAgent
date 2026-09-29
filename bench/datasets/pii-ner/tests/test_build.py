import json
import pytest
from privacagent_pii_ner_dataset.build import build
from privacagent_pii_ner_dataset.schema import Record


def test_frozen_manifest_verifies_bytes_and_rejects_drift(tmp_path, monkeypatch):
    import privacagent_pii_ner_dataset.build as module

    calls = []

    def corpus(lang, count, split):
        calls.append((lang, split))
        return [
            Record(
                f"{lang}_{split}",
                f"{lang} corpus {split}",
                lang,
                "wikiann",
                f"wikiann_{lang}_{split}",
            )
        ]

    monkeypatch.setattr(module, "load_wikiann", corpus)
    first = tmp_path / "first"
    build(out_dir=str(first))
    manifest = first / "dataset_manifest.json"
    build(out_dir=str(tmp_path / "second"), verify_manifest=str(manifest))
    assert set(calls) == {
        (lang, split)
        for lang in ("en", "hi")
        for split in ("train", "validation", "test")
    }
    value = json.loads(manifest.read_text())
    value["sha256"]["test.jsonl"] = "0" * 64
    manifest.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="frozen manifest"):
        build(out_dir=str(tmp_path / "third"), verify_manifest=str(manifest))
