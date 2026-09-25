# @privacagent/ui-kit (F-01)

Standalone side panel UI kit. Pure presentation: every component is driven by
props and callbacks, and the package contains no networking, backend, storage,
logging, or extension API code. It is developed and demoed without the
extension, so `pnpm --filter @privacagent/ui-kit dev` works in a plain browser.

## Install and build

The kit is a private workspace package, so consumers use it through the
workspace:

```bash
pnpm --filter @privacagent/ui-kit dev      # preview app on Vite's dev server
pnpm --filter @privacagent/ui-kit build    # typecheck + static preview in dist/preview/
```

`exports` points at `src`, not at `dist`. That is deliberate: a workspace
consumer resolves the kit straight from TypeScript and CSS, so `pnpm test`,
`pnpm build:chrome`, and `pnpm build:firefox` all work on a fresh checkout with
no prebuild step and no build-order coupling. `tsc --build` still typechecks the
package as a composite project; only the preview is emitted.

The trade is that **the consumer compiles the stylesheet**, so a consumer needs
Tailwind v4 and a plugin that runs it:

```bash
pnpm --filter @your/pkg add -D tailwindcss @tailwindcss/vite
```

```ts
// vite.config.ts
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({ plugins: [tailwindcss()] });
```

Skipping this is not a build error. The file is still valid CSS, so a build
succeeds and the panel ships with none of the kit's styling. The kit therefore
starts with `@import 'tailwindcss' source(none)`: automatic source detection is
off, so a consumer's sheet contains exactly the kit's own utilities and never
whatever happens to be in the consumer's project or `dist` directories. Add
`@source` directives to a consumer stylesheet to pull in your own classes.

If your build cannot run Tailwind (a plain static pipeline, a non-Vite bundler),
import a prebuilt sheet from your own build step instead and drop the
`./tokens.css` export from consideration.

## Preview

`src/preview` renders every component and every state deterministically, with no
network or clock dependency: all four button variants plus disabled and loading,
the action trace with all five statuses in static, interactive, and empty forms,
`EmptyState` with and without an action, `ErrorState` with retry and dismiss, and
320px/360px panel-width frames. The theme switcher drives the same
`data-pa-theme` contract consumers use.

## Theming

All colour, radius, and font values come from CSS custom properties in
`src/tokens.css`, exposed to Tailwind v4 through `@theme inline`:

| Token                            | Used for                          |
| -------------------------------- | --------------------------------- |
| `--pa-canvas`                    | panel background                  |
| `--pa-surface`                   | cards, list rows, buttons         |
| `--pa-elevated`                  | hover/pressed fills               |
| `--pa-border`                    | borders and dividers              |
| `--pa-text` / `--pa-muted`       | primary and secondary text        |
| `--pa-accent` / `--pa-on-accent` | primary action                    |
| `--pa-danger` / `--pa-on-danger` | destructive action and error text |
| `--pa-success` / `--pa-warning`  | action-trace status markers       |
| `--pa-ring`                      | focus ring                        |

Switching themes is a single attribute on any ancestor:

```ts
import { applyTheme, readTheme, type ThemeName } from '@privacagent/ui-kit';

applyTheme(document.documentElement, 'dark'); // sets data-pa-theme="dark"
applyTheme(document.documentElement, 'system'); // removes the attribute
readTheme(document.documentElement); // 'light' | 'dark' | 'system'
```

With no attribute present the stylesheet follows `prefers-color-scheme`, so
`system` needs no JavaScript. `ThemeToggle` is a controlled radio group for
host apps that persist a choice.

Styling hooks:

- Override the custom properties on `:root` or any wrapper; no component
  re-theming is needed.
- `ThemeToggle` and `ActionTraceList` accept a `class` prop for layout.
- The focus ring is a global `:focus-visible` outline, and animation is disabled
  under `prefers-reduced-motion`.

## Components

### `Button`

| Prop               | Type                                              | Default       | Notes                                                  |
| ------------------ | ------------------------------------------------- | ------------- | ------------------------------------------------------ |
| `label`            | `string`                                          | required      | Visible text                                           |
| `onClick`          | `(event: MouseEvent) => void`                     | –             | Fires on click, `Enter`, or `Space`                    |
| `variant`          | `'primary' \| 'secondary' \| 'ghost' \| 'danger'` | `'secondary'` | Also exposed as `data-variant`                         |
| `type`             | `'button' \| 'submit'`                            | `'button'`    |                                                        |
| `disabled`         | `boolean`                                         | `false`       |                                                        |
| `loading`          | `boolean`                                         | `false`       | Sets `aria-busy`, disables the button, shows a spinner |
| `loadingLabel`     | `string`                                          | `'Working…'`  | Announced while busy                                   |
| `ariaLabel`        | `string`                                          | –             | For icon-only usage; keep the visible text inside it   |
| `class` / `testId` | `string`                                          | –             | Layout escape hatch and test hook                      |

