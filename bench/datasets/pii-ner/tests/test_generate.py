from privacagent_pii_ner_dataset.generate import generate_english, generate_hindi
from privacagent_pii_ner_dataset.validate import validate_records


def test_english_generation_is_deterministic_for_fixed_seed():
    a = generate_english(seed=123, count_per_template=2)
    b = generate_english(seed=123, count_per_template=2)
    assert [r.text for r in a] == [r.text for r in b]


def test_hindi_generation_is_deterministic_for_fixed_seed():
    a = generate_hindi(seed=123, count_per_template=2)
    b = generate_hindi(seed=123, count_per_template=2)
    assert [r.text for r in a] == [r.text for r in b]


def test_entity_spans_match_substrings():
    records = generate_english(count_per_template=3) + generate_hindi(count_per_template=3)
    for record in records:
        for entity in record.entities:
            span_text = record.text[entity.start : entity.end]
            assert span_text.strip() == span_text
            assert len(span_text) > 0


def test_generated_records_pass_validation():
    records = generate_english(count_per_template=2) + generate_hindi(count_per_template=2)
    validate_records(records)


def test_negative_templates_have_no_entities():
    records = generate_english(count_per_template=1)
    negatives = [r for r in records if r.family.startswith("en_neg_")]
    assert len(negatives) > 0
    for record in negatives:
        assert record.entities == ()
