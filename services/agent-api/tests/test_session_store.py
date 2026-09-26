"""RedisSessionStore unit tests: TTL policy, expiry, deletion, failure modes,
and the E-05 session memory (task context + bounded action history)."""

from __future__ import annotations

import json
import time
from typing import Any

import pytest

from privacagent_agent_api.session_store import (
    HISTORY_LIMIT,
    HistoryDecodeError,
    HistoryEntry,
    HistoryResult,
    RedisSessionStore,
    SessionRecord,
    SessionStoreError,
)
from redis.exceptions import WatchError

KEY_PREFIX = "pa:agent:session:"


def make_record(
    session_id: str, task_id: str = "t_demo", task_version: int = 1
) -> SessionRecord:
    return SessionRecord(
        session_id=session_id,
        task_id=task_id,
        task_version=task_version,
        created_at=time.time(),
    )


def make_history_entry(
    action_id: str,
    *,
    seq: int = 1,
    action: dict[str, Any] | None = None,
) -> HistoryEntry:
    return HistoryEntry(
        action_id=action_id,
        plan_step=seq,
        seq=seq,
        doc_id="d_demo",
        observation_id=seq,
        action=action if action is not None else {"type": "click", "target": "e_save"},
        consequential=False,
        risk="low",
    )


def test_create_and_get_roundtrip(store: RedisSessionStore, redis_client) -> None:
    store.create(make_record("s_roundtrip"))
    got = store.get("s_roundtrip")
    assert got is not None
    assert got.session_id == "s_roundtrip"
    assert got.task_id == "t_demo"
    assert got.task_version == 1
    assert got.created_at > 0
    assert got.plan_step == 0
    assert got.seq is None and got.doc_id is None and got.observation_id is None


def test_get_missing_session_returns_none(store: RedisSessionStore) -> None:
    assert store.get("s_missing") is None


def test_create_sets_default_1800_second_ttl(
    store: RedisSessionStore, redis_client
) -> None:
    store.create(make_record("s_ttl"))
    pttl = redis_client.pttl(f"{KEY_PREFIX}s_ttl")
    assert 1_780_000 < pttl <= 1_800_000


def test_advance_updates_context_and_refreshes_ttl(
    store: RedisSessionStore, redis_client
) -> None:
    store.create(make_record("s_adv"))
    assert store.advance(
        "s_adv",
        seq=2,
        doc_id="d_x",
        observation_id=7,
        plan_step=3,
        last_action_id="a_s_adv_2",
    )
    got = store.get("s_adv")
    assert got is not None
    assert got.seq == 2
    assert got.doc_id == "d_x"
    assert got.observation_id == 7
    assert got.plan_step == 3
    assert got.last_action_id == "a_s_adv_2"
    # TTL slid forward again after the successful interaction.
    pttl = redis_client.pttl(f"{KEY_PREFIX}s_adv")
    assert pttl > 1_780_000


def test_advance_without_action_id_preserves_previous_value(
    store: RedisSessionStore,
) -> None:
    store.create(make_record("s_keep"))
    assert store.advance(
        "s_keep", seq=1, doc_id="d", observation_id=1, plan_step=1, last_action_id="a_1"
    )
    assert store.advance(
        "s_keep", seq=2, doc_id="d", observation_id=2, plan_step=1, last_action_id=None
    )
    got = store.get("s_keep")
    assert got is not None
    assert got.last_action_id == "a_1"


def test_create_clears_leftover_fields_from_id_collision(
    store: RedisSessionStore, redis_client
) -> None:
    store.create(make_record("s_dup", task_id="t_old"))
    assert store.advance(
        "s_dup",
        seq=9,
        doc_id="d_old",
        observation_id=9,
        plan_step=9,
        last_action_id="a_old",
    )
    store.create(make_record("s_dup", task_id="t_new"))
    got = store.get("s_dup")
    assert got is not None
    assert got.task_id == "t_new"
    assert got.plan_step == 0
    assert got.seq is None
    assert got.last_action_id is None


def test_advance_missing_session_returns_false(store: RedisSessionStore) -> None:
    assert not store.advance("s_none", seq=1, doc_id="d", observation_id=1, plan_step=1)


def test_advance_on_missing_key_leaves_no_partial_hash(
    store: RedisSessionStore, redis_client
) -> None:
    key = f"{KEY_PREFIX}s_ghost"
    assert not store.advance(
        "s_ghost", seq=1, doc_id="d", observation_id=1, plan_step=1
    )
    assert redis_client.exists(key) == 0


