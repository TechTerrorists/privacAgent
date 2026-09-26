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
- `sidepanel-view.tsx` is the Preact shell. It renders the header, task input, action
  trace, stop control and settings route out of `@privacagent/ui-kit` components, and
  re-renders from the controller subscription. `mountSidePanel` returns a handle whose
  `dispose()` unmounts the tree and drops the controller subscription; the view never
  disposes the injected controller.
- `controller.ts` is the synthetic demo controller. It has no network client and creates
  a deterministic local action trace. A real A-03/A-12-backed controller can implement the
  same `SidePanelController` contract without changing the view. Stopping is a handshake:
  `stop()` moves the run to `stopping` and only an acknowledgement moves it to `stopped`, so
  the panel can disable Stop and say so while a cancellation is in flight, and never report a
  stop the run did not confirm.
- The presentation layer is the F-01 kit (`@privacagent/ui-kit`): `Button`,
  `ActionTraceList`, `ErrorState` and `ThemeToggle` come from that package, and the shell
  imports its token stylesheet instead of shipping a second set of CSS variables. The
  interim DOM primitives that stood in for F-01 have been deleted.
- `sidepanel.css` is the shell's stylesheet entry: it imports the kit's tokens and adds
  `@source` for the shell's own files. The kit pins its sources with `source(none)`, so
  without those declarations every utility used only by the shell (`p-3` on the panel
  sections) is dropped and the panel ships with the elements but not the spacing.
- The theme follows the kit's `data-pa-theme` contract, applied to `#root` through
  `applyTheme`, so panel and kit cannot drift apart.
- `settings.ts` stores the `theme` key in local extension storage. No settings shown in
  the route are placeholders.

The route is hash-based so `#settings` can be opened directly. Theme changes are applied
immediately and written locally; reopening the panel hydrates the saved value.

Preact batches renders into a microtask, so the controller stays synchronous while the DOM
updates on the next tick. View tests await that flush; nothing else observes the delay.

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

`lint:firefox` reports one `UNSAFE_VAR_ASSIGNMENT` warning on the panel bundle. It points at
Preact's diffing code, which assigns `innerHTML` on its `dangerouslySetInnerHTML` path and
when clearing children. The panel renders no untrusted HTML and never passes
`dangerouslySetInnerHTML`, so neither branch runs here; the rule is left unsuppressed rather
than adding a security-rule exception to the manifest lint. Everything else is zero errors
and zero warnings.
