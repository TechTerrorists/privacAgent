import json
from pathlib import Path

import pytest
from jsonschema import Draft7Validator
from pydantic import ValidationError

from privacagent_protocol import (
    MESSAGE_NAMES,
    PROTOCOL_VERSION,
    ProtocolValidationError,
    get_schema,
    is_message,
    models,
    parse_message,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
VALID = json.loads((FIXTURES / "valid.json").read_text())
INVALID = json.loads((FIXTURES / "invalid.json").read_text())


@pytest.mark.parametrize("case", VALID, ids=lambda c: c["name"])
def test_valid_roundtrip(case):
    model = parse_message(case["message"], case["payload"])
    restored = json.loads(model.model_dump_json(exclude_unset=True))
    assert restored == case["payload"]
    assert is_message(case["message"], restored)


@pytest.mark.parametrize("case", INVALID, ids=lambda c: c["name"])
def test_invalid_messages(case):
    assert not is_message(case["message"], case["payload"])
    with pytest.raises(ProtocolValidationError, match="^Invalid protocol message$"):
        parse_message(case["message"], case["payload"])


def test_every_boundary_has_a_fixture_and_self_contained_schema():
    assert set(MESSAGE_NAMES) == {case["message"] for case in VALID}
    assert PROTOCOL_VERSION == "1.0"
    for name in MESSAGE_NAMES:
        schema = get_schema(name)
        Draft7Validator.check_schema(schema)
        validator = Draft7Validator(schema)
        for case in VALID:
            if case["message"] == name:
                assert validator.is_valid(case["payload"])


def test_exported_schema_is_a_copy():
    schema = get_schema("Action")
    schema["definitions"].clear()
    assert get_schema("Action")["definitions"]


def test_pydantic_models_forbid_extra_fields():
    case = next(c for c in VALID if c["message"] == "SessionStartResponse")
    with pytest.raises(ValidationError):
        models.SessionStartResponse.model_validate(
            {**case["payload"], "html": "PRIVATE_CANARY"}
        )


@pytest.mark.parametrize("number", [float("nan"), float("inf"), -float("inf")])
def test_non_json_numbers_are_rejected(number):
    case = next(c for c in VALID if c["message"] == "ScreenState")
    payload = json.loads(json.dumps(case["payload"]))
    payload["elements"][0]["bbox"][0] = number
    assert not is_message("ScreenState", payload)


def test_unknown_message_name_is_a_payload_free_error():
    with pytest.raises(ProtocolValidationError, match="^Invalid protocol message$"):
        parse_message("PRIVATE_CANARY", {})


def test_all_messages_reject_unknown_versions():
    for case in VALID:
        assert not is_message(case["message"], {**case["payload"], "protocol": "2.0"})
