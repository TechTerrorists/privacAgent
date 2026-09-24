"""FastAPI application and E-01 wire routes (E-02 skeleton).

Request validation goes through the E-01 boundary (``parse_message``), which is
the authoritative schema check; generated Pydantic models are used to double
check and serialize responses, and every response is re-validated through
``parse_message`` before it is sent. Routes read raw JSON themselves, so
FastAPI/Pydantic input dumps are never produced for these endpoints.

Diff Screen States are never interpreted as complete pages: without
reconstruction support (E-07/E-08) they get an explicit
``resync_required`` ``ProtocolError``. Escalation is registered but replies
with an ``unavailable`` ``ProtocolError`` until E-11 supplies VLM behavior.
"""

from __future__ import annotations

import json
import logging
import secrets
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from privacagent_protocol import (
    PROTOCOL_VERSION,
    ProtocolValidationError,
    get_schema,
    models,
    parse_message,
)

from .config import Settings
from .errors import (
    HTTP_STATUS_BY_CODE,
    ProtocolReject,
    RejectReason,
    build_protocol_error,
)
from .fixtures import builtin_scenarios
from .planner import Planner, ScriptedFakePlanner
from .session_store import (
    RedisSessionStore,
    SessionRecord,
    SessionStore,
    SessionStoreError,
)

logger = logging.getLogger("privacagent.agent_api")

_LOG_FORMAT = "%(asctime)s %(levelname)s %(message)s"
_configured_debug_path: str | None = None


