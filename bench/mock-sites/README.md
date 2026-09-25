# Mock sites pack 1 (B-08)

Three functional, deterministic local pages for DOM, privacy, vision, and future
executor testing. All data is synthetic. No extension, Redis, API server, models,
or internet connection is needed to use the sites after installing dependencies.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm mocks:start
```

Open **http://127.0.0.1:4173/**. Stop the server with Ctrl+C. To choose another port:

```sh
MOCK_SITES_PORT=4180 pnpm mocks:start
```

The server binds only to `127.0.0.1`, bundles the local TypeScript once at startup,
and serves an explicit list of routes/assets. Restart it after editing source.
It has no development hot-reload connection, external fonts/assets, request-body
handler, persistence, analytics, or access logs. Unsupported methods return 405;
unknown paths return 404. `/health` returns 200 after the bundle/assets are ready.
The site's CSP disables outbound connections and real form submissions.

## Scenarios and observable outcomes

| ID / URL                 | Initial state                                                                                 | Interactions and expected outcome                                                                                                                                                                                                                                                                                                                                        | Reset                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `profile` / `/profile`   | Avery Example, `avery.canary@example.test`, `+12025550147`; saved snapshot matches the fields | Editing sets **Unsaved changes** without updating the saved snapshot. **Save profile** validates required fields, email format, and `+` followed by 8–15 digits; a whitespace-only name is rejected. Successful save copies the field values into the visible snapshot and reports **Profile saved**. Invalid input leaves the snapshot unchanged and displays an error. | **Reset profile** restores all three fields, the saved snapshot, initial status, and validation state.            |
| `settings` / `/settings` | Notifications on, daily digest, comfortable density, Asia/Kolkata time zone                   | Changes remain unapplied until **Apply settings** updates the snapshot. Turning notifications off disables the digest select; applying displays digest **Off**. Re-enabling notifications retains the selected frequency. Density/time-zone preferences are shown in the snapshot; they do not change fixture styling or use a clock.                                    | **Reset settings** restores every control, dependent enabled state, snapshot, and initial status.                 |
| `search` / `/search`     | Empty query, all categories, availability filter off, six products                            | Search is trimmed, case-insensitive substring matching on product names. Category and available-only filters combine with AND. Results update on input/change or **Search**; order always follows the fixed dataset. Result count and empty state update visibly.                                                                                                        | **Clear filters** clears query, category, and availability and restores all six products in their original order. |

No page writes browser storage or cookies. Reloading/navigation to a fresh page
restores defaults, and tests get isolated browser contexts. Use the explicit reset
when reusing an already-open page; browser back/forward caching is not a reset API.
No randomized IDs, timestamps, remote content, or data-dependent delays are used.
Viewport/browser/fonts can affect geometry, so use the documented test viewport
(1280×720) for comparisons; cross-browser screenshots are not pixel-identical.

Catalog ground truth:

| ID  | Product            | Category   | Available |
| --- | ------------------ | ---------- | --------- |
| p01 | Cedar Notebook     | stationery | yes       |
| p02 | Harbor Pen Set     | stationery | no        |
| p03 | Cedar Desk Lamp    | home       | yes       |
| p04 | Pebble Mug         | home       | no        |
| p05 | Trail Backpack     | travel     | yes       |
| p06 | Cedar Travel Pouch | travel     | no        |

Examples: `Cedar` → `p01,p03,p06`; add travel → `p06`; add available-only
→ no results. Clear, then available-only → `p01,p03,p05`.

## Shared fixture contract and synthetic canaries

[`src/fixtures.ts`](src/fixtures.ts) exports `scenarios`, `profile`, `preferences`,
`products`, and `canaries`. Consumers may import this module for ground truth; it
has no DOM dependencies. It records URLs, stable control IDs, initial states,
expected initial result IDs, and the three sensitive values/locations.

| Canary                 | Input value      | Saved text     | Suggested privacy category |
| ---------------------- | ---------------- | -------------- | -------------------------- |
| `profile-name-canary`  | `#profile-name`  | `#saved-name`  | person                     |
| `profile-email-canary` | `#profile-email` | `#saved-email` | email                      |
| `profile-phone-canary` | `#profile-phone` | `#saved-phone` | phone                      |

The exact synthetic values are in `canaries[].value`. Each occurs in both a live
input property and the visible saved snapshot. Tests that edit a field must track
the edited input and previous saved value separately until save/reset. The
`.test` email and fictional NANP 555-01xx phone range avoid real contact details.

These category labels describe fixture ground truth, not a new PII-engine API or
proof of detector coverage. D-01 owns privacy types and canary suites; map these
markers to that contract. This pack is intentionally small and does not replace
D-02's wider pattern cases or C-16's intercepted-egress leak tests.

Stable HTML IDs and `data-product-id` are fixture addresses only. They are not
B-05 element IDs or E-01 wire IDs. Future executor/perception tests must discover
controls through their actual implementation; importing a fixture selector to
bypass extraction does not verify the consumer.

## Browser tests and CI

```sh
pnpm exec playwright install chromium firefox
pnpm test:mocks           # this pack, both browsers
pnpm test:browser         # B-02 edge cases + this pack, both browsers
MOCK_SITES_PORT=4180 pnpm test:mocks
```

Playwright owns server startup, `/health` readiness, and teardown. An occupied
port fails clearly instead of silently testing a different existing server. Stop
a manually started fixture server first, or use another port. CI's existing DOM
browser job runs both suites and uploads `test-results` on failure. No fixed
sleep is used for server startup or page behavior.

The tests cover saves, validation, literal text handling, keyboard submission,
dependent settings, combined filters, empty results, reset/repeatability,
reload/context isolation, narrow layouts, and server routing. Normal browser
requests are checked to remain on the fixture origin.

The B-02 smoke tests bundle the **real walker**, inject that bundle through a
test-only same-origin script route (preserving the site's CSP), and inspect its
actual candidates and separate text/attribute evidence on all three served pages.
They do not claim accessible-name computation, visibility filtering, or stable
wire element IDs that belong to later B features.

Playwright's own interactions verify the fixture pages. They **do not verify our
extension's synthetic executor**. B-10 onward must drive the real executor.
Likewise these tests prove neither installed-extension integration nor zero PII
egress. C-16 supplies the proxy, image inspection, and degraded-detector tests.

## Team handoff

- **DOM/executor:** semantic labels, native forms, controls, status text, and
  stable initial states for extraction and later real-executor scenarios.
- **Privacy:** input and text canaries with a shared value/location manifest;
  detectors and redaction remain in the extension.
- **Vision:** fixed pages/records for screenshots at controlled viewports; this
  feature does not generate a training dataset or run models.
- **Platform/UI/server:** pages to open alongside the extension, and documented
  example tasks. The E-02 scripted planner's synthetic Screen States are separate
  fixtures: do not assume its IDs/coordinates are interchangeable with these pages.

B-09 owns multi-page workflows, SPA routing, shadow DOM, canvas, and cross-origin
fixtures. B-08 supplies only the three scenarios above and focused consumer tests.
