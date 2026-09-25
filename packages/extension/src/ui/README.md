# Side panel shell (A-10)

The side panel is the same document for both build targets: Chrome mounts it as a side
panel and Firefox mounts it as a sidebar through the A-02 platform adapter and the MV3
manifests.

## Structure

- `sidepanel.ts` is the extension entry point. It reuses A-02's
  `activePlatform.browser.storage.local` for the one persisted setting and mounts the shell.
  `activePlatform` (`src/platform/active.ts`) resolves the adapter from the build-time
  `__BROWSER__` constant in a single expression so the inactive target's adapter is dropped
  from the bundle; importing A-02's `platform` entry instead would drag Chrome-only
  `chrome.sidePanel` / `chrome.offscreen` calls into the Firefox panel.
- `sidepanel-view.ts` owns DOM listeners and renders the header, task input, action trace,
  stop control and settings route. `mountSidePanel` returns a handle whose `dispose()`
  removes every listener and disposes the controller.
- `controller.ts` is the synthetic demo controller. It has no network client and creates
  a deterministic local action trace. A real A-03/A-12-backed controller can implement the
  same `SidePanelController` contract without changing the view.
- `kit.ts` contains the small DOM primitives used by this shell. The upstream F-01 UI kit
  was not present in this checkout, so these primitives are an explicit fallback seam:
  replace them with the F-01 exports when that branch is available, without changing the
  controller or route contract.
- `settings.ts` stores the `theme` key in local extension storage. No settings shown in
  the route are placeholders.

The route is hash-based so `#settings` can be opened directly. Theme changes are applied
immediately and written locally; reopening the panel hydrates the saved value.

## Verification

From the repository root:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
pnpm build
```

`pnpm test:browser` additionally drives the built Chrome panel in Chromium
(`packages/extension/tests/sidepanel.spec.ts`). Firefox is covered by
`pnpm --filter @privacagent/extension lint:firefox` and the manual sidebar steps in
`docs/development.md`.
