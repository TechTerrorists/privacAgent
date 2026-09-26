import type { JSX } from 'preact';
import { Button } from './Button.js';

export interface ErrorStateProps {
  readonly message: string;
  readonly title?: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  readonly class?: string;
  readonly testId?: string;
}

export function ErrorState(props: ErrorStateProps): JSX.Element {
  const classes = [
    'flex flex-col gap-3 rounded-pa border border-pa-danger bg-pa-surface px-4 py-3',
    props.class ?? '',
  ]
    .filter((value) => value.length > 0)
    .join(' ');

  const hasActions = Boolean(props.onRetry) || Boolean(props.onDismiss);

  return (
    <div class={classes} role="alert" data-testid={props.testId}>
      <div class="flex flex-col gap-1">
        <p class="text-sm font-semibold text-pa-danger">{props.title ?? 'Something went wrong'}</p>
        <p class="text-xs leading-relaxed text-pa-text">{props.message}</p>
      </div>
      {hasActions ? (
        <div class="flex flex-wrap gap-2">
          {props.onRetry ? (
            <Button
              label={props.retryLabel ?? 'Try again'}
              variant="secondary"
              onClick={props.onRetry}
              testId="pa-error-retry"
              class="w-auto"
            />
          ) : null}
          {props.onDismiss ? (
            <Button
              label={props.dismissLabel ?? 'Dismiss'}
              variant="ghost"
              onClick={props.onDismiss}
              testId="pa-error-dismiss"
              class="w-auto"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