def test_get_returns_none_for_malformed_partial_hash(
    store: RedisSessionStore, redis_client
) -> None:
    key = f"{KEY_PREFIX}s_partial"
    redis_client.hset(key, mapping={"seq": "2"})
    assert store.get("s_partial") is None
    redis_client.delete(key)


def test_delete_removes_all_state_without_tombstone(
    store: RedisSessionStore, redis_client
) -> None:
    store.create(make_record("s_del"))
    assert store.delete("s_del") is True
    assert store.get("s_del") is None
    assert store.delete("s_del") is False
    assert redis_client.exists(f"{KEY_PREFIX}s_del") == 0


def test_expiry_happens_without_a_30_minute_sleep(redis_client) -> None:
    one_second_store = RedisSessionStore(redis_client, ttl=1)
    one_second_store.create(make_record("s_exp"))
    assert one_second_store.get("s_exp") is not None
    time.sleep(1.5)
    assert one_second_store.get("s_exp") is None
    assert redis_client.exists(f"{KEY_PREFIX}s_exp") == 0


def test_redis_failure_surfaces_as_session_store_error() -> None:
    dead = RedisSessionStore.from_url("redis://127.0.0.1:1/0", ttl=1800)
    with pytest.raises(SessionStoreError):
        dead.get("s_any")
    with pytest.raises(SessionStoreError):
        dead.create(make_record("s_any"))
    with pytest.raises(SessionStoreError):
        dead.advance("s_any", seq=1, doc_id="d", observation_id=1, plan_step=1)
    with pytest.raises(SessionStoreError):
        dead.delete("s_any")


# --- E-05 session memory: retained task context + bounded history ----------


def test_create_get_roundtrip_retained_task_context(store: RedisSessionStore) -> None:
    record = make_record("s_ctx")
    record.task_text = "Mail {{EMAIL_1}} about the invoice"
    record.allowed_domains = ["example.com", "mail.example.org"]
    record.mode = "guide"
    record.read_only = True
    store.create(record)
    got = store.get("s_ctx")
    assert got is not None
    assert got.task_text == "Mail {{EMAIL_1}} about the invoice"
    assert got.allowed_domains == ["example.com", "mail.example.org"]
    assert got.mode == "guide"
    assert got.read_only is True


def test_create_get_roundtrip_default_task_context(store: RedisSessionStore) -> None:
    store.create(make_record("s_ctx_default"))
    got = store.get("s_ctx_default")
    assert got is not None
    assert got.task_text == ""
    assert got.allowed_domains == []
    assert got.mode == "agent"
    assert got.read_only is False
    assert got.history == []


def test_advance_appends_history_entry(store: RedisSessionStore) -> None:
    store.create(make_record("s_hist"))
    entry = make_history_entry("a_hist_1", seq=1)
    assert store.advance(
        "s_hist",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        last_action_id="a_hist_1",
        history_entry=entry.to_dict(),
    )
    got = store.get("s_hist")
    assert got is not None
    assert [e.to_dict() for e in got.history] == [entry.to_dict()]


def test_advance_history_keeps_newest_five_in_chronological_order(
    store: RedisSessionStore,
) -> None:
    store.create(make_record("s_trim"))
    for i in range(1, 7):
        assert store.advance(
            "s_trim",
            seq=i,
            doc_id="d_demo",
            observation_id=i,
            plan_step=i,
            last_action_id=f"a_{i}",
            history_entry=make_history_entry(f"a_{i}", seq=i).to_dict(),
        )
    got = store.get("s_trim")
    assert got is not None
    assert len(got.history) == HISTORY_LIMIT == 5
    # Oldest (a_1) evicted, remaining entries oldest → newest.
    assert [e.action_id for e in got.history] == ["a_2", "a_3", "a_4", "a_5", "a_6"]


def test_result_attach_sets_result_and_first_write_wins(
    store: RedisSessionStore, redis_client
) -> None:
    store.create(make_record("s_result"))
    assert store.advance(
        "s_result",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        last_action_id="a_res_1",
        history_entry=make_history_entry("a_res_1").to_dict(),
    )
    stored = json.loads(redis_client.hget(f"{KEY_PREFIX}s_result", "history"))
    assert "result" not in stored[0]  # pending is an absent key, not JSON null

    assert store.advance(
        "s_result",
        seq=2,
        doc_id="d_demo",
        observation_id=2,
        plan_step=1,
        result_entry={"action_id": "a_res_1", "status": "ok", "page_changed": True},
    )
    got = store.get("s_result")
    assert got is not None
    assert len(got.history) == 1
    assert got.history[0].result == HistoryResult(status="ok", page_changed=True)

    # Re-attaching the same action_id with a different status must not win.
    assert store.advance(
        "s_result",
        seq=3,
        doc_id="d_demo",
        observation_id=3,
        plan_step=1,
        result_entry={
            "action_id": "a_res_1",
            "status": "failed",
            "page_changed": False,
            "reason": "timeout",
        },
    )
    got = store.get("s_result")
    assert got is not None
    assert len(got.history) == 1
    assert got.history[0].result == HistoryResult(status="ok", page_changed=True)


