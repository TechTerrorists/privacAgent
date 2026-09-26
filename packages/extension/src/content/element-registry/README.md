# B-05: local element registry

`ElementRegistry` gives a live DOM element a stable opaque `e…` ID within an
opaque `doc_id`. These are the existing E-01 protocol types; no wire schema changed.
The registry lives in the isolated content-script world. It never writes IDs to
page elements and never sends DOM handles, text, URLs or attributes to the server.

## Consumer API

```ts
import { ElementRegistry } from './element-registry/index.js';
import { walkRegisteredDocument } from './element-registry/walk.js';

// In production, use the instance owned by content/index.ts. Pass it to consumers
// (e.g. the F-02 overlay); do not create a separate ID namespace for each consumer.
const registry = new ElementRegistry(document);
const result = await walkRegisteredDocument(document, registry);
if (result.status === 'complete') {
  const target = result.targets[0];
  if (target) {
    const resolved = registry.resolve(target.id, result.doc_id);
    if (resolved.status === 'ok') {
      // Local DOM handle for an overlay or, later, the executor's further checks.
      const element = resolved.element;
      void element;
    }
  }
}
```

- `register(element, expectedDocId)` gets or creates an ID. Repeated walks reuse
  the ID for the same valid node. Identical-looking controls have different IDs;
  replacements never inherit a removed control's identity.
- `resolve(id, expectedDocId)` returns `ok` with an `Element`, or a bounded
  `missing`, `stale`, or `disposed` result. Never substitute another element on
  failure. A `v…` ID is not a DOM target and cannot resolve here.
- `unregister(id)` retires a target explicitly. `invalidate()` starts a fresh top
  generation, including for major rerenders that keep the URL unchanged.
- `sweep()` is the deterministic per-step cleanup path. The registered-walk
  consumer calls it before and after extraction. Other consumers should call it
  at their step boundary too; there is no timer or idle polling.
- `onGenerationChange(callback)` returns an unsubscribe function. `scope: 'top'`
  means discard the old observation/targets. `scope: 'child'` means re-resolve
  child anchors; surviving top and sibling IDs remain valid. Subscriber failures
  cannot prevent invalidation or cleanup.
- `dispose()` removes listeners, unregisters finalizers and clears the registry.
  The content entry owns one session in its isolated global and disposes the old
  session before reinjection. That global is not visible to the page world.

`walkRegisteredDocument` is a real B-02 consumer, not another DOM walker. It
returns the local walk and registered targets together, handles top-generation
changes during asynchronous traversal, and skips targets that became invalid.
The caller owns the returned walk's **strong DOM references** and must release
it after the step. These results are not sanitized Screen State or serializable
messages. Observation sequence checks, semantic/bounding-box drift, mutation
tracking and action authorization remain the responsibilities of B-06/B-15 and
the executor. Successful identity resolution alone does not authorize an action.

## Lifetime and memory

The forward index is a `WeakMap<Element, ElementId>`. Reverse entries contain a
`WeakRef<Element>` plus weak root/frame/document references and document-version
snapshots. They never retain B-02's strong `TraversalContext` objects. A
`FinalizationRegistry` holds only an ID; unregister tokens let explicit cleanup
remove registrations. IDs are not recycled, so a late finalizer cannot remove a
new target. Supported browsers must provide weak references; there is no strong
Map fallback.

Every resolution validates connectivity, owning document, root chain, open shadow
hosts, reachable same-origin iframe ancestry, current frame document and route
versions. Adoption, removed hosts, detached frames, frame navigation and collected
nodes fail resolution. A child navigation retires that child's entries and its
descendants without invalidating unrelated top/sibling targets. Cross-origin and
closed-shadow contents are not registered.

Sweep removes dead/disconnected/stale entries without waiting for GC, and removes
listeners for child documents no longer used by any entry. Finalizers are only a
cleanup aid. The registry does not promise to detect a detach-and-reinsert that
occurs entirely between checks; B-06 mutation tracking/B-15 drift validation must
handle changes to an otherwise still-live target.

## Navigation and permissions

The native `Navigation.currententrychange` listener sees the page's router from
an isolated content script. `popstate`/`hashchange` and synchronous URL checks on
access supply additional invalidation. The policy is conservative: **every
history-entry change, including same-URL `pushState`/`replaceState`, retires IDs**.
No history API wrappers are installed.

For engines without the Navigation API, the background uses the `webNavigation`
permission and `onHistoryStateUpdated`/`onReferenceFragmentUpdated`. It probes for
an active on-demand registry in the affected tab and, under existing host access,
dispatches a data-free hint in the affected frame's isolated document. No URL is
relayed, logged or persisted. This is a narrow lifecycle hook, not A-03's general
message bus or A-09's frame discovery/injection system. It uses no persistent
ports, polling or in-memory tab subscription state, so background restarts do not
lose subscriptions. Browser notifications are asynchronous; URL checks reject
changed routes even before the notification arrives. Same-URL changes on legacy
engines invalidate when their browser notification arrives. B-15 must still check
observation freshness immediately before action execution.

Hints contain no target data and cannot authorize anything. A page can forge a
hint only to retire IDs, requiring re-observation. The production manifest still
has no static content scripts, install-time host grants or web-accessible assets.
A-09/the on-demand injection owner remains responsible for invoking the content
script on a newly loaded document.

`pagehide` retires IDs and prevents registration while hidden. A persisted
`pageshow` starts another fresh generation before reuse. Ordinary full navigation
creates a new document/registry; restored documents never reuse pre-hide IDs.

Primary browser API references:
[Navigation entry events](https://developer.mozilla.org/en-US/docs/Web/API/Navigation/currententrychange_event),
[webNavigation history events](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webNavigation/onHistoryStateUpdated).

## Verification

```sh
pnpm exec vitest run packages/extension/src/content/element-registry/index.test.ts
pnpm test:browser packages/extension/tests/element-registry.spec.ts packages/extension/tests/registry-extension.spec.ts
```

`test:browser` builds first so installed-extension tests cannot accidentally test
stale bundles. Unit tests exercise explicit cleanup, dead weak references and
late finalizer delivery with deterministic doubles, without requesting GC.
Chromium and Firefox browser tests cover actual DOM walks, duplicate/replaced
nodes, open/closed roots, adoption, frame removal/navigation, routes, generation
subscriptions and disposal.

Installed-extension tests use temporary profiles and copies of the production
bundles, with localhost-only test drivers/grants added to the **test manifest**.
They run real page-world history calls, verify that the page cannot access the
isolated registry, force the no-Navigation-API fallback, and test reinjection and
back/forward across full document navigation. Firefox is temporarily installed
through its local debugging protocol; no developer/user profile is modified.
Synthetic persisted pagehide/pageshow coverage is deterministic; a
`bfcache-coverage` artifact records whether the real browser back traversal used
BFCache. In the initial validation run, both browsers reloaded on that traversal
(`persisted: false`); actual cache restoration was not observed. Browser cache
eligibility is not assumed or forced by that assertion.
No test driver, DOM test response attribute or test messaging endpoint is present
in a production bundle.
