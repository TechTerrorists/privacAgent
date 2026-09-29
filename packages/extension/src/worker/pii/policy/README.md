# L5 per-site / per-user policy (D-03)

A `SitePolicy` is the only thing this module persists: an origin-scoped,
schema-validated record of always-redact selectors, a never-send flag, and
user-marked regions (selector-only — never a captured value or region
pixels). Nothing else is ever written to storage.

```ts
export interface SitePolicy {
  readonly origin: string; // must be an exact origin, e.g. https://a.example
  readonly alwaysRedactSelectors: readonly string[];
  readonly neverSend: boolean;
  readonly userMarkedRegions: readonly UserMarkedRegion[]; // { id, selector }
}
```

## Files

- `types.ts` — the `SitePolicy` shape and its bounds (`MAX_SELECTOR_LENGTH`,
  `MAX_SELECTORS_PER_ORIGIN`, `MAX_USER_MARKED_REGIONS`,
  `MAX_MATCHED_ELEMENTS_PER_SELECTOR`).
- `validate.ts` — origin exactness (`new URL(...).origin` round-trip, so
  `https://a.example/path` is rejected) and selector validation, split into a
  DOM-free `validateSelectorShape` (empty/length) and a DOM-dependent
  `validateSelectorSyntax` (`probe.querySelector` in a try/catch — never
  `eval`, a selector cannot execute code). `validateSelector`'s `probe` is
  **optional**: MV3's background/service-worker context has no `document`
  global at all, so a policy write issued from there can only be shape-checked
  at write time. Invalid _syntax_ written without a probe is still safe: every
  read path (`matchAlwaysRedactSelectors`) wraps `querySelectorAll` in its own
  try/catch and simply skips a selector that turns out to be unparseable — no
  crash, no code execution, regardless of when syntax was checked.
- `evaluate.ts` — `matchAlwaysRedactSelectors` (resolves selectors against a
  live `ParentNode`, bounded and deduplicated by element ID, emitting
  `l5_policy` findings) and `mergeDetectorAndPolicy` (monotonic union: a
  policy finding is added only if no detector finding already covers that
  exact location; detector findings are never removed or downgraded).
- `store.ts` — `createStoragePolicyStore(area)` wraps a
  `{get,set,remove}`-shaped storage area (mirrors `ui/settings.ts`'s
  `StorageAreaLike` pattern) with per-write validation and an
  `isExactOrigin` guard on every method.

## Why policy can only add protection, never remove it

`mergeDetectorAndPolicy` is a lattice merge, not a replace: it starts from
`detectorFindings` unchanged and appends non-duplicate policy findings. A
policy can mark more elements sensitive than the detectors found; it can
never un-mark one a high-precision detector already flagged. `isNeverSendOrigin`
is a separate, coarser gate — the future egress path consults it before
attempting to send _anything_ for that origin, findings aside.

## Origin scoping and staleness

Every store method takes an `origin`, not a document or tab, and rejects
anything that is not `new URL(origin).origin` exactly — no path, no
wildcard. Policy is never keyed by `doc_id`/`elementId`, so it survives
navigation by design; what does _not_ survive navigation is a _match_
(`matchAlwaysRedactSelectors`'s output), which must be re-run against the
current DOM on every fresh observation. This module has no notion of B-05's
`ElementRegistry` doc_id/generation invalidation because it never caches a
match — callers that do cache one are responsible for discarding it on the
same navigation/generation-change signal B-05 already exposes
(`registry.onGenerationChange`), the same way any other DOM-derived data is
invalidated.

## No DOM in the background context

`store-no-dom.test.ts` asserts `typeof document === 'undefined'` and proves
every write still works with structural validation alone. `store.test.ts`
(happy-dom) proves the same methods additionally catch invalid CSS syntax
when a probe is available. Together they cover both real runtime contexts a
`PolicyStore` can be constructed in.

**Known gotcha (happy-dom):** calling `probe.querySelector` twice with the
_identical_ invalid selector string on the same `document` instance throws on
the first call but not the second (an internal parse-result cache). Tests
must invoke the function under test exactly once per unique invalid selector
string and capture the result, rather than calling it twice to both assert
`not.toThrow()` and inspect the return value.

## Background wiring

`background/policyGuard.ts` exposes this store over the A-03 message bus
(`policy:get`, `policy:setAlwaysRedactSelectors`, `policy:setNeverSend`,
`policy:addUserMarkedRegion`, `policy:removeUserMarkedRegion`) for F-07/F-13's
settings UI, plus `guardEgress(store, origin)` for D-11/A-06's future
chokepoint to consult before sending anything for an origin. It is not wired
into `background/index.ts`'s runtime yet, since no live bus exists there
until A-04 lands — see `policyGuard.test.ts` for the standalone contract
proof over real `MessageBus` instances.

## Boundaries

Owns: policy definition, storage, validation, and selector-to-finding
matching. Does not own: the Screen State assembler that will call
`matchAlwaysRedactSelectors` per observation (D-05/D-11), the settings UI
itself (F-07/F-13, which must escape any page-supplied text before display —
this module never emits page text, only selectors and ids the user or policy
author supplied), or the egress chokepoint that will call `guardEgress`
(A-06/D-11).