def test_result_attach_with_reason_is_persisted(store: RedisSessionStore) -> None:
    store.create(make_record("s_reason"))
    assert store.advance(
        "s_reason",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        history_entry=make_history_entry("a_reason").to_dict(),
    )
    assert store.advance(
        "s_reason",
        seq=2,
        doc_id="d_demo",
        observation_id=2,
        plan_step=1,
        result_entry={
            "action_id": "a_reason",
            "status": "failed",
            "page_changed": False,
            "reason": "execution_error",
        },
    )
    got = store.get("s_reason")
    assert got is not None
    assert got.history[0].result == HistoryResult(
        status="failed", page_changed=False, reason="execution_error"
    )


def test_result_attach_for_unknown_action_id_is_a_noop(
    store: RedisSessionStore,
) -> None:
    store.create(make_record("s_unknown"))
    entry = make_history_entry("a_known")
    assert store.advance(
        "s_unknown",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        history_entry=entry.to_dict(),
    )
    assert store.advance(
        "s_unknown",
        seq=2,
        doc_id="d_demo",
        observation_id=2,
        plan_step=1,
        result_entry={"action_id": "a_ghost", "status": "ok", "page_changed": False},
    )
    got = store.get("s_unknown")
    assert got is not None
    assert [e.to_dict() for e in got.history] == [entry.to_dict()]


def test_advance_with_history_on_missing_session_creates_no_key(
    store: RedisSessionStore, redis_client
) -> None:
    key = f"{KEY_PREFIX}s_ghost_mem"
    assert not store.advance(
        "s_ghost_mem",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        history_entry=make_history_entry("a_ghost").to_dict(),
    )
    assert redis_client.exists(key) == 0


def test_advance_with_history_refreshes_ttl(redis_client) -> None:
    short_store = RedisSessionStore(redis_client, ttl=5)
    short_store.create(make_record("s_ttl_mem"))
    time.sleep(1.5)
    pttl = redis_client.pttl(f"{KEY_PREFIX}s_ttl_mem")
    assert pttl < 4_500
    assert short_store.advance(
        "s_ttl_mem",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        history_entry=make_history_entry("a_ttl").to_dict(),
    )
    pttl = redis_client.pttl(f"{KEY_PREFIX}s_ttl_mem")
    assert pttl > 4_500


def test_expiry_removes_history_with_the_session(redis_client) -> None:
    one_second_store = RedisSessionStore(redis_client, ttl=1)
    one_second_store.create(make_record("s_exp_mem"))
    assert one_second_store.advance(
        "s_exp_mem",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        history_entry=make_history_entry("a_exp").to_dict(),
    )
    assert one_second_store.get("s_exp_mem") is not None
    time.sleep(1.5)
    assert one_second_store.get("s_exp_mem") is None
    assert redis_client.exists(f"{KEY_PREFIX}s_exp_mem") == 0


def test_delete_removes_history_with_the_session(
    store: RedisSessionStore, redis_client
) -> None:
    store.create(make_record("s_del_mem"))
    assert store.advance(
        "s_del_mem",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        history_entry=make_history_entry("a_del").to_dict(),
    )
    assert store.delete("s_del_mem") is True
    assert store.get("s_del_mem") is None
    assert redis_client.exists(f"{KEY_PREFIX}s_del_mem") == 0


def test_history_is_isolated_between_sessions(store: RedisSessionStore) -> None:
    store.create(make_record("s_iso_a", task_id="t_a"))
    store.create(make_record("s_iso_b", task_id="t_b"))
    assert store.advance(
        "s_iso_a",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        history_entry=make_history_entry("a_only_a").to_dict(),
    )
    for i in (1, 2):
        assert store.advance(
            "s_iso_b",
            seq=i,
            doc_id="d_demo",
            observation_id=i,
            plan_step=i,
            history_entry=make_history_entry(f"a_b_{i}", seq=i).to_dict(),
        )
    got_a = store.get("s_iso_a")
    got_b = store.get("s_iso_b")
    assert got_a is not None and got_b is not None
    assert [e.action_id for e in got_a.history] == ["a_only_a"]
    assert [e.action_id for e in got_b.history] == ["a_b_1", "a_b_2"]
    assert got_a.task_id == "t_a" and got_b.task_id == "t_b"


