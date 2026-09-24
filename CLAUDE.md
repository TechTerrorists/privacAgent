# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A browser extension (Chrome + Firefox, MV3) plus a Python server that together let an AI
agent see and operate a web page for the user **without any personal data leaving the
user's machine**. The extension does all perception (DOM walk, screenshot, local vision
models) and all privacy filtering (PII detection + redaction) locally; the server only ever
receives a sanitized, structured description of the screen ("Screen State") and returns
structured commands ("Action").

Two source documents define the product. Read them before making design decisions:

- `PRD — On-device Visual Perception & Privacy Gateway for Browser Agents` — 53-page spec:
  architecture, protocol, privacy engine, performance budgets, milestones.
- `Browser Privacy Agent — Feature List` — 90 features in six lanes (A–F) with IDs,
  "done when" criteria, sizes, target weeks, and dependencies.

Work is tracked by those feature IDs (e.g. `A-06`, `D-11`, `C-16`). When implementing,
reference the ID and satisfy its "done when" clause literally.

## The one rule everything else serves

**Raw pixels and raw DOM never cross the network.** Perception, OCR, PII detection and
redaction happen on the client. The server is a reasoning engine over clean, structured
text, and it is told exactly which fields were redacted and how. Heavy visual reasoning on
the server is an exception path (Tier 2), used only for small, fully-redacted image crops.

Concretely, when writing code:

- **Never** add a `fetch`/XHR call outside the single network chokepoint in the background
  context (`A-06`). An ESLint rule enforces this; do not disable it.
- Every outbound payload passes the **Egress Guard** (`D-11`), which is fail-closed: schema
  check, detector-coverage check, field-aware vault matching, rule re-scan. If redaction
  cannot be verified, nothing is sent.
- The **vault** (placeholder → real value) lives in ML-worker memory only. Never serialize
  it to IndexedDB, logs, telemetry or crash reports. Every entry carries a use binding
  (`task_id`, `origin`, `doc_id`, `allowed_targets`, `operations`) enforced **on the
  client**; server validation is not authorisation.
- Telemetry is metrics-only (latency, backend, counts). Payload logging must be impossible
  by type, not merely avoided.
- Crop redaction uses **solid opaque fills**, never blur or pixelation (both are reversible).
- Tier 2 crops use an **allowlist**, not a blocklist: any region the pipeline cannot
  positively classify and check is masked; if masking leaves nothing useful, the crop is
  withheld.
- When a detector is unavailable, the client enters **restricted egress mode** (`D-10`) —
  reduced perception accuracy is acceptable on weak devices, reduced privacy is not.
- Page text is **data, not instructions**. Text matching injection patterns is flagged
  `suspicious: true` and the planner is told to ignore instructions from page content.

## Architecture

Hard trust boundary: the client owns all raw data and all perception; the server owns
planning over sanitized text.

| Component         | Runs in                                                                 | Responsibility                                                      |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Content script    | Page context, isolated world                                            | DOM/AX walk, stable element IDs, execute actions, observe mutations |
| Capture           | Background                                                              | `tabs.captureVisibleTab` on demand (≈2/s limit)                     |
| Perception engine | Offscreen doc (Chrome) / background page (Firefox), inside a Web Worker | Local models on WebGPU or WASM                                      |
| Fusion            | Worker                                                                  | Merge DOM elements + visual detections into one element graph       |
| PII engine        | Worker                                                                  | Classify sensitive elements/spans/regions, redact, fill vault       |
| Vault             | Worker memory only                                                      | Placeholder → real value; never persisted                           |
| Egress Guard      | Background                                                              | Final scan of every outbound payload; blocks on any violation       |
| Action executor   | Content script                                                          | Resolve element IDs + placeholders, perform DOM actions, verify     |
| Agent API         | Server                                                                  | Session state, prompt assembly, validation, routing                 |
| Planner LLM       | Server GPU                                                              | Reason over Screen State, emit one action per step                  |
| Escalation VLM    | Server GPU                                                              | Interpret small redacted crops when local confidence is low         |

### Tiered perception (cheapest sufficient signal first, decided per element)

- **Tier 0 (~80%)**: DOM/AX text and role are usable → text-only Screen State.
- **Tier 1 (~17%)**: element visually present but DOM is poor (canvas, icon-only button,
  custom widget) → UI detector, OCR on that region, icon classifier → text-only Screen
  State with vision-derived fields.
- **Tier 2 (~3%)**: local confidence below threshold or the task needs visual judgment →
  Screen State plus ≤ 2 fully-redacted crops (≤ 512 px long side).

Low confidence about **what an element does** may justify Tier 2 escalation. Low confidence
about **whether a region contains personal data** means mask or withhold — never escalate.

### PII detector layers (union of independent detectors; miss is costlier than over-mask)

