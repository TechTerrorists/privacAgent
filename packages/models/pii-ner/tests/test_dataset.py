from privacagent_pii_ner_dataset.schema import Entity, Record
from privacagent_pii_ner_dataset.labels import LABEL_TO_ID

from privacagent_pii_ner_model.dataset import encode_record
from privacagent_pii_ner_model.tokenizer import train_tokenizer

TRAIN_TEXTS = [
    "Contact Priya Sharma for details.",
    "This is filler text about nothing in particular.",
] * 30


def _tokenizer(tmp_path):
    return train_tokenizer(TRAIN_TEXTS, vocab_size=300, save_dir=str(tmp_path))


def test_short_text_produces_a_single_window(tmp_path):
    tokenizer = _tokenizer(tmp_path)
    record = Record(
        id="r1",
        text="Contact Priya Sharma for details.",
        lang="en",
        source="synthetic",
        family="f1",
        entities=(Entity(start=8, end=20, label="NAME"),),
    )
    windows = encode_record(tokenizer, record, max_length=32, stride=8)
    assert len(windows) == 1
    assert any(label not in (LABEL_TO_ID["O"], -100) for label in windows[0]["labels"])


def test_long_text_windows_preserve_original_text_offsets(tmp_path):
    tokenizer = _tokenizer(tmp_path)
    long_text = ("This is filler text. " * 20) + "Contact Priya Sharma for details."
    start = long_text.index("Priya Sharma")
    record = Record(
        id="long1",
        text=long_text,
        lang="en",
        source="synthetic",
        family="f1",
        entities=(Entity(start=start, end=start + len("Priya Sharma"), label="NAME"),),
    )
    windows = encode_record(tokenizer, record, max_length=32, stride=8)

    assert len(windows) > 1

    offsets_seen = [pair for w in windows for pair in w["offset_mapping"] if pair[1] > pair[0]]
    assert max(end for _, end in offsets_seen) > 32

    later_window_offsets = [pair for pair in windows[-1]["offset_mapping"] if pair[1] > pair[0]]
    assert min(s for s, _ in later_window_offsets) > 0

    entity_found_in_some_window = any(
        any(label not in (LABEL_TO_ID["O"], -100) for label in w["labels"]) for w in windows
    )
    assert entity_found_in_some_window