def test_create_on_id_collision_resets_history_and_task_context(
    store: RedisSessionStore, redis_client
) -> None:
    first = make_record("s_dup_mem", task_id="t_old")
    first.task_text = "old task {{EMAIL_1}}"
    first.allowed_domains = ["old.example"]
    first.mode = "guide"
    first.read_only = True
    store.create(first)
    assert store.advance(
        "s_dup_mem",
        seq=1,
        doc_id="d_old",
        observation_id=1,
        plan_step=1,
        last_action_id="a_old",
        history_entry=make_history_entry("a_old").to_dict(),
    )
    key = f"{KEY_PREFIX}s_dup_mem"
    assert redis_client.hget(key, "history") is not None

    store.create(make_record("s_dup_mem", task_id="t_new"))
    got = store.get("s_dup_mem")
    assert got is not None
    assert got.task_id == "t_new"
    assert got.seq is None and got.last_action_id is None
    assert got.task_text == ""
    assert got.allowed_domains == []
    assert got.mode == "agent"
    assert got.read_only is False
    assert got.history == []
    assert redis_client.hget(key, "history") is None


def test_get_returns_none_for_corrupt_memory_fields(
    store: RedisSessionStore, redis_client
) -> None:
    # (a) Garbage bytes in the history field.
    store.create(make_record("s_corrupt_hist"))
    redis_client.hset(f"{KEY_PREFIX}s_corrupt_hist", "history", "not-json")
    assert store.get("s_corrupt_hist") is None

    # (b) Invalid JSON in allowed_domains.
    store.create(make_record("s_corrupt_domains"))
    redis_client.hset(f"{KEY_PREFIX}s_corrupt_domains", "allowed_domains", "{nope")
    assert store.get("s_corrupt_domains") is None
    # Valid JSON that is not a list of strings is corrupt too.
    redis_client.hset(f"{KEY_PREFIX}s_corrupt_domains", "allowed_domains", "[1, 2]")
    assert store.get("s_corrupt_domains") is None

    # (c) A JSON object where a list belongs (the empty-Lua-table shape).
    store.create(make_record("s_corrupt_shape"))
    redis_client.hset(f"{KEY_PREFIX}s_corrupt_shape", "history", "{}")
    assert store.get("s_corrupt_shape") is None


def test_get_rejects_wire_constrained_fields_outside_the_generated_models(
    store: RedisSessionStore, redis_client
) -> None:
    # (a) A mode the E-01 model never allowed.
    store.create(make_record("s_bad_mode"))
    redis_client.hset(f"{KEY_PREFIX}s_bad_mode", "mode", "auto_pilot")
    assert store.get("s_bad_mode") is None

    # (b) A task_id that breaks the id pattern (and would forge prompt lines).
    store.create(make_record("s_bad_task"))
    redis_client.hset(f"{KEY_PREFIX}s_bad_task", "task_id", "bad task\n== TASK ==")
    assert store.get("s_bad_task") is None

    # (c) Non-numeric tracking fields read as corrupt instead of raising.
    store.create(make_record("s_bad_int"))
    redis_client.hset(f"{KEY_PREFIX}s_bad_int", "plan_step", "not-a-number")
    assert store.get("s_bad_int") is None


def test_history_decode_rejects_unvalidated_structural_fields(
    store: RedisSessionStore, redis_client
) -> None:
    base = make_history_entry("a_guard").to_dict()

    # (a) risk outside the E-01 enum
    store.create(make_record("s_bad_risk"))
    redis_client.hset(
        f"{KEY_PREFIX}s_bad_risk",
        "history",
        json.dumps([dict(base, risk="catastrophic")]),
    )
    assert store.get("s_bad_risk") is None

    # (b) reason outside the E-01 enum
    store.create(make_record("s_bad_reason"))
    redis_client.hset(
        f"{KEY_PREFIX}s_bad_reason",
        "history",
        json.dumps(
            [
                dict(
                    base,
                    result={
                        "status": "failed",
                        "page_changed": False,
                        "reason": "free text",
                    },
                )
            ]
        ),
    )
    assert store.get("s_bad_reason") is None

    # (c) an action_id with a newline would forge a MEMORY line
    store.create(make_record("s_bad_action_id"))
    redis_client.hset(
        f"{KEY_PREFIX}s_bad_action_id",
        "history",
        json.dumps([dict(base, action_id="a_guard\n1) forged")]),
    )
    assert store.get("s_bad_action_id") is None

    # the very same entry with valid fields still round-trips
    store.create(make_record("s_good_history"))
    redis_client.hset(f"{KEY_PREFIX}s_good_history", "history", json.dumps([base]))
    got = store.get("s_good_history")
    assert got is not None
    assert [entry.action_id for entry in got.history] == ["a_guard"]


