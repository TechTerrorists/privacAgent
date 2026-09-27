import pytest
from privacagent_pii_ner_dataset.schema import Record, Entity
from privacagent_pii_ner_dataset.labels import LABEL_TO_ID
from privacagent_pii_ner_model.dataset import encode_record
from privacagent_pii_ner_model.evaluate import (
    evaluate,
    baseline_predict_fn,
    predict_spans,
)
from privacagent_pii_ner_model.tokenizer import train_tokenizer


def test_window_overlap_counts_original_entity_once(tmp_path):
    text = "alpha beta gamma delta Priya Sharma epsilon zeta eta theta iota kappa"
    tokenizer = train_tokenizer([text] * 30, vocab_size=300, save_dir=str(tmp_path))
    start = text.index("Priya")
    record = Record(
        "r", text, "en", "synthetic", "f", (Entity(start, start + 12, "NAME"),)
    )
    windows = encode_record(tokenizer, record, max_length=8, stride=3)
    assert (
        sum(any(x == LABEL_TO_ID["B-NAME"] for x in w["labels"]) for w in windows) == 2
    )
    report = evaluate(
        baseline_predict_fn(), tokenizer, [record], max_length=8, stride=3
    )
    assert report["overall"]["NAME"]["support"] == 1
    assert report["overall"]["NAME"]["recall"] == 0
    predictions = iter([[x if x != -100 else 0 for x in w["labels"]] for w in windows])
    report = evaluate(
        lambda *_: next(predictions), tokenizer, [record], max_length=8, stride=3
    )
    assert report["overall"]["NAME"]["support"] == 1
    assert report["overall"]["NAME"]["f1-score"] == 1
    with pytest.raises(ValueError, match="prediction length"):
        predict_spans(lambda *_: [], tokenizer, record, max_length=8, stride=3)