def _configure_debug_file_logging(path: str) -> None:
    """Attach a single DEBUG file handler (idempotent) for reject diagnostics.

    The log records only fixed stage and reason codes —
    never request-body values, page text, or other payload content.
    """
    global _configured_debug_path
    target = str(Path(path).resolve()) if path else None
    if _configured_debug_path == target:
        return
    for handler in list(logger.handlers):
        if isinstance(handler, logging.FileHandler):
            logger.removeHandler(handler)
            handler.close()
    if target is None:
        _configured_debug_path = None
        return
    file_handler = logging.FileHandler(target, encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(logging.Formatter(_LOG_FORMAT))
    logger.setLevel(logging.DEBUG)
    logger.addHandler(file_handler)
    _configured_debug_path = target


def _rewrite_schema_refs(value: Any) -> None:
    if isinstance(value, dict):
        ref = value.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/definitions/"):
            value["$ref"] = "#/components/schemas/" + ref[len("#/definitions/") :]
        for child in value.values():
            _rewrite_schema_refs(child)
    elif isinstance(value, list):
        for child in value:
            _rewrite_schema_refs(child)


_E01_COMPONENT_SCHEMAS: dict[str, Any] = json.loads(
    json.dumps(get_schema("SessionStartRequest")["definitions"])
)
_rewrite_schema_refs(_E01_COMPONENT_SCHEMAS)


def _request_body(message_name: str, example: dict[str, Any]) -> dict[str, Any]:
    return {
        "required": True,
        "content": {
            "application/json": {
                "schema": {"$ref": f"#/components/schemas/{message_name}"},
                "example": example,
            }
        },
    }


def _success_response(
    message_name: str, example: dict[str, Any] | None = None
) -> dict[str, Any]:
    media: dict[str, Any] = {"schema": {"$ref": f"#/components/schemas/{message_name}"}}
    if example is not None:
        media["example"] = example
    return {
        "description": "Successful response",
        "content": {"application/json": media},
    }


def _error_response(code: str, description: str) -> dict[str, Any]:
    return {
        str(HTTP_STATUS_BY_CODE[code]): {
            "description": description,
            "content": {
                "application/json": {
                    "schema": {"$ref": "#/components/schemas/ProtocolError"},
                    "example": build_protocol_error(code),
                }
            },
        }
    }


_SESSION_ID_PLACEHOLDER = "REPLACE_WITH_SESSION_ID"

_SESSION_PATH_DESCRIPTION = (
    "Session ID returned by `POST /v1/sessions`. "
    "Must exactly equal the `session_id` field in the request body "
    f"(path/body mismatch is rejected as `invalid_request`). "
    f"Replace the example `{_SESSION_ID_PLACEHOLDER}` with the real id in "
    "**both** the path and the body."
)


def _session_path_parameters() -> list[dict[str, Any]]:
    return [
        {
            "name": "session_id",
            "in": "path",
            "required": True,
            "description": _SESSION_PATH_DESCRIPTION,
            "schema": {"$ref": "#/components/schemas/SessionId"},
            "example": _SESSION_ID_PLACEHOLDER,
        }
    ]


def _dedupe_session_path_parameters(schema: dict[str, Any]) -> None:
    """Keep one rich `session_id` path param per operation.

    FastAPI auto-generates a bare path parameter; when ``openapi_extra``
    also supplies one, Swagger shows duplicates. Prefer the documented
    ``$ref`` form over the bare ``{"type": "string"}`` form.
    """
    for methods in schema.get("paths", {}).values():
        for operation in methods.values():
            if not isinstance(operation, dict):
                continue
            params = operation.get("parameters")
            if not isinstance(params, list):
                continue
            session_params = [
                p
                for p in params
                if isinstance(p, dict)
                and p.get("name") == "session_id"
                and p.get("in") == "path"
            ]
            if len(session_params) <= 1:
                continue
            rich = next(
                (
                    p
                    for p in session_params
                    if isinstance(p.get("schema"), dict) and "$ref" in p["schema"]
                ),
                session_params[-1],
            )
            # Preserve original parameter order: replace the first session_id
            # slot with the rich form and drop any later duplicates.
            replaced = False
            merged: list[Any] = []
            for p in params:
                if (
                    isinstance(p, dict)
                    and p.get("name") == "session_id"
                    and p.get("in") == "path"
                ):
                    if not replaced:
                        merged.append(rich)
                        replaced = True
                    continue
                merged.append(p)
            operation["parameters"] = merged


_START_SESSION_EXAMPLE: dict[str, Any] = {
    "protocol": "1.0",
    "task_id": "t_profile_upd",
    "task_version": 1,
    "task": "Update my email to {{EMAIL_1}}",
    "allowed_domains": ["example.test"],
    "capabilities": {
        "browser": "chrome",
        "backend": "wasm",
        "detectors": ["dom", "rules"],
        "crops": False,
    },
    "mode": "agent",
    "read_only": False,
}

_FULL_STATE_EXAMPLE: dict[str, Any] = {
    "protocol": "1.0",
    "session_id": "REPLACE_WITH_SESSION_ID",
    "task_id": "t_profile_upd",
    "task_version": 1,
    "seq": 1,
    "doc_id": "d_profile",
    "observation_id": 1,
    "step": 0,
    "page": {
        "url": "https://example.test/profile",
        "title": "Profile",
        "viewport": {"w": 1280, "h": 720, "scroll_y": 0, "page_h": 1400},
    },
    "redaction_scheme": "v1",
    "mode": "agent",
    "kind": "full",
    "elements": [
        {
            "id": "e_email",
            "role": "textbox",
            "name": "Email",
            "bbox": [20, 40, 200, 32],
            "src": "dom",
            "conf": 1,
            "value_state": "empty",
            "value": "",
        },
        {
            "id": "e_save",
            "role": "button",
            "name": "Save",
            "bbox": [20, 90, 80, 32],
            "src": "dom",
            "conf": 1,
        },
    ],
    "text_context": ["Update your email address"],
    "suspicious": False,
}

_FEEDBACK_EXAMPLE: dict[str, Any] = {
    "protocol": "1.0",
    "session_id": "REPLACE_WITH_SESSION_ID",
    "task_id": "t_profile_upd",
    "task_version": 1,
    "seq": 1,
    "doc_id": "d_profile",
    "observation_id": 1,
    "result": {
        "action_id": "a_REPLACE_WITH_SESSION_ID_0",
        "status": "ok",
        "page_changed": False,
    },
}

_END_SESSION_EXAMPLE: dict[str, Any] = {
    "protocol": "1.0",
    "session_id": "REPLACE_WITH_SESSION_ID",
    "task_id": "t_profile_upd",
    "task_version": 1,
    "seq": 1,
}

_ESCALATE_EXAMPLE: dict[str, Any] = {
    "protocol": "1.0",
    "session_id": "REPLACE_WITH_SESSION_ID",
    "task_id": "t_profile_upd",
    "task_version": 1,
    "seq": 1,
    "doc_id": "d_profile",
    "observation_id": 1,
    "question": "What does this control mean?",
    "redaction_scheme": "v1",
    "crops": [
        {
            "crop_id": "c_demo",
            "target": "e_save",
            "bbox": [10, 20, 32, 32],
            "width": 32,
            "height": 32,
            "media_type": "image/jpeg",
            "data_base64": "AAAA",
            "regions": [
                {
                    "bbox": [0, 0, 32, 32],
                    "content_class": "ui_chrome",
                    "masked": False,
                    "checks": ["ui"],
                }
            ],
        }
    ],
}

_START_SESSION_RESPONSE_EXAMPLE: dict[str, Any] = {
    "protocol": "1.0",
    "session_id": "REPLACE_WITH_SESSION_ID",
    "task_id": "t_profile_upd",
    "task_version": 1,
    "expires_in_seconds": 1800,
}

_ACTION_RESPONSE_EXAMPLE: dict[str, Any] = {
    "protocol": "1.0",
    "session_id": "REPLACE_WITH_SESSION_ID",
    "task_id": "t_profile_upd",
    "task_version": 1,
    "seq": 1,
    "doc_id": "d_profile",
    "observation_id": 1,
    "action_id": "a_REPLACE_WITH_SESSION_ID_0",
    "action": {
        "type": "type",
        "target": "e_email",
        "text": "{{EMAIL_1}}",
        "clear_first": True,
    },
    "expect": {"element": "e_email", "value_equals": "{{EMAIL_1}}"},
    "consequential": False,
    "risk": "low",
    "thought": "[scripted-fake-v1:scenario=profile_email_update:step=0 of 3]",
}

_FEEDBACK_RESPONSE_EXAMPLE: dict[str, Any] = {
    "protocol": "1.0",
    "session_id": "REPLACE_WITH_SESSION_ID",
    "task_id": "t_profile_upd",
    "task_version": 1,
    "seq": 1,
    "status": "accepted",
}

_END_SESSION_RESPONSE_EXAMPLE: dict[str, Any] = {
    "protocol": "1.0",
    "session_id": "REPLACE_WITH_SESSION_ID",
    "task_id": "t_profile_upd",
    "task_version": 1,
    "seq": 1,
    "status": "ended",
}


def create_app(
    *,
    store: SessionStore | None = None,
    planner: Planner | None = None,
    settings: Settings | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    _configure_debug_file_logging(settings.debug_log_path)
    store = store or RedisSessionStore.from_url(
        settings.redis_url, ttl=settings.session_ttl
    )
    planner = planner or ScriptedFakePlanner(builtin_scenarios())

    app = FastAPI(
        title="privacagent agent API (E-02 skeleton)",
        version="0.1.0",
        description=(
            "E-01 wire protocol over HTTP. Every request body is validated by "
            "`parse_message`; every response (including `ProtocolError`) is "
            "re-validated before it is sent.\n\n"
            "**Swagger Try it out:** call `POST /v1/sessions` first and copy the "
            "`session_id` from the response. For every other route put that same "
            "value in the path parameter **and** in the body's `session_id` "
            "field. Every request-body example uses the placeholder `REPLACE_WITH_SESSION_ID` — "
            "replace it with the real `session_id` in the path **and** the body before Execute. Path and "
            "body `session_id` must be identical or the request is rejected "
            "with `invalid_request`."
        ),
    )

    # --- helpers ---------------------------------------------------------

    async def read_json(request: Request) -> Any:
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > settings.max_body_bytes:
                raise ProtocolReject(
                    "invalid_request", reason=RejectReason.BODY_TOO_LARGE
                )
            raw.extend(chunk)
        try:
            return json.loads(raw.decode("utf-8"))
        except UnicodeDecodeError:
            raise ProtocolReject(
                "invalid_request",
                reason=RejectReason.NOT_UTF8,
            ) from None
        except json.JSONDecodeError:
            raise ProtocolReject(
                "invalid_request",
                reason=RejectReason.MALFORMED_JSON,
            ) from None

    def version_code(body: Any) -> str:
        if (
            isinstance(body, dict)
            and isinstance(body.get("protocol"), str)
            and body["protocol"] != PROTOCOL_VERSION
        ):
            return "unsupported_version"
        return "invalid_request"

    def parse_or_reject(message_name: str, body: Any) -> Any:
        try:
            return parse_message(message_name, body)
        except ProtocolValidationError:
            raise ProtocolReject(
                version_code(body),
                reason=RejectReason.INVALID_SCHEMA,
            ) from None

    def validate_path_session_id(path_session_id: str) -> None:
        try:
            models.SessionId.model_validate(path_session_id)
        except ValidationError:
            raise ProtocolReject(
                "invalid_request",
                reason=RejectReason.INVALID_SESSION_ID,
            ) from None

    def checked_response(message_name: str, payload: dict[str, Any]) -> JSONResponse:
        """Validate a generated/named response against the wire schema, then
        serialize with omitted optionals absent (never inventing nulls)."""
        try:
            model = parse_message(message_name, payload)
        except ProtocolValidationError:
            raise ProtocolReject(
                "unavailable",
                correlation=_correlation_of_payload(payload),
                reason=RejectReason.RESPONSE_OFF_CONTRACT,
            ) from None
        return JSONResponse(content=model.model_dump(mode="json", exclude_unset=True))

    def checked_error(
        code: str,
        *,
        correlation: Mapping[str, Any] | None = None,
        status_code: int | None = None,
    ) -> JSONResponse:
        """Build a ProtocolError and validate it through the E-01 boundary.

        Every failure body — not just successful responses — is checked against
        the wire schema before it is sent. If the correlation fields ever fail
        the schema (a programmed error), they are stripped once and the error is
        rebuilt without them so the client still receives a bounded body.
        """
        payload = build_protocol_error(code, correlation=correlation)
        try:
            validated = parse_message("ProtocolError", payload)
        except ProtocolValidationError:
            payload = build_protocol_error(code)
            try:
                validated = parse_message("ProtocolError", payload)
            except ProtocolValidationError:
                logger.debug(
                    "stage=checked_error detail=error_body_off_contract code=%s",
                    code,
                )
                raise RuntimeError(
                    f"build_protocol_error produced an off-contract payload: {code}"
                ) from None
        return JSONResponse(
            status_code=(
                HTTP_STATUS_BY_CODE[code] if status_code is None else status_code
            ),
            content=validated.model_dump(mode="json", exclude_unset=True),
        )

    def _correlation_of_payload(payload: dict[str, Any]) -> dict[str, Any]:
        out = {}
        for field in ("session_id", "task_id", "task_version", "seq"):
            if field in payload and payload[field] is not None:
                out[field] = payload[field]
        return out

    def established_correlation(
        record: SessionRecord, node: Any | None = None, *, seq: int | None = None
    ) -> dict[str, Any]:
        """Correlation for an established session: task identity from the
        record (never the untrusted body), ``session_id`` from the path, and
        the request ``seq`` when present."""
        out: dict[str, Any] = {
            "session_id": record.session_id,
            "task_id": record.task_id,
            "task_version": record.task_version,
        }
        if node is not None:
            value = getattr(node, "seq", None)
            if value is not None:
                out["seq"] = value
        elif seq is not None:
            out["seq"] = seq
        return out

    def require_body_session_match(
        node: Any, path_session_id: str, record: SessionRecord
    ) -> None:
        body_session_id = getattr(node, "session_id", None)
        if body_session_id is None:
            raise ProtocolReject(
                "invalid_request",
                correlation=established_correlation(record, node),
                reason=RejectReason.BODY_MISSING_SESSION_ID,
            )
        if body_session_id.root != path_session_id:
            raise ProtocolReject(
                "invalid_request",
                correlation=established_correlation(record, node),
                reason=RejectReason.SESSION_ID_MISMATCH,
            )

    def require_task_identity(node: Any, record: SessionRecord) -> None:
        node_task_id = getattr(node, "task_id", None)
        node_task_version = getattr(node, "task_version", None)
        # On any task mismatch report the *session's* task identity — never
        # the body's unverified task_id/task_version — as ProtocolError
        # correlation.
        correlation = established_correlation(record, node)
        if node_task_id is None or node_task_version is None:
            raise ProtocolReject(
                "invalid_request",
                correlation=correlation,
                reason=RejectReason.BODY_MISSING_TASK_FIELDS,
            )
        if (
            node_task_id.root != record.task_id
            or node_task_version != record.task_version
        ):
            raise ProtocolReject(
                "invalid_request",
                correlation=correlation,
                reason=RejectReason.TASK_MISMATCH,
            )

    def store_get(session_id: str) -> SessionRecord:
        try:
            record = store.get(session_id)
        except SessionStoreError:
            raise ProtocolReject(
                "unavailable",
                correlation={"session_id": session_id},
                reason=RejectReason.STORE_GET_REDIS_ERROR,
            ) from None
        if record is None:
            raise ProtocolReject(
                "session_expired",
                correlation={"session_id": session_id},
                reason=RejectReason.SESSION_NOT_FOUND,
            )
        return record

    def store_advance(
        session_id: str,
        *,
        seq: int,
        doc_id: str,
        observation_id: int,
        plan_step: int,
        last_action_id: str | None = None,
    ) -> None:
        try:
            ok = store.advance(
                session_id,
                seq=seq,
                doc_id=doc_id,
                observation_id=observation_id,
                plan_step=plan_step,
                last_action_id=last_action_id,
            )
        except SessionStoreError:
            raise ProtocolReject(
                "unavailable",
                correlation={"session_id": session_id},
                reason=RejectReason.STORE_ADVANCE_REDIS_ERROR,
            ) from None
        if not ok:
            # Key expired or was deleted between store_get and advance.
            raise ProtocolReject(
                "session_expired",
                correlation={"session_id": session_id},
                reason=RejectReason.SESSION_VANISHED,
            )

    # --- routes ----------------------------------------------------------

    @app.post(
        "/v1/sessions",
        summary="Start Session",
        description=(
            "Create a session and receive a `session_id`. Use that `session_id` "
            "in the path **and** the `session_id` field of every later request "
            "body — the two must match exactly. The request-body example below "
            "is the complete wire format."
        ),
        openapi_extra={
            "requestBody": _request_body("SessionStartRequest", _START_SESSION_EXAMPLE)
        },
        responses={
            "200": _success_response(
                "SessionStartResponse", _START_SESSION_RESPONSE_EXAMPLE
            ),
            **_error_response(
                "invalid_request", "Malformed, unsupported, or oversized start request"
            ),
            **_error_response(
                "unsupported_version", "Request carries a protocol other than 1.0"
            ),
            **_error_response("unavailable", "Session store failure"),
        },
    )
    async def start_session(request: Request) -> JSONResponse:
        body = await read_json(request)
        start = parse_or_reject("SessionStartRequest", body)

        session_id = "s_" + secrets.token_urlsafe(16)
        record = SessionRecord(
            session_id=session_id,
            task_id=start.task_id.root,
            task_version=start.task_version,
            created_at=time.time(),
        )
        try:
            store.create(record)
        except SessionStoreError:
            raise ProtocolReject(
                "unavailable",
                reason=RejectReason.STORE_CREATE_REDIS_ERROR,
            ) from None

        # Report the TTL the store actually applied (may differ from settings
        # when a custom store is injected).
        store_ttl = int(getattr(store, "ttl", settings.session_ttl))
        payload = {
            "protocol": PROTOCOL_VERSION,
            "session_id": session_id,
            "task_id": record.task_id,
            "task_version": record.task_version,
            "expires_in_seconds": store_ttl,
        }
        logger.debug("OK route=POST /v1/sessions")
        return checked_response("SessionStartResponse", payload)

    @app.post(
        "/v1/sessions/{session_id}/step",
        summary="Step",
        description=(
            "Submit a full Screen State; returns one `Action`. "
            "`session_id` must appear in the path **and** the body, identical. "
            "The body example uses `REPLACE_WITH_SESSION_ID` — replace it with "
            "the real `session_id` from `POST /v1/sessions` (same value as the path). "
            "`task_id` / `task_version` must match the session."
        ),
        openapi_extra={
            "requestBody": _request_body("ScreenState", _FULL_STATE_EXAMPLE),
            "parameters": _session_path_parameters(),
        },
        responses={
            "200": _success_response("Action", _ACTION_RESPONSE_EXAMPLE),
            **_error_response(
                "invalid_request", "Schema, version, path/body, or task mismatch"
            ),
            **_error_response("unsupported_version", "Protocol version is not 1.0"),
            **_error_response(
                "resync_required", "Diff Screen State submitted; send a full state"
            ),
            **_error_response("session_expired", "Session missing or TTL-expired"),
            **_error_response("unavailable", "Store or planner failure"),
        },
    )
    async def step(request: Request, session_id: str) -> JSONResponse:
        validate_path_session_id(session_id)
        body = await read_json(request)
        state = parse_or_reject("ScreenState", body)
        node = state.root
        # Establish the session *before* path/body matching so errors only
        # carry correlation for sessions that actually exist.
        record = store_get(session_id)
        require_body_session_match(node, session_id, record)
        require_task_identity(node, record)

        if node.kind != "full":
            # No diff reconstruction in E-02: never treat an incremental
            # update as a complete page.
            raise ProtocolReject(
                "resync_required",
                correlation=established_correlation(record, node),
                reason=RejectReason.DIFF_STATE_REQUIRES_FULL_RESYNC,
            )

        try:
            action_payload = planner.plan(state, record)
            action = parse_message("Action", action_payload)
        except ProtocolValidationError:
            raise ProtocolReject(
                "unavailable",
                correlation=established_correlation(record, node),
                reason=RejectReason.ACTION_OFF_CONTRACT,
            ) from None

        store_advance(
            session_id,
            seq=node.seq,
            doc_id=node.doc_id.root,
            observation_id=node.observation_id,
            plan_step=record.plan_step + 1,
            last_action_id=action.action_id.root,
        )
        logger.debug("OK route=POST .../step")
        return checked_response(
            "Action", action.model_dump(mode="json", exclude_unset=True)
        )

    @app.post(
        "/v1/sessions/{session_id}/feedback",
        summary="Feedback",
        description=(
            "Report the outcome of the previous `Action`. "
            "`session_id` must appear in the path **and** the body, identical "
            "(replace `REPLACE_WITH_SESSION_ID` with the real value from "
            "session start). `result.action_id` is the `action_id` from the "
            "preceding `Action` response."
        ),
        openapi_extra={
            "requestBody": _request_body("FeedbackRequest", _FEEDBACK_EXAMPLE),
            "parameters": _session_path_parameters(),
        },
        responses={
            "200": _success_response("FeedbackResponse", _FEEDBACK_RESPONSE_EXAMPLE),
            **_error_response(
                "invalid_request",
                "Schema, version, path/body, task, or action_id mismatch",
            ),
            **_error_response("unsupported_version", "Protocol version is not 1.0"),
            **_error_response("session_expired", "Session missing or TTL-expired"),
            **_error_response("unavailable", "Store failure"),
        },
    )
    async def feedback(request: Request, session_id: str) -> JSONResponse:
        validate_path_session_id(session_id)
        body = await read_json(request)
        feedback_msg = parse_or_reject("FeedbackRequest", body)
        record = store_get(session_id)
        require_body_session_match(feedback_msg, session_id, record)
        require_task_identity(feedback_msg, record)

        # ActionResult.action_id must be the Action this session last issued
        # (E-01 freshness: API-side correlation of feedback to the prior step).
        last_action_id = record.last_action_id
        if (
            last_action_id is None
            or feedback_msg.result.action_id.root != last_action_id
        ):
            raise ProtocolReject(
                "invalid_request",
                correlation=established_correlation(record, feedback_msg),
                reason=RejectReason.ACTION_ID_MISMATCH,
            )

        store_advance(
            session_id,
            seq=feedback_msg.seq,
            doc_id=feedback_msg.doc_id.root,
            observation_id=feedback_msg.observation_id,
            plan_step=record.plan_step,
            last_action_id=last_action_id,
        )
        payload = {
            "protocol": PROTOCOL_VERSION,
            "session_id": session_id,
            "task_id": record.task_id,
            "task_version": record.task_version,
            "seq": feedback_msg.seq,
            "status": "accepted",
        }
        logger.debug("OK route=POST .../feedback")
        return checked_response("FeedbackResponse", payload)

    @app.delete(
        "/v1/sessions/{session_id}",
        summary="End Session",
        description=(
            "End the session and delete its server state. "
            "`session_id` must appear in the path **and** the body, identical "
            "(replace `REPLACE_WITH_SESSION_ID` with the real value from "
            "session start)."
        ),
        openapi_extra={
            "requestBody": _request_body("SessionEndRequest", _END_SESSION_EXAMPLE),
            "parameters": _session_path_parameters(),
        },
        responses={
            "200": _success_response(
                "SessionEndResponse", _END_SESSION_RESPONSE_EXAMPLE
            ),
            **_error_response(
                "invalid_request", "Schema, version, path/body, or task mismatch"
            ),
            **_error_response("unsupported_version", "Protocol version is not 1.0"),
            **_error_response("session_expired", "Session missing or TTL-expired"),
            **_error_response("unavailable", "Store failure"),
        },
    )
    async def end_session(request: Request, session_id: str) -> JSONResponse:
        validate_path_session_id(session_id)
        body = await read_json(request)
        end = parse_or_reject("SessionEndRequest", body)
        record = store_get(session_id)
        require_body_session_match(end, session_id, record)
        require_task_identity(end, record)

        try:
            store.delete(session_id)
        except SessionStoreError:
            raise ProtocolReject(
                "unavailable",
                correlation=established_correlation(record, end),
                reason=RejectReason.STORE_DELETE_REDIS_ERROR,
            ) from None

        payload = {
            "protocol": PROTOCOL_VERSION,
            "session_id": session_id,
            "task_id": record.task_id,
            "task_version": record.task_version,
            "seq": end.seq,
            "status": "ended",
        }
        logger.debug("OK route=DELETE /v1/sessions/{session_id}")
        return checked_response("SessionEndResponse", payload)

    @app.post(
        "/v1/sessions/{session_id}/escalate",
        summary="Escalate",
        description=(
            "Tier-2 escalation (redacted crop to a VLM). Not implemented until "
            "E-11; currently always returns `unavailable` (503) after validating "
            "the session. `session_id` must appear in the path **and** the body, "
            "identical (replace `REPLACE_WITH_SESSION_ID` with the real value "
            "from session start)."
        ),
        openapi_extra={
            "requestBody": _request_body("EscalateRequest", _ESCALATE_EXAMPLE),
            "parameters": _session_path_parameters(),
        },
        responses={
            **_error_response(
                "unavailable", "Tier-2 escalation is not implemented until E-11"
            ),
            **_error_response(
                "invalid_request", "Schema, version, path/body, or task mismatch"
            ),
            **_error_response("unsupported_version", "Protocol version is not 1.0"),
            **_error_response("session_expired", "Session missing or TTL-expired"),
        },
    )
    async def escalate(request: Request, session_id: str) -> JSONResponse:
        validate_path_session_id(session_id)
        body = await read_json(request)
        escalate_msg = parse_or_reject("EscalateRequest", body)
        record = store_get(session_id)
        require_body_session_match(escalate_msg, session_id, record)
        require_task_identity(escalate_msg, record)

        # E-11 supplies VLM behavior. Until then this endpoint is registered
        # and protocol-valid but explicitly reports the feature as unavailable.
        # It does not touch the session or its TTL.
        raise ProtocolReject(
            "unavailable",
            correlation=established_correlation(record, escalate_msg),
            reason=RejectReason.VLM_NOT_IMPLEMENTED_UNTIL_E11,
        )

    # --- bounded error handlers -----------------------------------------

    @app.exception_handler(ProtocolReject)
    async def on_protocol_reject(request: Request, exc: ProtocolReject) -> JSONResponse:
        logger.debug("REJECT %s", exc.reason.value if exc.reason else "unspecified")
        return checked_error(exc.code, correlation=exc.correlation)

    @app.exception_handler(RequestValidationError)
    async def on_request_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        logger.debug("REJECT stage=request_validation")
        return checked_error("invalid_request")

    @app.exception_handler(StarletteHTTPException)
    async def on_http_exception(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        code = "rate_limited" if exc.status_code == 429 else "invalid_request"
        logger.debug("REJECT stage=http_exception")
        return checked_error(code)

    class BoundedErrorsMiddleware:
        """Contain exceptions before Starlette re-raises them to server logging."""

        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                return await self.app(scope, receive, send)
            started = False

            async def tracked_send(message):
                nonlocal started
                if message["type"] == "http.response.start":
                    started = True
                await send(message)

            try:
                await self.app(scope, receive, tracked_send)
            except Exception:
                logger.warning("REJECT stage=unhandled")
                if started:
                    # A partial response cannot be replaced. Keep its exception
                    # data out of the server's traceback as well.
                    raise RuntimeError("Response interrupted") from None
                await checked_error("unavailable")(scope, receive, send)

    app.add_middleware(BoundedErrorsMiddleware)

    fastapi_openapi = app.openapi

    def openapi_with_e01_schemas() -> dict[str, Any]:
        if app.openapi_schema is not None:
            return app.openapi_schema
        schema = fastapi_openapi()
        components = schema.setdefault("components", {})
        components.setdefault("schemas", {}).update(_E01_COMPONENT_SCHEMAS)
        _dedupe_session_path_parameters(schema)
        app.openapi_schema = schema
        return schema

    app.openapi = openapi_with_e01_schemas

    return app


def create_app_from_env() -> FastAPI:
    return create_app(settings=Settings.from_env())


app = create_app_from_env()

__all__ = ["app", "create_app", "create_app_from_env"]
