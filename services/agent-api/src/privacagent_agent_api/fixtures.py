"""Deterministic synthetic scenarios and fixture Screen States (E-02).

These fixtures are the sandbox the extension/server contributors exercise the
protocol against. They are plain, self-contained payloads; none of them come
from a real page, none contain personal data, and the element ids they use are
exactly the ids the scripted fake planner targets in its actions.

Every ``Scenario`` carries its own ``fixture_state`` (a full Screen State
payload). ``full_state_payload`` returns a fresh copy with the correlation
fields re-keyed for a given session, so a test client can drive the scripts
with its own session/doc/observation identity.
"""

from __future__ import annotations

import copy
from typing import Any

from .planner import Scenario, ScriptedStep

_PAGE: dict[str, Any] = {
    "url": "https://example.test/profile",
    "title": "Profile",
    "viewport": {"w": 1280, "h": 720, "scroll_y": 0, "page_h": 1400},
}

_DEFAULT_CAPABILITIES: dict[str, Any] = {
    "browser": "chrome",
    "backend": "wasm",
    "detectors": ["dom", "rules"],
    "crops": False,
}


def _full_state(
    *,
    session_id: str,
    task_id: str,
    task_version: int,
    seq: int,
    doc_id: str,
    observation_id: int,
    step: int,
    elements: list[dict[str, Any]],
    text_context: list[str],
    mode: str = "agent",
) -> dict[str, Any]:
    return {
        "protocol": "1.0",
        "session_id": session_id,
        "task_id": task_id,
        "task_version": task_version,
        "seq": seq,
        "doc_id": doc_id,
        "observation_id": observation_id,
        "step": step,
        "page": copy.deepcopy(_PAGE),
        "redaction_scheme": "v1",
        "mode": mode,
        "kind": "full",
        "elements": elements,
        "text_context": text_context,
        "suspicious": False,
    }


_EMAIL_FIXTURE_ELEMENTS: list[dict[str, Any]] = [
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
    {
        "id": "e_cancel",
        "role": "button",
        "name": "Cancel",
        "bbox": [120, 90, 80, 32],
        "src": "dom",
        "conf": 1,
    },
]

_SEARCH_FIXTURE_ELEMENTS: list[dict[str, Any]] = [
    {
        "id": "e_search",
        "role": "combobox",
        "name": "Search products",
        "bbox": [20, 40, 240, 32],
        "src": "dom",
        "conf": 1,
        "value_state": "empty",
        "value": "",
    },
    {
        "id": "e_go",
        "role": "button",
        "name": "Go",
        "bbox": [260, 40, 60, 32],
        "src": "dom",
        "conf": 1,
    },
    {
        "id": "e_result",
        "role": "status",
        "name": "Result",
        "bbox": [20, 90, 240, 64],
        "src": "dom",
        "conf": 1,
    },
]


def _email_scenario() -> Scenario:
    fixture_state = _full_state(
        session_id="s_demo",
        task_id="t_profile_upd",
        task_version=1,
        seq=1,
        doc_id="d_profile",
        observation_id=1,
        step=0,
        elements=_EMAIL_FIXTURE_ELEMENTS,
        text_context=["Update your email address"],
    )
    steps = (
        ScriptedStep(
            command={
                "type": "type",
                "target": "e_email",
                "text": "{{EMAIL_1}}",
                "clear_first": True,
            },
            expect={"element": "e_email", "value_equals": "{{EMAIL_1}}"},
            consequential=False,
            risk="low",
        ),
        ScriptedStep(
            command={"type": "click", "target": "e_save"},
            expect={"disappear": "e_save"},
            consequential=True,
            risk="medium",
        ),
        ScriptedStep(
            command={"type": "done", "summary": "Email updated"},
            consequential=False,
            risk="low",
        ),
    )
    return Scenario(
        name="profile_email_update",
        task_id="t_profile_upd",
        task_text="Update my email to {{EMAIL_1}}",
        fixture_state=fixture_state,
        steps=steps,
    )


def _search_scenario() -> Scenario:
    fixture_state = _full_state(
        session_id="s_demo",
        task_id="t_search_demo",
        task_version=1,
        seq=1,
        doc_id="d_catalog",
        observation_id=1,
        step=0,
        elements=_SEARCH_FIXTURE_ELEMENTS,
        text_context=["Find products by keyword"],
    )
    steps = (
        ScriptedStep(
            command={"type": "click", "target": "e_search"},
            consequential=False,
            risk="low",
        ),
        ScriptedStep(
            command={
                "type": "type",
                "target": "e_search",
                "text": "coffee",
                "clear_first": True,
            },
            expect={"element": "e_search", "value_equals": "coffee"},
            consequential=False,
            risk="low",
        ),
        ScriptedStep(
            command={"type": "extract", "target": "e_result", "field": "text_context"},
            consequential=False,
            risk="low",
        ),
        ScriptedStep(
            command={"type": "done", "summary": "Search complete"},
            consequential=False,
            risk="low",
        ),
    )
    return Scenario(
        name="search_catalog",
        task_id="t_search_demo",
        task_text="Search the catalog for coffee",
        fixture_state=fixture_state,
        steps=steps,
    )


def builtin_scenarios() -> tuple[Scenario, ...]:
    return (_email_scenario(), _search_scenario())


def scenario_by_task_id(task_id: str) -> Scenario | None:
    for scenario in builtin_scenarios():
        if scenario.task_id == task_id:
            return scenario
    return None


def start_request_payload(scenario: Scenario, *, read_only: bool = False) -> dict[str, Any]:
    """SessionStartRequest payload for the given scenario."""
    return {
        "protocol": "1.0",
        "task_id": scenario.task_id,
        "task_version": 1,
        "task": scenario.task_text,
        "allowed_domains": ["example.test"],
        "capabilities": copy.deepcopy(_DEFAULT_CAPABILITIES),
        "mode": "agent",
        "read_only": read_only,
    }


def full_state_payload(
    scenario: Scenario,
    session_id: str,
    *,
    seq: int = 1,
    observation_id: int = 1,
    step: int = 0,
    doc_id: str = "d_profile",
    task_version: int = 1,
) -> dict[str, Any]:
    """A fresh full Screen State payload bound to ``session_id``."""
    payload = copy.deepcopy(scenario.fixture_state)
    payload["session_id"] = session_id
    payload["task_id"] = scenario.task_id
    payload["task_version"] = task_version
    payload["seq"] = seq
    payload["doc_id"] = doc_id
    payload["observation_id"] = observation_id
    payload["step"] = step
    return payload


def diff_state_payload(
    scenario: Scenario,
    session_id: str,
    *,
    seq: int = 2,
    observation_id: int = 2,
    base_observation_id: int = 1,
    step: int = 0,
    doc_id: str = "d_profile",
    removed: list[str] | None = None,
) -> dict[str, Any]:
    """A diff Screen State payload (used to prove the resync_required path)."""
    payload = full_state_payload(
        scenario,
        session_id,
        seq=seq,
        observation_id=observation_id,
        step=step,
        doc_id=doc_id,
    )
    payload["kind"] = "diff"
    payload["base_observation_id"] = base_observation_id
    payload["removed"] = list(removed or [])
    return payload