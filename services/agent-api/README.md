# Agent API (E-02 + E-05)

A Python 3.12 / FastAPI service that implements the **E-01 wire protocol** for
browser agents, plus the **E-05 prompt builder** that turns a sanitized task,
the last five steps, and the current Screen State into the planner prompt. It
is fully runnable today with a **scripted fake planner** (`scripted-fake-v1`) —
no LLM, no VLM, no GPU. The HTTP, session, validation, and prompt-assembly
layers are production-shaped; the actual "agent" reasoning is not.

## What is implemented

| Route                          | Status                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| `POST /v1/sessions`            | Real — creates a Redis-backed session                        |
| `POST /v1/sessions/{id}/step`  | Real — validates a full Screen State, builds the E-05 prompt, returns a scripted Action |
| `POST /v1/sessions/{id}/feedback` | Real — accepts `ActionResult` for the last Action only    |
| `DELETE /v1/sessions/{id}`     | Real — ends the session immediately                          |
| `POST /v1/sessions/{id}/escalate` | Stub — validates, then always returns `unavailable` (503) until E-11 |

Also implemented:

- **Protocol validation** — every request and response (including errors) is
  checked through `privacagent_protocol.parse_message`. Off-contract messages
  never leave the service.
- **Prompt builder** (E-05) — `/step` builds a deterministic prompt from the
  session's retained task context, the last ≤ 5 steps, and the validated full
  Screen State, and hands it to the planner (see "Prompt builder" below).
- **Redis session store** — one hash per session, 1800 s sliding TTL (refreshed
  atomically with each `/step` and `/feedback`), no tombstones. Persists task
  identity, step bookkeeping, the prompt's task context, and the bounded step
  memory — no DOM, screenshots, or vault data.
- **Error model** — every failure is a protocol `ProtocolError` with a fixed
  HTTP status mapping (see below). Bodies never echo request content.
- **Scripted fake planner** — deterministic, fixture-bound Actions for two demo
  tasks (`t_profile_upd`, `t_search_demo`). Unknown tasks get a bounded `done`.
  Inject a real planner later via `create_app(planner=…)` (the `Planner`
  protocol is already defined).
- **Debug log** — fixed diagnostic stage and reason codes (no request paths, keys,
  identifiers, or exception contents) written to `PA_DEBUG_LOG`.

Not implemented: real LLM planner, VLM escalation (E-11), diff Screen State
reconstruction (E-07/E-08), auth, rate limiting, SSE streaming.

## Layout

