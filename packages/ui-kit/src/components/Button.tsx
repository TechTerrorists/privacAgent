import type { JSX } from 'preact';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  readonly label: string;
  readonly onClick?: (event: MouseEvent) => void;
  readonly variant?: ButtonVariant;
  readonly type?: 'button' | 'submit';
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  readonly ariaLabel?: string;
  readonly class?: string;
  readonly testId?: string;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-pa-accent text-pa-on-accent border-transparent hover:opacity-90 active:opacity-80',
  secondary:
    'bg-pa-surface text-pa-text border-pa-border hover:bg-pa-elevated active:bg-pa-elevated',
  ghost:
    'bg-transparent text-pa-text border-transparent hover:bg-pa-elevated active:bg-pa-elevated',
  danger: 'bg-pa-danger text-pa-on-danger border-transparent hover:opacity-90 active:opacity-80',
};

const BASE_CLASSES =
  'inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-pa border px-3 py-2 ' +
  'text-sm font-medium transition-opacity select-none ' +
  'disabled:cursor-not-allowed disabled:opacity-55';

const SPINNER_CLASSES =
  'size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent';

export function Button(props: ButtonProps): JSX.Element {
  const variant = props.variant ?? 'secondary';
  const loading = props.loading ?? false;
  const disabled = (props.disabled ?? false) || loading;
  const text = loading ? (props.loadingLabel ?? 'Working…') : props.label;

  const classes = [BASE_CLASSES, VARIANT_CLASSES[variant], props.class ?? '']
    .filter((value) => value.length > 0)
    .join(' ');

  return (
    <button
      type={props.type ?? 'button'}
      class={classes}
      disabled={disabled}
      aria-busy={loading}
      aria-label={props.ariaLabel}
      data-variant={variant}
      data-testid={props.testId}
      onClick={props.onClick}
    >
      {loading ? <span class={SPINNER_CLASSES} aria-hidden="true" /> : null}
      <span>{text}</span>
    </button>
  );
}
