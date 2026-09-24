# Agent API (E-02)

A Python 3.12 / FastAPI service skeleton that lets extension and server
contributors exercise the shared **E-01 protocol** against a deterministic,
local service before any planner models or GPUs are available.

The ONLY planner present is a **scripted fake** ("`scripted-fake-v1`"): it
returns one schema-valid `Action` per supported step from fixed synthetic
scenarios. No LLM, no VLM, no model download, no GPU.

Privacy boundary (same rule as everywhere): this server only ever handles the
sanitized Screen State. It stores no DOM, no screenshots, no vault mappings,
logs no payloads, and never echoes request bodies. Validation happens through
the E-01 boundary (`privacagent_protocol.parse_message`); generated Pydantic
models are used to serialize but never trusted to be the only check. Both
successful responses **and** `ProtocolError` bodies are re-validated through
`parse_message` immediately before they are sent, so nothing off-contract ever
leaves the service.

## Layout

```
services/agent-api/
  pyproject.toml                 # uv workspace member; consumes privacagent-protocol
  README.md
  src/privacagent_agent_api/
    app.py                       # FastAPI app factory, routes, error handlers
    config.py                    # PA_REDIS_URL / PA_SESSION_TTL / PA_MAX_BODY_BYTES
    session_store.py             # Redis-backed store, 1800 s TTL, SessionRecord
    errors.py                    # ProtocolError builder + HTTP status mapping
    planner.py                   # Planner protocol + ScriptedFakePlanner
    fixtures.py                  # deterministic synthetic scenarios / fixture states
    __main__.py                  # python -m privacagent_agent_api
  tests/                         # pytest (required: a real Redis, see below)
```

## Reproducible local startup

Requires Python 3.12 (uv-managed), `uv`, Node/pnpm only if you run the root
checks, and a Redis server. Start Redis with Docker:

```sh
docker run --name pa-redis -p 6379:6379 -d redis:7-alpine
```

From the repository root install everything and run the service:

```sh
uv python install 3.12                      # once, if not present
uv sync --locked --python 3.12
uv run --locked uvicorn privacagent_agent_api.app:app --port 8000
```

Interactive API docs (Swagger UI), ReDoc, and the OpenAPI schema are served at
`/docs`, `/redoc`, and `/openapi.json`. Every route documents its full E-01
request body (from the shared protocol schema) plus a concrete, schema-valid
example, so Swagger's "Try it out" is usable out of the box. Validation still
runs only through the E-01 boundary (`parse_message`) — no internal Pydantic
models and no DOM-shaped input are ever exposed.

Configuration is read from the environment:

| Variable          | Default                    | Meaning                                     |
| ----------------- | -------------------------- | ------------------------------------------- |
| `PA_REDIS_URL`    | `redis://127.0.0.1:6379/0` | Redis connection URL                        |
| `PA_SESSION_TTL`  | `1800`                     | Session TTL in seconds (1–1800, protocol cap) |
| `PA_MAX_BODY_BYTES` | `5242880`                | Request body cap (rejects oversized input as `invalid_request`) |

Run the End-to-end tests (they require a live Redis):

```sh
uv run --locked pytest
```

The suites connect to `PA_TEST_REDIS_URL` (default
`redis://127.0.0.1:6379/15`, a dedicated logical DB that the fixture flushes at
session setup/teardown), so a local `redis-server` or the Docker container
above is enough. CI runs the same command against a `redis:7-alpine` service
container with `PA_TEST_REDIS_URL` pointing at DB 15.

## Endpoint contract

| Route                          | Request             | Successful response  |
| ------------------------------ | ------------------- | -------------------- |
| `POST /v1/sessions`            | `SessionStartRequest` | `SessionStartResponse` |
| `POST /v1/sessions/{id}/step`  | `ScreenState`       | `Action`             |
| `POST /v1/sessions/{id}/feedback` | `FeedbackRequest` | `FeedbackResponse` |
| `DELETE /v1/sessions/{id}`     | `SessionEndRequest` | `SessionEndResponse` |
| `POST /v1/sessions/{id}/escalate` | `EscalateRequest` | `ProtocolError` `unavailable` (until E-11) |
| Any failure                     | —                    | `ProtocolError`      |

