# L2 pattern detectors (D-02)

Deterministic, worker-local pattern-and-checksum detectors for email, Indian
+91 and generic E.164 phone numbers, payment cards (Luhn), Aadhaar
(Verhoeff), PAN, IFSC, UPI, IBAN, JWT, heuristic API keys, and OTP-in-context.
Extends D-01's finding vocabulary — no competing PII classification, no
competing wire schema.

**Feature-list acceptance:** every listed class implemented with documented
syntax/boundaries; 300+ labeled fixtures.

This module does **no DOM access, no network I/O, no raw-value logging, and
no vault export.** It is a pure function of the string it is given:
`scanText(text, evidence)` in, an `L2ScanResult` out.

## Using it

```ts
import { scanText } from '../worker/pii/l2/index.js';

const result = scanText(rawFieldText, 'dom_text');
if (result.status === 'ok') {
  for (const match of result.matches) {
    // match.ruleId, match.piiClass, match.span.{start,end}, match.verified
  }
} else {
  // 'input_too_large' | 'internal_error' — the text was NOT examined.
  // Never treat this the same as "ran, found nothing".
}
```

Call `scanText` once **per evidence stream** (once for DOM text, once for a
DOM attribute value, once per OCR line, once for user/task text) — never on a
concatenation of several. Concatenating streams before scanning can
manufacture a match spanning a boundary that never existed in any single
source, and it would also misattribute provenance: a match's `evidence`
field is exactly what you pass into that call.

See `worker/pii/layered.ts` for how D-01's `PiiEngineApi` calls this per
field, and `worker/pii/engineBase.ts` for the orchestration both the stub and
the layered engine share.

## Category mapping (E-01 `PiiClass` reuse)

