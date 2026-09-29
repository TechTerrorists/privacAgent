from privacagent_pii_ner_model.tokenizer import train_tokenizer

TRAIN_TEXTS = [
    "मेरा नाम अनिल शर्मा है और मैं जयपुर में रहता हूँ।",
    "प्रिया सिंह पुणे में काम करती हैं।",
    "Priya Sharma lives in Pune.",
    "Contact Anil Sharma at his office in Jaipur.",
] * 20


def test_devanagari_combining_marks_are_not_dropped(tmp_path):
    tokenizer = train_tokenizer(TRAIN_TEXTS, vocab_size=500, save_dir=str(tmp_path))
    text = "मेरा नाम अनिल शर्मा है"
    encoding = tokenizer(text, return_offsets_mapping=True)
    reconstructed = "".join(
        text[start:end] for start, end in encoding["offset_mapping"] if end > start
    )
    assert reconstructed.replace(" ", "") == text.replace(" ", "")


def test_english_case_is_preserved(tmp_path):
    tokenizer = train_tokenizer(TRAIN_TEXTS, vocab_size=500, save_dir=str(tmp_path))
    text = "Priya Sharma"
    encoding = tokenizer(text, return_offsets_mapping=True)
    reconstructed = "".join(
        text[start:end] for start, end in encoding["offset_mapping"] if end > start
    )
    assert reconstructed.replace(" ", "") == text.replace(" ", "")


def test_offsets_are_valid_slices_into_original_text(tmp_path):
    tokenizer = train_tokenizer(TRAIN_TEXTS, vocab_size=500, save_dir=str(tmp_path))
    text = "प्रिया सिंह पुणे में काम करती हैं।"
    encoding = tokenizer(text, return_offsets_mapping=True)
    for start, end in encoding["offset_mapping"]:
        assert 0 <= start <= end <= len(text)
