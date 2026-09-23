# Shared protocol (E-01)

This package is the contract between the extension and the future agent API. Edit
`schemas/protocol.schema.json`; generate TypeScript declarations, standalone browser
validators and Pydantic v2 models from it. Do not hand-edit generated files.

Protocol **1.0** is the initial, unpublished wire contract. The package version is
**0.1.0**. No server, networking, PII detector, executor or Egress Guard is implemented
by this package.

## Team setup

From the repository root, with Node 22+, the pinned pnpm version, Python 3.12 and uv:

```sh
pnpm install --frozen-lockfile
uv sync --locked --python 3.12
pnpm build
pnpm test
```

`pnpm test` runs Vitest and pytest, including an actual TypeScript → Python → TypeScript
round trip over the same fixture corpus. Python dependencies are managed only by uv.

```sh
pnpm protocol:generate  # Regenerate all checked-in outputs after schema changes
pnpm protocol:check     # Regenerate in memory/temp files and fail on drift
pnpm typecheck
pnpm lint
pnpm format:check
```

Run `uv sync --locked` before generation on a fresh checkout. CI installs both toolchains,
checks generated-file drift and runs the shared validation tests. Generation uses
`json-schema-to-typescript`, `datamodel-code-generator` and Ajv standalone compilation.
The browser runtime does not compile schemas or require `eval`/`new Function`.

## TypeScript consumers

Add `"@privacagent/protocol": "workspace:*"` to the consuming package's dependencies,
and a TypeScript project reference to this package if it uses project builds. Run
`pnpm install`, then `pnpm build` so the workspace export exists.

```ts
import {
  isMessage,
  parseMessage,
  PROTOCOL_VERSION,
  type Action,
  type ScreenState,
} from '@privacagent/protocol';

const action: Action = parseMessage('Action', decodedJson);
if (isMessage('ScreenState', anotherDecodedJson)) {
  const state: ScreenState = anotherDecodedJson;
  // `kind` distinguishes full and diff states; `action.type` narrows commands.
}
```

`parseMessage` accepts decoded JSON and returns the same object after validation.
`isMessage` returns a type predicate. Neither mutates/coerces inputs. Errors expose only
`Invalid protocol message`, with no payload or unexpected property names. Keep the
generated validators private; their diagnostic internals are not a logging API.

The source schema is exported as `@privacagent/protocol/schema`. JavaScript types alone
do not enforce bounds, patterns or exact object properties: validate at boundaries.

## Python consumers

The root uv workspace installs `privacagent-protocol` as a local package. Future service
packages should declare this workspace dependency. The wheel also contains the schema
resource, generated models, typed overloads and `py.typed` marker.

```python
from privacagent_protocol import parse_message, get_schema, models

action: models.Action = parse_message("Action", decoded_json)
wire_json = action.model_dump_json(exclude_unset=True)
action_schema = get_schema("Action")  # Self-contained schema for constrained decoding
```

Always use `parse_message` for untrusted messages. Generated models cannot express all
JSON Schema rules, particularly optional fields that must not be explicit `null`.
The boundary validates the authoritative schema first, then constructs a Pydantic model.
Use `exclude_unset=True` when serializing to preserve absent fields. Generated scalar
and union `RootModel` wrappers expose their typed value through `.root`.

`get_schema` returns a copy and does not fetch remote references. The `.invalid` schema
ID is an identifier, not a network endpoint. JSON numbers with integral values (such
as `1.0`) are accepted for integer fields in both languages; strings and booleans are
not. NaN and infinities are rejected.

## Wire boundaries

| Endpoint                          | Request               | Response               |
| --------------------------------- | --------------------- | ---------------------- |
| `POST /v1/sessions`               | `SessionStartRequest` | `SessionStartResponse` |
| `POST /v1/sessions/{id}/step`     | `ScreenState`         | `Action`               |
| `POST /v1/sessions/{id}/escalate` | `EscalateRequest`     | `EscalateResponse`     |
| `POST /v1/sessions/{id}/feedback` | `FeedbackRequest`     | `FeedbackResponse`     |
| `DELETE /v1/sessions/{id}`        | `SessionEndRequest`   | `SessionEndResponse`   |
| Any endpoint error                | —                     | `ProtocolError`        |

Session/task IDs are opaque. Only element IDs carry the PRD's `e`/`v` prefix contract.
Task version, sequence, document ID and observation ID are required on observation-bound
requests and responses. Errors before session creation can omit unavailable correlation
fields. Path/body ID consistency and actual freshness checks belong to the API/executor.

Full states contain the complete element list. Diff states contain added/changed elements,
removed IDs and a required `base_observation_id`; all other supplied fields describe the
current observation. State reconstruction, duplicate ID detection, hashes and resync
behavior are E-07/E-08 work; these are contracts, not implementations of those features.

All objects reject unknown properties. The schema caps element lists at 300, tab digests
at eight and escalation crops at two, with each declared crop dimension at most 512 px.
Bounding boxes are `[x, y, width, height]`; dimensions cannot be negative. Crop-region
boxes use crop pixels, and element/crop-source boxes use page CSS pixels.

Form-value states are distinct variants: `empty` requires `value: ""`, `filled` requires
a nonempty value, and `redacted` requires a placeholder plus `pii_class`. Display-only
elements omit value fields. `{{SECRET}}` and `{{TEXT_WITHHELD}}` are supported; resolving
secrets is still prohibited by the executor contract.

Action variants cover the core actions plus Guide/Ask/Background outputs. Each variant
has its own permitted arguments; scroll-by-amount versus scroll-to-target, and timed
wait versus condition wait, are exclusive. An optional expectation is one of local value
equality, appearance, disappearance or URL equality. Outcomes are `ok`, `failed`,
`mismatch` or `unknown`. Guide speech is capped at 25 whitespace-separated words.
Mode permissions, target existence and consequential-action approval are runtime rules.

Conservative initial bounds also limit ordinary text to 4,096 characters, URLs to 2,048,
answers to 8,192, waits to 30 seconds and crop encodings to 1 MiB of base64 text. These
are explicit protocol limits, not measured performance guarantees. Requests exceeding
them must be reduced locally, never silently truncated by validation.

## Privacy boundary and acceptance tests

**Passing this schema is not permission to transmit data.** Any allowed text field can
still contain PII. URLs, titles, task text and mode-specific text need local sanitization,
as do element names/values and text context. No raw DOM, attributes or screenshot field
is accepted. The only image field is the redacted-crop envelope on escalation requests.

A crop's base64 string, declared size and region manifest do not prove that it is a safe
image. D-11/D-14 must decode and check actual dimensions, complete region coverage,
detector coverage, allowlisted content and opaque masks before transmission. The crop
fixture uses a structural stand-in, **not** a privacy-approved JPEG. No network client
should send these fixtures or real page data without the future Egress Guard.

Tests cover each message/action, rejection of unknown properties and versions, required
freshness metadata, malformed values and commands, redaction metadata, array/size limits,
Unicode text and round trips without invented nulls. They do not prove privacy recall,
safe image content, browser execution or task completion; those need later feature tests.

For contract changes, edit the schema, add shared valid/invalid fixtures, regenerate,
and run the root checks. Both languages consume the same fixtures. Coordinate breaking
changes with both client/server owners and update the protocol version explicitly before
shipping incompatible consumers; do not weaken validation to accept unknown versions.
