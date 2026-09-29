from __future__ import annotations

import os

from tokenizers import Tokenizer
from tokenizers.models import WordPiece
from tokenizers.normalizers import BertNormalizer
from tokenizers.pre_tokenizers import BertPreTokenizer
from tokenizers.processors import TemplateProcessing
from tokenizers.trainers import WordPieceTrainer
from transformers import BertTokenizerFast

SPECIAL_TOKENS = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]


def train_tokenizer(
    texts: list[str], vocab_size: int, save_dir: str
) -> BertTokenizerFast:
    tokenizer = Tokenizer(WordPiece(unk_token="[UNK]"))
    tokenizer.normalizer = BertNormalizer(
        clean_text=True, handle_chinese_chars=True, strip_accents=False, lowercase=False
    )
    tokenizer.pre_tokenizer = BertPreTokenizer()

    trainer = WordPieceTrainer(vocab_size=vocab_size, special_tokens=SPECIAL_TOKENS)
    tokenizer.train_from_iterator(texts, trainer=trainer)

    cls_id = tokenizer.token_to_id("[CLS]")
    sep_id = tokenizer.token_to_id("[SEP]")
    tokenizer.post_processor = TemplateProcessing(
        single="[CLS] $A [SEP]",
        pair="[CLS] $A [SEP] $B:1 [SEP]:1",
        special_tokens=[("[CLS]", cls_id), ("[SEP]", sep_id)],
    )

    os.makedirs(save_dir, exist_ok=True)
    tokenizer.save(os.path.join(save_dir, "tokenizer.json"))

    fast_tokenizer = BertTokenizerFast(
        tokenizer_object=tokenizer,
        unk_token="[UNK]",
        pad_token="[PAD]",
        cls_token="[CLS]",
        sep_token="[SEP]",
        mask_token="[MASK]",
        do_lower_case=False,
        strip_accents=False,
        tokenize_chinese_chars=True,
    )
    fast_tokenizer.save_pretrained(save_dir)
    return fast_tokenizer


def load_tokenizer(save_dir: str) -> BertTokenizerFast:
    return BertTokenizerFast.from_pretrained(save_dir)
