"""RedisSessionStore unit tests: TTL policy, expiry, deletion, failure modes."""

from __future__ import annotations

import time

import pytest

from privacagent_agent_api.session_store import RedisSessionStore, SessionRecord, SessionStoreError

KEY_PREFIX = "pa:agent:session:"


def make_record(session_id: str, task_id: str = "t_demo", task_version: int = 1) -> SessionRecord:
    return SessionRecord(
        session_id=session_id,
        task_id=task_id,
        task_version=task_version,
        created_at=time.time(),
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


def test_create_sets_default_1800_second_ttl(store: RedisSessionStore, redis_client) -> None:
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
        "s_dup", seq=9, doc_id="d_old", observation_id=9, plan_step=9, last_action_id="a_old"
    )
    store.create(make_record("s_dup", task_id="t_new"))
    got = store.get("s_dup")
    assert got is not None
    assert got.task_id == "t_new"
    assert got.plan_step == 0
    assert got.seq is None
    assert got.last_action_id is None


def test_advance_missing_session_returns_false(store: RedisSessionStore) -> None:
    assert not store.advance(
        "s_none", seq=1, doc_id="d", observation_id=1, plan_step=1
    )


def test_advance_on_missing_key_leaves_no_partial_hash(
    store: RedisSessionStore, redis_client
) -> None:
    key = f"{KEY_PREFIX}s_ghost"
    assert not store.advance("s_ghost", seq=1, doc_id="d", observation_id=1, plan_step=1)
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