### `ActionTraceList`

| Prop                              | Type                          | Default          | Notes                                                            |
| --------------------------------- | ----------------------------- | ---------------- | ---------------------------------------------------------------- |
| `items`                           | `readonly ActionTraceItem[]`  | required         | `{ id, label, status, detail?, meta? }`                          |
| `ariaLabel`                       | `string`                      | `'Action trace'` | Applied to the `<ol>`                                            |
| `emptyTitle` / `emptyDescription` | `string`                      | shown above      | Used when `items` is empty                                       |
| `onItemActivate`                  | `(item) => void`              | –                | Renders a real button per item, so activation is keyboard-native |
| `renderItemAction`                | `(item) => ComponentChildren` | –                | Trailing control per row                                         |
| `class` / `testId`                | `string`                      | –                |                                                                  |

`status` is one of `pending`, `running`, `done`, `failed`, `stopped`; each row
carries `data-status`, and the `running` row is marked `aria-current="step"`.
Status text is rendered visibly, so colour is never the only signal. An empty
`items` array renders `EmptyState` rather than an empty list.

### `EmptyState`

| Prop               | Type                | Default  | Notes                                   |
| ------------------ | ------------------- | -------- | --------------------------------------- |
| `title`            | `string`            | required |                                         |
| `description`      | `string`            | –        |                                         |
| `icon`             | `ComponentChildren` | –        | Rendered `aria-hidden`                  |
| `children`         | `ComponentChildren` | –        | Optional action, supplied by the caller |
| `class` / `testId` | `string`            | –        |                                         |

Rendered with `role="status"` so it is announced when it appears.

### `ErrorState`

| Prop                          | Type         | Default                     | Notes                                    |
| ----------------------------- | ------------ | --------------------------- | ---------------------------------------- |
| `message`                     | `string`     | required                    |                                          |
| `title`                       | `string`     | `'Something went wrong'`    |                                          |
| `onRetry` / `onDismiss`       | `() => void` | –                           | Each renders a button only when provided |
| `retryLabel` / `dismissLabel` | `string`     | `'Try again'` / `'Dismiss'` |                                          |
| `class` / `testId`            | `string`     | –                           |                                          |

Rendered with `role="alert"` for immediate announcement.

### `ThemeToggle`

| Prop               | Type                         | Default   | Notes                                    |
| ------------------ | ---------------------------- | --------- | ---------------------------------------- |
| `value`            | `ThemeName`                  | required  | Controlled                               |
| `onChange`         | `(theme: ThemeName) => void` | required  | Receives `'system' \| 'light' \| 'dark'` |
| `label`            | `string`                     | `'Theme'` | Visible legend                           |
| `class` / `testId` | `string`                     | –         |                                          |

## Accessibility

- Real `button`, `fieldset`/`legend`, and radio semantics: no click handlers on
  non-interactive elements, and every action is reachable by `Tab` plus
  `Enter`/`Space` (arrow keys move within the theme group).
- `EmptyState` is a `role="status"` region, `ErrorState` is a `role="alert"`, and
  the running trace row is `aria-current`.
- Focus is always visible through the `:focus-visible` ring, and targets are at
  least `min-h-9` with visible `focus` order matching reading order.
- Status is conveyed by text and `data-status`, not colour alone; motion is
  reduced under `prefers-reduced-motion`.
- Measured WCAG contrast for both themes: body text 14.4:1 or higher, muted text
  6.0:1 or higher, accent button labels 5.5:1 or higher, error text 5.8:1, and
  the focus ring against surfaces 5.7:1 or higher.
- Layout is width-agnostic: the kit uses `flex`/`min-w-0`/`w-full`, wraps action
  rows, and the preview proves 320px and 360px panel widths.

## Mounting in the side panel (A-10)

A-10 mounts this package into the extension side panel; it does not own the
markup. The intended shape:

```ts
import { render } from 'preact';
import { ActionTraceList, Button, EmptyState, ErrorState } from '@privacagent/ui-kit';
import '@privacagent/ui-kit/tokens.css';

const root = document.getElementById('panel-root');
if (root) {
  render(
    <ActionTraceList
      items={controller.state.trace}
      emptyTitle="No actions yet"
      onRetry={controller.retry}
    />,
    root
  );
}
```

The side panel host is responsible for the DOM node, the controller, and theme
persistence; the kit only receives the data and callbacks. A-10 keeps its
interim DOM kit behind `packages/extension/src/ui/kit.ts` until F-01 is merged,
then deletes it and renders these components instead.

## Tests

`pnpm --filter @privacagent/ui-kit test` is covered by the root `pnpm test`;
suites live beside the components and cover click/keyboard activation, disabled
and busy states, empty/error rendering, list semantics, theme switching, and the
token contract for both themes.
