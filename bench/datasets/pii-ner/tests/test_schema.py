import pytest

from privacagent_pii_ner_dataset.schema import (
    Entity,
    InvalidRecordError,
    Record,
    read_jsonl,
    write_jsonl,
)


def test_valid_record_construction():
    record = Record(
        id="r1",
        text="Hello Priya from Pune",
        lang="en",
        source="synthetic",
        family="f1",
        entities=(
            Entity(start=6, end=11, label="NAME"),
            Entity(start=17, end=21, label="LOCATION"),
        ),
    )
    assert record.text[6:11] == "Priya"
    assert record.text[17:21] == "Pune"


def test_entity_end_beyond_text_raises():
    with pytest.raises(InvalidRecordError):
        Record(
            id="r1",
            text="short",
            lang="en",
            source="synthetic",
            family="f1",
            entities=(Entity(start=0, end=100, label="NAME"),),
        )


def test_overlapping_entities_raise():
    with pytest.raises(InvalidRecordError):
        Record(
            id="r1",
            text="Priya Sharma",
            lang="en",
            source="synthetic",
            family="f1",
            entities=(
                Entity(start=0, end=5, label="NAME"),
                Entity(start=3, end=12, label="NAME"),
            ),
        )


def test_unsupported_lang_raises():
    with pytest.raises(InvalidRecordError):
        Record(id="r1", text="x", lang="fr", source="synthetic", family="f1")


def test_non_bmp_character_offsets_are_python_code_points():
    text = "🔥🔥 Priya Sharma called."
    start = text.index("Priya")
    assert start == 3
    end = start + len("Priya Sharma")
    record = Record(
        id="r1",
        text=text,
        lang="en",
        source="synthetic",
        family="f1",
        entities=(Entity(start=start, end=end, label="NAME"),),
    )
    assert text[record.entities[0].start : record.entities[0].end] == "Priya Sharma"


def test_devanagari_combining_marks_do_not_shift_offsets():
    text = "नमस्ते प्रिया शर्मा से मिलें।"
    start = text.index("प्रिया")
    end = start + len("प्रिया शर्मा")
    record = Record(
        id="r1",
        text=text,
        lang="hi",
        source="synthetic",
        family="f1",
        entities=(Entity(start=start, end=end, label="NAME"),),
    )
    assert text[record.entities[0].start : record.entities[0].end] == "प्रिया शर्मा"


def test_jsonl_round_trip(tmp_path):
    record = Record(
        id="r1",
        text="नमस्ते Priya",
        lang="en",
        source="synthetic",
        family="f1",
        entities=(Entity(start=7, end=12, label="NAME"),),
    )
    path = tmp_path / "out.jsonl"
    write_jsonl([record], str(path))
    loaded = read_jsonl(str(path))
    assert loaded == [record]
