# F-03 overlay primitives — frame timing (chromium, headless)

Generated 2026-09-29T10:10:38.973Z by `bench/mock-sites/tests/overlay-timing.spec.ts`.

## Numbers

| configuration | overlay ticks / 3 s | longest tick | frames | modal interval | p95 | long tasks |
| --- | --- | --- | --- | --- | --- | --- |
| baseline (no overlay mounted) | 0 | 0 ms | 180 | 16.7 ms | 16.7 ms | 0 |
| 64 annotations, cold mount (create + first tick) | 1 | 1.4 ms | 0 | 0 ms | 0 ms | 0 |
| 64 annotations, settled | 7 | 1.4 ms | 180 | 16.7 ms | 16.8 ms | 0 |
| 7 annotations, settled | 7 | 1.4 ms | 180 | 16.7 ms | 16.8 ms | 0 |
| 64 annotations, page scrolling | 179 | 1.4 ms | 180 | 16.7 ms | 16.8 ms | 0 |
| 64 annotations, targets moving | 149 | 1.4 ms | 180 | 16.7 ms | 16.8 ms | 0 |
| 64 annotations, re-settled after motion | 7 | 1.4 ms | 180 | 16.7 ms | 16.7 ms | 0 |

## How to read this

- **overlay ticks / 3 s** is the number that matters, and it comes from the core's own
  instrumentation rather than from this harness. A layer in motion ticks on nearly every
  frame; a settled layer falls back to the 400 ms heartbeat, so 3 s buys roughly 8. The gap
  between those two rows is what "~0% idle CPU" means here — and the re-settled row is the
  one that would catch a glide which never unsubscribed.
- **longest tick** is the core's high-water mark for a single tick of work, and is cumulative
  over the page's life, so it is the strictest reading available. The budget asserted is
  < 8 ms: a tick approaching one frame at 60 Hz would be spending the whole display budget on
  decorations.
- **long tasks** is the PRD's hard bound (> 50 ms is a failure).
- **frames / modal interval / p95** are a *control*, not a result. This harness runs its own
  requestAnimationFrame loop to sample cadence, and that loop pins the page to the display
  cadence whether or not an overlay exists — so the frame counts would read the same either
  way. They are reported because a p95 that drifts from the modal value would show the
  overlay introducing jank, and because a control that is never compared to the baseline row
  is not a control.

## Hardware and fixture

The issue asks for the measurement to name its hardware and fixture complexity, because a
timing number without them is not reproducible.

| | |
| --- | --- |
| Machine | recorded below, at run time |
| Engines | Playwright Chromium and Firefox, both headless |
| Viewport | 1280x720, device scale factor 1 |
| Page | B-08 `bench/mock-sites/overlay.html`, local and deterministic, no network |
| Page under test | the gallery plus a synthetic 64-cell viewport-fixed grid |
| Layer size | 64 annotations, the core's cap, cycling all seven primitive kinds |
| Motion cases | page scroll, and all 64 targets oscillating every frame |

Recorded on this run: Apple M5, 16 GB, darwin 25.5.0, node v24.18.0.

## Limitation

Both Playwright projects run headless, and a headless browser has no display and therefore no
vsync, so the absolute cadence figures are the headless cadence and are not a claim about a
real 60 Hz display. No claim is made here about on-device frame rate.

The figures that do not depend on a display are the tick count, the per-tick cost and the
long-task bound, and those are asserted rather than merely reported. Timing is also taken on a
developer machine rather than the PRD's reference device, so the per-tick cost should be read
as an upper bound.
