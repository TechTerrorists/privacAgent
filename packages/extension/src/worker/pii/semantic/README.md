# L1 semantic DOM classification (D-03)

`classifySemanticEvidence` turns B-03's evidence hints (`TextEvidenceHints`:
`inputType`, `autocomplete`, `labelKeywords`) into a `PiiClass` with a
confidence and a `rule` string recording which signal fired, so a
`PiiFinding`'s provenance is auditable without re-deriving it.

B-03 (element role/visibility/occlusion classification) has not landed yet.
`TextEvidenceHints` already reserves the fields B-03 will populate, so this
module consumes that existing D-01 contract directly rather than inventing a
substitute. `fixtures.ts` supplies deterministic hint sets for testing until
real B-03 output exists — it is fixture data, not a mock of B-03 itself.

## Precedence

1. `inputType === 'password'` → `secret`, confidence `1`, rule
   `input_type:password`. Terminal: no other signal can downgrade or
   reclassify a password field.
2. Any other known `inputType` → mapped class, confidence `1`.
3. `autocomplete`'s **last** whitespace-separated token (WHATWG spec: earlier
   tokens are section/context prefixes) → mapped class, confidence `0.9`.
4. `labelKeywords`, matched case-insensitively against a priority-ordered
   English+Hindi keyword list (secret > email > phone > dob > address >
   organization > name > location) → confidence `0.6`.
5. No match → `{ piiClass: 'other', confidence: 0, rule: 'none', matched:
false }`.

Hidden and visible fields are classified identically — `classifySemanticEvidence`
never reads visibility, so an `aria-hidden` or `display:none` field carrying
the same hints gets the same protection as its visible counterpart.

## Using it

```ts
import { classifySemanticEvidence } from './semantic/l1.js';

const classification = classifySemanticEvidence({ inputType: 'email' });
// { piiClass: 'email', confidence: 1, rule: 'input_type:email', matched: true }
```

`stub.ts` and `layered.ts` both call this directly and place `confidence`/
`rule` onto the resulting `PiiFinding` — see `worker/pii/README.md`.

## Boundaries

Owns: mapping already-extracted semantic hints to a class. Does not own:
extracting those hints from the DOM (B-03), pattern/checksum detection (D-02,
`l2/`), or deciding whether a finding should be sent (D-11).
