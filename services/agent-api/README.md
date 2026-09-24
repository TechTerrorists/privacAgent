# Agent API (E-02)

A Python 3.12 / FastAPI service that implements the **E-01 wire protocol** for
browser agents. It is fully runnable today with a **scripted fake planner**
(`scripted-fake-v1`) — no LLM, no VLM, no GPU. The HTTP, session, and
validation layers are production-shaped; the actual "agent" reasoning is not.

## What is implemented

| Route                          | Status                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| `POST /v1/sessions`            | Real — creates a Redis-backed session                        |
| `POST /v1/sessions/{id}/step`  | Real — validates a full Screen State, returns a scripted Action |
| `POST /v1/sessions/{id}/feedback` | Real — accepts `ActionResult` for the last Action only    |
| `DELETE /v1/sessions/{id}`     | Real — ends the session immediately                          |
| `POST /v1/sessions/{id}/escalate` | Stub — validates, then always returns `unavailable` (503) until E-11 |

Also implemented:

- **Protocol validation** — every request and response (including errors) is
  checked through `privacagent_protocol.parse_message`. Off-contract messages
  never leave the service.
- **Redis session store** — one hash per session, 1800 s sliding TTL (refreshed
  atomically with each `/step` and `/feedback`), no tombstones. Persists only
  task identity and step bookkeeping — no DOM, screenshots, or vault data.
- **Error model** — every failure is a protocol `ProtocolError` with a fixed
  HTTP status mapping (see below). Bodies never echo request content.
- **Scripted fake planner** — deterministic, fixture-bound Actions for two demo
  tasks (`t_profile_upd`, `t_search_demo`). Unknown tasks get a bounded `done`.
  Inject a real planner later via `create_app(planner=…)` (the `Planner`
  protocol is already defined).
- **Debug log** — fixed diagnostic stage and reason codes (no request paths, keys,
  identifiers, or exception contents) written to `PA_DEBUG_LOG`.

Not implemented: real LLM planner, VLM escalation (E-11), diff Screen State
reconstruction (E-07/E-08), prompt assembly, auth, rate limiting, SSE streaming.

## Layout

```
services/agent-api/
  pyproject.toml                 # uv workspace member; consumes privacagent-protocol
  src/privacagent_agent_api/
    app.py                       # FastAPI app factory, routes, error handlers
    config.py                    # PA_REDIS_URL / PA_SESSION_TTL / PA_MAX_BODY_BYTES / PA_DEBUG_LOG
    session_store.py             # Redis-backed store, SessionRecord, sliding TTL
    errors.py                    # ProtocolError builder + HTTP status mapping
    planner.py                   # Planner protocol + ScriptedFakePlanner
    fixtures.py                  # deterministic synthetic scenarios
    __main__.py                  # python -m privacagent_agent_api
  tests/                         # pytest (requires a live Redis)
```

## Run locally

Requires Python 3.12 (uv-managed) and a Redis server:

```sh
docker run --name pa-redis -p 6379:6379 -d redis:7-alpine

uv python install 3.12                      # once, if not present
uv sync --locked --python 3.12
uv run --locked uvicorn privacagent_agent_api.app:app --port 8000 --no-access-log
```

Swagger UI, ReDoc, and the OpenAPI schema are at `/docs`, `/redoc`, and
`/openapi.json`. Every route documents a schema-valid example body. For Swagger
"Try it out": create a session first, then put its `session_id` in the path
**and** the body (the shipped examples use `REPLACE_WITH_SESSION_ID`); the two
must match or the request is rejected as `invalid_request`.

### Configuration

| Variable            | Default                    | Meaning                                    |
| ------------------- | -------------------------- | ------------------------------------------ |
| `PA_REDIS_URL`      | `redis://127.0.0.1:6379/0` | Redis connection URL                       |
| `PA_SESSION_TTL`    | `1800`                     | Session TTL in seconds (1–1800, protocol cap) |
| `PA_MAX_BODY_BYTES` | `5242880`                  | Streaming request body cap                           |
| `PA_DEBUG_LOG`      | `debug.log`                | Stage-level reject log (empty disables)    |

### Tests

```sh
uv run --locked pytest
```

Tests require a live Redis at `PA_TEST_REDIS_URL` (default
`redis://127.0.0.1:6379/15`, flushed per test session). They fail — never skip —
if Redis is unreachable. CI runs the same command against `redis:7-alpine`.

## Endpoint contract

| Route                          | Request             | Successful response  |
| ------------------------------ | ------------------- | -------------------- |
| `POST /v1/sessions`            | `SessionStartRequest` | `SessionStartResponse` |
| `POST /v1/sessions/{id}/step`  | `ScreenState`       | `Action`             |
| `POST /v1/sessions/{id}/feedback` | `FeedbackRequest` | `FeedbackResponse`   |
| `DELETE /v1/sessions/{id}`     | `SessionEndRequest` | `SessionEndResponse` |
| `POST /v1/sessions/{id}/escalate` | `EscalateRequest` | `ProtocolError` `unavailable` (until E-11) |
| Any failure                     | —                    | `ProtocolError`      |

Rules worth knowing:

- Only `kind: "full"` Screen States are accepted; a `diff` state returns
  `resync_required` (409) until reconstruction lands (E-07/E-08).
- Feedback must reference the last `action_id` the session received; anything
  else is `invalid_request`.