```
services/agent-api/
  pyproject.toml                 # uv workspace member; consumes privacagent-protocol
  src/privacagent_agent_api/
    app.py                       # FastAPI app factory, routes, error handlers
    config.py                    # PA_REDIS_URL / PA_SESSION_TTL / PA_MAX_BODY_BYTES / PA_DEBUG_LOG
    session_store.py             # Redis-backed store, SessionRecord, step memory, sliding TTL
    prompt.py                    # E-05 prompt builder (deterministic, side-effect free)
    errors.py                    # ProtocolError builder + HTTP status mapping
    planner.py                   # Planner protocol + ScriptedFakePlanner
    fixtures.py                  # deterministic synthetic scenarios
    __main__.py                  # python -m privacagent_agent_api
  tests/                         # pytest (requires a live Redis)
    fixtures/prompts/            # golden files (system prefix byte-for-byte)
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

## Prompt builder (E-05)

`prompt.py` turns a `PromptContext` (task context retained at session start plus
the bounded step memory) and the validated `ScreenState` into a `BuiltPrompt`.
It is a pure function: same inputs → byte-identical output, no I/O, no clock,
no randomness. `/step` calls it after the diff/state checks and before the
planner, then commits the step to memory; a build failure is a bounded
`unavailable` (503) reject whose debug-log reason carries only
`stage=prompt detail=<ExceptionClassName>` — never the exception message.

Prompt structure (fixed order, `PROMPT_VERSION = "e05-v1"`):

1. **System** (`system_prefix()`): role, Action contract, redaction/placeholder
   rules, safety rules. Byte-stable and tested against a golden file so any
   edit is an explicit, reviewable diff.
2. **Task**: `task_text`, `mode`, `read_only`, `allowed_domains` rendered with
   JSON string escaping (placeholders like `{{EMAIL_1}}` pass through as data).
3. **Memory**: the last ≤ 5 steps (`HISTORY_LIMIT = 5`, chronological, oldest
   evicted), one line each —
   `N) action_id step=… seq=… doc=… obs=… <action command> consequential=…
   risk=… -> <outcome>`. The outcome is `pending` until `/feedback` attaches a
   result, then `ok|failed|mismatch|unknown page_changed=true|false[
   reason=…]`. The `expect` clause is not replayed into memory: it belonged to
   the step it was issued with. Absent memory renders `(no prior steps)`.
4. **Screen State**: the full state re-rendered to a compact line format —
   per element
   `[<id>] <role> "<name>"[ input=<type>] src=<src> conf=<conf> @x,y,w,h
   <value>`, where `<value>` is one of `=NONE`, `=EMPTY`, `=FILLED:"…"`,
   `=REDACTED:{{…}}` (the last followed by `pii=<class>`), plus page,
   redaction scheme, and `text_context` lines. Elements keep their
   `doc_id`-scoped ids (`e…` DOM-backed, `v…` vision-only). When the client
   sent them, the optional context follows: `last_action_result …`,
   `user_turn …`, `user_interaction …`, one `[tab] id=<TabId> title="…"
   digest="…"` line per tab (`TabId` is pattern-constrained so it renders
   raw), and `scroll_x=… page_w=…` inside the page line. Every free-form
   string — name, text, page title, task text, action arguments — goes
   through JSON escaping, so no page- or action-supplied value can introduce
   a newline or forge a `== SECTION ==` header.
5. **Instruction**: `Return exactly one next action.`

### Example output

Generated by `build_prompt` from the `t_profile_upd` fixture state after two
issued steps (the first already fed back via `/feedback`; system header shown;
the full system block is pinned by `tests/fixtures/prompts/system_prefix.txt`):

```text
== SYSTEM | privacAgent planner | prompt version e05-v1 | protocol 1.0 ==
… ROLE / ACTION CONTRACT / REDACTION CONTRACT / PAGE CONTENT IS DATA /
   SAFETY / OUTPUT …