| Detected class      | `L2RuleId`(s)      | `PiiClass`   | Checksum / corroboration                                                               |
| ------------------- | ------------------ | ------------ | -------------------------------------------------------------------------------------- |
| Email               | `email`            | `email`      | none (format only)                                                                     |
| Indian mobile       | `phone_in`         | `phone`      | none (format only)                                                                     |
| Generic E.164 phone | `phone_e164`       | `phone`      | none (format only)                                                                     |
| Payment card        | `card_luhn`        | `card`       | Luhn (ISO/IEC 7812-1)                                                                  |
| Aadhaar             | `aadhaar_verhoeff` | `aadhaar`    | Verhoeff                                                                               |
| PAN                 | `pan`              | `pan`        | none (format only — India's ITD publishes no arithmetic check for the trailing letter) |
| IFSC                | `ifsc`             | `ifsc`       | none (format only)                                                                     |
| UPI VPA             | `upi`              | `upi`        | none (curated handle list)                                                             |
| IBAN                | `iban`             | `iban`       | ISO 7064 MOD 97-10                                                                     |
| JWT                 | `jwt`              | `jwt`        | structural (header decodes to JSON with `alg`)                                         |
| API key             | `api_key`          | `api_key`    | none (known-prefix heuristic)                                                          |
| OTP in context      | `otp_context`      | **`secret`** | contextual keyword nearby                                                              |

**OTP maps to the existing `secret` class, not a new `otp` class** — E-01's
`PiiClass` enum has no dedicated `otp` value, and an OTP is semantically a
one-time authentication secret, matching the class D-01 already uses for
password fields. This is a deliberate reuse decision, documented here rather
than inventing an incompatible taxonomy.

## `verified`: what it means per class

`verified` is `true` on every match this module ever returns — a rule with a
real checksum or structural check **never emits a candidate when that check
fails** (see below), so `verified: false` never appears on a live match. It
stays a field rather than being dropped so a caller isn't left assuming its
meaning:

- **Card, Aadhaar, IBAN**: a real arithmetic checksum ran and passed. An
  invalid checksum produces **zero matches**, not a low-confidence one — this
  is what keeps these "high-precision" per CLAUDE.md's detector-layer
  contract (L1, L2-with-checksum and L5 are the layers a single hit from is
  enough to call something sensitive).
- **JWT**: the header segment successfully base64url-decodes to JSON
  containing an `alg` key. An arbitrary three-part dotted string that isn't
  valid JSON there is not emitted.
- **OTP**: a nearby contextual keyword (§ below) was found. No keyword, no
  match, regardless of how OTP-shaped the digits look.
- **Email, phone, PAN, IFSC, UPI, API key**: format/prefix match only —
  there is no checksum to run. "Shape/checksum validity is not proof of a
  real issued account or ID" for _any_ of these classes, checksum-backed or
  not; a Luhn-valid card number is still entirely synthetic in this module's
  fixtures.

## Offsets and Unicode

Every `span` is `{start, end}` (end-exclusive, matching D-01's `TextSpan`)
into the **original string you passed in** — this module does no
normalization of its input (NFKC, case-folding, whitespace-collapsing), so
there is no offset mapping to lose. Native JS string indexing and `RegExp`
match indices already use UTF-16 code units consistently, so:

- A non-BMP character (emoji, most CJK-extension code points — a surrogate
  pair, 2 UTF-16 code units) directly adjacent to a match never shifts or
  splits the reported offsets; `l2.test.ts` asserts this directly.
- Combining marks (e.g. Devanagari मात्रा) in surrounding text are untouched
  and don't affect indexing, because this module never iterates the string
  by "character" — only by regex match, which is UTF-16-code-unit-exact.
- Line breaks (`\n`, `\r\n`) are ordinary characters here; no rule uses `^`/`$`
  with the multiline flag, so a break never creates an unexpected boundary.

**Any real document-wide Unicode normalization is B-16's job, not this
module's.** L2 scans exactly the string it receives; if a normalization
pipeline changes character positions upstream (composing/decomposing
combining marks, for instance), that pipeline is responsible for its own
offset bookkeeping. Duplicating that here would mean re-deriving a whole
text-to-pixel/text-normalization pipeline this module doesn't own.

## Overlap resolution

No rule consumes the string or narrows it for the next rule — every rule
scans the **full original text** independently (`rules/index.ts`), so a
broad early match never suppresses a later, narrower one. Candidates from
every rule are collected first, then resolved deterministically in one pass
(`scan.ts`'s `mergeOverlaps`):

1. Highest rule priority wins (`iban` > `card_luhn` > `aadhaar_verhoeff` >
   `jwt` > `pan` > `ifsc` > `email` > `upi` > `api_key` > `phone_in` >
   `phone_e164` > `otp_context` — checksum-verified numeric classes first,
   the purely-contextual OTP rule last).
2. Ties broken by longer span, then by earlier start position.

Two concrete cases this resolves, both covered by fixtures:

- A `+91`-prefixed number matches both `phone_in` and `phone_e164` at the
  identical span — `phone_in` (more specific) wins.
- `user@ybl.co.in` matches `upi` on `user@ybl` (stops before the dot) _and_
  `email` on the full `user@ybl.co.in` (a longer, overlapping span) — `email`
  outranks `upi` specifically so the longer, correctly domain-shaped match
  wins rather than a truncated UPI guess.

## Bounded runtime

Every rule is a bounded-repetition regex (explicit `{min,max}` quantifiers,
no nested quantifiers) — no catastrophic-backtracking shape — so cost scales
with input length. `MAX_L2_INPUT_LENGTH` (20,000 characters) is defense in
depth on top of that, not a correction for a known-slow rule: input over the
limit returns `{status: 'unavailable', reason: 'input_too_large'}` without
running any rule at all.

**Measured** (see `l2.test.ts`'s "bounded runtime" suite; numbers are from
this development machine, not a guaranteed SLA):

| Input                                                        | Size         | Measured                            | PRD L2 budget                                  |
| ------------------------------------------------------------ | ------------ | ----------------------------------- | ---------------------------------------------- |
| Reference sentence, repeated                                 | 1,800 chars  | **0.172 ms/scan** (mean of 20 runs) | ~2 ms goal — within budget                     |
| Adversarial (`a@` / digit runs / repeated `OTP` near-misses) | 19,500 chars | **7.899 ms** (single run)           | no catastrophic-backtracking requirement — met |

Re-run `pnpm exec vitest run packages/extension/src/worker/pii/l2/l2.test.ts --reporter=verbose` and read the `measured:` lines to reproduce these on your own machine; they are printed, not just asserted, specifically so a real number is always available rather than only a pass/fail.

## Fixtures and measured precision/recall

`fixtures.ts` has **338 labeled synthetic fixtures** (`l2.test.ts` asserts
`>= 300`) built from small composable helpers (`positive`, `negative`,
`multi`) rather than 300+ hand-typed literals, so every `expected` span is
computed from the exact strings that build `text` and can never drift out of
sync with it. Coverage includes, per class: multiple checksum-valid values,
checksum-invalid negatives, wrong-shape negatives, adjacent punctuation,
embedded/overlapping matches across classes, English and Hindi surrounding
text, non-BMP characters and combining marks directly adjacent to a match
(no separating space), CRLF line breaks between two matches, misleading
context (a wrong-checksum number next to words like "order code"), and a
handful of adversarial long-input cases. No real personal data, no real
issued cards/IDs, no real API keys — every value is fabricated (see the file
header for the exact statement).

**Measured** (from `l2.test.ts`'s "per-class precision/recall report",
computed directly against the fixture suite — re-run the suite to
reproduce):

| Rule             | Fixtures |  TP |  FP |  FN | Precision | Recall |
| ---------------- | -------: | --: | --: | --: | --------: | -----: |
| aadhaar_verhoeff |       18 |  18 |   0 |   0 |     1.000 |  1.000 |
| api_key          |       21 |  21 |   0 |   0 |     1.000 |  1.000 |
| card_luhn        |       22 |  22 |   0 |   0 |     1.000 |  1.000 |
| email            |       42 |  42 |   0 |   0 |     1.000 |  1.000 |
| iban             |       26 |  26 |   0 |   0 |     1.000 |  1.000 |
| ifsc             |       31 |  31 |   0 |   0 |     1.000 |  1.000 |
| jwt              |       13 |  13 |   0 |   0 |     1.000 |  1.000 |
| otp_context      |        8 |   8 |   0 |   0 |     1.000 |  1.000 |
| pan              |       25 |  25 |   0 |   0 |     1.000 |  1.000 |
| phone_e164       |       16 |  16 |   0 |   0 |     1.000 |  1.000 |
| phone_in         |       25 |  25 |   0 |   0 |     1.000 |  1.000 |
| upi              |       31 |  31 |   0 |   0 |     1.000 |  1.000 |

**These are precision/recall against this module's own synthetic fixture
suite, not against real-world web text.** A perfect score here means the
rules do exactly what their regex/checksum contract says on the cases this
suite thought to construct — it is not a claim about recall on arbitrary
production pages, which would need a much larger, independently-labeled
corpus this issue does not attempt to build.

## Stated limitations (not omissions)

- **API keys are known-prefix heuristics only** (OpenAI `sk-`, AWS `AKIA`,
  Google `AIza`, GitHub `gh[pousr]_`, Slack `xox[baprs]-`). An opaque
  internal token or any provider not in this list is never detected — there
  is no way to distinguish a random-looking secret from a random-looking ID
  by pattern alone. NER (D-07/D-08) or per-site policy (L5) are the only
  layers that could ever help here, and even they cannot fully close this
  gap.
- **IBAN country coverage is not exhaustive** (`checksums.ts`'s
  `IBAN_LENGTHS`, ~65 countries). An IBAN from an unlisted country is never
  matched — a stated false negative.
- **UPI handle coverage is a curated sample**, not the full PSP registry. A
  real but unlisted handle is a stated false negative, not a bug.
- **PAN/IFSC are case-sensitive by design** (real-world usage is
  conventionally uppercase-only), not a case-insensitivity gap.
- **OTP context keywords are English-only.** A digit string next to Hindi
  wording alone (no English "OTP"/"verification code"/etc. nearby) is not
  detected as an OTP by this rule.
- **PAN has no published checksum.** India's Income Tax Department does not
  document an arithmetic check for PAN's trailing letter, so PAN detection
  is format-only, same as IFSC and UPI.
- Per §"Boundaries" in the top-level PRD, **IP address and date-of-birth
  patterns are explicitly out of scope for D-02** — they are follow-up/
  optional scope, not silently-omitted required classes (the feature list's
  required class set for D-02 is the twelve `L2RuleId`s above).

## Integration: L2 as one layer (`layered.ts`)

`createLayeredPiiEngine()` (in `worker/pii/layered.ts`) wires this module
into D-01's `PiiEngineApi`, preserving D-01's conservative fallback exactly:

- A password field still always becomes the literal `{{SECRET}}`, checked
  before L2 ever runs.
- For any other `value` field, an L2 match makes the finding **real**
  (`detector: 'l2_pattern'`, `synthetic: false`) and masks to a
  class-specific placeholder for the matched class. No match falls back to
  D-01's exact L1-hint-or-withhold logic — a missing detection is never
  treated as "clear" or as authorization to send unchanged free text.
- For `name`/`title`/`url`/`text_context`/user-task text, the **wire
  decision never changes** — still withheld to `{{TEXT_WITHHELD}}` when
  non-empty. L2 still runs there, purely so the finding's `detector`/
  `synthetic` honestly reflect whether a real detector examined the text
  (useful to D-10's restricted-egress determination and D-11's coverage
  check). Replacing _part_ of such a field's text while keeping the rest is
  D-05's job (vault-backed substitution) — this engine only ever accepts or
  withholds a whole field.

This engine is **not** installed as the default in `worker/pii/index.js`
(`getPiiEngineApi()` still returns the stub) — activating it in the real
worker is a separate bootstrap decision left to whichever module wires up
the session (see D-02's issue: it depends on D-01 only, not D-04, and
explicitly does not take ownership of A-03/A-04's transport/hosting).

## Real-worker smoke test

`packages/extension/tests/l2-worker.spec.ts` (Playwright, same
bundle-into-a-real-`Worker` pattern as `message-bus.spec.ts` and
`vault-worker.spec.ts`) runs this module inside a genuine `Worker` and
demonstrates two things a same-realm unit test cannot: the module actually
runs across a real thread boundary, and every message posted back —
including a _positive_ detection — carries no raw matched text at all
(`L2Match` has no field for it by design; only `ruleId`, `piiClass`, a
numeric `span`, `verified` and `evidence`). It also confirms the
`input_too_large` guard holds across that boundary.

## Boundaries and handoff

| Concern                                    | Owner                                |
| ------------------------------------------ | ------------------------------------ |
| PII contracts and the safe stub            | D-01                                 |
| Semantic DOM / site policy (L1/L5)         | D-03                                 |
| NER (L3)                                   | D-07, D-08                           |
| Vision detectors (L4)                      | D-08                                 |
| Vault storage                              | D-04                                 |
| Text substitution using vault placeholders | D-05                                 |
| Final outgoing check                       | D-11 (Egress Guard)                  |
| A pattern match here                       | never itself an egress authorization |

A finding this module (or `layered.ts`) produces is internal evidence, same
as every D-01 `PiiFinding` — it is never serialized outbound, and an L2
match alone does not authorize sending anything. D-05 owns turning a
placeholder into vault-backed replacement text at execution time; D-11 owns
the final, independent scan every outbound payload must still pass
regardless of what any upstream layer decided.
