# B-06 — incremental local extraction

`IncrementalSession` owns observers, an immutable comparison baseline and local diffs.
The content session exposes it lazily as `session.extraction`; reinjection disposes the
old owner. Nothing runs periodically. Call `extract()` when an observation is needed.

```ts
const result = await session.extraction.extract(abortSignal);
if (result.status === 'complete') {
  // Local privacy/fusion consumer only. Do not serialize this result to the server.
  // Apply removed IDs, then added/changed snapshots to the matching baseline.
}
session.extraction.invalidate('layout'); // e.g. after a CSSOM update
const unsubscribe = session.extraction.onRelevantMutation(() => {
  // B-07 can restart its quiet window here; B-06 implements no settle timer.
});
```

## Identity, equality and atomicity

A complete result carries `doc_id`, a monotonically increasing local `observation`
number and `baseline` (the preceding successful observation, or `null` for a reset).
These are local comparison identities, **not** E-07 sequence numbers/hashes or E-01
`observation_id`s. A consumer must discard its old state on `baseline: null`, and
otherwise require both its document and observation identity to match the result.
Failed, cancelled, stale, busy, limited, disposed or unstable requests carry no diff
and do not advance a baseline. Retry `unstable` on the next settled observation;
continuous page churn does not produce an allegedly coherent partial result.

The first request runs B-02's full walker. Later requests coalesce dirty subtrees,
reuse the same walker and scheduler for discovery, and re-extract semantic dependents
through B-03. External labels, missing/new ID references, ancestor changes and live
control events invalidate dependencies. Structural index changes conservatively
invalidate the affected tree scope. Pure text replacements do not rebuild that index.
No-change requests do no DOM traversal or semantic extraction (cache validity still
gets checked). Style/class/hidden changes, scroll/resize, root-load/slot events,
queue overflow and generation changes conservatively request a full refresh.

Candidates retain B-05 IDs. Moves and transient remove/reinsert batches preserve an
ID while a replacement node gets a new ID. Equality compares frozen semantic fields,
selected native/ARIA state, live form value and immediate parent ID. The parent ID
can identify a non-candidate. `geometry: null` explicitly excludes B-04 geometry and
visibility from this feature; changes in those fields need later assembly. Arrays
are sorted by ID and sets do not overlap. Evidence uses separate session-local IDs.
Every snapshot copies values; prior observations never retain live DOM handles.

Observers are installed before each root is scanned and drained before and after
extraction. A mutation revision change during a yielding pass rejects the pass and
retains its dirty work. Abort/error leaves the prior baseline intact. Top-document
registry generation changes reset it; child changes refresh and remove only obsolete
entries while preserving surviving top/sibling IDs. Detached frame/shadow observers
are disconnected on the next extraction or disposal. Root count is bounded meanwhile.

## Privacy handoff

`candidates` and `evidence` are **raw local inputs**. Text-node evidence, attribute
pairs and live form-value evidence are separate from candidate semantics; candidate
equality is never privacy approval. New/changed evidence must go through local PII
processing again and removed evidence must be retired. A later fusion/privacy consumer
must build and validate a sanitized Screen State; E-07 owns wire delta assembly.
No networking, logging, persistence, worker messaging or privacy bypass is added here.
Password live values are not read (DOM attribute evidence remains raw and sensitive).

## Bounds, lifecycle and coverage limits

Defaults: 1,024 queued records/dirty targets, 20,000 entries per cache, 128 observed
roots, 65,536 characters per evidence/value snapshot and a full reconciliation every
20 successful **requested** observations. Snapshot/cache overflow returns `limited`
without committing partial output; record overflow falls back to full extraction.
The scheduler uses the existing ≤8 ms cooperative budget. Native DOM calls/GC are
not preemptible; metrics report actual active/elapsed time and longest scheduled chunk.

`input`/`change` capture live form properties, including radio-group side effects.
Programmatic property writes without events, `attachShadow()` on an already attached
host, CSSOM/adopted stylesheet changes and state changes from arbitrary CSS selectors
cannot all be inferred from MutationObserver. Call `invalidate('input', control)`,
`invalidate('roots')` or `invalidate('layout')` as appropriate; periodic on-demand
reconciliation bounds otherwise missed changes. There are no setter monkeypatches,
polling loops, hidden geometry-freshness guarantees, closed-root or cross-origin reads.

`reset()` drops the comparison baseline. `dispose()` aborts scheduled work, disconnects
observers/listeners and releases caches/dependencies. An injected registry is borrowed;
an internally created registry is disposed by this session. Content-session teardown
also disposes extraction before its registry. Exact overlay host/fallback-style nodes
are tracked in a WeakSet; mixed page mutations are never hidden by a CSS selector.

## Validation

Unit tests cover immutable baselines, diff/fresh equivalence, no-op work, external
references, input events, explicit invalidation, periodic reconciliation, races,
abort/retry, overflow, generation reset, owned nodes and limits. Real Chromium and
Firefox tests cover native shadow/frame roots, frame navigation/detachment, SPA
history, radios and a 2,000-node benchmark (1,000 buttons plus text nodes).

Run `pnpm exec playwright test packages/extension/tests/incremental.spec.ts`.
The benchmark attaches active/elapsed/work counters to its report. The fixture asserts
one semantic extraction for a small edit, none for a no-op and no ≥50 ms scheduled
incremental chunk; the ≤10 ms active-time target needs measurement on the PRD reference
machine, not an assertion that every laptop/browser scheduling delay fits that budget.

Measured on 2026-09-29, Linux x86_64, Intel Core Ultra 9 275HX (24 cores),
headless Chromium 153 / Firefox 155, 1280×720 viewport, one test worker:

| Browser  | Full active / elapsed | Small edit active / elapsed | No-op active / elapsed | Edit longest chunk |
| -------- | --------------------- | --------------------------- | ---------------------- | ------------------ |
| Chromium | 30.4 / 248.2 ms       | 5.1 / 126.3 ms              | 1.5 / 200.3 ms         | 4.9 ms             |
| Firefox  | 33 / 138 ms           | 5 / 99 ms                   | 2 / 66 ms              | 4 ms               |

These are one-run scheduler measurements, not p50 claims. Idle waits dominate elapsed
time; active counters exclude synchronous setup/diff sorting. The Chromium full pass
had a 10.3 ms chunk despite the cooperative 8 ms request. This machine is stronger than
the PRD reference device; the benchmark does not establish that device's budget.
