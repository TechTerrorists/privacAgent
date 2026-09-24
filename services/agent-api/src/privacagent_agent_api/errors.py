"""Bounded ``ProtocolError`` construction and the HTTP status mapping (E-02).

Every failure body is an E-01 ``ProtocolError``; the wire schema is the only
source of truth and request contents are never echoed back. FastAPI/Pydantic
input dumps are not exposed because routes never bind generated models to
request bodies.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import RootModel

from privacagent_protocol import PROTOCOL_VERSION

HTTP_STATUS_BY_CODE: dict[str, int] = {
    "invalid_request": 400,
    "unsupported_version": 400,
    "session_expired": 404,
    "unauthorized": 401,
    "rate_limited": 429,
    "unavailable": 503,
    "resync_required": 409,
}

_RETRYABLE_BY_CODE: dict[str, bool] = {
    "invalid_request": False,
    "unsupported_version": False,
    "session_expired": True,
    "unauthorized": False,
    "rate_limited": True,
    "unavailable": True,
    "resync_required": True,
}

_CORRELATION_FIELDS = ("session_id", "task_id", "task_version", "seq")


class ProtocolReject(Exception):
    """Internal signal: raise to have the app return a bounded ProtocolError."""

    def __init__(self, code: str, *, correlation: Mapping[str, Any] | None = None) -> None:
        if code not in HTTP_STATUS_BY_CODE:
            raise ValueError(f"unknown ProtocolError code: {code}")
        self.code = code
        self.correlation = dict(correlation or {})
        super().__init__(code)


def correlation_of(message: Any) -> dict[str, Any]:
    """Pull the subset of correlation fields the ProtocolError schema permits.

    Works for generated models and for ``RootModel`` wrappers (``ScreenState``).
    Only fields that are actually set are included; nothing else from the
    message is ever copied into an error body.
    """
    node = getattr(message, "root", message)
    out: dict[str, Any] = {}
    for field in _CORRELATION_FIELDS:
        value = getattr(node, field, None)
        if value is None:
            continue
        out[field] = value.root if isinstance(value, RootModel) else value
    return out


def build_protocol_error(
    code: str,
    *,
    correlation: Mapping[str, Any] | None = None,
    retryable: bool | None = None,
) -> dict[str, Any]:
    """Build a ProtocolError payload (validated by the caller before sending)."""
    payload: dict[str, Any] = {"protocol": PROTOCOL_VERSION}
    for field in _CORRELATION_FIELDS:
        value = (correlation or {}).get(field)
        if value is not None:
            payload[field] = value
    payload["code"] = code
    payload["retryable"] = _RETRYABLE_BY_CODE[code] if retryable is None else retryable
    return payload