# Overlay core and primitives

F-02 is the isolated overlay core; F-03 adds the element-anchored primitives that draw on it.
They are one module and one host: F-03 did not add a second controller, a second shadow root or a
second frame loop, because two overlays on one page means two hosts to defend and two loops to
budget. The old F-02 title is kept below for history.

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
- `tests/primitives.spec.ts` — the F-03 safety rules in both engines (see below).

## F-03 — Element-anchored primitives

An annotation supplies a `primitive` and the core draws it in place of the F-02 dot marker. The
seven kinds are `pointer`, `circle`, `arrow`, `badge`, `label`, `underline` and `spotlight`.

### One renderer per layer, and why the marker is not a kind

A layer is constructed with exactly one renderer: F-02's `markerRenderer` by default, or
`createPrimitiveRenderer()` for primitives. An annotation therefore draws _either_ as the marker
_or_ as a primitive, and a single layer cannot mix the two. That is a deliberate boundary rather
than an unfinished feature — accepting `'marker'` in the primitive dispatcher's kind union would
mean a `RangeError` on the default path, or a second renderer contract with no caller. A caller
that wants markers and primitives at once uses two layers; the core supports that, and the cost is
two hosts, which is why nothing inside the extension does it.

### The safety rules, and where each one is proven

Every rule below is asserted in `tests/primitives.spec.ts` against real Chromium and real
Firefox, not only in the unit suite. A rule that is only unit-tested is a rule that has never
fired in an engine.

| rule              | how it is held                                                                                                                                                               | proven by                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Click-through     | one `pointer-events: none !important` on the shadow root, not per node                                                                                                       | click lands on the page element, not the decoration                        |
| Non-focusable     | primitives create no `tabindex` and nothing calls `focus()`; the root is not reachable by keyboard                                                                           | Tab order and `document.activeElement` are unchanged with annotations live |
| Non-modal         | no `role`, no `aria-modal`, no `inert`, no focus trap, no event capture outside the root                                                                                     | AX tree gain is 0 and no page `keydown` is consumed                        |
| Text is data      | `textContent` only, never `innerHTML`; label bounded by `MAX_LABEL_CHARS` and measured to fit                                                                                | hostile string in a label renders as literal text                          |
| Status handling   | `data-status` on each node; the sheet hides everything that is not `visible`, so stale, missing, hidden, off-screen and unsupported targets each remove their own decoration | one test per status, plus stale/missing/hidden/offscreen                   |
| Reduced motion    | layer answers `prefers-reduced-motion`; placement is applied immediately with no glide                                                                                       | mock of the media query; no animation at all                               |
| No perpetual loop | a glide subscribes on arrival and unsubscribes **before** its final write                                                                                                    | settled frame count, in both the unit suite and the benchmark              |
| Hostile page CSS  | the host's critical rules live in an adopted `CSSStyleSheet`                                                                                                                 | injected `!important` reset and `pointer-events` overrides lose            |

### The hostile-CSS finding

A page's `!important` declaration beats a shadow root's `:host { ... !important }` — the cascade
resolves across the shadow boundary in the page's favour, which is correct per spec and hostile in
practice. The two obvious fixes are both wrong here: inline styles on the host leak into the
B-02 attribute evidence, and a `<style>` element is blocked outright by a strict
`Content-Security-Policy`. So the host installs its critical rules as an adopted stylesheet, with
a `<style>` fallback for engines without `replaceSync`, and a high-specificity
`html > div:nth-of-type(n)` selector so the host wins on specificity as well as origin. The host
stays attribute-free, which is what keeps the B-02 evidence check passing.

### The glide bug worth knowing about

`Glide.moveTo()` originally restarted `startedAt` on every call. With the core's 400 ms heartbeat
requesting a frame, a settled layer re-issued `moveTo()` to the position it was already at, the
elapsed time reset to zero every tick, and the rAF loop never terminated — 73 frames in 1.2 s
instead of ~14. The fix is an early return when the requested destination equals the current one.
The regression test asserts the frame count, and the benchmark's re-settled row asserts it again
in a real engine, because a perpetual loop is precisely the failure a unit test can miss.

### F-04 and E-12

F-03 is the drawing half of F-04 ("annotate"): the primitives and the safe surface that an
annotation needs are in place, and a planner-supplied annotation renders without the page being
disturbed. What is deliberately not here is anything interactive — no leader line that a user can
drag, no control, no confirmation affordance. The F-04 work is composing a screen state from
several annotations and letting the planner choose among them, which is a planner change and
depends on protocol work rather than on this module.

E-12 is the local-model lane and is untouched by F-03. It is noted here only because the feature
list lists both under the same milestone, and it would be easy to assume a primitives pass had
moved it. It has not.

### Frame timing

`bench/mock-sites/tests/overlay-timing.spec.ts` measures the core's own tick count and per-tick
cost against a 64-annotation layer (the cap) in both engines, and writes a report to
`bench/mock-sites/tests/reports/`. Headless, the numbers are: ~0 long tasks, a longest tick of
~2 ms in Chromium and ~3 ms in Firefox, and a settled layer falling back to 7–8 ticks per 3 s
while the same layer in motion ticks on nearly every frame. The settled-versus-moving ratio is the
"~0% idle CPU" claim as a measurement rather than an intention.

Both projects run headless, so the absolute frame cadence is the headless cadence. **This is not a
claim of 60 fps**, and the issue explicitly rules out claiming it from a requestAnimationFrame count:
a headless browser has no display and no vsync, so the cadence it reports is not the cadence a user
would see. What the measurement does establish is the part that does not depend on a display —
long tasks (0), the cost of one tick (1.8 ms Chromium / 3 ms Firefox for a full 64-annotation layer),
and the tick counts (7 per 3 s settled versus ~175 moving, which is the idle-cost claim). Each
report records the machine, viewport, fixture and layer size it was measured against, read from the
host at run time rather than typed in, so a report cannot claim hardware it was not measured on.

Verifying this on real hardware, with a display attached, is the one item here that this
environment cannot close, and it is recorded as such rather than approximated.

The `hostChildCount` / `positionOf` / `statusOf` accessors exist because a closed shadow root
leaves no other way to observe a marker from outside. They are ordinary API, used by the tests
and needed by F-03's leader lines and F-08's companion placement.