### Synthetic request examples

All bodies are the exact E-01 wire messages (see `packages/protocol`). Start a
session (task `t_profile_upd` is scripted by the fake planner):

```sh
curl -s localhost:8000/v1/sessions -d '{
  "protocol": "1.0",
  "task_id": "t_profile_upd",
  "task_version": 1,
  "task": "Update my email to {{EMAIL_1}}",
  "allowed_domains": ["example.test"],
  "capabilities": {
    "browser": "chrome",
    "backend": "wasm",
    "detectors": ["dom", "rules"],
    "crops": false
  },
  "mode": "agent",
  "read_only": false
}'
```

Take `SESSION_ID` from the response and submit a full Screen State. The two
scripted tasks are `t_profile_upd` (type → click Save → done) and
`t_search_demo` (click → type → extract → done); the exact fixture Screen
States live in `privacagent_agent_api.fixtures`:

```sh
curl -s localhost:8000/v1/sessions/$SESSION_ID/step -d '{
  "protocol": "1.0",
  "session_id": "'"$SESSION_ID"'",
  "task_id": "t_profile_upd",
  "task_version": 1,
  "seq": 1,
  "doc_id": "d_profile",
  "observation_id": 1,
  "step": 0,
  "page": {
    "url": "https://example.test/profile",
    "title": "Profile",
    "viewport": {"w": 1280, "h": 720, "scroll_y": 0, "page_h": 1400}
  },
  "redaction_scheme": "v1",
  "mode": "agent",
  "kind": "full",
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
```

Then send feedback and end the session:

```sh
curl -s localhost:8000/v1/sessions/$SESSION_ID/feedback -d '{
  "protocol": "1.0", "session_id": "'"$SESSION_ID"'",
  "task_id": "t_profile_upd", "task_version": 1, "seq": 1,
  "doc_id": "d_profile", "observation_id": 1,
  "result": {"action_id": "a_t_profile_upd_0", "status": "ok", "page_changed": false}
}'

curl -s -X DELETE localhost:8000/v1/sessions/$SESSION_ID -d '{
  "protocol": "1.0", "session_id": "'"$SESSION_ID"'",
  "task_id": "t_profile_upd", "task_version": 1, "seq": 1
}'
```

Escalation is routed but intentionally unavailable:

```sh
curl -s localhost:8000/v1/sessions/$SESSION_ID/escalate -d '{
  "protocol": "1.0", "session_id": "'"$SESSION_ID"'",
  "task_id": "t_profile_upd", "task_version": 1, "seq": 1,
  "doc_id": "d_profile", "observation_id": 1,
  "question": "What does this control mean?",
  "redaction_scheme": "v1",
  "crops": [{
    "crop_id": "c_demo", "target": "e_save", "bbox": [10, 20, 32, 32],
    "width": 32, "height": 32, "media_type": "image/jpeg",
    "data_base64": "AAAA",
    "regions": [{"bbox": [0, 0, 32, 32], "content_class": "ui_chrome",
                 "masked": false, "checks": ["ui"]}]
  }]
}'
# -> 503 {"protocol": "1.0", "session_id": "...", "task_id": "...",
#         "task_version": 1, "seq": 1, "code": "unavailable",
#         "retryable": true}
```

## Error model and HTTP status mapping

Every failure is an E-01 `ProtocolError`. Error bodies never echo request
content and never expose FastAPI/Pydantic input dumps (routes read raw JSON and
validate through `parse_message`). Errors before a session exists omit session
correlation fields entirely — they never fabricate a session identity.