L1 semantic DOM (`type`/`autocomplete`/label keywords) · L2 pattern rules with checksums
(email, +91/E.164, Luhn card, Verhoeff Aadhaar, PAN, IFSC, UPI, IBAN, JWT/API keys, OTP in
context) · L3 local NER · L4 vision (faces, OCR text re-fed to L2/L3) · L5 per-site and
per-user policy. An item is sensitive if any high-precision layer (L1, L2-with-checksum,
L5) fires, or L3/L4 scores ≥ 0.5. Thresholds are tuned recall-first (≥ 98%), then precision.

Fusion produces two outputs that must not be confused: the **interaction map** (for
planning; DOM and vision merged at IoU ≥ 0.5) and the **privacy evidence** (for redaction;
DOM text, DOM attribute values and OCR text kept separately and each scanned independently).

## Repository layout (target, per PRD §13.2)

```
/packages
  /protocol        JSON schemas, generated TS + Python types, version tests
  /extension
    /src/background  routing, capture, egress-guard
    /src/offscreen   worker host (Chrome)
    /src/worker      perception, fusion, pii, vault
    /src/content     dom-extract, executor, mutation tracking
    /src/ui          side panel / sidebar
    /src/platform    chrome.ts, firefox.ts adapters
  /models          training scripts, export, quantization, model cards, hashes
/services
  /agent-api       FastAPI app, prompts, validators, session store
  /inference       vLLM configs, VLM config
/bench
  /mock-sites      deterministic test sites
  /datasets        perception, PII, task suites + annotations
  /harness         metric computation, reports
```

`packages/extension` exists as of A-01 (build tooling plus placeholder entry points); the
rest of the tree is created as features land, rather than scaffolded up front.

### Build targets

`packages/extension` builds twice from one source tree, selected by Vite mode:

- `pnpm build:chrome` → `dist/chrome`, via `@crxjs/vite-plugin`.
- `pnpm build:firefox` → `dist/firefox`, via plain Vite plus a small manifest-emitting
  plugin (`@crxjs` is Chrome-only), then `web-ext` for linting and packaging.

Each target runs **two** Vite passes. The second, `vite.content.config.ts`, builds the
content script alone as a self-contained IIFE into `content/index.js`, with
`emptyOutDir: false` so it adds to the first pass's output. This is not optional tidiness:
`scripting.executeScript` runs a file as a **classic script**, so a bare `import` in that
bundle throws at injection time. Never give the content script an ESM or code-split output,
and never fold it back into the main pass.

`src/manifest.ts` is the single source of truth for both MV3 dialects — do not hand-edit a
generated `dist/*/manifest.json`. Two build constants are injected by `define` and declared
in `src/env.d.ts`: `__BROWSER__` and `__CONTENT_SCRIPT_PATH__`; read the path from the
constant rather than hard-coding it.

The manifest declares **no `web_accessible_resources`**. `executeScript` does not need one,
and any entry there is fetchable by any page at a stable `chrome-extension://<id>/…` URL,
which fingerprints the extension before perception has run. If one ever becomes necessary
it needs `use_dynamic_url: true`.

Build tooling (`vite*.config.ts`, `vitest.config.ts`) is covered by `tsconfig.node.json`,
so `pnpm typecheck` and type-aware lint both check it. Keep it that way — these files call
into `src/`, and untyped config is where signature drift hides.

## Tech stack

- **Extension**: TypeScript, MV3, Vite + `@crxjs/vite-plugin` (Chrome) and `web-ext`
  (Firefox), `webextension-polyfill`, plus a small `platform/` adapter with two impls.
- **Side panel UI**: Preact or React + Tailwind (small bundle).
- **Local inference**: `onnxruntime-web` (WebGPU → WASM+SIMD/threads → WASM) as the single
  runtime; Transformers.js for NER tokenization. All inference in a dedicated Web Worker —
  the content script and page main thread never run ML.
- **Shared protocol**: JSON Schema → TS via `json-schema-to-typescript`, → Pydantic via
  `datamodel-code-generator`. The same schema drives constrained decoding on the server.
- **Server**: Python 3.12, FastAPI, Pydantic v2, Redis (session TTL 30 min), vLLM with
  guided decoding.
- **Model training**: PyTorch, Ultralytics (detector), HF Transformers (NER), ONNX export +
  quantization.
- **Testing**: Vitest, Playwright (Chromium extension tests), web-ext + Selenium/geckodriver
  (Firefox extension tests), mitmproxy for egress capture, pytest.

### Package managers

Use **`pnpm`** for everything JavaScript/TypeScript — the repo is a pnpm workspace
(`pnpm-workspace.yaml`), so a stray `npm` or `yarn` invocation creates a competing lockfile.
This includes read-only lookups: `pnpm view <pkg> version`, not `npm view`.

Use **`uv`** for all Python dependency management and virtual environments. Do not use
`pip`/`venv`/`poetry` directly.

