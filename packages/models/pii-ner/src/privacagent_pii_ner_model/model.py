from __future__ import annotations

from transformers import BertConfig, BertForTokenClassification

from privacagent_pii_ner_dataset.labels import ID_TO_LABEL, LABEL_TO_ID

HIDDEN_SIZE = 128
NUM_HIDDEN_LAYERS = 2
NUM_ATTENTION_HEADS = 2
INTERMEDIATE_SIZE = 512
MAX_POSITION_EMBEDDINGS = 128


def build_model(vocab_size: int) -> BertForTokenClassification:
    config = BertConfig(
        vocab_size=vocab_size,
        hidden_size=HIDDEN_SIZE,
        num_hidden_layers=NUM_HIDDEN_LAYERS,
        num_attention_heads=NUM_ATTENTION_HEADS,
        intermediate_size=INTERMEDIATE_SIZE,
        max_position_embeddings=MAX_POSITION_EMBEDDINGS,
        num_labels=len(LABEL_TO_ID),
        id2label=ID_TO_LABEL,
        label2id=LABEL_TO_ID,
    )
    return BertForTokenClassification(config)


def count_parameters(model: BertForTokenClassification) -> int:
    return sum(p.numel() for p in model.parameters())
