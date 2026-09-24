"""Privacy-safe diagnostics and bounded streaming through the real ASGI app."""

import asyncio
import json
import logging

import pytest
from fastapi.testclient import TestClient
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException

from privacagent_agent_api.app import create_app
from privacagent_agent_api.config import Settings
from privacagent_agent_api.errors import ProtocolReject
from privacagent_agent_api.fixtures import (
    full_state_payload,
    scenario_by_task_id,
    start_request_payload,
)
from privacagent_protocol import parse_message
from helpers import MemoryStore

CANARY = "PRIVATE_CANARY_924"


def application(*, limit=4096, log=""):
    return create_app(
        settings=Settings("redis://localhost/0", 1800, limit, log),
        store=MemoryStore(),
    )


def exchange(app, chunks, path="/v1/sessions", method="POST", headers=()):
    """Fail if the app asks for data beyond the supplied stream prefix."""
    messages = []
    reads = 0

    async def run():
        async def receive():
            nonlocal reads
            index = reads
            reads += 1
            assert index < len(chunks), "read beyond allowed stream prefix"
            body, more = chunks[index]
            return {"type": "http.request", "body": body, "more_body": more}

        async def send(message):
            messages.append(message)

        await app(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": method,
                "scheme": "http",
                "path": path,
                "raw_path": path.encode(),
                "query_string": b"",
                "root_path": "",
                "headers": list(headers),
                "server": ("test", 80),
                "client": ("test", 1),
            },
            receive,
            send,
        )

    asyncio.run(run())
    status = next(m["status"] for m in messages if m["type"] == "http.response.start")
    body = json.loads(b"".join(m.get("body", b"") for m in messages))
    return status, body, reads


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/v1/sessions"),
        ("POST", "/v1/sessions/s_test/step"),
        ("POST", "/v1/sessions/s_test/feedback"),
        ("POST", "/v1/sessions/s_test/escalate"),
        ("DELETE", "/v1/sessions/s_test"),
    ],
)
@pytest.mark.parametrize("headers", [(), ((b"content-length", b"1"),)])
def test_overflow_stops_before_reading_remaining_stream(method, path, headers):
    status, body, reads = exchange(
        application(limit=16),
        [(b"x" * 8, True), (b"x" * 9, True)],
        path,
        method,
        headers,
    )
    assert status == 400
    assert parse_message("ProtocolError", body).code == "invalid_request"
    assert reads == 2


def test_exact_limit_and_split_utf8_are_accepted():
    payload = start_request_payload(scenario_by_task_id("t_profile_upd"))
    payload["task"] = "Synthetic café task"
    raw = json.dumps(payload, ensure_ascii=False).encode()
    split = raw.index("é".encode()) + 1
    status, body, reads = exchange(
        application(limit=len(raw)), [(raw[:split], True), (raw[split:], False)]
    )
    assert status == 200
    parse_message("SessionStartResponse", body)
    assert reads == 2


@pytest.mark.parametrize("raw", [b"", b"{", b"\xff"])
def test_invalid_json_still_returns_protocol_error(raw):
    status, body, _ = exchange(application(), [(raw, False)])
    assert status == 400
    parse_message("ProtocolError", body)


def test_diagnostics_never_log_request_or_exception_content(tmp_path):
    path = tmp_path / "debug.log"
    app = application(log=str(path))

    @app.get("/explode")
    def explode():
        raise RuntimeError(CANARY)

    @app.get("/http-error")
    def http_error():
        raise HTTPException(400, detail=CANARY)

    @app.get("/validation-error")
    def validation_error():
        raise RequestValidationError(
            [{"loc": ("body", CANARY), "type": CANARY, "input": CANARY}]
        )

    with TestClient(app) as client:
        payload = start_request_payload(scenario_by_task_id("t_profile_upd"))
        for bad in (
            {**payload, CANARY: "value"},
            {**payload, "capabilities": {**payload["capabilities"], CANARY: CANARY}},
        ):
            assert client.post("/v1/sessions", json=bad).status_code == 400
        assert client.get(f"/{CANARY}?secret={CANARY}").status_code == 400
        assert client.get("/http-error").status_code == 400
        assert client.get("/validation-error").status_code == 400
        # TestClient re-raises escaped server exceptions by default.
        assert client.get("/explode").status_code == 503
        sid = client.post("/v1/sessions", json=payload).json()["session_id"]
        state = full_state_payload(scenario_by_task_id("t_profile_upd"), CANARY)
        assert client.post(f"/v1/sessions/{sid}/step", json=state).status_code == 400
        state["session_id"] = sid
        state["task_id"] = CANARY
        assert client.post(f"/v1/sessions/{sid}/step", json=state).status_code == 400
        payload["task"] = CANARY
        payload["task_id"] = CANARY
        assert client.post("/v1/sessions", json=payload).status_code == 200
    text = path.read_text()
    assert "invalid_schema" in text
    assert "stage=unhandled" in text
    assert CANARY not in text
    application(log="")
    assert not any(
        isinstance(h, logging.FileHandler)
        for h in logging.getLogger("privacagent.agent_api").handlers
    )


def test_reject_reason_cannot_accept_arbitrary_strings():
    with pytest.raises(TypeError):
        ProtocolReject("invalid_request", reason=CANARY)


def test_launcher_disables_url_access_logging(monkeypatch):
    from privacagent_agent_api.__main__ import main

    options = {}
    monkeypatch.setattr("uvicorn.run", lambda *args, **kwargs: options.update(kwargs))
    main()
    assert options["access_log"] is False


def test_real_server_logs_do_not_expose_urls_or_exceptions(caplog):
    import socket
    import threading
    import time

    import httpx
    import uvicorn

    app = application()

    @app.get("/explode")
    def explode():
        raise RuntimeError(CANARY)

    server = uvicorn.Server(uvicorn.Config(app, access_log=False, log_config=None))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]})
        with caplog.at_level(logging.DEBUG):
            thread.start()
            try:
                deadline = time.monotonic() + 5
                while (
                    not server.started
                    and thread.is_alive()
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.01)
                assert server.started
                with httpx.Client(
                    base_url=f"http://127.0.0.1:{port}", trust_env=False
                ) as client:
                    assert client.get(f"/{CANARY}?q={CANARY}").status_code == 400
                    assert client.get("/explode").status_code == 503
            finally:
                server.should_exit = True
                thread.join(timeout=5)
            assert not thread.is_alive()
    records = [
        r for r in caplog.records if r.name.startswith(("uvicorn", "privacagent"))
    ]
    assert records
    formatter = logging.Formatter()
    assert CANARY not in "\n".join(formatter.format(r) for r in records)
