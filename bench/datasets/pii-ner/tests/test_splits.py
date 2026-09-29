from privacagent_pii_ner_dataset.generate import generate_all
from privacagent_pii_ner_dataset.splits import assert_no_leakage, deduplicate, split_by_family
from privacagent_pii_ner_dataset.schema import Record


def test_split_produces_no_family_or_text_leakage():
    records = generate_all(seed=7)
    splits = split_by_family(records, seed=7)
    assert_no_leakage(splits)
    assert len(splits.train) > 0
    assert len(splits.val) > 0
    assert len(splits.test) > 0


def test_split_is_deterministic_for_fixed_seed():
    records = generate_all(seed=7)
    a = split_by_family(records, seed=7)
    b = split_by_family(records, seed=7)
    assert [r.id for r in a.train] == [r.id for r in b.train]
    assert [r.id for r in a.val] == [r.id for r in b.val]
    assert [r.id for r in a.test] == [r.id for r in b.test]


def test_deduplicate_removes_identical_text():
    a = Record(id="a", text="same text", lang="en", source="synthetic", family="f1")
    b = Record(id="b", text="same text", lang="en", source="synthetic", family="f1")
    c = Record(id="c", text="different text", lang="en", source="synthetic", family="f2")
    deduped = deduplicate([a, b, c])
    assert len(deduped) == 2