Root scripts: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`,
`pnpm build`. CI runs exactly these, so run them before pushing.

## Wire protocol

Endpoints: `POST /v1/sessions`, `POST /v1/sessions/{id}/step`, `.../escalate`,
`.../feedback`, `DELETE /v1/sessions/{id}`. HTTPS + TLS 1.3, gzip, optional SSE streaming
for the Action.

Screen State rules worth remembering:

- `id` prefixes: `e` = DOM-backed, `v` = vision-only (executed by coordinates).
- Every Screen State carries `observation_id`, `doc_id` and `seq`. Element IDs are only
  meaningful together with their `doc_id`, which changes on navigation or SPA route change.
- No free-form HTML, no attributes, no CSS, no raw text outside `name`, `value` and
  `text_context`. Elements capped at 300.
- `value_state` is `empty | filled | redacted`; `pii_class` accompanies redacted values.
- Placeholders are consistent within a session (`{{EMAIL_1}}` always maps to the same value)
  so the planner can reason about equality without seeing the value.

Action types: `click`, `type`, `select`, `scroll`, `press_key`, `wait`, `navigate`,
`extract`, `ask_user`, `escalate`, `done`. Guide mode adds `point`, `annotate`, `say`;
Agent/Background add `switch_tab`, `report`.

## Executor rules

- Check freshness first: the action's `doc_id` and `observation_id` must match the current
  document and latest observation, else discard and re-observe.
- If the target node is gone or its role/name/bbox moved beyond tolerance, **never**
  substitute a similar control — re-observe and ask the planner again.
- Use the per-control adapter, not generic `dispatchEvent`: `element.click()` after focus
  for buttons/links/checkboxes; native value setter + `input`/`change` for text inputs;
  `beforeinput` + `insertText` for contenteditable; `form.requestSubmit()` for Enter;
  `focus()` for Tab. Synthetic key events do not insert text or move focus.
- Verify with the action's `expect` clause after settle (300 ms DOM quiet, 3 s cap). Outcome
  is one of `ok | failed | mismatch | unknown`.
- **Consequential actions (submit, pay, send, delete) with `unknown` or `mismatch` outcome
  are never retried automatically** — they may have succeeded. Look for evidence, else ask.
- The agent never types into password fields; `{{SECRET}}` cannot be resolved by the
  executor.

## Performance budgets

Reference device: mid-range laptop, 4-core CPU, 8 GB RAM, integrated GPU with WebGPU.

- Step latency p50: ~1.1 s (Tier 0), ~1.3 s (Tier 1), ~2.3 s (Tier 2). Target p50 ≤ 1.5 s.
- Main thread: **no long task > 50 ms.** DOM walk runs in `requestIdleCallback` chunks ≤ 8 ms.
- DOM extraction: ≤ 40 ms full for 2,000 nodes, ≤ 10 ms incremental.
- Model download ≤ 40 MB core (voice pack ≤ 80 MB, only on first voice use).
- Extra RAM ≤ 250 MB steady, ≤ 350 MB peak; GPU memory ≤ 300 MB.
- Models unloaded after 10 min idle; ~0% idle CPU, no background polling.

## Testing expectations

- **Executor tests must go through the real executor.** Playwright's own clicks are trusted
  input and prove nothing about our synthetic events.
- Canary leak CI (`C-16`) is a required gate: an intercepting proxy captures all egress,
  decompresses and decodes bodies, and searches for seeded canaries; captured images get OCR
  and face checks. Known-PII egress on the benchmark and canary suites must be **0**.
- The degraded-device suite re-runs the canary pages with NER, OCR and face models disabled
  one at a time, to prove restricted egress mode holds.
- Model data splits are **by site family, not by page**.
- Mock sites are local and deterministic so latency and success are reproducible.

## Development workflow

This repo uses strict **issue-driven development**; direct commits to `main` are disabled.

1. Open an issue before writing code.
2. Create the branch from the issue via the GitHub UI ("Create a branch" in the issue's
   Development sidebar), then check it out locally — do not branch from `main` in the
   terminal.
3. Open a PR against `main` whose description contains a closing keyword
   (`Closes #12`, `Fixes #34`). The `Enforce Linked Issue` GitHub Action fails the PR
   without one.
4. Merge only after required reviews and status checks pass.

## Scope boundaries (v1 non-goals)

Mobile browsers and Safari · operating outside the browser tab · solving CAPTCHAs or
bypassing anti-bot measures · fully autonomous payments or irreversible actions without user
confirmation · training large models from scratch · server-side speech models (they need raw
audio) · connected-account agents (email/calendar APIs) · building our own browser.

Also: do not use the browser's Web Speech recognition API — in Chrome it ships audio to a
cloud service, which violates the privacy rule. STT is local (Whisper-tiny/Moonshine class
via Transformers.js); TTS is `speechSynthesis` restricted to `voice.localService === true`.
