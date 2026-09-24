"""Scripted fake planner: determinism, fixture coverage, schema validity."""

from __future__ import annotations

from privacagent_protocol import is_message, parse_message

from privacagent_agent_api.fixtures import (
    builtin_scenarios,
    full_state_payload,
    scenario_by_task_id,
)
from privacagent_agent_api.planner import (
    FALLBACK_DONE_FINISHED,
    FALLBACK_DONE_UNKNOWN_TASK,
    LABEL,
    Scenario,
    ScriptedFakePlanner,
    ScriptedStep,
    action_id_for,
)
from privacagent_agent_api.session_store import SessionRecord


def record_for(scenario, *, plan_step: int = 0, session_id: str = "s_plan") -> SessionRecord:
    return SessionRecord(
        session_id=session_id,
        task_id=scenario.task_id,
        task_version=1,
        created_at=0.0,
        plan_step=plan_step,
    )


def state_for(scenario, *, seq: int = 1, observation_id: int = 1, session_id: str = "s_plan"):
    payload = full_state_payload(
        scenario, session_id, seq=seq, observation_id=observation_id, doc_id="d_plan"
    )
    return parse_message("ScreenState", payload)


def assert_valid_action(action: dict) -> None:
    assert is_message("Action", action), "planner output must be wire-valid"


def test_planner_is_identified_as_scripted(planner: ScriptedFakePlanner) -> None:
    assert planner.name == LABEL
    for scenario in builtin_scenarios():
        action = planner.plan(state_for(scenario), record_for(scenario))
        assert "scripted-fake-v1" in action["thought"]


def test_every_scenario_targets_only_present_fixture_elements() -> None:
    for scenario in builtin_scenarios():
        ids = [element["id"] for element in scenario.fixture_state["elements"]]
        assert len(ids) == len(set(ids)), f"{scenario.name} duplicates element ids"
        assert scenario.referenced_element_ids() <= scenario.element_ids(), (
            f"{scenario.name} references elements missing from its fixture state"
        )


def test_each_scripted_step_yields_a_valid_identity_preserving_action(
    planner: ScriptedFakePlanner,
) -> None:
    for scenario in builtin_scenarios():
        for idx in range(len(scenario.steps)):
            state = state_for(scenario, seq=idx + 1, observation_id=idx + 1)
            record = record_for(scenario, plan_step=idx)
            action = planner.plan(state, record)
            assert_valid_action(action)
            assert action["session_id"] == "s_plan"
            assert action["task_id"] == scenario.task_id
            assert action["task_version"] == 1
            assert action["seq"] == idx + 1
            assert action["doc_id"] == "d_plan"
            assert action["observation_id"] == idx + 1
            # Each step targets a real element that the fixture state supplies.
            referenced = set()
            cmd = action["action"]
            for key in ("target", "to_element"):
                if key in cmd:
                    referenced.add(cmd[key])
            if action.get("expect"):
                for key in ("element", "appear", "disappear"):
                    if key in action["expect"]:
                        referenced.add(action["expect"][key])
            assert referenced <= scenario.element_ids()


def test_plan_is_deterministic(planner: ScriptedFakePlanner) -> None:
    scenario = builtin_scenarios()[0]
    record = record_for(scenario)
    first = planner.plan(state_for(scenario), record)
    second = planner.plan(state_for(scenario), record)
    assert first == second
    assert action_id_for(record) == f"a_{scenario.task_id}_0"


def test_exhausted_scenario_returns_done(planner: ScriptedFakePlanner) -> None:
    scenario = builtin_scenarios()[0]
    record = record_for(scenario, plan_step=len(scenario.steps))
    action = planner.plan(state_for(scenario), record)
    assert_valid_action(action)
    assert action["action"]["type"] == "done"
    assert action["action"]["summary"] == FALLBACK_DONE_FINISHED


def test_unknown_task_returns_done_without_leaking(planner: ScriptedFakePlanner) -> None:
    scenario = builtin_scenarios()[0]
    record = SessionRecord(
        session_id="s_plan", task_id="t_not_in_catalog", task_version=1, created_at=0.0
    )
    action = planner.plan(state_for(scenario), record)
    assert_valid_action(action)
    assert action["action"]["type"] == "done"
    assert action["action"]["summary"] == FALLBACK_DONE_UNKNOWN_TASK
    assert "scenario=none" in action["thought"]


def test_missing_target_yields_wait_not_substitution(planner: ScriptedFakePlanner) -> None:
    scenario = builtin_scenarios()[0]
    payload = full_state_payload(scenario, "s_plan", doc_id="d_plan")
    payload["elements"] = [
        element for element in payload["elements"] if element["id"] != "e_email"
    ]
    state = parse_message("ScreenState", payload)
    action = planner.plan(state, record_for(scenario, plan_step=0))
    assert_valid_action(action)
    assert action["action"]["type"] == "wait"
    assert "target_missing" in action["thought"]


def escalate_targets_scenario() -> Scenario:
    return Scenario(
        name="escalate_targets",
        task_id="t_escalate_targets",
        task_text="Escalate with element targets",
        fixture_state=builtin_scenarios()[0].fixture_state,
        steps=(
            ScriptedStep(
                command={"type": "escalate", "targets": ["e_missing"], "question": "q?"},
            ),
        ),
    )


def test_escalate_targets_missing_element_yields_wait() -> None:
    scenario = escalate_targets_scenario()
    planner = ScriptedFakePlanner([scenario])
    state = state_for(scenario)
    action = planner.plan(state, record_for(scenario))
    assert_valid_action(action)
    assert action["action"]["type"] == "wait"
    assert action["action"]["ms"] == 500
    assert "target_missing" in action["thought"]
    assert "e_missing" in action["thought"]


def test_escalate_targets_present_passes_through_unchanged() -> None:
    scenario = escalate_targets_scenario()
    planner = ScriptedFakePlanner([scenario])
    payload = full_state_payload(scenario, "s_plan", doc_id="d_plan")
    payload["elements"] = [
        {
            "id": "e_missing",
            "role": "button",
            "name": "Missing",
            "bbox": [20, 40, 80, 32],
            "src": "dom",
            "conf": 1,
        }
    ]
    state = parse_message("ScreenState", payload)
    action = planner.plan(state, record_for(scenario))
    assert_valid_action(action)
    assert action["action"] == {
        "type": "escalate",
        "targets": ["e_missing"],
        "question": "q?",
    }
    assert "target_missing" not in action["thought"]


def test_scenarios_cover_multiple_tasks(planner: ScriptedFakePlanner) -> None:
    tasks = {scenario.task_id for scenario in builtin_scenarios()}
    assert len(tasks) == len(builtin_scenarios())
    for task_id in tasks:
        assert scenario_by_task_id(task_id) is not None
    assert scenario_by_task_id("t_does_not_exist") is None