from privacagent_pii_ner_dataset.labels import LABEL_TO_ID, ID_TO_LABEL

from privacagent_pii_ner_model.align import align_labels_with_offsets, decode_predictions_to_spans


def test_align_single_token_entity():
    text = "Priya lives here"
    entities = [(0, 5, "NAME")]
    offsets = [(0, 0), (0, 5), (6, 11), (12, 16), (0, 0)]
    labels = align_labels_with_offsets(entities, offsets, LABEL_TO_ID)
    assert labels == [
        -100,
        LABEL_TO_ID["B-NAME"],
        LABEL_TO_ID["O"],
        LABEL_TO_ID["O"],
        -100,
    ]


def test_align_multi_subword_entity_gets_b_then_i():
    text = "Chakradhar lives here"
    entities = [(0, 10, "NAME")]
    offsets = [(0, 0), (0, 5), (5, 10), (11, 16), (17, 21), (0, 0)]
    labels = align_labels_with_offsets(entities, offsets, LABEL_TO_ID)
    assert labels[1] == LABEL_TO_ID["B-NAME"]
    assert labels[2] == LABEL_TO_ID["I-NAME"]
    assert labels[3] == LABEL_TO_ID["O"]


def test_align_two_adjacent_entities_of_same_type_each_get_their_own_b():
    entities = [(0, 5, "NAME"), (6, 11, "NAME")]
    offsets = [(0, 0), (0, 5), (6, 11), (0, 0)]
    labels = align_labels_with_offsets(entities, offsets, LABEL_TO_ID)
    assert labels[1] == LABEL_TO_ID["B-NAME"]
    assert labels[2] == LABEL_TO_ID["B-NAME"]


def test_decode_round_trips_a_multi_token_entity():
    offsets = [(0, 0), (0, 5), (5, 10), (11, 16), (0, 0)]
    predicted = [
        -100,
        LABEL_TO_ID["B-NAME"],
        LABEL_TO_ID["I-NAME"],
        LABEL_TO_ID["O"],
        -100,
    ]
    spans = decode_predictions_to_spans(offsets, predicted, ID_TO_LABEL)
    assert spans == [(0, 10, "NAME")]


def test_decode_handles_second_window_offsets_not_reset_to_zero():
    offsets = [(0, 0), (200, 205), (206, 211), (0, 0)]
    predicted = [-100, LABEL_TO_ID["B-LOCATION"], LABEL_TO_ID["I-LOCATION"], -100]
    spans = decode_predictions_to_spans(offsets, predicted, ID_TO_LABEL)
    assert spans == [(200, 211, "LOCATION")]
