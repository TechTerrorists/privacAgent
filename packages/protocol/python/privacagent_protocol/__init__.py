"""E-01 protocol boundary. Use parse_message on untrusted decoded JSON."""

import json
from importlib.resources import files
from typing import Any

from jsonschema import Draft7Validator
from pydantic import BaseModel, ValidationError

from . import models
from ._registry import MESSAGE_MODELS, PROTOCOL_VERSION

__all__ = [
    "models",
    "MESSAGE_NAMES",
    "PROTOCOL_VERSION",
    "ProtocolValidationError",
    "parse_message",
    "is_message",
    "get_schema",
]

MESSAGE_NAMES = tuple(MESSAGE_MODELS)
_SCHEMA = json.loads(
    files(__package__).joinpath("_schema.json").read_text(encoding="utf-8")
)
_VALIDATORS = {
    name: Draft7Validator({**_SCHEMA, "oneOf": [{"$ref": f"#/definitions/{name}"}]})
    for name in MESSAGE_NAMES
}


class ProtocolValidationError(ValueError):
    """A payload-free error, safe to report without copying page data."""

    def __init__(self) -> None:
        super().__init__("Invalid protocol message")


def get_schema(name: str) -> dict[str, Any]:
    """Return a self-contained schema for validation or constrained decoding."""
    if name not in MESSAGE_MODELS:
        raise ProtocolValidationError()
    return {
        "$schema": _SCHEMA["$schema"],
        "$ref": f"#/definitions/{name}",
        "definitions": json.loads(json.dumps(_SCHEMA["definitions"])),
    }


def parse_message(name: str, value: Any) -> BaseModel:
    """Validate the exact wire contract, then return the generated Pydantic model.

    Generated models alone cannot express every JSON Schema constraint, notably
    optional-but-non-null fields and union exclusivity. Validate the schema first.
    This checks structure only; D-11 must separately authorize client egress.
    """
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError):
        raise ProtocolValidationError() from None
    if name not in MESSAGE_MODELS or not _VALIDATORS[name].is_valid(value):
        raise ProtocolValidationError()
    try:
        return MESSAGE_MODELS[name].model_validate(value)
    except ValidationError:
        raise ProtocolValidationError() from None


def is_message(name: str, value: Any) -> bool:
    try:
        parse_message(name, value)
    except ProtocolValidationError:
        return False
    return True
