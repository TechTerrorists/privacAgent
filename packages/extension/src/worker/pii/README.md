# Worker PII engine API (D-01, extended by D-02, D-03)

Finding and redaction types, a callable `PiiEngineApi`, and a conservative
stub that masks or withholds everything, so other lanes can integrate with
the privacy pipeline before any real detector exists. Mirrors the
`worker/inference` module's fake-engine pattern.

**Feature-list acceptance:** finding and redaction types; a stub redactor
that masks everything so early end-to-end runs are safe; a canary case list
for C-16.

D-01 itself ships **no detection** — this stub's job was always to be a safe
default, not the final word. D-02 (`l2/`) now adds real pattern-and-checksum
detection (email, phone, cards, Aadhaar, PAN, IFSC, UPI, IBAN, JWT, API keys,
contextual OTP), wired into D-01's contracts through `layered.ts`'s
`createLayeredPiiEngine()` — see `l2/README.md` for that module in full. NER
(L3), vision (L4), per-site/per-user policy (L5), consistent session vault
mappings, and restricted-egress enforcement remain D-03 and D-07 through
D-14. Crop pixel redaction does not exist yet — every engine here withholds
every crop.

## Using it

```ts
import { getPiiEngineApi } from '../worker/pii/index.js';

const engine = getPiiEngineApi();

const name = await engine.scanText({
  evidence: 'dom_text',
  text: rawAccessibleName,
  location: { kind: 'element_field', elementId: 'e12', field: 'name' },
});
// name.outcome is 'clear' (rawAccessibleName was '') or 'withheld'
// ({{TEXT_WITHHELD}}) — never the original non-empty text.

const outcome = await engine.redactElement({
  id: 'e12',
  role: 'textbox',
  rawName: rawAccessibleName,
  bbox: [10, 20, 120, 24],
  src: 'dom',
  conf: 0.95,
  inputType: 'email',
  hasValue: true,
  rawValue: 'someone@example.com',
});
if (outcome.outcome === 'ok') {
  // outcome.element is a wire-safe E-01 Element — push it into
  // FullScreenState.elements as-is.
} else {
  // outcome.outcome === 'withheld' — drop the element from `elements`
  // entirely. Never send a partial one.
}
```

## Why two different placeholder shapes

The protocol's `Placeholder` type accepts exactly three shapes:
`{{CLASS_N}}`, the literal `{{SECRET}}`, or the literal `{{TEXT_WITHHELD}}`
(`packages/protocol/schemas/protocol.schema.json`). Which one a field gets
depends on whether that field has a companion metadata slot on the wire:

| Field                                                        | Companion slot            | Stub replaces non-empty text with |
| ------------------------------------------------------------ | ------------------------- | --------------------------------- |
| `value` (password)                                           | `value_state`+`pii_class` | literal `{{SECRET}}`              |
| `value` (anything else)                                      | `value_state`+`pii_class` | class-specific `{{<CLASS>_N}}`    |
| `name`, `title`, `url`, `text_context` entry, user/task text | none                      | literal `{{TEXT_WITHHELD}}`       |

`scanText`'s three outcomes track this directly: `clear` (text was empty —
the only case that returns original content), `redacted` (a `value` field,
masked to a classified placeholder), `withheld` (everything else, replaced by
the class-less marker). Sending a made-up class-specific placeholder for
`name` would silently invent a metadata channel the schema doesn't have; the
protocol defines `{{TEXT_WITHHELD}}` for exactly this case.

`redactTextContext` goes one step further for `text_context`: since it is an
array, a withheld entry is **dropped**, not replaced by the marker string —
there's no reason to spend space on a placeholder in a free-form list when
omitting the entry is just as safe and produces a smaller payload.

## Why the stub never returns a `FilledElement`

`FilledElement` (`value_state: 'filled'`, raw text on the wire) exists in the
protocol for values a detector pass has actually cleared. The stub runs no
detector, so it may never produce one — every non-empty value becomes
`RedactedElement`. This is the concrete form of "no detector pass may be
invented to make an integration succeed": a `FilledElement` from this engine
would be exactly that invented clearance.

`DisplayElement` (no value fields at all) is still produced for elements
where `hasValue: false` — a button or link has no value concept, and
`DisplayElement` is the wire shape for that, not evidence the stub decided
something was safe.

`EmptyElement` is produced when `rawValue === ''`: an empty value is
genuinely safe (there is nothing to hide), not a gap in coverage.

## Structural withholding vs. privacy withholding

