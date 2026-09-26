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

Retained session context (E-05)
    ``create`` also persists the *sanitized* task context the prompt builder
    needs — ``task_text``, ``allowed_domains``, ``mode``, ``read_only`` — plus
    a bounded ``history`` of at most ``HISTORY_LIMIT`` issued actions and their
    reported results (the "last-5-step memory"). It does **not** store Screen
    States, DOM, screenshots, vault mappings, raw prompts or payload logs, and
    the whole hash still lives and dies with the session: the same sliding TTL
    and ``DELETE`` lifecycle cover the memory because it is a field of the
    session key itself, never a separate key.

    Memory writes go through ``advance``, not through a second key or a second
    command: the append/attach, the tracking fields and the TTL refresh are one
    EXISTS-guarded Lua script, so a step can never record an action the client
    never received, and a memory write can never resurrect an expired session.

    An empty history is never stored. ``create`` omits the field when there is
    nothing to keep and ``get`` reads an absent field as ``[]``, because Redis
    Lua re-encodes an empty table as a JSON object ``{}`` rather than ``[]`` —
    the invariant that keeps the Lua append path free of that edge case.

    The read path re-validates what the prompt renders raw. The wire
    guaranteed the ``task_id``/``doc_id``/``action_id`` patterns and the
    ``mode``, ``risk`` and ``reason`` enums on write; ``get`` and
    ``HistoryEntry.from_dict`` check them again with the generated E-01
    models, because a hash is only as trustworthy as its last writer. A hash
    that fails any of those checks — or whose numeric fields are not numbers —
    reads as missing: it never feeds unvalidated text into a prompt and never
    raises into a route.

Only sanitized session metadata is stored. No DOM, screenshots, vault
mappings, payload logging or request bodies are ever written to Redis.
"""

from __future__ import annotations

import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol as TypingProtocol, get_args

import redis as _redis
from privacagent_protocol import models
from pydantic import ValidationError
from redis import Redis

# Keep only the most recent issued steps in prompt memory (PRD 8.3).
HISTORY_LIMIT = 5


def _literal_values(annotation: Any) -> frozenset[Any]:
    """All members of a (possibly optional) ``Literal`` annotation.

    Reads the generated E-01 model instead of repeating its vocabulary here,
    so the store can never drift from the wire contract.
    """
    values: list[Any] = []
    for arg in get_args(annotation) or (annotation,):
        if arg is type(None):
            continue
        nested = get_args(arg)
        values.extend(nested if nested else (arg,))
    return frozenset(values)


_RISK_VALUES = _literal_values(models.Action.model_fields["risk"].annotation)
_REASON_VALUES = _literal_values(models.ActionResult.model_fields["reason"].annotation)

# Every field name that may appear as a top-level key of an ActionCommand,
# read from the generated models (19 command variants) instead of repeated
# here, so the store can never drift from the wire contract. Used to reject a
# stored action whose keys did not come from the schema — a key is the one
# part of a MEMORY line that the renderer cannot assume is identifier-shaped.
_ACTION_COMMAND_FIELDS: frozenset[str] = frozenset().union(
    *(
        set(variant.model_fields)
        for variant in get_args(models.ActionCommand.model_fields["root"].annotation)
    )
)


def _matches(model: Any, value: str) -> bool:
    """True when ``value`` satisfies the generated E-01 model for it."""
    try:
        model.model_validate(value)
    except ValidationError:
        return False
    return True


class SessionStoreError(Exception):
    """Redis is unreachable or a store operation failed.

    Routes map this to a bounded ``unavailable`` ``ProtocolError``. It never
    carries payload contents.
    """


class HistoryDecodeError(ValueError):
    """A stored ``history`` field could not be decoded.

    Payload-free by construction (a fixed message, never the offending bytes)
    so it can be raised, logged or chained without leaking task or page text.
    Treated like a partial/corrupted hash: the session reads as missing.
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
        history_entry: "Mapping[str, Any] | None" = None,
        result_entry: "Mapping[str, Any] | None" = None,
    ) -> bool:
        """Refresh tracking fields + sliding TTL, optionally updating memory.

        ``history_entry`` (a ``HistoryEntry.to_dict()``) is appended to the
        session's bounded history, evicting the oldest beyond
        ``HISTORY_LIMIT``. ``result_entry`` (``{"action_id", "status",
        "page_changed", "reason"?}``) attaches a reported result to the entry
        with that ``action_id``; it is idempotent (an entry that already has a
        result is left untouched) and never appends. Both updates run inside
        the same EXISTS-guarded, TTL-refreshing script as the tracking fields,
        so they can neither resurrect an expired session nor commit one
        without the other.

        Returns False only when the session key is gone (expired/deleted).
        """

    def delete(self, session_id: str) -> bool: ...


