# F-02 — Isolated overlay core

A guidance-only overlay anchored to element identity. It answers one question for later
features — _where on screen is the element this id refers to, and is that answer still true?_ —
and it answers it without becoming part of the page.

Built for F-03 (visual primitives) and F-08 (companion). It is deliberately **not** a UI kit:
it draws a noninteractive marker and reports status. There is no approval flow, no button, no
input, and nothing a user is ever asked to confirm here. Consequential actions stay with the
executor's confirm path.

## Using it

The overlay is owned by the content session, which builds it against the B-05 registry and
tears it down with the session that created it:

```ts
import { startContentSession } from './element-registry/session.js';

const session = startContentSession(document);
const registration = session.registry.register(node, session.registry.docId);
if (registration.status === 'ok') {
  // Re-pointing the same anchor is an update, not a second annotation.
  const id = session.overlay.update(
    { doc_id: registration.doc_id, element_id: registration.id },
    { placement: 'auto', label: 'Start here' }
  );
  session.overlay.statusOf(id); // 'visible' | 'offscreen' | 'hidden' | 'stale' | 'missing' | ...
  session.overlay.positionOf(id); // marker box in viewport coordinates, or null when not drawn
}
```

`update` is keyed on `(doc_id, element_id)`, so the same element under a new document
generation is a _different_ annotation. Nothing is created until the first `update`, so a
content script that never annotates adds no nodes, observers, or listeners to the page.

## Host and layer contract

| Property         | Value                    | Why                                                                                                                                                                              |
| ---------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shadow root      | **closed**               | `host.shadowRoot` is `null` for page script; contents cannot be read, restyled, or removed.                                                                                      |
| Host attributes  | **none**                 | B-02 reports any element with an attribute as raw page evidence. A `data-` marker or even an inline `style` would put the overlay into the perception stream as if the page had. |
| Style reset      | `all: initial`           | The page's cascade, including inherited properties, has no hold on the host.                                                                                                     |
| Position         | `fixed`, 0×0 at top-left | Out of normal flow: no layout shift, no scrollbar, nothing for the page to reflow around.                                                                                        |
| `pointer-events` | `none`                   | A marker can never take a click, and the page stays fully interactive underneath it.                                                                                             |
| `z-index`        | `2147483647`             | Above page content, including sticky/fixed chrome.                                                                                                                               |
| Parent           | `<html>`                 | A page that empties or replaces `<body>` during navigation or an SPA re-render cannot take the overlay with it.                                                                  |

The host's safety-critical properties are declared `!important`. Shadow-tree `:host` rules
already outrank ordinary page rules, but an author stylesheet using `!important` would
otherwise be able to make the overlay clickable.

**Markers are positioned with `position: fixed` inside that root**, in viewport coordinates, so
they track the visual viewport rather than the document. A page that puts a `transform`,
`filter`, or `contain: layout` on `<html>` itself defeats this: that makes the root element a
containing block for fixed descendants, and the overlay's markers would move with it. This is a
known, documented limitation rather than a silent one.

## Identity

An annotation is addressed by `(doc_id, element_id)`. Ids mean nothing without their generation,
because navigation and SPA route changes mint a new generation and retire every id from the
previous one. The overlay therefore:

- holds no id table and mints no ids — every lookup goes through the B-05 registry;
- persists nothing, in memory or otherwise, across documents;
- reports `stale` rather than re-pointing an annotation at a similar-looking node.

The session subscribes to the registry's generation changes: a **top-level** change is a
navigation, so annotations are dropped outright; a **child** change invalidates one subtree, so
the survivors are re-measured. Without that, a marker could sit on screen against a dead id until
the next scroll.

## Coordinate space

Everything here is **CSS viewport coordinates** — `getBoundingClientRect` space, the same space
`position: fixed` consumes. The overlay never converts, and never guesses:

- a **vision-only** id (`v` prefix) is executed by coordinates and has no node to anchor to, so
  it reports `unsupported` until A-08/A-09 land;
- a target in a **child frame** reports a rect in that frame's viewport, so it is `unsupported`
  too rather than being silently misplaced.

Converting page, image, or frame-local coordinates into viewport space is A-08's job, and the
`TargetResolver` interface is the seam where it plugs in.

## Statuses

| Status        | Meaning                                                                             | Drawn |
| ------------- | ----------------------------------------------------------------------------------- | ----- |
| `visible`     | On screen and rendering an area.                                                    | yes   |
| `offscreen`   | Connected and rendered, but outside the viewport.                                   | no    |
| `hidden`      | Connected but rendering no area (`display: none`, `visibility: hidden`, zero size). | no    |
| `stale`       | The document generation moved on, so the id identifies nothing.                     | no    |
| `missing`     | Unknown to the registry, or the node is detached.                                   | no    |
| `unsupported` | Cannot be addressed in viewport coordinates (yet).                                  | no    |

An off-screen target draws nothing on purpose: a marker clamped to the window edge would point
at a control the user cannot see, and the executor's rule is to re-observe rather than guess.

## Frame budget and lifecycle

Tracking is **event-driven, not a permanent rAF loop**. Scroll (captured, so nested containers
count), viewport resize, and `visualViewport` scroll/resize all request a frame, and
`ResizeObserver` covers a target changing size. Everything is coalesced into one frame callback,
with all reads before all writes.

One case no event covers: a target that _moves_ because something else reflowed — a transition,
a collapsing panel, a sibling pushing it down. That fires no scroll, no resize, and no
`ResizeObserver` callback, because the target's own box never changed. A slow heartbeat
(`HEARTBEAT_MS`, 400 ms) re-measures while annotations exist, which is what makes "follows
layout changes" true rather than best-effort. It stops as soon as the last annotation is removed,
so an idle page costs nothing.

`dispose()` is total and idempotent: nodes, observers, listeners, the heartbeat, the pending
frame, and every target reference go away. A page that deletes the host gets it re-attached a
bounded number of times (3 by default) before the overlay reports and stops, so a page that
deletes the host on every insertion cannot keep it busy.

Simultaneous annotations are capped at 64 to keep one frame's measurement well inside the 50 ms
long-task budget. Exceeding it is reported as a `RangeError` rather than silently dropped.

## Testing

- `positioner.test.ts`, `scheduler.test.ts` — pure geometry and frame coalescing.
- `controller.test.ts` — lifecycle, statuses, host isolation, and leak checks in `happy-dom`.
- `resolver.test.ts` — the B-05 contract, including the cases a page driver cannot produce.
- `tests/overlay.spec.ts` — real Chromium **and** Firefox: rendering, page scroll, nested scroll,
  viewport resize, event-less layout movement, style isolation in both directions, click
  pass-through, walker purity, host removal, and dispose.

The `hostChildCount` / `positionOf` / `statusOf` accessors exist because a closed shadow root
leaves no other way to observe a marker from outside. They are ordinary API, used by the tests
and needed by F-03's leader lines and F-08's companion placement.