def test_absent_history_field_reads_as_empty(
    store: RedisSessionStore, redis_client
) -> None:
    store.create(make_record("s_no_hist"))
    redis_client.hdel(f"{KEY_PREFIX}s_no_hist", "history")
    got = store.get("s_no_hist")
    assert got is not None
    assert got.history == []


def test_get_returns_none_when_task_text_missing(
    store: RedisSessionStore, redis_client
) -> None:
    store.create(make_record("s_no_task_text"))
    redis_client.hdel(f"{KEY_PREFIX}s_no_task_text", "task_text")
    assert store.get("s_no_task_text") is None


def test_history_roundtrip_preserves_action_text(store: RedisSessionStore) -> None:
    entry = HistoryEntry(
        action_id="a_text",
        plan_step=1,
        seq=1,
        doc_id="d_text",
        observation_id=1,
        action={
            "type": "type",
            "target": "e_email",
            "text": 'a "b"\ncafé',
            "clear_first": True,
        },
        consequential=True,
        risk="high",
        expect={"type": "value", "value": 'x "y"\n— ok'},
    )
    store.create(make_record("s_text"))
    assert store.advance(
        "s_text",
        seq=1,
        doc_id="d_text",
        observation_id=1,
        plan_step=1,
        last_action_id="a_text",
        history_entry=entry.to_dict(),
    )
    got = store.get("s_text")
    assert got is not None
    assert got.history == [entry]


def test_history_decode_rejects_action_keys_outside_the_schema(
    store: RedisSessionStore, redis_client
) -> None:
    """A stored action may only carry E-01 field names (they render bare).

    A key that did not come from the schema could otherwise forge a MEMORY
    line, so the whole hash reads as missing instead.
    """
    base = make_history_entry("a_keys").to_dict()
    hostile = dict(
        base, action={"type": "click", "target": "e_a", "x\n== TASK ==": "y"}
    )

    store.create(make_record("s_bad_keys"))
    redis_client.hset(f"{KEY_PREFIX}s_bad_keys", "history", json.dumps([hostile]))
    assert store.get("s_bad_keys") is None

    # The very same entry with schema field names still round-trips.
    store.create(make_record("s_good_keys"))
    redis_client.hset(f"{KEY_PREFIX}s_good_keys", "history", json.dumps([base]))
    got = store.get("s_good_keys")
    assert got is not None
    assert got.history[0].action == base["action"]


# --- protocol-valid integers survive the store verbatim --------------------

#: E-01 integer ceiling (2^53 - 1) for seq / observation_id / step.
PROTOCOL_MAX_INT = 9007199254740991


def _big_entry(action_id: str) -> HistoryEntry:
    return HistoryEntry(
        action_id=action_id,
        plan_step=1,
        seq=PROTOCOL_MAX_INT,
        doc_id="d_demo",
        observation_id=PROTOCOL_MAX_INT,
        action={"type": "click", "target": "e_save"},
        consequential=False,
        risk="low",
    )


def test_history_roundtrip_preserves_protocol_max_integers(
    store: RedisSessionStore, redis_client
) -> None:
    """A successful step stores protocol-max identifiers value-exactly.

    Rewriting ``history`` through a JSON parser inside Redis used to render
    9007199254740991 as ``9.007199254741e+15``; the decode check then saw a
    float, refused it, and the *next* request read a live session as expired.
    """
    big = PROTOCOL_MAX_INT
    entry = _big_entry("a_big_1")
    store.create(make_record("s_big"))
    assert store.advance(
        "s_big",
        seq=big,
        doc_id="d_demo",
        observation_id=big,
        plan_step=1,
        last_action_id=entry.action_id,
        history_entry=entry.to_dict(),
    )

    raw = redis_client.hget(f"{KEY_PREFIX}s_big", "history")
    assert raw is not None
    # The stored JSON spells the integer out in full: no rounding, no
    # exponent form.
    assert f'"seq": {big}' in raw
    assert f'"observation_id": {big}' in raw
    assert '"plan_step": 1' in raw

    got = store.get("s_big")
    assert got is not None
    assert type(got.seq) is int and got.seq == big
    assert type(got.observation_id) is int and got.observation_id == big
    assert got.last_action_id == "a_big_1"
    assert got.history == [entry]