@dataclass(frozen=True)
class HistoryResult:
    """A reported ``ActionResult`` summary attached to one issued step.

    Only wire-safe scalars: an outcome enum, a page-changed flag and an
    optional failure reason. Never page text, never a prompt excerpt.
    """

    status: str  # ok | failed | mismatch | unknown
    page_changed: bool
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"status": self.status, "page_changed": self.page_changed}
        if self.reason is not None:
            out["reason"] = self.reason
        return out

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "HistoryResult":
        if not isinstance(data, Mapping):
            raise HistoryDecodeError()
        status = data.get("status")
        page_changed = data.get("page_changed")
        reason = data.get("reason")
        if status not in ("ok", "failed", "mismatch", "unknown"):
            raise HistoryDecodeError()
        if not isinstance(page_changed, bool):
            raise HistoryDecodeError()
        # ``reason`` is an E-01 enum: anything else is a corrupt store value
        # and must never reach the MEMORY section of a prompt unescaped.
        if reason is not None and reason not in _REASON_VALUES:
            raise HistoryDecodeError()
        return cls(status=status, page_changed=page_changed, reason=reason)


@dataclass(frozen=True)
class HistoryEntry:
    """One issued step kept for prompt memory: the action that was actually
    sent to the client plus its reported result (``None`` = still pending).

    ``action`` is the schema-bounded ``ActionCommand`` dict verbatim,
    placeholders included — the server never resolves them. No Screen State,
    no DOM, no ``thought``, no prompt dump is ever retained here.
    """

    action_id: str
    plan_step: int
    seq: int
    doc_id: str
    observation_id: int
    action: dict[str, Any]
    consequential: bool
    risk: str
    expect: dict[str, Any] | None = None
    result: HistoryResult | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "action_id": self.action_id,
            "plan_step": self.plan_step,
            "seq": self.seq,
            "doc_id": self.doc_id,
            "observation_id": self.observation_id,
            "action": self.action,
            "consequential": self.consequential,
            "risk": self.risk,
        }
        if self.expect is not None:
            out["expect"] = self.expect
        # Absent key (not JSON null) means "no feedback yet": it keeps the
        # Lua/cjson round trip free of null-sentinel edge cases and makes
        # "pending" structurally distinguishable from any reported outcome.
        if self.result is not None:
            out["result"] = self.result.to_dict()
        return out

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "HistoryEntry":
        """Decode one stored memory entry, re-checking it against E-01.

        Every field that renders into a MEMORY line — ids, risk, reason and
        the action's field names — is checked against the generated models
        again, because a hash is only as trustworthy as its last writer. Any
        mismatch raises ``HistoryDecodeError`` (payload-free), which the store
        treats as a corrupt hash rather than as prompt data. Action *values*
        are not re-validated here: the renderer escapes every one of them.
        """
        if not isinstance(data, Mapping):
            raise HistoryDecodeError()
        try:
            action_id = data["action_id"]
            plan_step = data["plan_step"]
            seq = data["seq"]
            doc_id = data["doc_id"]
            observation_id = data["observation_id"]
            action = data["action"]
            consequential = data["consequential"]
            risk = data["risk"]
        except KeyError:
            raise HistoryDecodeError() from None
        if not isinstance(action_id, str) or not isinstance(doc_id, str):
            raise HistoryDecodeError()
        if not isinstance(plan_step, int) or not isinstance(seq, int):
            raise HistoryDecodeError()
        if not isinstance(observation_id, int) or not isinstance(action, dict):
            raise HistoryDecodeError()
        if not isinstance(consequential, bool) or not isinstance(risk, str):
            raise HistoryDecodeError()
        # Structural fields render raw in the MEMORY line (one line per step),
        # so they are re-checked against the generated E-01 constraints at the
        # decode boundary: the wire guaranteed them on write, Redis must not be
        # trusted to still guarantee them on read.
        if not _matches(models.ActionId, action_id) or not _matches(
            models.DocumentId, doc_id
        ):
            raise HistoryDecodeError()
        if risk not in _RISK_VALUES:
            raise HistoryDecodeError()
        # The action's keys are rendered bare into a MEMORY line, so they must
        # still be known E-01 field names (hence identifier-shaped). The check
        # stops at the keys on purpose: a full ActionCommand validation would
        # also reject an action whose empty JSON array Redis Lua re-encoded as
        # `{}`, which is a round-trip artifact rather than a corrupt hash.
        if not set(action) <= _ACTION_COMMAND_FIELDS:
            raise HistoryDecodeError()
        expect = data.get("expect")
        if expect is not None and not isinstance(expect, dict):
            raise HistoryDecodeError()
        raw_result = data.get("result")
        result = None if raw_result is None else HistoryResult.from_dict(raw_result)
        return cls(
            action_id=action_id,
            plan_step=plan_step,
            seq=seq,
            doc_id=doc_id,
            observation_id=observation_id,
            action=action,
            consequential=consequential,
            risk=risk,
            expect=expect,
            result=result,
        )


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
    # Sanitized prompt context retained at session start (E-05). Defaults keep
    # direct constructions (tests, fixtures) valid; the Redis store persists
    # them and treats a hash missing them as partial/corrupt.
    task_text: str = ""
    allowed_domains: list[str] = field(default_factory=list)
    mode: str = "agent"
    read_only: bool = False
    history: list[HistoryEntry] = field(default_factory=list)