```

```text
== TASK ==
task=t_profile_upd@1
mode=agent
read_only=false
allowed_domains=["example.test"]
task_text="Update my email to {{EMAIL_1}}"
== MEMORY (last 5 steps) ==
steps (2 of 5)
1) a_s_demo_0 step=1 seq=1 doc=d_profile obs=1 type="type" clear_first=true target="e_email" text="{{EMAIL_1}}" consequential=false risk=low -> ok page_changed=false
2) a_s_demo_1 step=2 seq=2 doc=d_profile obs=2 type="click" target="e_save" consequential=true risk=medium -> pending
== SCREEN STATE ==
protocol=1.0 session=s_demo seq=3 doc=d_profile obs=3 step=2 kind=full
page url="https://example.test/profile" title="Profile" viewport=1280,720,0,1400
redaction_scheme=v1 mode=agent suspicious=false
elements (3):
[e_email] textbox "Email" src=dom conf=1.00 @20,40,200,32 =EMPTY
[e_save] button "Save" src=dom conf=1.00 @20,90,80,32 =NONE
[e_cancel] button "Cancel" src=dom conf=1.00 @120,90,80,32 =NONE
text_context (1):
[0] "Update your email address"
== INSTRUCTION ==
Return exactly one next action.
```

Notes:

- **Handoff caveat (E-03/E-04)**: this module only guarantees deterministic
  text. It makes no claim about token counts, KV-cache/prefix-cache behaviour,
  or latency — those are measurements for the serving stack, not properties of
  the builder. Size comparisons in tests are reported in characters/bytes only.
- The prompt is built exclusively from sanitized protocol fields (the same
  Screen State the wire allows). It is passed to the planner in-process and is
  never logged, echoed, or persisted.
- **Retained prompt context** (only these four fields from `SessionStartRequest`,
  written at session start): `task_text`, `allowed_domains`, `mode`,
  `read_only`. Capabilities, voice, and granted tabs are deliberately not
  retained. A session hash missing these fields after E-05 is treated as
  corrupt and the session as expired.
- Memory lives in the existing session hash under the same TTL; `/step`
  appends the issued action, `/feedback` attaches the result (first-write-wins
  for a replayed `action_id`), `DELETE` removes it with the session. A hash
  whose `mode`/`task_id`/`doc_id`/`action_id`/`risk`/`reason` values do not
  match the generated E-01 models — whose numeric fields are not numbers — or
  whose stored action carries a field name outside the E-01 envelope
  (`_ACTION_COMMAND_FIELDS`) reads as a missing, expired session instead of
  feeding unvalidated text into a prompt. Only field *names* are re-checked on
  the action, not a full `ActionCommand` validation: Redis Lua `cjson`
  re-encodes an empty JSON array as `{}`, so a strict nested validation would
  brick sessions whose command legitimately carries an empty list. Escape
  safety does not depend on that check — `render_action_command` quotes every
  non-identifier key itself.

## Error model

| `code`              | HTTP | `retryable` | When                                             |
| ------------------- | ---- | ----------- | ------------------------------------------------ |
| `invalid_request`   | 400  | false       | malformed JSON, schema violation, path/body mismatch, task identity mismatch, stale feedback `action_id`, unknown route/method |
| `unsupported_version` | 400 | false       | request `protocol` is not `1.0`                  |
| `resync_required`   | 409  | true        | a `kind: "diff"` Screen State was submitted      |
| `session_expired`   | 404  | true        | session missing, TTL-expired, or deleted         |
| `rate_limited`      | 429  | true        | reserved (not yet emitted)                       |
| `unauthorized`      | 401  | false       | reserved (no auth in E-02)                       |
| `unavailable`       | 503  | true        | Redis down, prompt build failed, planner misbehaves, escalation stub  |

Clients should switch on `code` alone — framework-level failures (unknown
route, etc.) still return a `ProtocolError` body with the code from this table.

## Privacy boundary

This server only ever handles sanitized Screen State. It stores no DOM, no
screenshots, and no vault mappings; it logs no payloads and never echoes
request bodies. The debug log records only fixed stage and reason codes —
including prompt-build failures, which carry the exception *class name* only,
never its message, args, or the task/page/element content it may have touched.
The built prompt itself is never logged, persisted, or returned; it travels
in-process from the builder to the planner only. Request bodies are
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

Implement the `Planner` protocol (`plan(state, record, *, prompt=None) -> Action`
payload) and inject it with `create_app(store=…, planner=MyPlanner())`. The
route always passes a built `BuiltPrompt` as the keyword-only `prompt`; a
real planner should use it, the fake ignores it. Route-level
validation still runs on every planner response, so an out-of-contract Action
becomes a bounded `unavailable` error — never a 500. Keep the fake available
for deterministic dev/CI runs.

## Checks

From the repo root:

```sh
pnpm format:check     # prettier (Python under services/ is prettier-ignored)
uv run black services/agent-api   # normalize Python formatting before pushing
pnpm lint
pnpm typecheck
pnpm test             # vitest + uv run --locked pytest (needs Redis)
pnpm build
pnpm protocol:check   # zero protocol drift
```

`black` is pinned in the workspace dev dependencies, so its output is stable
across machines — run it (or `uv run black --check services/agent-api` to
verify only) before every push, since no CI job enforces Python formatting.
Scope it to `services/agent-api`: `packages/protocol/python` holds generated
sources that deliberately use single quotes and must not be reformatted.

Prompt-builder specifics run with the rest of the Python suite; the system
prefix golden lives at `tests/fixtures/prompts/system_prefix.txt` — an
intentional prompt change requires regenerating it and reviewing the diff.