def test_big_identifiers_survive_feedback_and_the_next_step(
    store: RedisSessionStore, redis_client
) -> None:
    """Subsequent access — feedback, then another step — keeps ids exact.

    Both writes re-encode the whole history list, so either one alone was
    enough to degrade the identifiers before.
    """
    big = PROTOCOL_MAX_INT
    entry = _big_entry("a_big_2")
    store.create(make_record("s_big_fb"))
    assert store.advance(
        "s_big_fb",
        seq=big,
        doc_id="d_demo",
        observation_id=big,
        plan_step=1,
        last_action_id=entry.action_id,
        history_entry=entry.to_dict(),
    )
    assert store.advance(
        "s_big_fb",
        seq=big - 1,
        doc_id="d_demo",
        observation_id=big - 1,
        plan_step=1,
        last_action_id=entry.action_id,
        result_entry={
            "action_id": "a_big_2",
            "status": "ok",
            "page_changed": False,
        },
    )
    got = store.get("s_big_fb")
    assert got is not None
    assert got.seq == big - 1
    assert got.observation_id == big - 1
    # The feedback write re-encoded the list: the issued entry keeps its ids.
    assert got.history[0].seq == big
    assert got.history[0].observation_id == big
    assert got.history[0].result == HistoryResult(status="ok", page_changed=False)

    # A following step appends without disturbing the retained entry.
    assert store.advance(
        "s_big_fb",
        seq=big,
        doc_id="d_demo",
        observation_id=big,
        plan_step=2,
        last_action_id="a_big_3",
        history_entry=make_history_entry("a_big_3", seq=big).to_dict(),
    )
    got = store.get("s_big_fb")
    assert got is not None
    assert [e.action_id for e in got.history] == ["a_big_2", "a_big_3"]
    assert all(type(e.seq) is int for e in got.history)
    assert [e.seq for e in got.history] == [big, big]


def test_advance_with_unreadable_history_reads_as_gone(
    store: RedisSessionStore, redis_client
) -> None:
    """Undecodable memory is never written over: the session reads as missing."""
    store.create(make_record("s_bad_hist"))
    redis_client.hset(f"{KEY_PREFIX}s_bad_hist", "history", "not-json")
    assert not store.advance(
        "s_bad_hist",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        history_entry=make_history_entry("a_bad").to_dict(),
    )
    assert redis_client.hget(f"{KEY_PREFIX}s_bad_hist", "history") == "not-json"
    assert store.get("s_bad_hist") is None


# --- optimistic-locked advance: a lost WATCH race is retried ----------------


class _ConflictingRedis:
    """A Redis handle whose pipelines lose the WATCH race on demand.

    A failing commit raises ``WatchError`` *before* touching the server — the
    same failure a real concurrent writer produces — and the pipeline is still
    reset by the store's ``with`` block, so the test observes only the store's
    retry behaviour. Everything else delegates to the real client.
    """

    def __init__(self, client: Any, failures: int) -> None:
        self._client = client
        self._failures = failures

    def pipeline(self) -> "_ConflictingPipeline":
        return _ConflictingPipeline(self._client.pipeline(), self)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


class _ConflictingPipeline:
    def __init__(self, pipe: Any, owner: _ConflictingRedis) -> None:
        self._pipe = pipe
        self._owner = owner

    def execute(self, *args: Any, **kwargs: Any) -> Any:
        if self._owner._failures > 0:
            self._owner._failures -= 1
            raise WatchError()
        return self._pipe.execute(*args, **kwargs)

    def __enter__(self) -> "_ConflictingPipeline":
        self._pipe.__enter__()
        return self

    def __exit__(self, *exc_info: Any) -> Any:
        return self._pipe.__exit__(*exc_info)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pipe, name)


