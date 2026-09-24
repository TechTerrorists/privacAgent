"""Redis-backed session state for the synthetic E-02 session flow.

TTL policy
    * A session is created with ``ttl`` seconds (default 1,800, the protocol
      ceiling from ``SessionStartResponse.expires_in_seconds``).
    * The TTL slides forward on every successful ``/step`` and ``/feedback``
      request (activity-based). A silent session expires 30 minutes after its
      last successful interaction.
    * ``DELETE /v1/sessions/{id}`` removes the key immediately. Expired and
      deleted sessions leave no tombstone, so a later request is reported as
      ``session_expired``.
    * ``/escalate`` returns an ``unavailable`` error today and does not touch
      the session or its TTL.

Only sanitized session metadata is stored. No DOM, screenshots, vault
mappings, payload logging or request bodies are ever written to Redis.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Protocol as TypingProtocol

import redis as _redis
from redis import Redis


class SessionStoreError(Exception):
    """Redis is unreachable or a store operation failed.

    Routes map this to a bounded ``unavailable`` ``ProtocolError``. It never
    carries payload contents.
    """


class SessionStore(TypingProtocol):
    ttl: int

    def create(self, record: "SessionRecord") -> None: ...

    def get(self, session_id: str) -> "SessionRecord | None": ...

    def advance(
        self,
        session_id: str,
        *,
        seq: int,
        doc_id: str,
        observation_id: int,
        plan_step: int,
        last_action_id: str | None = None,
    ) -> bool: ...

    def delete(self, session_id: str) -> bool: ...


@dataclass
class SessionRecord:
    session_id: str
    task_id: str
    task_version: int
    created_at: float
    seq: int | None = None
    doc_id: str | None = None
    observation_id: int | None = None
    plan_step: int = 0
    last_action_id: str | None = None


_KEY_PREFIX = "pa:agent:session:"

# EXISTS + HSET + EXPIRE together, so a refresh can never re-create a key that
# already expired without its task identity/created_at fields, and a key that
# disappears mid-advance reports False instead of leaving a partial hash. TTL
# and the session's tracking fields are therefore always updated atomically.
# ``last_action_id`` is written only when the caller supplies one (step);
# feedback re-supplies the previous value so it is not cleared.
_ADVANCE_SCRIPT = """
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
redis.call('HSET', KEYS[1], 'seq', ARGV[1], 'doc_id', ARGV[2],
  'observation_id', ARGV[3], 'plan_step', ARGV[4])
if ARGV[6] ~= '' then
  redis.call('HSET', KEYS[1], 'last_action_id', ARGV[6])
end
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1
"""


class RedisSessionStore:
    """Redis hash-backed session store.

    The store talks to Redis directly and only surfaces ``SessionStoreError``
    for infrastructure problems; a missing key is a normal ``None`` result and
    becomes the route's job to interpret as ``session_expired``.

    ``advance`` refreshes the sliding TTL atomically with the field update via
    a single Lua script, so a successful step/feedback always leaves the key
    with a full TTL and a complete hash. A partially-written or
    context-less hash is treated as missing by ``get``.
    """

    def __init__(self, client: Redis, *, ttl: int = 1800) -> None:
        self._client = client
        self.ttl = ttl

    @classmethod
    def from_url(cls, url: str, *, ttl: int = 1800) -> "RedisSessionStore":
        client = Redis.from_url(
            url,
            decode_responses=True,
            socket_connect_timeout=2.0,
            socket_timeout=2.0,
        )
        return cls(client, ttl=ttl)

    @staticmethod
    def _key(session_id: str) -> str:
        return f"{_KEY_PREFIX}{session_id}"

    def create(self, record: SessionRecord) -> None:
        key = self._key(record.session_id)
        mapping = {
            "task_id": record.task_id,
            "task_version": str(record.task_version),
            "created_at": str(record.created_at),
        }
        try:
            with self._client.pipeline() as pipe:
                # Drop any leftover fields from a theoretical id collision so a
                # new session never inherits seq/plan_step/last_action_id.
                pipe.delete(key)
                pipe.hset(key, mapping=mapping)
                pipe.expire(key, self.ttl)
                pipe.execute()
        except _redis.RedisError as exc:
            raise SessionStoreError() from exc

    def get(self, session_id: str) -> SessionRecord | None:
        try:
            data = self._client.hgetall(self._key(session_id))
        except _redis.RedisError as exc:
            raise SessionStoreError() from exc
        if not data:
            return None
        # A hash without its identity fields can only be a partial/corrupted
        # write; treat it like an expired session instead of raising KeyError.
        if not {"task_id", "task_version", "created_at"} <= data.keys():
            return None
        return SessionRecord(
            session_id=session_id,
            task_id=str(data["task_id"]),
            task_version=int(data["task_version"]),
            created_at=float(data["created_at"]),
            seq=int(data["seq"]) if "seq" in data else None,
            doc_id=data.get("doc_id"),
            observation_id=int(data["observation_id"]) if "observation_id" in data else None,
            plan_step=int(data.get("plan_step", "0")),
            last_action_id=data.get("last_action_id") or None,
        )

    def advance(
        self,
        session_id: str,
        *,
        seq: int,
        doc_id: str,
        observation_id: int,
        plan_step: int,
        last_action_id: str | None = None,
    ) -> bool:
        key = self._key(session_id)
        try:
            ok = self._client.eval(
                _ADVANCE_SCRIPT,
                1,
                key,
                str(seq),
                doc_id,
                str(observation_id),
                str(plan_step),
                self.ttl,
                last_action_id or "",
            )
        except _redis.RedisError as exc:
            raise SessionStoreError() from exc
        return ok == 1

    def delete(self, session_id: str) -> bool:
        try:
            return bool(self._client.delete(self._key(session_id)))
        except _redis.RedisError as exc:
            raise SessionStoreError() from exc
