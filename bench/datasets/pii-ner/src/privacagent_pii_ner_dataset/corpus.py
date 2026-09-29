from __future__ import annotations

from .schema import Entity, Record

WIKIANN_TAG_TO_ENTITY: dict[str, str] = {
    "PER": "NAME",
    "ORG": "ORG",
    "LOC": "LOCATION",
}

WIKIANN_DATASET_ID = "unimelb-nlp/wikiann"
WIKIANN_LICENSE = "CC BY-SA 3.0 (derived from Wikipedia via WikiAnn/PAN-X, redistributed through the Hugging Face Hub)"
WIKIANN_CITATION = "Pan et al. 2017, 'Cross-lingual Name Tagging and Linking for 282 Languages', ACL."


def _wikiann_tag_names(ner_tags_feature) -> list[str]:
    return ner_tags_feature.feature.names


def convert_wikiann_split(
    hf_split, lang: str, split_name: str, family_chunk_size: int = 25
) -> list[Record]:
    tag_names = _wikiann_tag_names(hf_split.features["ner_tags"])
    records: list[Record] = []

    for row_idx, row in enumerate(hf_split):
        tokens: list[str] = row["tokens"]
        tag_ids: list[int] = row["ner_tags"]
        tags = [tag_names[t] for t in tag_ids]

        text_parts: list[str] = []
        token_spans: list[tuple[int, int]] = []
        cursor = 0
        for token in tokens:
            if text_parts:
                text_parts.append(" ")
                cursor += 1
            start = cursor
            text_parts.append(token)
            cursor += len(token)
            token_spans.append((start, cursor))
        text = "".join(text_parts)

        entities: list[Entity] = []
        open_entity: tuple[str, int, int] | None = None
        for (tok_start, tok_end), tag in zip(token_spans, tags):
            if tag == "O":
                if open_entity is not None:
                    label, e_start, e_end = open_entity
                    entities.append(Entity(start=e_start, end=e_end, label=label))
                    open_entity = None
                continue
            bio, wikiann_type = tag.split("-", 1)
            mapped = WIKIANN_TAG_TO_ENTITY.get(wikiann_type)
            if mapped is None:
                if open_entity is not None:
                    label, e_start, e_end = open_entity
                    entities.append(Entity(start=e_start, end=e_end, label=label))
                    open_entity = None
                continue
            if bio == "B" or open_entity is None or open_entity[0] != mapped:
                if open_entity is not None:
                    label, e_start, e_end = open_entity
                    entities.append(Entity(start=e_start, end=e_end, label=label))
                open_entity = (mapped, tok_start, tok_end)
            else:
                open_entity = (mapped, open_entity[1], tok_end)
        if open_entity is not None:
            label, e_start, e_end = open_entity
            entities.append(Entity(start=e_start, end=e_end, label=label))

        chunk_idx = row_idx // family_chunk_size
        records.append(
            Record(
                id=f"wikiann_{lang}_{split_name}_{row_idx}",
                text=text,
                lang=lang,
                source="wikiann",
                family=f"wikiann_{lang}_chunk_{chunk_idx}",
                entities=tuple(entities),
            )
        )

    return records


def load_wikiann(lang: str, max_examples: int, split: str = "train") -> list[Record]:
    from datasets import load_dataset

    hf_split = load_dataset(WIKIANN_DATASET_ID, lang, split=f"{split}[:{max_examples}]")
    return convert_wikiann_split(hf_split, lang=lang, split_name=split)