def test_advance_retries_a_lost_watch_race_then_fails_loudly(
    store: RedisSessionStore, redis_client
) -> None:
    """A concurrent writer to the same session is re-read, never dropped.

    One lost race is retried against the winner's result and still commits; a
    conflict that outlives the bounded retry budget is a store failure
    (``unavailable``), with no partial write left behind.
    """
    store.create(make_record("s_race"))
    entry = make_history_entry("a_race")
    flaky = _ConflictingRedis(redis_client, failures=1)
    racy = RedisSessionStore(flaky, ttl=1800)
    assert racy.advance(
        "s_race",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        last_action_id=entry.action_id,
        history_entry=entry.to_dict(),
    )
    # The first commit really did lose the race, and the retry is what
    # committed: a store that ignored the conflict would not have spent it.
    assert flaky._failures == 0
    got = store.get("s_race")
    assert got is not None
    assert [e.action_id for e in got.history] == ["a_race"]

    # Far more conflicts than the retry budget: the write must fail loudly.
    stubborn_client = _ConflictingRedis(redis_client, failures=99)
    stubborn = RedisSessionStore(stubborn_client, ttl=1800)
    with pytest.raises(SessionStoreError):
        stubborn.advance(
            "s_race",
            seq=2,
            doc_id="d_demo",
            observation_id=2,
            plan_step=2,
            last_action_id="a_race_2",
            history_entry=make_history_entry("a_race_2").to_dict(),
        )
    # Every attempt spent its conflict instead of committing anything.
    assert stubborn_client._failures < 99
    got = store.get("s_race")
    assert got is not None
    assert [e.action_id for e in got.history] == ["a_race"]
    assert got.seq == 1
    assert got.plan_step == 1


# --- invalid input is refused before any mutation ---------------------------


def test_advance_rejects_invalid_result_entry_without_writing(
    store: RedisSessionStore, redis_client
) -> None:
    """Invalid feedback never reaches Redis: the hash stays as it was.

    ``result_entry`` is validated against the E-01 ``ActionResult`` fields
    before the transaction starts, so a bad ``status``, a non-boolean
    ``page_changed``, a bad ``reason`` or a bad ``action_id`` attaches
    nothing — and does not restart the sliding TTL either.
    """
    entry = make_history_entry("a_valid_1")
    store.create(make_record("s_bad_result"))
    assert store.advance(
        "s_bad_result",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        last_action_id=entry.action_id,
        history_entry=entry.to_dict(),
    )
    key = f"{KEY_PREFIX}s_bad_result"
    before = redis_client.hgetall(key)
    # Let the TTL degrade, so a forbidden refresh would show up as a jump
    # back to the full 1800s below.
    time.sleep(0.1)
    before_pttl = redis_client.pttl(key)

    invalid: list[Any] = [
        # Not an E-01 status.
        {"action_id": "a_valid_1", "status": "exploded", "page_changed": False},
        # A required ActionResult field is missing.
        {"action_id": "a_valid_1", "status": "ok"},
        # 1 is an int but not a bool: it must not read as true.
        {"action_id": "a_valid_1", "status": "ok", "page_changed": 1},
        {"action_id": "a_valid_1", "status": "ok", "page_changed": "yes"},
        # Not an E-01 reason.
        {
            "action_id": "a_valid_1",
            "status": "failed",
            "page_changed": False,
            "reason": "made_up_reason",
        },
        # No action_id, or one that breaks the ActionId pattern.
        {"status": "ok", "page_changed": False},
        {"action_id": "not an id!", "status": "ok", "page_changed": False},
        # Not a mapping at all.
        ["ok"],
    ]
    for result_entry in invalid:
        assert (
            store.advance(
                "s_bad_result",
                seq=2,
                doc_id="d_demo",
                observation_id=2,
                plan_step=1,
                result_entry=result_entry,
            )
            is False
        )

    assert redis_client.hgetall(key) == before
    # No commit means no TTL refresh: a refresh would have restored the full
    # window, which is far above the degraded reading taken above.
    assert redis_client.pttl(key) <= before_pttl
    got = store.get("s_bad_result")
    assert got is not None
    assert got.history[0].result is None


