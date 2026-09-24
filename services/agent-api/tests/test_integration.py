"""End-to-end synthetic client flow over the E-01 wire contract.

This simulates what the future extension session client will do: start a
session, submit a full Screen State, receive a schema-valid Action, send
feedback, advance to the next observation, and end the session. The same
fixtures and helpers are reusable by the real client later.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from privacagent_protocol import is_message

from privacagent_agent_api.fixtures import full_state_payload, scenario_by_task_id

from helpers import end_payload, feedback_payload, start_session

EMAIL = scenario_by_task_id("t_profile_upd")
DOC_ID = "d_profile"


def step_and_feedback(client: TestClient, sid: str, *, seq: int, observation_id: int):
    state = full_state_payload(
        EMAIL, sid, seq=seq, observation_id=observation_id, step=observation_id - 1, doc_id=DOC_ID
    )
    resp = client.post(f"/v1/sessions/{sid}/step", json=state)
    assert resp.status_code == 200, resp.text
    action = resp.json()
    assert is_message("Action", action), "step response must be wire-valid"
    assert action["session_id"] == sid
    assert action["seq"] == seq
    assert action["observation_id"] == observation_id
    assert action["doc_id"] == DOC_ID

    fb = feedback_payload(
        session_id=sid,
        task_id=EMAIL.task_id,
        seq=seq,
        doc_id=DOC_ID,
        observation_id=observation_id,
        action_id=action["action_id"],
        status="ok",
    )
    resp = client.post(f"/v1/sessions/{sid}/feedback", json=fb)
    assert resp.status_code == 200, resp.text
    assert is_message("FeedbackResponse", resp.json())
    assert resp.json()["status"] == "accepted"
    return action


def test_synthetic_client_flow(client: TestClient) -> None:
    start = start_session(client, EMAIL)
    assert is_message("SessionStartResponse", start)
    sid = start["session_id"]

    # Observation 1: scripted type into the email field.
    action_1 = step_and_feedback(client, sid, seq=1, observation_id=1)
    assert action_1["action"]["type"] == "type"
    assert action_1["action"]["target"] == "e_email"
    assert "scripted-fake-v1" in action_1["thought"]

    # Observation 2: scripted click on Save (target from the fixture state).
    action_2 = step_and_feedback(client, sid, seq=2, observation_id=2)
    assert action_2["action"]["type"] == "click"
    assert action_2["action"]["target"] == "e_save"
    assert action_2["consequential"] is True
    assert action_2["risk"] == "medium"

    # Observation 3: the script finishes with done.
    action_3 = step_and_feedback(client, sid, seq=3, observation_id=3)
    assert action_3["action"]["type"] == "done"
    assert action_3["action"]["summary"] == "Email updated"

    # End the session; afterwards the session is gone entirely.
    resp = client.request(
        "DELETE",
        f"/v1/sessions/{sid}",
        json=end_payload(session_id=sid, task_id=EMAIL.task_id, seq=3),
    )
    assert resp.status_code == 200
    ended = resp.json()
    assert is_message("SessionEndResponse", ended)
    assert ended["status"] == "ended"
    assert ended["session_id"] == sid

    resp = client.post(
        f"/v1/sessions/{sid}/step",
        json=full_state_payload(EMAIL, sid, seq=4, observation_id=4, doc_id=DOC_ID),
    )
    assert resp.status_code == 404
    assert resp.json()["code"] == "session_expired"


def test_second_scenario_is_independently_scripted(client: TestClient) -> None:
    search = scenario_by_task_id("t_search_demo")
    start = start_session(client, search)
    sid = start["session_id"]

    for seq, expected in [(1, "click"), (2, "type"), (3, "extract"), (4, "done")]:
        state = full_state_payload(
            search, sid, seq=seq, observation_id=seq, step=seq - 1, doc_id="d_catalog"
        )
        resp = client.post(f"/v1/sessions/{sid}/step", json=state)
        assert resp.status_code == 200, resp.text
        action = resp.json()
        assert is_message("Action", action)
        assert action["action"]["type"] == expected, f"step {seq} expected {expected}"

    resp = client.request(
        "DELETE",
        f"/v1/sessions/{sid}",
        json=end_payload(session_id=sid, task_id=search.task_id, seq=4),
    )
    assert resp.status_code == 200