`redactElement` returns `{ outcome: 'withheld', reason }` — meaning _drop the
whole element_ — only for structurally malformed input (missing `id`/`role`,
a non-finite `bbox`), never as a privacy decision. Privacy decisions always
have a safe placeholder to fall back to (`{{TEXT_WITHHELD}}` or a classified
placeholder), so they never need to drop the element. A caller-contract
violation (`hasValue: true` with `rawValue` absent) throws
`InvalidPiiInputError` instead, since that indicates a bug in the caller, not
data the engine examined and rejected.

## L1 semantic classification, not a detector

`scanText` reads `hints.inputType` (`email`, `tel`, `password`) to choose a
`pii_class` for a `value` field. This is **not** a detector pass — it is
reading DOM semantics the browser already exposed (CLAUDE.md's PII detector
layer L1), and it never changes whether the text is masked, only which class
label the mask carries. Without a matching hint, the class defaults to
`'other'` and the text is masked exactly the same way. A finding's
`detector` field records which stand-in fired (`'l1_semantic'` or
`'stub'`) so D-11 can tell a semantic label from a genuine pattern/NER/vision
detection later — but the finding's `synthetic: true` flag is what actually
governs trust: no finding from this engine may satisfy a coverage check.

## Findings are internal, never outbound

`PiiFinding` (in `types.ts`) records evidence source, location, class,
detector provenance and the mask/withhold decision — this is exactly the
internal evidence a vault (D-02+) and the Egress Guard (D-11) need, and it
must never reach the wire. `scanText`'s `PiiTextResult.finding` is present
for exactly that reason: callers keep it for the vault/Egress Guard and place
only `PiiTextResult.value` into the outbound Screen State.

## Canaries (C-16)

`canaries.ts` exports `PII_CANARIES`: synthetic cases (never real personal
data, each carrying a unique `CANARY-…` marker) covering the planned PII
classes, secrets, English and Hindi text, DOM text vs. DOM attribute vs. OCR
vs. user/task evidence, a field with no companion `pii_class` slot, an
unclassifiable value (no local signal fires — the closest analogue this
engine has to "detector unavailable": it still masks, never passes
through), and an empty-string control case. Each case asserts the exact
outcome and that the marker is absent from the returned value — not merely
that some value came back. `pii.test.ts` shows the reference assertions;
C-16's harness runs the same cases against whatever engine is active.

## How D-02's layered engine replaces the stub

```ts
import { createLayeredPiiEngine, setPiiEngineApi } from './index.js';

setPiiEngineApi(createLayeredPiiEngine()); // installs D-02's L2-backed engine
```

`getPiiEngineApi()` still returns the stub by default — `worker/pii/index.ts`
does not call this automatically. Activating the layered engine in the real
worker is a separate bootstrap decision for whoever wires up the session
(D-02 depends only on D-01, not on A-03/A-04's transport/hosting). Tests that
swap the engine must call `resetPiiEngineApi()` afterwards, since the
registry is module-level state — same pattern as `worker/inference`.

A real engine must keep the guarantees this module documents: no network
client, no vault-value persistence, no raw-evidence logging, and `synthetic:
false` only on a finding a real detector pass actually produced. See
`l2/README.md` for exactly how `createLayeredPiiEngine` upholds this while
preserving D-01's conservative fallback.

## L1 semantic classification and L5 site policy (D-03)

`stub.ts` and `layered.ts` now derive a field's `pii_class` (and the
finding's `rule` provenance) via `semantic/l1.ts`'s `classifySemanticEvidence`
instead of a hardcoded input-type map — see `semantic/README.md`. Separately,
`policy/` adds per-origin always-redact selectors, a never-send flag and
user-marked regions, merged with detector output through
`policy/evaluate.ts`'s `mergeDetectorAndPolicy` (monotonic: policy can only
add protection) — see `policy/README.md`. `background/policyGuard.ts` exposes
the policy store over the message bus for F-07/F-13's settings UI and a
`guardEgress` hook for D-11/A-06.

## Boundaries

| Concern                                                | Owner               |
| ------------------------------------------------------ | ------------------- |
| L2 pattern/checksum detectors                          | D-02 (`l2/`)        |
| Semantic DOM classification (L1)                       | D-03 (`semantic/`)  |
| Per-site/per-user policy (L5)                          | D-03 (`policy/`)    |
| NER (L3), vision (L4)                                  | D-07, D-08          |
| Vault storage                                          | D-04                |
| Consistent session vault mappings, destination binding | D-04, D-09          |
| Text substitution using vault placeholders             | D-05                |
| Text/pixel crop redaction                              | D-13, D-14          |
| Restricted egress mode                                 | D-10                |
| Final outbound scan, fail-closed enforcement           | D-11 (Egress Guard) |
| Intercepting-proxy leak harness                        | C-16                |

This engine must never perform network I/O, and its decisions never
authorize a network send by themselves — the Egress Guard's own scan is
still required for every outbound payload.
