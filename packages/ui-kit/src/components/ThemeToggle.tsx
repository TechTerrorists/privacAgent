import type { JSX } from 'preact';
import { THEME_NAMES, type ThemeName } from '../theme.js';

export interface ThemeToggleProps {
  readonly value: ThemeName;
  readonly onChange: (theme: ThemeName) => void;
  readonly label?: string;
  readonly class?: string;
  readonly testId?: string;
}

const OPTION_LABELS: Record<ThemeName, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

const OPTION_CLASSES =
  'peer-checked:bg-pa-accent peer-checked:text-pa-on-accent ' +
  'hover:bg-pa-elevated peer-focus-visible:outline-2 peer-focus-visible:outline-pa-ring';

export function ThemeToggle(props: ThemeToggleProps): JSX.Element {
  const classes = ['flex flex-col gap-1', props.class ?? '']
    .filter((value) => value.length > 0)
    .join(' ');

  return (
    <fieldset class={classes} data-testid={props.testId}>
      <legend class="text-xs font-medium text-pa-muted">{props.label ?? 'Theme'}</legend>
      <div class="flex overflow-hidden rounded-pa border border-pa-border">
        {THEME_NAMES.map((name) => (
          <label
            key={name}
            class={[
              'flex-1 cursor-pointer px-3 py-1.5 text-center text-sm text-pa-text',
              'peer-checked:font-medium has-checked:border-transparent',
              OPTION_CLASSES,
            ].join(' ')}
          >
            <input
              type="radio"
              name="pa-theme"
              value={name}
              class="sr-only"
              checked={props.value === name}
              onChange={() => props.onChange(name)}
              data-testid="pa-theme-option"
            />
            {OPTION_LABELS[name]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
