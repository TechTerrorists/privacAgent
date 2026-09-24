"""Planner interface and the deterministic scripted fake planner (E-02).

The fake planner is exactly what its name says: a scripted, deterministic
sequence of schema-valid Actions. It never loads a model and never depends on
a GPU. Every Action it produces carries a ``thought`` field that starts with
``[scripted-fake-v1]`` so it is unmissable on the wire that a planner, not an
LLM, produced the response.

Each scenario is keyed by the session's ``task_id`` and indexed by the
session's ``plan_step`` counter, so identical session histories produce
byte-identical Actions. A real planner replaces this later by implementing the
same ``Planner`` protocol and being injected into ``create_app``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, Sequence

from privacagent_protocol import PROTOCOL_VERSION, models

from .session_store import SessionRecord

LABEL = "scripted-fake-v1"

FALLBACK_DONE_UNKNOWN_TASK = "Scripted fake planner has no scenario for this task"
FALLBACK_DONE_FINISHED = "Scripted plan complete"
FALLBACK_WAIT = {"type": "wait", "ms": 500}

# Keys inside command/expect objects that may name an ElementId. Bounded list
# on purpose: the fake planner only inspects what it itself emitted.
_TARGET_KEYS = ("target", "to_element")
_LIST_KEYS = ("targets",)
_EXPECT_KEYS = ("element", "appear", "disappear")


@dataclass(frozen=True)
class ScriptedStep:
    command: dict[str, Any]
    expect: dict[str, Any] | None = None
    consequential: bool = False
    risk: str = "low"


@dataclass(frozen=True)
class Scenario:
    name: str
    task_id: str
    task_text: str
    fixture_state: dict[str, Any]
    steps: tuple[ScriptedStep, ...]

    def element_ids(self) -> set[str]:
        ids: set[str] = set()
        for element in self.fixture_state.get("elements", []):
            element_id = element.get("id")
            if isinstance(element_id, str):
                ids.add(element_id)
        return ids

    def referenced_element_ids(self) -> set[str]:
        ids: set[str] = set()
        for step in self.steps:
            ids |= _referenced_element_ids(step.command, step.expect)
        return ids


class Planner(Protocol):
    """A planner turns one parsed Screen State into one Action payload."""

    name: str

    def plan(self, state: models.ScreenState, record: SessionRecord) -> dict[str, Any]: ...


def _referenced_element_ids(command: dict[str, Any], expect: dict[str, Any] | None) -> set[str]:
    ids: set[str] = set()
    for key in _TARGET_KEYS:
        value = command.get(key)
        if isinstance(value, str):
            ids.add(value)
    for key in _LIST_KEYS:
        value = command.get(key)
        if isinstance(value, list):
            ids.update(item for item in value if isinstance(item, str))
    if isinstance(expect, dict):
        for key in _EXPECT_KEYS:
            value = expect.get(key)
            if isinstance(value, str):
                ids.add(value)
    return ids


def _present_element_ids(state: models.ScreenState) -> set[str]:
    node = state.root
    return {
        element.root.id.root for element in node.elements if element.root.id is not None
    }


class ScriptedFakePlanner:
    """Deterministic scripted planner, unambiguously marked as a fake.

    ``plan`` only relies on the session record (task identity and the number of
    steps already served) and on the incoming Screen State (for correlation
    fields and, defensively, for whether referenced elements are present). It
    never synthesizes an element that the client did not supply. When a
    scripted command targets an id missing from the state, the planner emits a
    harmless ``wait`` instead — it never substitutes a similar control.
    """

    name = LABEL

    def __init__(self, scenarios: Sequence[Scenario]) -> None:
        self._scenarios = {scenario.task_id: scenario for scenario in scenarios}
        self._orders = {scenario.task_id: list(scenario.steps) for scenario in scenarios}

    def scenarios(self) -> tuple[Scenario, ...]:
        return tuple(self._scenarios.values())

    def plan(self, state: models.ScreenState, record: SessionRecord) -> dict[str, Any]:
        node = state.root
        scenario = self._scenarios.get(record.task_id)
        steps = self._orders.get(record.task_id)
        present = _present_element_ids(state)

        if scenario is not None and steps and record.plan_step < len(steps):
            scripted = steps[record.plan_step]
            command = dict(scripted.command)
            expect = dict(scripted.expect) if scripted.expect is not None else None
            consequential = scripted.consequential
            risk = scripted.risk
            missing = _referenced_element_ids(command, expect) - present
            if missing:
                command = dict(FALLBACK_WAIT)
                expect = None
                consequential = False
                risk = "low"
                thought = (
                    f"[{LABEL}:scenario={scenario.name}:step={record.plan_step}:"
                    f"target_missing={sorted(missing)}]"
                )
            else:
                thought = (
                    f"[{LABEL}:scenario={scenario.name}:"
                    f"step={record.plan_step} of {len(steps)}]"
                )
        elif scenario is not None:
            command = {"type": "done", "summary": FALLBACK_DONE_FINISHED}
            expect = None
            consequential = False
            risk = "low"
            thought = f"[{LABEL}:scenario={scenario.name}:steps_exhausted]"
        else:
            command = {"type": "done", "summary": FALLBACK_DONE_UNKNOWN_TASK}
            expect = None
            consequential = False
            risk = "low"
            thought = f"[{LABEL}:scenario=none:task_id={record.task_id[:48]}]"

        payload: dict[str, Any] = {
            "protocol": PROTOCOL_VERSION,
            "session_id": record.session_id,
            "task_id": record.task_id,
            "task_version": record.task_version,
            "seq": node.seq,
            "doc_id": node.doc_id.root,
            "observation_id": node.observation_id,
            "action_id": action_id_for(record),
            "action": command,
            "consequential": consequential,
            "risk": risk,
        }
        if expect is not None:
            payload["expect"] = expect
        payload["thought"] = thought
        return payload


def action_id_for(record: SessionRecord) -> str:
    """Deterministic per (task, session step) Action id, bounded to 80 chars."""
    return f"a_{record.task_id[:44]}_{record.plan_step}"