_KEY_PREFIX = "pa:agent:session:"

# One script, one atomic step: EXISTS guard, memory update, tracking fields
# and the sliding TTL all land together (Redis 7, ``cjson``).
#
# * EXISTS → 0 first: an expired or deleted session reads as gone, so a memory
#   write can never resurrect a key without its identity/created_at fields.
#   The route maps 0 to ``session_expired``.
# * ARGV[7] appends one history entry and evicts the oldest beyond ARGV[9]
#   (= HISTORY_LIMIT), keeping the newest 5 in chronological order. ARGV[8]
#   attaches a reported result to the matching ``action_id``: first write wins
#   (an entry that already has a result is untouched) and an unknown id or an
#   absent ``history`` field is a silent no-op — the session exists either way,
#   so the script still returns 1.
# * ARGV[6] (``last_action_id``) is written only when the caller supplies one
#   (step); feedback re-supplies the previous value so it is not cleared.
# * The append path may start from an absent ``history`` field, but it always
#   writes back at least one entry — Lua re-encodes an empty table as ``{}``
#   rather than ``[]``, which is exactly why an empty history is never stored
#   (``create`` omits the field; ``get`` reads it as ``[]``).
_ADVANCE_SCRIPT = """
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if ARGV[7] ~= '' then
  local raw = redis.call('HGET', KEYS[1], 'history')
  local list = raw == false and {} or cjson.decode(raw)
  table.insert(list, cjson.decode(ARGV[7]))
  while #list > tonumber(ARGV[9]) do
    table.remove(list, 1)
  end
  redis.call('HSET', KEYS[1], 'history', cjson.encode(list))
end
if ARGV[8] ~= '' then
  local raw = redis.call('HGET', KEYS[1], 'history')
  if raw ~= false then
    local list = cjson.decode(raw)
    local res = cjson.decode(ARGV[8])
    for i = #list, 1, -1 do
      local entry = list[i]
      if entry['action_id'] == res['action_id'] then
        if entry['result'] == nil then
          local result = {status = res['status'], page_changed = res['page_changed']}
          if res['reason'] ~= nil and res['reason'] ~= cjson.null then
            result['reason'] = res['reason']
          end
          entry['result'] = result
        end
        break
      end
    end
    redis.call('HSET', KEYS[1], 'history', cjson.encode(list))
  end
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

    ``advance`` runs one Lua script that refreshes the sliding TTL together
    with the tracking fields and the optional memory update, so a successful
    step/feedback always leaves the key with a full TTL, a complete hash and a
    history that matches what was actually issued. A partially-written,
    context-less or memory-corrupt hash is treated as missing by ``get``.
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
        mapping: dict[str, Any] = {
            "task_id": record.task_id,
            "task_version": str(record.task_version),
            "created_at": str(record.created_at),
            "task_text": record.task_text or "",
            "allowed_domains": json.dumps(list(record.allowed_domains)),
            "mode": record.mode,
            "read_only": "1" if record.read_only else "0",
        }
        # An empty history is left out of the hash entirely: Redis Lua would
        # re-encode an empty table as ``{}``, not ``[]``, and ``get`` already
        # reads an absent field as no memory yet.
        if record.history:
            mapping["history"] = json.dumps([e.to_dict() for e in record.history])
        try:
            with self._client.pipeline() as pipe:
                # Drop any leftover fields from a theoretical id collision so a
                # new session never inherits seq/plan_step/last_action_id or a
                # previous session's task context and memory.
                pipe.delete(key)
                pipe.hset(key, mapping=mapping)
                pipe.expire(key, self.ttl)
                pipe.execute()
        except _redis.RedisError as exc:
            raise SessionStoreError() from exc

    @staticmethod
    def _decode_history(raw: str | None) -> list[HistoryEntry] | None:
        """Decode the stored ``history`` field; ``None`` means corrupt.

        Absent field → ``[]`` (no memory yet). Anything that is not a JSON
        list of well-formed entries → ``None``, which makes the whole session
        read as missing. ``HistoryDecodeError`` is a ``ValueError``, so every
        decode failure — JSON, shape or entry — is caught here and never
        reaches a route as an exception.
        """
        if raw is None:
            return []
        try:
            decoded = json.loads(raw)
            if not isinstance(decoded, list):
                return None
            return [HistoryEntry.from_dict(item) for item in decoded]
        except (TypeError, ValueError):
            return None

    def get(self, session_id: str) -> SessionRecord | None:
        try:
            data = self._client.hgetall(self._key(session_id))
        except _redis.RedisError as exc:
            raise SessionStoreError() from exc
        if not data:
            return None
        # A hash without its identity fields can only be a partial/corrupted
        # write; treat it like an expired session instead of raising KeyError.
        required = {
            "task_id",
            "task_version",
            "created_at",
            "task_text",
            "allowed_domains",
            "mode",
            "read_only",
        }
        if not required <= data.keys():
            return None
        try:
            allowed_domains = json.loads(data["allowed_domains"])
        except (TypeError, ValueError):
            return None
        if not isinstance(allowed_domains, list) or not all(
            isinstance(domain, str) for domain in allowed_domains
        ):
            return None
        history = self._decode_history(data.get("history"))
        if history is None:
            return None
        # Identity fields render raw in the TASK/MEMORY sections of the
        # prompt, so a hash that no longer satisfies the E-01 patterns or
        # enums (partial write, corruption) reads as missing, not as data.
        if not _matches(models.TaskId, data["task_id"]) or not _matches(
            models.Mode, data["mode"]
        ):
            return None
        doc_id = data.get("doc_id")
        last_action_id = data.get("last_action_id") or None
        if doc_id is not None and not _matches(models.DocumentId, doc_id):
            return None
        if last_action_id is not None and not _matches(models.ActionId, last_action_id):
            return None
        try:
            task_version = int(data["task_version"])
            created_at = float(data["created_at"])
            seq = int(data["seq"]) if "seq" in data else None
            observation_id = (
                int(data["observation_id"]) if "observation_id" in data else None
            )
            plan_step = int(data.get("plan_step", "0"))
        except (TypeError, ValueError):
            return None
        return SessionRecord(
            session_id=session_id,
            task_id=str(data["task_id"]),
            task_version=task_version,
            created_at=created_at,
            seq=seq,
            doc_id=doc_id,
            observation_id=observation_id,
            plan_step=plan_step,
            last_action_id=last_action_id,
            task_text=data["task_text"],
            allowed_domains=allowed_domains,
            mode=data["mode"],
            read_only=data["read_only"] == "1",
            history=history,
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
        history_entry: Mapping[str, Any] | None = None,
        result_entry: Mapping[str, Any] | None = None,
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
                json.dumps(dict(history_entry)) if history_entry is not None else "",
                json.dumps(dict(result_entry)) if result_entry is not None else "",
                str(HISTORY_LIMIT),
            )
        except _redis.RedisError as exc:
            raise SessionStoreError() from exc
        return ok == 1

    def delete(self, session_id: str) -> bool:
        try:
            return bool(self._client.delete(self._key(session_id)))
        except _redis.RedisError as exc:
            raise SessionStoreError() from exc
