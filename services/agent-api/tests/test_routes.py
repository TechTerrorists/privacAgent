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
    VanishingAdvanceStore,
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
    data = assert_protocol_error(resp, "invalid_request", 400)
    # 400 echoes the path session_id so Swagger users can fix the body.
    assert data.get("session_id") == sid
    assert "session_id_mismatch" not in resp.text


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
    client = make_client(ttl=5)
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    assert start["expires_in_seconds"] == 5
    key = f"pa:agent:session:{sid}"
    time.sleep(1.5)
    pttl_before = redis_client.pttl(key)
    assert 1000 < pttl_before < 5000
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid))
    assert resp.status_code == 200
    pttl_after = redis_client.pttl(key)
    assert pttl_after > 4500


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
    client = make_client(ttl=5)
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    key = f"pa:agent:session:{sid}"
    time.sleep(1.5)
    pttl_before = redis_client.pttl(key)
    assert 1000 < pttl_before < 5000
    payload = escalate_payload(session_id=sid, task_id=EMAIL.task_id, doc_id=DOC_ID)
    resp = client.post(f"/v1/sessions/{sid}/escalate", json=payload)
    assert_protocol_error(resp, "unavailable", 503)
    pttl_after = redis_client.pttl(key)
    # A refresh would have reset the key to the full 5000 ms TTL.
    assert pttl_after <= pttl_before
    assert pttl_after < 4500


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


def test_openapi_session_path_param_is_documented(client: TestClient) -> None:
    """Path session_id must be a single SessionId $ref with usage guidance."""
    spec = client.get("/openapi.json").json()
    for path in (
        "/v1/sessions/{session_id}/step",
        "/v1/sessions/{session_id}/feedback",
        "/v1/sessions/{session_id}",
        "/v1/sessions/{session_id}/escalate",
    ):
        for method, operation in spec["paths"][path].items():
            session_params = [
                p
                for p in operation.get("parameters", [])
                if p.get("name") == "session_id" and p.get("in") == "path"
            ]
            assert len(session_params) == 1, f"{method} {path} must have one session_id param"
            param = session_params[0]
            assert param["required"] is True
            assert param["schema"].get("$ref") == "#/components/schemas/SessionId"
            assert "session_id" in param.get("description", "").lower()
            assert "path" in param.get("description", "").lower()


def test_openapi_success_responses_reference_e01_messages(client: TestClient) -> None:
    """200 responses must declare the E-01 response message and an example."""
    spec = client.get("/openapi.json").json()
    expected = {
        ("/v1/sessions", "post"): "SessionStartResponse",
        ("/v1/sessions/{session_id}/step", "post"): "Action",
        ("/v1/sessions/{session_id}/feedback", "post"): "FeedbackResponse",
        ("/v1/sessions/{session_id}", "delete"): "SessionEndResponse",
    }
    for (path, method), message_name in expected.items():
        media = spec["paths"][path][method]["responses"]["200"]["content"][
            "application/json"
        ]
        assert media["schema"]["$ref"] == f"#/components/schemas/{message_name}"
        assert is_message(message_name, media["example"]), (
            f"200 example for {path} must be wire-valid"
        )


def test_openapi_app_description_documents_try_it_out(client: TestClient) -> None:
    spec = client.get("/openapi.json").json()
    description = spec["info"]["description"]
    assert "session_id" in description
    assert "path" in description
    assert "body" in description


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
    store = FailAdvanceStore()
    client = make_client(store=store)
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    # Seed a prior step's action_id so feedback passes the action_id check
    # and actually reaches store_advance.
    store._data[sid].last_action_id = "a_prior_action"
    resp = client.post(
        f"/v1/sessions/{sid}/feedback",
        json=feedback_payload(
            session_id=sid, task_id=EMAIL.task_id, action_id="a_prior_action"
        ),
    )
    assert_protocol_error(resp, "unavailable", 503)


def test_feedback_rejects_stale_action_id(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid, seq=1, observation_id=1))
    first = resp.json()
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid, seq=2, observation_id=2))
    second = resp.json()
    assert first["action_id"] != second["action_id"]
    fb = feedback_payload(
        session_id=sid,
        task_id=EMAIL.task_id,
        seq=2,
        observation_id=2,
        action_id=first["action_id"],
    )
    resp = client.post(f"/v1/sessions/{sid}/feedback", json=fb)
    data = assert_protocol_error(resp, "invalid_request", 400)
    assert data["session_id"] == sid
    assert data["task_id"] == EMAIL.task_id


