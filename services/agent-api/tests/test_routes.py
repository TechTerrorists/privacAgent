"""Route-level behavior and bounded error mapping (E-02)."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from privacagent_protocol import is_message, parse_message

from privacagent_agent_api.config import Settings
from privacagent_agent_api.fixtures import (
    diff_state_payload,
    full_state_payload,
    scenario_by_task_id,
    start_request_payload,
)
from privacagent_agent_api.session_store import SessionStoreError

from conftest import REDIS_URL
from helpers import (
    FailAdvanceStore,
    FailAlwaysStore,
    FailDeleteStore,
    FailGetStore,
    MemoryStore,
    end_payload,
    escalate_payload,
    feedback_payload,
    start_session,
)

EMAIL = scenario_by_task_id("t_profile_upd")
SEARCH = scenario_by_task_id("t_search_demo")
DOC_ID = "d_profile"


def email_state(client_session_id, *, seq=1, observation_id=1, step=0):
    return full_state_payload(
        EMAIL,
        client_session_id,
        seq=seq,
        observation_id=observation_id,
        step=step,
        doc_id=DOC_ID,
    )


def assert_protocol_error(resp, expected_code, expected_status):
    assert resp.status_code == expected_status
    data = resp.json()
    assert is_message("ProtocolError", data), "error body must be wire-valid"
    assert data["code"] == expected_code
    assert "protocol" in data and data["protocol"] == "1.0"
    assert isinstance(data["retryable"], bool)
    return data


# --- session start -------------------------------------------------------


def test_start_session_returns_protocol_session_with_ttl(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    assert is_message("SessionStartResponse", start)
    assert start["protocol"] == "1.0"
    assert start["session_id"].startswith("s_")
    assert start["task_id"] == EMAIL.task_id
    assert start["task_version"] == 1
    assert start["expires_in_seconds"] == 1800


def test_start_rejects_malformed_json(client: TestClient) -> None:
    resp = client.post(
        "/v1/sessions",
        content=b"this is not json",
        headers={"Content-Type": "application/json"},
    )
    data = assert_protocol_error(resp, "invalid_request", 400)
    assert "session_id" not in data, "pre-session errors must not fabricate session identity"


def test_start_rejects_unknown_protocol_version(client: TestClient) -> None:
    payload = {
        "protocol": "2.0",
        "task_id": EMAIL.task_id,
        "task_version": 1,
        "task": EMAIL.task_text,
        "allowed_domains": ["example.test"],
        "capabilities": {"browser": "chrome", "backend": "wasm", "detectors": ["dom"], "crops": False},
        "mode": "agent",
        "read_only": False,
    }
    resp = client.post("/v1/sessions", json=payload)
    assert_protocol_error(resp, "unsupported_version", 400)


def test_start_rejects_unknown_fields_without_echo(client: TestClient) -> None:
    import json as _json

    payload = {
        "protocol": "1.0",
        "task_id": EMAIL.task_id,
        "task_version": 1,
        "task": EMAIL.task_text,
        "allowed_domains": ["example.test"],
        "capabilities": {"browser": "chrome", "backend": "wasm", "detectors": ["dom"], "crops": False},
        "mode": "agent",
        "read_only": False,
        "html": "PRIVATE_CANARY",
    }
    resp = client.post("/v1/sessions", json=payload)
    data = assert_protocol_error(resp, "invalid_request", 400)
    assert "PRIVATE_CANARY" not in _json.dumps(data)
    assert "html" not in data


def test_start_rejects_missing_identity_fields(client: TestClient) -> None:
    payload = {
        "protocol": "1.0",
        "task_id": EMAIL.task_id,
        "task": EMAIL.task_text,
        "allowed_domains": ["example.test"],
        "capabilities": {"browser": "chrome", "backend": "wasm", "detectors": ["dom"], "crops": False},
        "mode": "agent",
        "read_only": False,
    }
    resp = client.post("/v1/sessions", json=payload)
    assert_protocol_error(resp, "invalid_request", 400)


def test_start_rejects_oversized_body_without_echo(make_client) -> None:
    import json as _json

    client = make_client(
        settings=Settings(redis_url=REDIS_URL, session_ttl=1800, max_body_bytes=10)
    )
    payload = start_request_payload(EMAIL)
    assert len(_json.dumps(payload)) > 10
    resp = client.post("/v1/sessions", json=payload)
    assert_protocol_error(resp, "invalid_request", 400)
    assert "Update my email" not in resp.text
    assert "Update my email" not in _json.dumps(resp.json())


# --- step ----------------------------------------------------------------


def test_step_returns_one_scripted_action_with_preserved_identity(
    client: TestClient,
) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    state = email_state(sid, seq=1, observation_id=1, step=0)
    resp = client.post(f"/v1/sessions/{sid}/step", json=state)
    assert resp.status_code == 200
    action = resp.json()
    assert is_message("Action", action)
    action_model = parse_message("Action", action)
    assert action_model.session_id.root == sid
    assert action_model.task_id.root == EMAIL.task_id
    assert action_model.task_version == 1
    assert action_model.seq == 1
    assert action_model.doc_id.root == DOC_ID
    assert action_model.observation_id == 1
    cmd = action["action"]
    assert cmd["type"] == "type"
    assert cmd["target"] == "e_email"
    assert cmd["text"] == "{{EMAIL_1}}"
    assert action["consequential"] is False
    assert action["risk"] == "low"
    assert "scripted-fake-v1" in action["thought"]


def test_step_omits_unset_optionals_instead_of_inventing_nulls(
    client: TestClient,
) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    # Step 1 (type): expect set, other optionals stay absent.
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid, seq=1, observation_id=1))
    action = resp.json()
    assert "expect" in action
    assert "progress" not in action
    # Step 2 (click) also carries an expect clause but no invented-null optionals.
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid, seq=2, observation_id=2))
    action = resp.json()
    assert action["action"]["type"] == "click"
    assert "expect" in action
    assert "progress" not in action
    # Step 3 (done) has no expect; it must be absent, not null.
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid, seq=3, observation_id=3))
    action = resp.json()
    assert action["action"]["type"] == "done"
    assert "expect" not in action
    assert "progress" not in action


def test_step_rejects_path_body_session_mismatch(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    state = email_state("s_someone_else")
    resp = client.post(f"/v1/sessions/{sid}/step", json=state)
    assert_protocol_error(resp, "invalid_request", 400)


def test_step_unknown_session(client: TestClient) -> None:
    state = email_state("s_never_created")
    resp = client.post("/v1/sessions/s_never_created/step", json=state)
    data = assert_protocol_error(resp, "session_expired", 404)
    assert data["retryable"] is True


def test_step_after_expiry_without_long_sleep(make_client) -> None:
    client = make_client(ttl=1)
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    assert start["expires_in_seconds"] == 1
    time.sleep(1.5)
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid))
    assert_protocol_error(resp, "session_expired", 404)


def test_step_success_refreshes_session_ttl(make_client, redis_client) -> None:
    client = make_client(ttl=2)
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    key = f"pa:agent:session:{sid}"
    time.sleep(1.2)
    pttl_before = redis_client.pttl(key)
    assert 0 < pttl_before < 2000
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid))
    assert resp.status_code == 200
    pttl_after = redis_client.pttl(key)
    assert pttl_after > 1500


def test_step_diff_state_returns_resync_required(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    diff = diff_state_payload(
        EMAIL, sid, seq=2, observation_id=2, base_observation_id=1, doc_id=DOC_ID
    )
    resp = client.post(f"/v1/sessions/{sid}/step", json=diff)
    data = assert_protocol_error(resp, "resync_required", 409)
    assert data["retryable"] is True
    assert data["session_id"] == sid  # correlation of an established session


def test_step_rejects_task_identity_mismatch(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    state = full_state_payload(
        SEARCH, sid, seq=1, observation_id=1, doc_id="d_catalog"
    )
    resp = client.post(f"/v1/sessions/{sid}/step", json=state)
    assert_protocol_error(resp, "invalid_request", 400)


def test_step_rejects_missing_correlation_fields(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    state = email_state(sid)
    del state["doc_id"]
    resp = client.post(f"/v1/sessions/{sid}/step", json=state)
    assert_protocol_error(resp, "invalid_request", 400)


# --- feedback ------------------------------------------------------------


def test_feedback_accepted_with_identity(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid, seq=1, observation_id=1))
    action = resp.json()
    fb = feedback_payload(
        session_id=sid,
        task_id=EMAIL.task_id,
        seq=1,
        doc_id=DOC_ID,
        observation_id=1,
        action_id=action["action_id"],
        status="ok",
    )
    resp = client.post(f"/v1/sessions/{sid}/feedback", json=fb)
    assert resp.status_code == 200
    data = resp.json()
    assert is_message("FeedbackResponse", data)
    assert data["status"] == "accepted"
    assert data["session_id"] == sid
    assert data["task_id"] == EMAIL.task_id
    assert data["seq"] == 1


def test_feedback_unknown_session(client: TestClient) -> None:
    fb = feedback_payload(session_id="s_never_created", task_id=EMAIL.task_id)
    resp = client.post("/v1/sessions/s_never_created/feedback", json=fb)
    assert_protocol_error(resp, "session_expired", 404)


def test_feedback_path_body_mismatch(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    fb = feedback_payload(session_id="s_someone_else", task_id=EMAIL.task_id)
    resp = client.post(f"/v1/sessions/{sid}/feedback", json=fb)
    assert_protocol_error(resp, "invalid_request", 400)


def test_feedback_rejects_task_identity_mismatch(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    fb = feedback_payload(session_id=sid, task_id=SEARCH.task_id)
    resp = client.post(f"/v1/sessions/{sid}/feedback", json=fb)
    assert_protocol_error(resp, "invalid_request", 400)


# --- end -----------------------------------------------------------------


def test_end_deletes_session_state(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    resp = client.request(
        "DELETE",
        f"/v1/sessions/{sid}",
        json=end_payload(session_id=sid, task_id=EMAIL.task_id, seq=1),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert is_message("SessionEndResponse", data)
    assert data["status"] == "ended"
    assert data["session_id"] == sid
    # Ended session state must not be retained.
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid))
    assert_protocol_error(resp, "session_expired", 404)


def test_end_unknown_session(client: TestClient) -> None:
    pid = "s_never_created"
    resp = client.request(
        "DELETE", f"/v1/sessions/{pid}", json=end_payload(session_id=pid, task_id=EMAIL.task_id, seq=1)
    )
    assert_protocol_error(resp, "session_expired", 404)


def test_end_path_body_mismatch(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    resp = client.request(
        "DELETE",
        f"/v1/sessions/{sid}",
        json=end_payload(session_id="s_someone_else", task_id=EMAIL.task_id, seq=1),
    )
    assert_protocol_error(resp, "invalid_request", 400)


def test_end_rejects_task_identity_mismatch(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    resp = client.request(
        "DELETE",
        f"/v1/sessions/{sid}",
        json=end_payload(session_id=sid, task_id=SEARCH.task_id, seq=1),
    )
    assert_protocol_error(resp, "invalid_request", 400)


# --- escalate ------------------------------------------------------------


def test_escalate_returns_explicit_unavailable(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    payload = escalate_payload(session_id=sid, task_id=EMAIL.task_id, doc_id=DOC_ID)
    resp = client.post(f"/v1/sessions/{sid}/escalate", json=payload)
    data = assert_protocol_error(resp, "unavailable", 503)
    assert data["retryable"] is True
    assert data["session_id"] == sid
    assert data["task_id"] == EMAIL.task_id
    assert data["task_version"] == 1
    assert data["seq"] == 1
    # The escalation must not run a VLM nor destroy/refresh the session.
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid, seq=1, observation_id=1))
    assert resp.status_code == 200
    assert resp.json()["action"]["type"] == "type"


def test_escalate_unknown_session(client: TestClient) -> None:
    pid = "s_never_created"
    payload = escalate_payload(session_id=pid, task_id=EMAIL.task_id)
    resp = client.post(f"/v1/sessions/{pid}/escalate", json=payload)
    assert_protocol_error(resp, "session_expired", 404)


def test_escalate_rejects_task_identity_mismatch(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    payload = escalate_payload(session_id=sid, task_id=SEARCH.task_id, doc_id="d_catalog")
    resp = client.post(f"/v1/sessions/{sid}/escalate", json=payload)
    assert_protocol_error(resp, "invalid_request", 400)


def test_escalate_rejects_path_body_session_mismatch(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    payload = escalate_payload(session_id="s_wrong", task_id=EMAIL.task_id, doc_id=DOC_ID)
    resp = client.post(f"/v1/sessions/{sid}/escalate", json=payload)
    assert_protocol_error(resp, "invalid_request", 400)


def test_escalate_does_not_refresh_session_ttl(make_client, redis_client) -> None:
    client = make_client(ttl=2)
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    key = f"pa:agent:session:{sid}"
    time.sleep(1.2)
    pttl_before = redis_client.pttl(key)
    assert 0 < pttl_before < 2000
    payload = escalate_payload(session_id=sid, task_id=EMAIL.task_id, doc_id=DOC_ID)
    resp = client.post(f"/v1/sessions/{sid}/escalate", json=payload)
    assert_protocol_error(resp, "unavailable", 503)
    pttl_after = redis_client.pttl(key)
    # A refresh would have reset the key to the full 2000 ms TTL.
    assert pttl_after <= pttl_before
    assert pttl_after < 1500


# --- openapi / swagger ---------------------------------------------------


@pytest.mark.parametrize(
    "path,method,message_name",
    [
        ("/v1/sessions", "post", "SessionStartRequest"),
        ("/v1/sessions/{session_id}/step", "post", "ScreenState"),
        ("/v1/sessions/{session_id}/feedback", "post", "FeedbackRequest"),
        ("/v1/sessions/{session_id}", "delete", "SessionEndRequest"),
        ("/v1/sessions/{session_id}/escalate", "post", "EscalateRequest"),
    ],
)
def test_openapi_exposes_e01_request_bodies(
    client: TestClient, path: str, method: str, message_name: str
) -> None:
    spec = client.get("/openapi.json").json()
    components = spec["components"]["schemas"]
    assert message_name in components, f"{message_name} must be a component"
    assert "ProtocolError" in components
    assert "SessionId" in components

    operation = spec["paths"][path][method]
    body = operation["requestBody"]["content"]["application/json"]
    assert body["schema"], "request body must carry a schema"
    ref = body["schema"]["$ref"]
    assert ref == f"#/components/schemas/{message_name}"
    example = body["example"]
    assert is_message(message_name, example), (
        f"swagger example for {path} must be wire-valid"
    )

    components_for = ref.replace("#/components/schemas/", "")
    assert components_for in components


def test_openapi_protocol_error_responses(client: TestClient) -> None:
    spec = client.get("/openapi.json").json()
    step = spec["paths"]["/v1/sessions/{session_id}/step"]["post"]
    expected = {"400", "404", "409", "503"}
    assert expected <= set(step["responses"])
    every = [
        resp
        for op in spec["paths"].values()
        for obj in op.values()
        for resp in obj["responses"].values()
        if isinstance(resp, dict)
    ]
    protocol_errors = [
        resp
        for resp in every
        if "ProtocolError" in str(resp.get("content", {}).get("application/json", {}))
    ]
    assert len(protocol_errors) >= 4


# --- failure mapping -----------------------------------------------------


def test_store_failure_maps_to_unavailable(make_client) -> None:
    client = make_client(store=FailAlwaysStore())
    resp = client.post(
        "/v1/sessions",
        json={
            "protocol": "1.0",
            "task_id": EMAIL.task_id,
            "task_version": 1,
            "task": EMAIL.task_text,
            "allowed_domains": ["example.test"],
            "capabilities": {"browser": "chrome", "backend": "wasm", "detectors": ["dom"], "crops": False},
            "mode": "agent",
            "read_only": False,
        },
    )
    assert_protocol_error(resp, "unavailable", 503)


def test_step_store_failure_is_bounded(make_client) -> None:
    client = make_client(store=FailAlwaysStore())
    resp = client.post("/v1/sessions/s_any/step", json=email_state("s_any"))
    assert_protocol_error(resp, "unavailable", 503)


def test_step_store_get_failure_is_bounded_with_correlation(make_client) -> None:
    client = make_client(store=FailGetStore())
    resp = client.post("/v1/sessions/s_any/step", json=email_state("s_any"))
    data = assert_protocol_error(resp, "unavailable", 503)
    assert data.get("session_id") == "s_any"


def test_step_store_advance_failure_is_bounded(make_client) -> None:
    client = make_client(store=FailAdvanceStore())
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid))
    data = assert_protocol_error(resp, "unavailable", 503)
    assert data.get("session_id") == sid


def test_feedback_store_advance_failure_is_bounded(make_client) -> None:
    client = make_client(store=FailAdvanceStore())
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    resp = client.post(
        f"/v1/sessions/{sid}/feedback",
        json=feedback_payload(session_id=sid, task_id=EMAIL.task_id),
    )
    assert_protocol_error(resp, "unavailable", 503)


def test_end_store_delete_failure_is_bounded(make_client) -> None:
    client = make_client(store=FailDeleteStore())
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    resp = client.request(
        "DELETE",
        f"/v1/sessions/{sid}",
        json=end_payload(session_id=sid, task_id=EMAIL.task_id, seq=1),
    )
    assert_protocol_error(resp, "unavailable", 503)


def test_step_unsupported_version_is_bounded(make_client) -> None:
    client = make_client()
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    state = email_state(sid)
    state["protocol"] = "2.0"
    resp = client.post(f"/v1/sessions/{sid}/step", json=state)
    assert_protocol_error(resp, "unsupported_version", 400)


def test_step_malformed_body_is_bounded(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    resp = client.post(
        f"/v1/sessions/{sid}/step",
        content=b"{ not json",
        headers={"Content-Type": "application/json"},
    )
    assert_protocol_error(resp, "invalid_request", 400)


def test_planner_invalid_output_maps_to_unavailable(make_client) -> None:
    class BrokenPlanner:
        name = "broken"

        def plan(self, state, record):
            return {"type": "type", "target": "e_email", "text": "x", "clear_first": True}

    client = make_client(store=MemoryStore(), planner=BrokenPlanner())
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid))
    assert_protocol_error(resp, "unavailable", 503)


def test_planner_crash_is_bounded_and_does_not_leak(make_client) -> None:
    class CrashingPlanner:
        name = "crashing"

        def plan(self, state, record):
            raise RuntimeError("PRIVATE_CANARY secret=xx")

    client = make_client(store=MemoryStore(), planner=CrashingPlanner())
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid))
    data = assert_protocol_error(resp, "unavailable", 503)
    assert "PRIVATE_CANARY" not in str(data)
    assert "secret=xx" not in str(data)


def test_unknown_route_and_method_return_bounded_protocol_bodies(client: TestClient) -> None:
    resp = client.get("/v1/sessions")
    assert_protocol_error(resp, "invalid_request", resp.status_code)
    resp = client.get("/v1/sessions/not-an-endpoint")
    assert_protocol_error(resp, "invalid_request", resp.status_code)


@pytest.mark.parametrize(
    "which",
    [
        "malformed",
        "unknown-version",
        "unknown-field",
        "missing-identity",
        "mismatched-session",
        "unknown-session",
    ],
)
def test_all_error_bodies_are_schema_valid(client: TestClient, which: str) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    if which == "malformed":
        resp = client.post("/v1/sessions", content=b"{", headers={"Content-Type": "application/json"})
    elif which == "unknown-version":
        resp = client.post(
            "/v1/sessions",
            json={
                "protocol": "2.0",
                "task_id": EMAIL.task_id,
                "task_version": 1,
                "task": EMAIL.task_text,
                "allowed_domains": ["example.test"],
                "capabilities": {"browser": "chrome", "backend": "wasm", "detectors": ["dom"], "crops": False},
                "mode": "agent",
                "read_only": False,
            },
        )
    elif which == "unknown-field":
        payload = email_state(sid)
        payload["kind"] = "full"
        resp = client.post(f"/v1/sessions/{sid}/step", json={**email_state(sid), "page": None})
    elif which == "missing-identity":
        payload = email_state(sid)
        del payload["observation_id"]
        resp = client.post(f"/v1/sessions/{sid}/step", json=payload)
    elif which == "mismatched-session":
        resp = client.post(f"/v1/sessions/{sid}/step", json=email_state("s_someone_else"))
    else:
        resp = client.post("/v1/sessions/s_never_created/step", json=email_state("s_never_created"))
    assert resp.status_code >= 400
    assert_protocol_error(resp, resp.json()["code"], resp.status_code)