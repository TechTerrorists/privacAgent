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
    build_protocol_error,
    correlation_of,
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
    "session_id": "s_demo",
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
    "session_id": "s_demo",
    "task_id": "t_profile_upd",
    "task_version": 1,
    "seq": 1,
    "doc_id": "d_profile",
    "observation_id": 1,
    "result": {"action_id": "a_t_profile_upd_0", "status": "ok", "page_changed": False},
}

_END_SESSION_EXAMPLE: dict[str, Any] = {
    "protocol": "1.0",
    "session_id": "s_demo",
    "task_id": "t_profile_upd",
    "task_version": 1,
    "seq": 1,
}

_ESCALATE_EXAMPLE: dict[str, Any] = {
    "protocol": "1.0",
    "session_id": "s_demo",
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


def create_app(
    *,
    store: SessionStore | None = None,
    planner: Planner | None = None,
    settings: Settings | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    store = store or RedisSessionStore.from_url(
        settings.redis_url, ttl=settings.session_ttl
    )
    planner = planner or ScriptedFakePlanner(builtin_scenarios())

    app = FastAPI(
        title="privacagent agent API (E-02 skeleton)",
        version="0.1.0",
    )

    # --- helpers ---------------------------------------------------------

    async def read_json(request: Request) -> Any:
        raw = await request.body()
        if len(raw) > settings.max_body_bytes:
            raise ProtocolReject("invalid_request")
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ProtocolReject("invalid_request") from None

    def version_code(body: Any) -> str:
        if (
            isinstance(body, dict)
            and isinstance(body.get("protocol"), str)
            and body["protocol"] != PROTOCOL_VERSION
        ):
            return "unsupported_version"
        return "invalid_request"

    def validate_path_session_id(path_session_id: str) -> None:
        try:
            models.SessionId.model_validate(path_session_id)
        except ValidationError:
            raise ProtocolReject("invalid_request") from None

    def checked_response(message_name: str, payload: dict[str, Any]) -> JSONResponse:
        """Validate a generated/named response against the wire schema, then
        serialize with omitted optionals absent (never inventing nulls)."""
        try:
            model = parse_message(message_name, payload)
        except ProtocolValidationError:
            raise ProtocolReject(
                "unavailable", correlation=_correlation_of_payload(payload)
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

    def require_body_session_match(node: Any, path_session_id: str) -> None:
        body_session_id = getattr(node, "session_id", None)
        if body_session_id is None or body_session_id.root != path_session_id:
            raise ProtocolReject("invalid_request")

    def require_task_identity(node: Any, record: SessionRecord) -> None:
        if (
            getattr(node, "task_id", None) is None
            or getattr(node, "task_version", None) is None
            or node.task_id.root != record.task_id
            or node.task_version != record.task_version
        ):
            raise ProtocolReject("invalid_request", correlation=correlation_of(node))

    def store_get(session_id: str) -> SessionRecord:
        try:
            record = store.get(session_id)
        except SessionStoreError:
            raise ProtocolReject("unavailable", correlation={"session_id": session_id}) from None
        if record is None:
            raise ProtocolReject("session_expired", correlation={"session_id": session_id})
        return record

    def store_advance(session_id: str, *, seq: int, doc_id: str, observation_id: int, plan_step: int) -> None:
        try:
            store.advance(
                session_id,
                seq=seq,
                doc_id=doc_id,
                observation_id=observation_id,
                plan_step=plan_step,
            )
        except SessionStoreError:
            raise ProtocolReject("unavailable", correlation={"session_id": session_id}) from None

    # --- routes ----------------------------------------------------------

    @app.post(
        "/v1/sessions",
        openapi_extra={
            "requestBody": _request_body("SessionStartRequest", _START_SESSION_EXAMPLE)
        },
        responses=_error_response(
            "invalid_request", "Malformed, unsupported, or oversized start request"
        ),
    )
    async def start_session(request: Request) -> JSONResponse:
        body = await read_json(request)
        try:
            start = parse_message("SessionStartRequest", body)
        except ProtocolValidationError:
            raise ProtocolReject(version_code(body)) from None

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
            raise ProtocolReject("unavailable") from None

        payload = {
            "protocol": PROTOCOL_VERSION,
            "session_id": session_id,
            "task_id": record.task_id,
            "task_version": record.task_version,
            "expires_in_seconds": settings.session_ttl,
        }
        return checked_response("SessionStartResponse", payload)

    @app.post(
        "/v1/sessions/{session_id}/step",
        openapi_extra={"requestBody": _request_body("ScreenState", _FULL_STATE_EXAMPLE)},
        responses={
            **_error_response("invalid_request", "Schema, version, or path/body mismatch"),
            **_error_response("resync_required", "Diff Screen State submitted; send a full state"),
            **_error_response("session_expired", "Session missing or TTL-expired"),
            **_error_response("unavailable", "Store or planner failure"),
        },
    )
    async def step(request: Request, session_id: str) -> JSONResponse:
        validate_path_session_id(session_id)
        body = await read_json(request)
        try:
            state = parse_message("ScreenState", body)
        except ProtocolValidationError:
            raise ProtocolReject(version_code(body)) from None
        node = state.root
        require_body_session_match(node, session_id)
        record = store_get(session_id)
        require_task_identity(node, record)

        if node.kind != "full":
            # No diff reconstruction in E-02: never treat an incremental
            # update as a complete page.
            raise ProtocolReject("resync_required", correlation=correlation_of(node))

        try:
            action_payload = planner.plan(state, record)
            action = parse_message("Action", action_payload)
        except ProtocolValidationError:
            raise ProtocolReject("unavailable", correlation=correlation_of(node)) from None

        store_advance(
            session_id,
            seq=node.seq,
            doc_id=node.doc_id.root,
            observation_id=node.observation_id,
            plan_step=record.plan_step + 1,
        )
        return checked_response("Action", action.model_dump(mode="json", exclude_unset=True))

    @app.post(
        "/v1/sessions/{session_id}/feedback",
        openapi_extra={"requestBody": _request_body("FeedbackRequest", _FEEDBACK_EXAMPLE)},
        responses={
            **_error_response("invalid_request", "Schema, version, or path/body mismatch"),
            **_error_response("session_expired", "Session missing or TTL-expired"),
            **_error_response("unavailable", "Store failure"),
        },
    )
    async def feedback(request: Request, session_id: str) -> JSONResponse:
        validate_path_session_id(session_id)
        body = await read_json(request)
        try:
            feedback = parse_message("FeedbackRequest", body)
        except ProtocolValidationError:
            raise ProtocolReject(version_code(body)) from None
        require_body_session_match(feedback, session_id)
        record = store_get(session_id)
        require_task_identity(feedback, record)

        store_advance(
            session_id,
            seq=feedback.seq,
            doc_id=feedback.doc_id.root,
            observation_id=feedback.observation_id,
            plan_step=record.plan_step,
        )
        payload = {
            "protocol": PROTOCOL_VERSION,
            "session_id": session_id,
            "task_id": record.task_id,
            "task_version": record.task_version,
            "seq": feedback.seq,
            "status": "accepted",
        }
        return checked_response("FeedbackResponse", payload)

    @app.delete(
        "/v1/sessions/{session_id}",
        openapi_extra={"requestBody": _request_body("SessionEndRequest", _END_SESSION_EXAMPLE)},
        responses={
            **_error_response("invalid_request", "Schema, version, or path/body mismatch"),
            **_error_response("session_expired", "Session missing or TTL-expired"),
            **_error_response("unavailable", "Store failure"),
        },
    )
    async def end_session(request: Request, session_id: str) -> JSONResponse:
        validate_path_session_id(session_id)
        body = await read_json(request)
        try:
            end = parse_message("SessionEndRequest", body)
        except ProtocolValidationError:
            raise ProtocolReject(version_code(body)) from None
        require_body_session_match(end, session_id)
        record = store_get(session_id)
        require_task_identity(end, record)

        try:
            store.delete(session_id)
        except SessionStoreError:
            raise ProtocolReject("unavailable", correlation={"session_id": session_id}) from None

        payload = {
            "protocol": PROTOCOL_VERSION,
            "session_id": session_id,
            "task_id": record.task_id,
            "task_version": record.task_version,
            "seq": end.seq,
            "status": "ended",
        }
        return checked_response("SessionEndResponse", payload)

    @app.post(
        "/v1/sessions/{session_id}/escalate",
        openapi_extra={"requestBody": _request_body("EscalateRequest", _ESCALATE_EXAMPLE)},
        responses={
            **_error_response("unavailable", "Tier-2 escalation is not implemented until E-11"),
            **_error_response("invalid_request", "Schema, version, or path/body mismatch"),
            **_error_response("session_expired", "Session missing or TTL-expired"),
        },
    )
    async def escalate(request: Request, session_id: str) -> JSONResponse:
        validate_path_session_id(session_id)
        body = await read_json(request)
        try:
            escalate = parse_message("EscalateRequest", body)
        except ProtocolValidationError:
            raise ProtocolReject(version_code(body)) from None
        require_body_session_match(escalate, session_id)
        record = store_get(session_id)
        require_task_identity(escalate, record)

        # E-11 supplies VLM behavior. Until then this endpoint is registered
        # and protocol-valid but explicitly reports the feature as unavailable.
        # It does not touch the session or its TTL.
        raise ProtocolReject("unavailable", correlation=correlation_of(escalate))

    # --- bounded error handlers -----------------------------------------

    @app.exception_handler(ProtocolReject)
    async def on_protocol_reject(request: Request, exc: ProtocolReject) -> JSONResponse:
        return checked_error(exc.code, correlation=exc.correlation)

    @app.exception_handler(RequestValidationError)
    async def on_request_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # Should not happen (no bound body models) but never echo input.
        return checked_error("invalid_request")

    @app.exception_handler(StarletteHTTPException)
    async def on_http_exception(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        # Unknown routes and method mismatches still get a bounded body.
        code = "rate_limited" if exc.status_code == 429 else "invalid_request"
        return checked_error(code, status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def on_unhandled(request: Request, exc: Exception) -> JSONResponse:
        # Last-resort bounded error. Log the exception class name only — never
        # arguments or tracebacks, which could carry page-derived strings.
        logger.warning("unhandled server error: %s", type(exc).__name__)
        return checked_error("unavailable")

    fastapi_openapi = app.openapi

    def openapi_with_e01_schemas() -> dict[str, Any]:
        if app.openapi_schema is not None:
            return app.openapi_schema
        schema = fastapi_openapi()
        components = schema.setdefault("components", {})
        components.setdefault("schemas", {}).update(_E01_COMPONENT_SCHEMAS)
        app.openapi_schema = schema
        return schema

    app.openapi = openapi_with_e01_schemas

    return app


def create_app_from_env() -> FastAPI:
    return create_app(settings=Settings.from_env())


app = create_app_from_env()

__all__ = ["app", "create_app", "create_app_from_env"]
