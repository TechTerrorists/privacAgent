# Worker vault (D-04)

A worker-memory-only store: sensitive values in, opaque placeholders out.
Built on D-01's privacy types (`PiiClass`, `Placeholder`) and E-01's
identifiers. Gives D-05's text substitution a consistent, session-local
placeholder service — without introducing any channel that resolves a
placeholder back to a raw value. That resolution channel is D-09's job, and
D-04 deliberately does not build a placeholder version of it.

**Feature-list acceptance:** worker-memory store, consistent placeholders per
session, cleared on task end, tab close, or 15 minutes idle.

## Using it (D-01/D-05 integration sketch)

```ts
import { createVault } from '../worker/vault/index.js';

const vault = createVault(); // one instance per worker; hold onto it

vault.createScope({ scopeId: sessionId, taskId, ownerTabId: tabId });

// D-05, after D-01 has decided a value needs masking:
const result = vault.intern(sessionId, {
  piiClass: 'email',
  value: rawEmailFromDom,
  binding: {
    taskId,
    origin: pageOrigin,
    docId,
    allowedTargets: [elementId], // where a resolved value may later be typed
    operations: ['type'],
  },
});

if (result.outcome === 'ok') {
  // result.placeholder is `{{EMAIL_1}}`-shaped — safe to put on the wire.
} else {
  // 'scope_missing' | 'capacity_exceeded' | 'task_mismatch' — D-01's stub
  // already withholds by default; there is no raw-value fallback to reach for.
}
```

There is no `resolve(placeholder)` method. A caller that needs to type a
resolved value back into the page waits for D-09, which owns authorization,
destination confirmation and execution integration. See **Resolution is
deliberately absent** below.

## Identity and equality

A forward lookup key is the exact `(piiClass, value)` pair, using plain `Map`
equality (`SameValueZero`) — no case-folding, whitespace-trimming, or Unicode
normalization. Two strings that a human would consider "the same" but that
differ by a single code point get two different placeholders. This is
deliberate: normalizing here would either merge two genuinely different
original values under one placeholder, or make a later real restoration
(D-09) reconstruct the wrong byte-for-byte string.

**A literal, placeholder-shaped raw value is just data.** If the actual page
text the engine hands to `intern` happens to be `'{{EMAIL_99}}'`, the vault
never treats that as a reference to an existing entry — it is interned like
any other string and gets a fresh, independently-numbered placeholder. There
is no code path that parses an incoming value looking for `{{...}}` syntax.

**Reserved secrets never become typable.** `piiClass === 'secret'` always
returns the literal `{{SECRET}}` placeholder without creating any
forward/reverse entry — there is nothing stored to resolve, regardless of
what D-09 eventually implements. This mirrors `worker/pii`'s stub, which
never resolves `{{SECRET}}` either.

## Session isolation

Every scope owns its own forward/reverse maps and its own per-class
placeholder counters. Two different sessions interning the identical value
under the identical class each get their own independently-numbered
placeholder (both may legitimately be `{{EMAIL_1}}`) — nothing is shared
across scope boundaries, and ending one scope never touches another.

## Use-binding metadata: recorded, never merged

Each interned entry accumulates a **list** of `UseBinding`s — one per
`intern` call that resolved to that placeholder — rather than replacing or
widening a single stored binding. Re-observing the same value under a
narrower or differently-scoped binding (a different `docId`, a different
`allowedTargets`) appends a new, independent record; it never unions
`allowedTargets` or `operations` across observations. `getBindings` returns
all of them (a copy, not a live reference) so D-09's authorization check can
require a match against _some specific recorded binding_, never an inflated
superset. `intern` also rejects a binding whose `taskId` doesn't match the
scope's own `taskId` (`'task_mismatch'`) — a mismatch signals a caller bug,
not evidence to fall back on.

## Capacity