- Path and body `session_id` must be identical on every request.
- Errors before a session exists omit session correlation fields; errors after
  include the **session's** identity, never a mismatched body value.

### Example flow

```sh
# 1. Start a session (t_profile_upd is scripted by the fake planner)
curl -s localhost:8000/v1/sessions -d '{
  "protocol": "1.0",
  "task_id": "t_profile_upd",
  "task_version": 1,
  "task": "Update my email to {{EMAIL_1}}",
  "allowed_domains": ["example.test"],
  "capabilities": {"browser": "chrome", "backend": "wasm",
                   "detectors": ["dom", "rules"], "crops": false},
  "mode": "agent",
  "read_only": false
}'

# 2. Submit a full Screen State (take SESSION_ID from the response).
#    Fixture states live in privacagent_agent_api.fixtures; the two scripted
#    tasks are t_profile_upd (type → click Save → done) and
#    t_search_demo (click → type → extract → done).
curl -s localhost:8000/v1/sessions/$SESSION_ID/step -d '{
  "protocol": "1.0",
  "session_id": "'"$SESSION_ID"'",
  "task_id": "t_profile_upd", "task_version": 1, "seq": 1,
  "doc_id": "d_profile", "observation_id": 1, "step": 0,
  "page": {"url": "https://example.test/profile", "title": "Profile",
           "viewport": {"w": 1280, "h": 720, "scroll_y": 0, "page_h": 1400}},
  "redaction_scheme": "v1", "mode": "agent", "kind": "full",
  "elements": [
    {"id": "e_email", "role": "textbox", "name": "Email",
     "bbox": [20, 40, 200, 32], "src": "dom", "conf": 1,
     "value_state": "empty", "value": ""},
    {"id": "e_save", "role": "button", "name": "Save",
     "bbox": [20, 90, 80, 32], "src": "dom", "conf": 1}
  ],
  "text_context": ["Update your email address"],
  "suspicious": false
}'

# 3. Send feedback for the returned ACTION_ID, then end the session
curl -s localhost:8000/v1/sessions/$SESSION_ID/feedback -d '{
  "protocol": "1.0", "session_id": "'"$SESSION_ID"'",
  "task_id": "t_profile_upd", "task_version": 1, "seq": 1,
  "doc_id": "d_profile", "observation_id": 1,
  "result": {"action_id": "'"$ACTION_ID"'", "status": "ok", "page_changed": false}
}'

curl -s -X DELETE localhost:8000/v1/sessions/$SESSION_ID -d '{
  "protocol": "1.0", "session_id": "'"$SESSION_ID"'",
  "task_id": "t_profile_upd", "task_version": 1, "seq": 1
}'
```

Escalation is routed but intentionally unavailable until E-11:

```sh
curl -s localhost:8000/v1/sessions/$SESSION_ID/escalate -d '{ … }'
# -> 503 {"protocol": "1.0", "session_id": "...", "task_id": "...",
#         "task_version": 1, "seq": 1, "code": "unavailable", "retryable": true}
```

## Error model

| `code`              | HTTP | `retryable` | When                                             |
| ------------------- | ---- | ----------- | ------------------------------------------------ |
| `invalid_request`   | 400  | false       | malformed JSON, schema violation, path/body mismatch, task identity mismatch, stale feedback `action_id`, unknown route/method |
| `unsupported_version` | 400 | false       | request `protocol` is not `1.0`                  |
| `resync_required`   | 409  | true        | a `kind: "diff"` Screen State was submitted      |
| `session_expired`   | 404  | true        | session missing, TTL-expired, or deleted         |
| `rate_limited`      | 429  | true        | reserved (not yet emitted)                       |
| `unauthorized`      | 401  | false       | reserved (no auth in E-02)                       |
| `unavailable`       | 503  | true        | Redis down, planner misbehaves, escalation stub  |

Clients should switch on `code` alone — framework-level failures (unknown
route, etc.) still return a `ProtocolError` body with the code from this table.

## Privacy boundary

This server only ever handles sanitized Screen State. It stores no DOM, no
screenshots, and no vault mappings; it logs no payloads and never echoes
request bodies. The debug log records only fixed stage and reason codes. Request bodies are
counted as chunks arrive and rejected before buffering a chunk that exceeds
`PA_MAX_BODY_BYTES`, regardless of `Content-Length`. The Python launcher disables
Uvicorn access logs because URLs can contain personal data; retain
`--no-access-log` when launching Uvicorn directly. Unexpected route exceptions
are contained before the server can log their contents. Any deployment proxy
must likewise avoid logging request URLs or bodies.
Validation runs exclusively through the E-01 boundary (`parse_message`); both
success responses and `ProtocolError` bodies are re-validated immediately
before send.

## Replacing the fake planner

Implement the `Planner` protocol (`plan(state, record) -> Action` payload) and
inject it with `create_app(store=…, planner=MyPlanner())`. Route-level
validation still runs on every planner response, so an out-of-contract Action
becomes a bounded `unavailable` error — never a 500. Keep the fake available
for deterministic dev/CI runs.

## Checks

From the repo root:

```sh
pnpm format:check     # prettier (Python under services/ is prettier-ignored)
pnpm lint
pnpm typecheck
pnpm test             # vitest + uv run --locked pytest (needs Redis)
```