def test_feedback_without_prior_step_rejects_unknown_action_id(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    fb = feedback_payload(session_id=sid, task_id=EMAIL.task_id, action_id="a_demo")
    resp = client.post(f"/v1/sessions/{sid}/feedback", json=fb)
    assert_protocol_error(resp, "invalid_request", 400)


def test_step_vanishing_advance_reports_session_expired(make_client) -> None:
    client = make_client(store=VanishingAdvanceStore())
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    resp = client.post(f"/v1/sessions/{sid}/step", json=email_state(sid))
    data = assert_protocol_error(resp, "session_expired", 404)
    assert data["session_id"] == sid


def test_feedback_vanishing_advance_reports_session_expired(make_client) -> None:
    store = VanishingAdvanceStore()
    client = make_client(store=store)
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    store._data[sid].last_action_id = "a_prior_action"
    resp = client.post(
        f"/v1/sessions/{sid}/feedback",
        json=feedback_payload(
            session_id=sid, task_id=EMAIL.task_id, action_id="a_prior_action"
        ),
    )
    assert_protocol_error(resp, "session_expired", 404)


def test_step_path_body_mismatch_on_unknown_session_omits_correlation(
    client: TestClient,
) -> None:
    # Unknown path session must report session_expired without echoing the
    # body's (untrusted) task identity or seq.
    state = email_state("s_someone_else")
    resp = client.post("/v1/sessions/s_never_created/step", json=state)
    data = assert_protocol_error(resp, "session_expired", 404)
    assert data.get("session_id") == "s_never_created"
    assert "task_id" not in data
    assert "seq" not in data


def test_step_task_mismatch_correlation_uses_session_identity(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    sid = start["session_id"]
    state = full_state_payload(SEARCH, sid, seq=1, observation_id=1, doc_id="d_catalog")
    resp = client.post(f"/v1/sessions/{sid}/step", json=state)
    data = assert_protocol_error(resp, "invalid_request", 400)
    assert data["session_id"] == sid
    assert data["task_id"] == EMAIL.task_id, "must report the session's task, not the body's"
    assert data["task_version"] == 1


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
    # Framework errors (unknown route/method) always use invalid_request → 400
    # so HTTP status matches errors.HTTP_STATUS_BY_CODE.
    resp = client.get("/v1/sessions")
    assert_protocol_error(resp, "invalid_request", 400)
    resp = client.get("/v1/sessions/not-an-endpoint")
    assert_protocol_error(resp, "invalid_request", 400)
    resp = client.put(f"/v1/sessions/{start_session(client, EMAIL)['session_id']}/step")
    assert_protocol_error(resp, "invalid_request", 400)


def test_start_expires_in_matches_store_ttl(make_client) -> None:
    class CustomTtlStore(MemoryStore):
        ttl = 42

    client = make_client(store=CustomTtlStore())
    start = start_session(client, EMAIL)
    assert start["expires_in_seconds"] == 42


def test_dead_redis_maps_to_bounded_unavailable(make_client) -> None:
    from privacagent_agent_api.session_store import RedisSessionStore

    dead = RedisSessionStore.from_url("redis://127.0.0.1:1/0", ttl=1800)
    client = make_client(store=dead)
    resp = client.post("/v1/sessions", json=start_request_payload(EMAIL))
    data = assert_protocol_error(resp, "unavailable", 503)
    assert "redis" not in resp.text.lower() or data["code"] == "unavailable"
    resp = client.post("/v1/sessions/s_any/step", json=email_state("s_any"))
    assert_protocol_error(resp, "unavailable", 503)


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
        resp = client.post(
            f"/v1/sessions/{sid}/step", json={**email_state(sid), "not_a_field": 1}
        )
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


# --- debug logging --------------------------------------------------------


def test_debug_log_records_stage_reasons_without_payload(
    make_client, tmp_path, monkeypatch
) -> None:
    """Rejections land in debug.log with stage detail; response stays bare."""
    import json as _json

    from privacagent_agent_api.config import Settings

    log_path = tmp_path / "debug.log"
    monkeypatch.setenv("PA_DEBUG_LOG", str(log_path))
    client = make_client(
        settings=Settings(
            redis_url=REDIS_URL,
            session_ttl=1800,
            max_body_bytes=5 * 1024 * 1024,
            debug_log_path=str(log_path),
        )
    )
    start = start_session(client, EMAIL)
    sid = start["session_id"]

    # Path/body session mismatch — the common Swagger footgun.
    resp = client.post(
        f"/v1/sessions/{sid}/step", json=email_state("REPLACE_WITH_SESSION_ID")
    )
    assert_protocol_error(resp, "invalid_request", 400)
    assert "stage=path_body_match" not in resp.text
    assert "PRIVATE_CANARY" not in resp.text
    assert resp.json().get("session_id") == sid

    # Schema failure with a canary value that must not appear in the log.
    bad = email_state(sid)
    bad["page"] = None
    resp = client.post(f"/v1/sessions/{sid}/step", json=bad)
    assert_protocol_error(resp, "invalid_request", 400)

    # Missing required field.
    missing = email_state(sid)
    del missing["observation_id"]
    resp = client.post(f"/v1/sessions/{sid}/step", json=missing)
    assert_protocol_error(resp, "invalid_request", 400)

    text = log_path.read_text(encoding="utf-8")
    assert "stage=path_body_match" in text
    assert "session_id_mismatch" in text
    assert f"path={sid}" in text
    assert "stage=parse_message" in text
    assert "missing required 'observation_id'" in text
    # Stage detail must never appear in HTTP bodies.
    assert "session_id_mismatch" not in resp.text
    # Task text / page values must not be copied into the log.
    assert EMAIL.task_text not in text
    assert "https://example.test/profile" not in text