Each scope holds at most `maxEntriesPerScope` entries (default 500 — see
`vault.ts` for the rationale). Once full, interning a genuinely new
`(piiClass, value)` pair returns `{ outcome: 'unavailable', reason:
'capacity_exceeded' }`. Re-interning an **already-stored** value still
succeeds (it doesn't consume new capacity) and returns its existing
placeholder. A full scope never falls back to raw content and never reuses
an existing placeholder for a different value — the two behaviors the
deliverable explicitly forbids.

## Lifecycle and expiry

A scope ends on:

- **Explicit disposal / task end / task cancel** — `endScope(scopeId, reason)`.
- **Owning tab closure** — `notifyTabClosed(tabId)` ends every scope that tab
  owns (tracked via `ownerTabId` at `createScope` time).
- **15 minutes of inactivity** — the default `idleTimeoutMs`.

**Only `intern` counts as activity.** `hasScope`, `entryCount` and
`getBindings` are read-only status checks and never refresh the idle timer —
otherwise a background poller (or an unrelated session's status check) could
keep a scope alive indefinitely.

**Expiry is checked at access time, not only by the timer.** Every method
calls the same internal gate (`ensureLive`), which compares `now() -
lastActivity` against `idleTimeoutMs` _before_ trusting a scope exists. The
one-shot idle timer (`clock.setTimeout`, re-armed on every `intern`) is a
performance optimization — it cleans up promptly instead of only at the next
access — not the sole source of truth. A worker that was suspended past the
idle window, whose timer callback never got the chance to run, still finds
the scope gone on its next call.

**Cleanup is idempotent and complete.** Ending an already-ended scope is a
no-op. Ending a scope clears its idle timer, removes it from the owning
tab's index, clears its forward/reverse/counter maps explicitly, and removes
it from the scope table — a stale timer from a disposed scope cannot fire
into a later scope that reuses the same `scopeId` (each `createScope` call
creates an entirely new, independent scope object; see `vault.test.ts`
"stale timer" cases). A disposed scope's id is not special afterward:
`createScope` with the same id opens a genuinely fresh scope, with its own
empty maps and placeholder numbering restarted from 1.

**Injectable clock.** All of this is deterministic to test via `Clock`
(`clock.ts`): production code uses `createRealClock()`; tests use
`createManualClock()`, which only advances when told to and can jump time
forward _without_ firing due callbacks (`jumpWithoutFiring`) to simulate a
suspended worker.

**Worker termination.** Termination drops every scope's `Map`s along with
everything else in the worker's memory — nothing here writes to disk or
survives a restart, and nothing attempts to. Removing the last reference to
a value only makes it eligible for garbage collection; this is not a claim
of cryptographic erasure of JavaScript string memory. A-04's own idle-host
teardown (10 minutes) may tear down the worker, and therefore this vault,
before the vault's own 15-minute window elapses — that is expected and safe,
since a torn-down worker has already dropped everything this module holds.

## Lifecycle host contract (A-04 handoff)

`endScope` and `notifyTabClosed` take only non-sensitive identifiers
(`VaultScopeId`, `TabId`) — the same identifiers a real host has on hand
without ever touching vault contents. `testHost.ts` provides
`createTestLifecycleHost(vault)`, an executable stand-in that wires simulated
`emitTaskEnded` / `emitTaskCancelled` / `emitTabClosed` events to those two
calls, and `vault.test.ts` exercises it end-to-end. **What remains for
A-04**: subscribing this exact call pattern to the real
`chrome.tabs.onRemoved` / `browser.tabs.onRemoved` event and to whatever
message the background/session controller sends on task end, cancellation,
or explicit disposal. There is no production event source to wire up yet in
this repository, and a fake one would only be more code to delete later —
`createTestLifecycleHost` demonstrates the wiring shape, not the production
subscription.

## Resolution is deliberately absent

There is no method anywhere in `VaultApi` that returns a raw stored value by
placeholder. That is intentional, not an oversight: D-09 owns full
resolution authorization, destination confirmation, and execution
integration, and "production resolution must be absent or fail closed" until
it lands. Knowing a placeholder, or presenting a server-issued `Action`
containing one, is not authorization by itself — D-04 does not create an API
surface that could be mistaken for one. When D-09 lands, it is expected to
read this module's internal reverse map and `UseBinding` history to decide
whether a specific resolution request is authorized; it does not get a
public "give me the value" method to shortcut that decision through.

## Boundaries

| Concern                                                    | Owner            |
| ---------------------------------------------------------- | ---------------- |
| PII contracts and the safe stub                            | D-01             |
| Detection (semantic/pattern/NER/vision)                    | D-02, D-03, D-08 |
| Text substitution using vault placeholders                 | D-05             |
| Authorized resolution, destination confirmation, execution | D-09             |
| Egress Guard enforcement                                   | D-11             |
| Transport (worker \<-\> background \<-\> content script)   | A-03             |
| Production worker hosting, host-idle teardown              | A-04             |

This module never performs network I/O and never persists to extension
storage, IndexedDB, `localStorage`, logs, telemetry, or crash diagnostics. No
vault value appears in any thrown error — `InvalidVaultInputError` only
carries structural detail (e.g. "scopeId, taskId and ownerTabId are all
required"), never a value a caller passed in.