| `code`              | HTTP status | `retryable` | When                                             |
| ------------------- | ----------- | ----------- | ------------------------------------------------ |
| `invalid_request`   | 400         | false       | malformed JSON, schema violation, unknown field, path/body mismatch, task identity mismatch |
| `unsupported_version` | 400       | false       | request carries a `protocol` other than `1.0`    |
| `resync_required`   | 409         | true        | a diff `ScreenState` is submitted (no reconstruction support yet) |
| `session_expired`   | 404         | true        | session key missing or TTL-expired               |
| `rate_limited`      | 429         | true        | reserved / framework 429                         |
| `unauthorized`      | 401         | false       | reserved (no auth in E-02)                       |
| `unavailable`       | 503         | true        | Redis down, planner misbehaves, escalation feature unavailable (E-11) |

Path/body `session_id` mismatches are `invalid_request`. A missing or expired
session (or a session deleted by `DELETE`) is reported as `session_expired`;
there is no tombstone and no retained ended-state.

## Screen State handling

Only **full** Screen States are accepted. A `kind: "full"` state is parsed and
passed to the planner. A `kind: "diff"` state gets `resync_required` — the
service never interprets an incremental update as a complete page (reconstruction
arrives with E-07/E-08). Both full and diff states are schema-validated before
that decision, so a diff reachable in tests is a real diff, not a parse error.

## Session TTL policy (Redis)

- Created with `PA_SESSION_TTL` (default 1800 s, the protocol ceiling echoed in
  `SessionStartResponse.expires_in_seconds`).
- Slides forward on every successful `/step` and `/feedback` request. The
  refresh is atomic with the field update (a single Lua script), so a successful
  interaction always leaves the key with a full TTL and a complete hash — a key
  can never be re-created without its task identity, and a partial write is
  treated as missing by `get`.
- `/escalate` returns an error today and does not touch the TTL.
- `DELETE` removes the key immediately.
- Expired sessions are gone; the API reports `session_expired`.

The store writes one Redis hash per session (`pa:agent:session:{id}`) containing
only task identity and the correlation/step bookkeeping needed for the synthetic
flow. Nothing else is persisted.

## The scripted fake planner

`ScriptedFakePlanner` (`planner.py`) is injected into `create_app`. It is:

- **Scripted** — one fixed `Action` per `task_id` + per `plan_step` counter.
- **Deterministic** — identical session histories produce byte-identical
  Actions; `action_id` is derived from `task_id` and the step counter.
- **Clearly identified** — every Action `thought` starts with
  `[scripted-fake-v1:scenario=…]`, and the planner registers under
  `name == "scripted-fake-v1"`.
- **Fixture-bound** — scripted commands only target element ids that the
  scenario's own fixture Screen State contains (enforced by tests). If a
  client submits a state missing a targeted id, the planner emits a harmless
  `wait` instead of substituting a similar control.
- **Bounded for unknown tasks** — an unscripted `task_id` deterministically
  yields a `done` Action marked `scenario=none`.

Two built-in scenarios: `t_profile_upd` and `t_search_demo`. Add scenarios by
constructing `Scenario`/`ScriptedStep` objects in `fixtures.py`.

## Replacing the test client and the fake planner

- **Client side**: the test suites under `tests/` are a synthetic client that
  speaks the E-01 contract over HTTP. The future extension session client does
  the same thing: `POST /v1/sessions` → `POST …/step` with a full Screen State
  → apply the returned `Action` → `POST …/feedback` with the `ActionResult` →
  `DELETE …` when the task finishes. Nothing in this contract changes when the
  real client replaces the tests.
- **Planner side**: implement the `Planner` protocol (`plan(state, record) ->
  Action payload`), then inject it — `create_app(store=…, planner=MyPlanner())`.
  The route still validates every planner response through `parse_message`
  before sending, so an out-of-contract planner response is a bounded
  `unavailable` error, never a 500 with dumped internals. Keep the fake
  registered (or behind a flag) for deterministic dev/CI runs; feature E-later
  swaps in the server GPU planner and VLM escalation.

## Checks

From the repo root:

```sh
pnpm format:check     # prettier (Python under services/ is prettier-ignored via .prettierignore)
pnpm lint
pnpm typecheck
pnpm test             # vitest + uv run --locked pytest (needs Redis)
```