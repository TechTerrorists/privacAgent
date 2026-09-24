# DOM walker (B-02)

`walkDocument` discovers local candidates for the DOM/perception pipeline. It runs only
when called and never starts polling, injects another script, executes a control or sends
data. It does not modify the page. The content-script entry point is still a scaffold;
A-03 and the later agent loop will call this module on demand.

## API and ownership

```ts
import { walkDocument } from './dom-extract/index.js';

const controller = new AbortController();
const result = await walkDocument(document, { signal: controller.signal });
if (result.status === 'complete') {
  // Local consumers can inspect result.candidates and result.evidence.
  // Release the result after local processing; it holds live DOM references.
}
// The task owner can call controller.abort() while the walk is pending.
```

Results are discriminated by `status`:

| Status      | Meaning                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`  | Traversal finished for the accessible, loaded roots discovered in this run                                                            |
| `cancelled` | The caller aborted; no partial candidates/evidence are returned                                                                       |
| `stale`     | A traversed root/cursor became detached, moved to another root, changed document, or the top document received `pagehide`; re-observe |
| `error`     | Unexpected processing/scheduling failure; no page-derived exception details or partial data are returned                              |

Invalid scheduling options or a document without a window reject with a fixed programmer
error. Failures during scheduled processing resolve to `error`. There are no payload logs.

A completed result contains:

- `candidates`: DOM `node`, `context` and the reasons the node qualified.
- `evidence.textNodes`: individual live Text-node handles with their context.
- `evidence.attributeElements`: separate element handles that have attributes. This is
  not a copied attribute bag or the live value of an input. Privacy processing must read
  required attributes and live form values separately in the content context, then send
  only the necessary local evidence to the worker through the future message bus.
- `frames`: each encountered iframe with `same-origin`, `opaque` or `unloaded` access.
- `contexts`: document/root/frame ancestry, without invented stable IDs.
- `metrics`: numeric work-unit/chunk counts, active time, elapsed time and longest chunk.

These are **local-only objects**, not E-01 wire `Element` or `ScreenState` messages.
DOM nodes must never be serialized into messaging, logging, persistence or egress.
Text/attribute handles are live evidence, not an immutable snapshot or detector approval.
Privacy processing must scan DOM text, relevant attributes/live values and later OCR
independently; fusion must not erase one source because another supplied a label.

## Traversal and filtering

One native `TreeWalker` visits each discovered root; a FIFO queue adds open shadow roots
and accessible loaded same-origin iframe documents. It accepts all node types internally
and classifies one returned node per work unit. Filtering inside `nextNode()` could hide
a long synchronous run of non-candidates from the scheduler, so candidate filtering is
performed outside the native walker.

Weak sets prevent duplicate visits/root queuing if nodes move during a walk. Slots are
not recursively expanded via `assignedNodes()`: their light-DOM nodes are already visited
in the owning document/root. Fallback slot content may also be discovered; B-04 later
decides whether it is visible. Distinct controls with identical text stay distinct.

Candidates include native links, buttons, inputs, selects, textareas and summary controls;
explicit roles, editable roots and tabindex-bearing elements; headings, labels, outputs,
alerts/status/live regions; iframe boundaries; and otherwise unclassified elements with
computed `cursor: pointer`. Disabled/hidden/off-screen controls are not filtered out here.
The initial context rule does not recognize every arbitrary CSS-styled error message.
B-03 owns complete semantic role/name rules and B-04 owns visibility.

Non-candidate parents do not prune descendants. Script, style, template and noscript
content is excluded from candidates/evidence. Other text nodes are retained as references
without calling `innerText`, `innerHTML` or whole-subtree `textContent`; this avoids large
text copies, normalization and layout work inside a traversal unit.

Closed shadow roots are inaccessible through this API, and a null `shadowRoot` cannot
distinguish them from absent roots. Cross-origin/sandboxed iframe contents are opaque;
no permissions are requested or bypassed. An accessible iframe still loading is recorded
as `unloaded` and is not traversed in this run. Retry after it loads. Cross-origin frame
injection and an outbound `opaque_frame` representation belong to A-09.

Result order is deterministic root-discovery/tree order on an unchanged document, not
composed-tree visual order. B-01 page-coordinate geometry and the eventual outbound sort
and 300-element selection happen downstream. B-02 reads no bounding boxes and does not
mislabel viewport/frame coordinates as page coordinates. Traversal continues past 300
candidates so later controls and privacy evidence are not silently lost.

## Scheduling, changes and cleanup

The default scheduler uses `requestIdleCallback` with a 100 ms starvation timeout. Each
turn stops at its remaining idle deadline, the 8 ms elapsed-work budget, or 4,096 work units.
Timed-out idle callbacks and the asynchronous timer fallback retain the elapsed/unit
limits. Callers may lower `budgetMs` (positive, at most 8) and `maxUnitsPerChunk` for tests
or tighter responsiveness. The optional `WorkScheduler` interface supports deterministic
clock/deadline tests; its callbacks must be asynchronous and cancellable.

The 8 ms budget is cooperative: JavaScript cannot interrupt a native traversal/style
operation already running. The walker checks between units and records actual durations.
A single expensive browser operation or GC pause can overshoot. Do not advertise a hard
real-time guarantee from the timer check; investigate benchmark/trace overruns.

An unchanged DOM is visited once per reachable node. A changing DOM is best-effort:
nodes inserted behind a cursor may be missed, and a returned live node may change again.
Detected cursor/root invalidation returns `stale`; contexts are rechecked in bounded work
units before completion. B-05/B-06/B-07/B-15 own durable document identity, mutation
tracking, settling and action freshness. A successful walk alone authorizes no action.

Abort cancels pending callbacks; all outcomes remove abort/pagehide listeners and clear
internal traversal queues. Non-complete results discard accumulated candidates/evidence.
After success, the caller owns the returned references and must release them when the
observation is no longer needed. The module has no cache or persistent registry.

## Tests and benchmark

From the repository root:

```sh
pnpm exec playwright install chromium firefox
pnpm test
pnpm test:browser
pnpm bench:dom
```

On a supported Linux CI image, `pnpm exec playwright install --with-deps chromium firefox`
also installs browser system dependencies. CI runs the browser suite separately from the
root Vitest/Python tests and uploads its synthetic result artifacts.

Vitest tests deterministic scheduling, timeouts, fallback, cancellation and error cleanup.
Playwright runs the **actual bundled walker** against synthetic browser DOM in Chromium
and Firefox: controls/context, shadow/slot/frame boundaries, DOM removal, cancellation,
fallback and more than 300 candidates. Routes are fulfilled locally; no live site data is
read. These are DOM-module tests, not proof of extension injection, messaging, executor
behavior, privacy recall or a complete Firefox add-on integration harness.

`pnpm bench:dom` constructs exactly 2,000 DOM nodes, settles initial layout, and records
six runs with browser/OS/CPU/RAM metadata. Results are attached under `test-results/` and
printed as numeric benchmark reports. Active time excludes waiting for idle turns;
elapsed time includes it. Compare active time with the PRD's ≤40 ms full-extraction target,
while recognizing that B-03/B-04 and the rest of extraction are not measured here.
Host-dependent timings are reported rather than used as flaky shared-runner assertions.

### Recorded local verification

All nine browser cases passed in each engine (18 total). Six benchmark runs per engine
on Linux 7.1.5, Intel Core Ultra 9 275HX (24 logical CPUs), 62.2 GiB RAM, headless with
pre-settled layout, produced:

| Test browser           | Median active time | Median elapsed time | Longest observed chunk |
| ---------------------- | ------------------ | ------------------- | ---------------------- |
| Chromium 153.0.8010.12 | 2.5 ms             | 10.5 ms             | 6.6 ms                 |
| Firefox 155.0          | 3.0 ms             | 16.0 ms             | 5.0 ms                 |

Every run found 996 candidates in the same 2,000-node fixture. These are development-machine
measurements, not certification on the PRD's 4-core/8 GB reference laptop or results for
complete extraction. Idle waiting varies independently of active processing. Re-run the
benchmark on target hardware; the saved JSON includes each run rather than just medians.

## Handoff

Reuse the [B-01 element contract](../../../../protocol/element-model.md) when downstream
code constructs sanitized wire data. B-03 supplies names/roles/state, B-04 visibility,
B-05 IDs and registry, A-08 coordinate conversion, A-09 frame orchestration and D-01
local privacy processing. No competing wire schema or raw-data transport is introduced.
