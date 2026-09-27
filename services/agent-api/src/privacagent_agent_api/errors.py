"""Bounded ``ProtocolError`` construction and the HTTP status mapping (E-02).

Every failure body is an E-01 ``ProtocolError``; the wire schema is the only
source of truth and request contents are never echoed back. FastAPI/Pydantic
input dumps are not exposed because routes never bind generated models to
request bodies.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from enum import Enum
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


class RejectReason(str, Enum):
    """Closed diagnostic vocabulary; never accepts request-derived strings."""

    NOT_UTF8 = "stage=read_json detail=not_utf8"
    MALFORMED_JSON = "stage=read_json detail=malformed_json"
    INVALID_SCHEMA = "stage=parse_message detail=invalid_schema"
    INVALID_SESSION_ID = "stage=path_param detail=invalid_session_id"
    RESPONSE_OFF_CONTRACT = "stage=checked_response detail=response_off_contract"
    BODY_MISSING_SESSION_ID = "stage=path_body_match detail=body_missing_session_id"
    SESSION_ID_MISMATCH = "stage=path_body_match detail=session_id_mismatch"
    BODY_MISSING_TASK_FIELDS = "stage=task_identity detail=body_missing_task_fields"
    TASK_MISMATCH = "stage=task_identity detail=task_mismatch"
    STORE_GET_REDIS_ERROR = "stage=store_get detail=redis_error"
    SESSION_NOT_FOUND = "stage=store_get detail=session_not_found"
    STORE_ADVANCE_REDIS_ERROR = "stage=store_advance detail=redis_error"
    SESSION_VANISHED = "stage=store_advance detail=session_vanished"
    STORE_CREATE_REDIS_ERROR = "stage=store_create detail=redis_error"
    DIFF_STATE_REQUIRES_FULL_RESYNC = (
        "stage=step detail=diff_state_requires_full_resync"
    )
    ACTION_OFF_CONTRACT = "stage=planner detail=action_off_contract"
    ACTION_ID_MISMATCH = "stage=feedback detail=action_id_mismatch"
    STORE_DELETE_REDIS_ERROR = "stage=store_delete detail=redis_error"
    VLM_NOT_IMPLEMENTED_UNTIL_E11 = (
        "stage=escalate detail=vlm_not_implemented_until_e11"
    )
    BODY_TOO_LARGE = "stage=read_json detail=body_too_large"


# Bounded shape for dynamic reasons: a stage token plus a detail token, both
# derived from code (never from request or payload content), so a dynamic
# reason can be validated exactly like an enum member.
_DYNAMIC_REASON_RE = re.compile(
    r"\Astage=[a-z][a-z_]{0,31} detail=[A-Za-z_][A-Za-z0-9_]{0,63}\Z"
)


def prompt_build_reason(exc: BaseException) -> str:
    """``stage=prompt detail=<ExceptionClassName>`` for prompt-build failures.

    Only the exception class name is carried (code-derived); its message and
    args are never included. A name that does not fit the bounded pattern
    falls back to a fixed token so the reason always validates.
    """
    name = type(exc).__name__
    if not _DYNAMIC_REASON_RE.fullmatch(f"stage=prompt detail={name}"):
        name = "exception"
    return f"stage=prompt detail={name}"


class ProtocolReject(Exception):
    """Internal signal: raise to have the app return a bounded ProtocolError.

    ``reason`` is either a member of a closed diagnostic enum or a bounded
    dynamic ``stage=... detail=...`` string matching ``_DYNAMIC_REASON_RE``
    (derived from code, never from request or payload content); it is written
    to the debug log only. It is never serialized into the HTTP response body
    and never carries payload.
    """

    def __init__(
        self,
        code: str,
        *,
        correlation: Mapping[str, Any] | None = None,
        reason: RejectReason | str | None = None,
    ) -> None:
        if code not in HTTP_STATUS_BY_CODE:
            raise ValueError(f"unknown ProtocolError code: {code}")
        if reason is not None and not isinstance(reason, RejectReason):
            if not (isinstance(reason, str) and _DYNAMIC_REASON_RE.fullmatch(reason)):
                raise TypeError(
                    "reason must be a RejectReason or a bounded "
                    "'stage=... detail=...' string"
                )
        self.code = code
        self.correlation = dict(correlation or {})
        self.reason = reason
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
