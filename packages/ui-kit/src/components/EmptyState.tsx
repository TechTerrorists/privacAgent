import type { ComponentChildren, JSX } from 'preact';

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: string;
  readonly icon?: ComponentChildren;
  readonly children?: ComponentChildren;
  readonly class?: string;
  readonly testId?: string;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  const classes = [
    'flex flex-col items-center gap-2 rounded-pa border border-dashed border-pa-border',
    'bg-pa-surface px-4 py-6 text-center',
    props.class ?? '',
  ]
    .filter((value) => value.length > 0)
    .join(' ');

  return (
    <div class={classes} role="status" data-testid={props.testId}>
      {props.icon ? (
        <span class="text-pa-muted" aria-hidden="true">
          {props.icon}
        </span>
      ) : null}
      <p class="text-sm font-medium text-pa-text">{props.title}</p>
      {props.description ? <p class="text-xs text-pa-muted">{props.description}</p> : null}
      {props.children}
    </div>
  );
}