def test_advance_rejects_invalid_history_entry_without_writing(
    store: RedisSessionStore, redis_client
) -> None:
    """A malformed step entry is refused before it can poison the session.

    ``history_entry`` is round-tripped through ``HistoryEntry.from_dict``:
    anything that would make the next ``get`` reject the whole hash is
    rejected here instead, with the stored history left untouched.
    """
    base = make_history_entry("a_ok_1").to_dict()
    store.create(make_record("s_bad_entry"))
    assert store.advance(
        "s_bad_entry",
        seq=1,
        doc_id="d_demo",
        observation_id=1,
        plan_step=1,
        last_action_id="a_ok_1",
        history_entry=base,
    )
    key = f"{KEY_PREFIX}s_bad_entry"
    before = redis_client.hgetall(key)

    invalid: list[Any] = [
        # A required field is missing.
        {k: v for k, v in base.items() if k != "risk"},
        # bools and floats are not integer ids.
        {**base, "seq": True},
        {**base, "observation_id": True},
        {**base, "plan_step": 1.5},
        # Not the E-01 risk enum / ActionId pattern.
        {**base, "risk": "spicy"},
        {**base, "action_id": "not an id!"},
        # A field name outside the E-01 action envelope.
        {**base, "action": {"type": "click", "target": "e1", "evil": 1}},
        # Not a mapping at all.
        ["not", "a", "mapping"],
    ]
    for history_entry in invalid:
        assert (
            store.advance(
                "s_bad_entry",
                seq=2,
                doc_id="d_demo",
                observation_id=2,
                plan_step=1,
                history_entry=history_entry,
            )
            is False
        )

    assert redis_client.hgetall(key) == before
    # Nothing was appended and nothing was refreshed away.
    got = store.get("s_bad_entry")
    assert got is not None
    assert [e.action_id for e in got.history] == ["a_ok_1"]
    assert got.history[0] == HistoryEntry.from_dict(base)


def test_advance_rejects_non_strict_tracking_fields(
    store: RedisSessionStore, redis_client
) -> None:
    """``seq``/``observation_id``/``plan_step`` are strict ints, ids strict.

    ``True`` is an ``int`` in Python but not a step: persisting it would write
    ``"True"``, which ``get`` refuses — the session would read as expired
    right after a "successful" call. A ``doc_id``/``last_action_id`` outside
    the E-01 patterns would do the same on the next read.
    """
    store.create(make_record("s_bad_tracking"))
    key = f"{KEY_PREFIX}s_bad_tracking"
    before = redis_client.hgetall(key)

    rejected: list[dict[str, Any]] = [
        {"seq": True},
        {"observation_id": True},
        {"plan_step": True},
        {"seq": 1.5},
        {"observation_id": "2"},
        {"doc_id": "not an id!"},
        {"doc_id": ""},
        {"last_action_id": "not an id!"},
    ]
    for override in rejected:
        kwargs: dict[str, Any] = {
            "seq": 1,
            "doc_id": "d_demo",
            "observation_id": 1,
            "plan_step": 1,
            **override,
        }
        assert store.advance("s_bad_tracking", **kwargs) is False

    assert redis_client.hgetall(key) == before


def test_history_entry_from_dict_refuses_booleans_and_partial_entries() -> None:
    """The read path's integer checks are strict too: ``True`` is not a seq."""
    base = make_history_entry("a_bool").to_dict()
    for name in ("seq", "plan_step", "observation_id"):
        with pytest.raises(HistoryDecodeError):
            HistoryEntry.from_dict({**base, name: True})
    with pytest.raises(HistoryDecodeError):
        HistoryEntry.from_dict({k: v for k, v in base.items() if k != "risk"})


def test_history_result_from_dict_refuses_unhashable_enums() -> None:
    """An unhashable value where an enum belongs is a decode error, not a
    ``TypeError`` escaping to the caller."""
    with pytest.raises(HistoryDecodeError):
        HistoryResult.from_dict({"status": ["ok"], "page_changed": False})
    with pytest.raises(HistoryDecodeError):
        HistoryResult.from_dict(
            {"status": "ok", "page_changed": False, "reason": ["timeout"]}
        )
    with pytest.raises(HistoryDecodeError):
        HistoryResult.from_dict({"status": "ok", "page_changed": 1})


def test_get_rejects_a_read_only_flag_that_is_not_zero_or_one(
    store: RedisSessionStore, redis_client
) -> None:
    """``read_only`` decodes only the two values ``create`` writes.

    Anything else is a corrupted flag and reads as missing rather than
    silently becoming ``False`` — reporting a read-only session as writable
    is the one wrong answer to avoid.
    """
    store.create(make_record("s_ro"))
    key = f"{KEY_PREFIX}s_ro"
    for flag in ("true", "yes", "2", ""):
        redis_client.hset(key, "read_only", flag)
        assert store.get("s_ro") is None

    redis_client.hset(key, "read_only", "1")
    got = store.get("s_ro")
    assert got is not None and got.read_only is True
    redis_client.hset(key, "read_only", "0")
    got = store.get("s_ro")
    assert got is not None and got.read_only is False
