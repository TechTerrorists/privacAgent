"""Shared request builders and stub stores for the E-02 test suites.

The synthetic clients in these tests are the stand-ins for the future
extension session client. They exercise the exact E-01 wire contract over HTTP,
so the README's "replace the test client with the extension client" path is a
drop-in swap.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import replace
from typing import Any

from privacagent_agent_api.fixtures import start_request_payload
from privacagent_agent_api.planner import Scenario
from privacagent_agent_api.session_store import (
    HISTORY_LIMIT,
    HistoryEntry,
    HistoryResult,
    SessionRecord,
    SessionStoreError,
)


def new_session_id() -> str:
    return f"s_{uuid.uuid4().hex}"


def start_session(client, scenario: Scenario) -> dict[str, Any]:
    resp = client.post("/v1/sessions", json=start_request_payload(scenario))
    assert resp.status_code == 200, resp.text
    return resp.json()


def feedback_payload(
    *,
    session_id: str,
    task_id: str,
    seq: int = 1,
    doc_id: str = "d_profile",
    observation_id: int = 1,
    action_id: str = "a_demo",
    status: str = "ok",
    page_changed: bool = False,
    reason: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "action_id": action_id,
        "status": status,
        "page_changed": page_changed,
    }
    if reason is not None:
        result["reason"] = reason
    return {
        "protocol": "1.0",
        "session_id": session_id,
        "task_id": task_id,
        "task_version": 1,
        "seq": seq,
        "doc_id": doc_id,
        "observation_id": observation_id,
        "result": result,
    }


def end_payload(*, session_id: str, task_id: str, seq: int = 3) -> dict[str, Any]:
    return {
        "protocol": "1.0",
        "session_id": session_id,
        "task_id": task_id,
        "task_version": 1,
        "seq": seq,
    }


def escalate_payload(
    *,
    session_id: str,
    task_id: str,
    seq: int = 1,
    doc_id: str = "d_profile",
    observation_id: int = 1,
) -> dict[str, Any]:
    return {
        "protocol": "1.0",
        "session_id": session_id,
        "task_id": task_id,
        "task_version": 1,
        "seq": seq,
        "doc_id": doc_id,
        "observation_id": observation_id,
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


class CapturingPlanner:
    """Wraps a planner and records every prompt the route hands it."""

    name = "capturing"

    def __init__(self, inner) -> None:
        self.inner = inner
        self.prompts: list[Any] = []

    def plan(self, state, record, *, prompt=None):
        self.prompts.append(prompt)
        return self.inner.plan(state, record, prompt=prompt)


class MemoryStore:
    """In-memory SessionStore used to unit-test route error mapping without Redis."""

    ttl = 1800

    def __init__(self) -> None:
        self._data: dict[str, SessionRecord] = {}

    def create(self, record: SessionRecord) -> None:
        self._data[record.session_id] = record

    def get(self, session_id: str) -> SessionRecord | None:
        return self._data.get(session_id)

    def advance(
        self,
        session_id: str,
        *,
        seq: int,
        doc_id: str,
        observation_id: int,
        plan_step: int,
        last_action_id: str | None = None,
        history_entry: Mapping[str, Any] | None = None,
        result_entry: Mapping[str, Any] | None = None,
    ) -> bool:
        record = self._data.get(session_id)
        if record is None:
            return False
        record.seq = seq
        record.doc_id = doc_id
        record.observation_id = observation_id
        record.plan_step = plan_step
        if last_action_id is not None:
            record.last_action_id = last_action_id
        if history_entry is not None:
            record.history.append(HistoryEntry.from_dict(dict(history_entry)))
            # Keep the newest HISTORY_LIMIT entries, oldest first (Redis store).
            record.history[:] = record.history[-HISTORY_LIMIT:]
        if result_entry is not None:
            # First write wins: scan newest-first, attach only to a matching
            # entry that is still pending, no-op otherwise.
            for idx in range(len(record.history) - 1, -1, -1):
                entry = record.history[idx]
                if entry.action_id == result_entry.get("action_id"):
                    if entry.result is None:
                        record.history[idx] = replace(
                            entry, result=HistoryResult.from_dict(result_entry)
                        )
                    break
        return True

    def delete(self, session_id: str) -> bool:
        return self._data.pop(session_id, None) is not None


class FailAlwaysStore:
    """SessionStore that raises SessionStoreError on every operation."""

    ttl = 1800

    def create(self, record: SessionRecord) -> None:
        raise SessionStoreError()

    def get(self, session_id: str) -> SessionRecord | None:
        raise SessionStoreError()

    def advance(
        self,
        session_id: str,
        *,
        seq: int,
        doc_id: str,
        observation_id: int,
        plan_step: int,
        last_action_id: str | None = None,
        history_entry: Mapping[str, Any] | None = None,
        result_entry: Mapping[str, Any] | None = None,
    ) -> bool:
        raise SessionStoreError()

    def delete(self, session_id: str) -> bool:
        raise SessionStoreError()


class FailGetStore(MemoryStore):
    """SessionStore that fails only session lookups."""

    def get(self, session_id: str) -> SessionRecord | None:
        raise SessionStoreError()


class FailAdvanceStore(MemoryStore):
    """SessionStore that fails only TTL/context refreshes."""

    def advance(
        self,
        session_id: str,
        *,
        seq: int,
        doc_id: str,
        observation_id: int,
        plan_step: int,
        last_action_id: str | None = None,
        history_entry: Mapping[str, Any] | None = None,
        result_entry: Mapping[str, Any] | None = None,
    ) -> bool:
        raise SessionStoreError()


class VanishingAdvanceStore(MemoryStore):
    """SessionStore whose advance reports the key vanished (returns False)."""

    def advance(
        self,
        session_id: str,
        *,
        seq: int,
        doc_id: str,
        observation_id: int,
        plan_step: int,
        last_action_id: str | None = None,
        history_entry: Mapping[str, Any] | None = None,
        result_entry: Mapping[str, Any] | None = None,
    ) -> bool:
        self._data.pop(session_id, None)
        return False


class FailDeleteStore(MemoryStore):
    """SessionStore that fails only session deletion."""

    def delete(self, session_id: str) -> bool:
        raise SessionStoreError()
