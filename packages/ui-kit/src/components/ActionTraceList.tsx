import type { ComponentChildren, JSX } from 'preact';
import { EmptyState } from './EmptyState.js';

export type ActionTraceStatus = 'pending' | 'running' | 'done' | 'failed' | 'stopped';

export interface ActionTraceItem {
  readonly id: string;
  readonly label: string;
  readonly status: ActionTraceStatus;
  readonly detail?: string;
  readonly meta?: string;
}

export interface ActionTraceListProps {
  readonly items: readonly ActionTraceItem[];
  readonly ariaLabel?: string;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly onItemActivate?: (item: ActionTraceItem) => void;
  readonly renderItemAction?: (item: ActionTraceItem) => ComponentChildren;
  readonly class?: string;
  readonly testId?: string;
}

const STATUS_TEXT: Record<ActionTraceStatus, string> = {
  pending: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

const MARKER_CLASSES: Record<ActionTraceStatus, string> = {
  pending: 'bg-pa-muted',
  running: 'bg-pa-accent animate-pulse',
  done: 'bg-pa-success',
  failed: 'bg-pa-danger',
  stopped: 'bg-pa-warning',
};

const LABEL_CLASSES: Record<ActionTraceStatus, string> = {
  pending: 'text-pa-muted',
  running: 'text-pa-text font-semibold',
  done: 'text-pa-text',
  failed: 'text-pa-danger font-medium',
  stopped: 'text-pa-muted line-through',
};

export function ActionTraceList(props: ActionTraceListProps): JSX.Element {
  const classes = ['flex flex-col gap-1.5', props.class ?? '']
    .filter((value) => value.length > 0)
    .join(' ');

  if (props.items.length === 0) {
    return (
      <EmptyState
        title={props.emptyTitle ?? 'No actions yet'}
        description={props.emptyDescription ?? 'Submitted work will appear here as it runs.'}
        testId="pa-trace-empty"
      />
    );
  }

  return (
    <ol class={classes} aria-label={props.ariaLabel ?? 'Action trace'} data-testid={props.testId}>
      {props.items.map((item) => {
        const statusText = STATUS_TEXT[item.status];
        const interactive = props.onItemActivate !== undefined;

        return (
          <li
            key={item.id}
            class="flex items-start gap-2 rounded-pa border border-pa-border bg-pa-surface px-3 py-2"
            data-status={item.status}
            data-testid="pa-trace-item"
            aria-current={item.status === 'running' ? 'step' : undefined}
          >
            <span
              class={['mt-1.5 size-2 shrink-0 rounded-full', MARKER_CLASSES[item.status]].join(' ')}
              aria-hidden="true"
            />
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              {interactive ? (
                <button
                  type="button"
                  class={[
                    'text-left text-sm underline decoration-dotted underline-offset-2',
                    'hover:text-pa-accent',
                    LABEL_CLASSES[item.status],
                  ].join(' ')}
                  onClick={() => props.onItemActivate?.(item)}
                  data-testid="pa-trace-activate"
                >
                  {item.label}
                </button>
              ) : (
                <span class={['text-sm', LABEL_CLASSES[item.status]].join(' ')}>{item.label}</span>
              )}
              {item.detail ? <span class="text-xs text-pa-muted">{item.detail}</span> : null}
            </div>
            <div class="flex shrink-0 flex-col items-end gap-1">
              <span class="text-xs text-pa-muted" data-testid="pa-trace-status">
                {statusText}
              </span>
              {item.meta ? <span class="text-xs text-pa-muted">{item.meta}</span> : null}
            </div>
            {props.renderItemAction ? props.renderItemAction(item) : null}
            <span class="sr-only">
              {item.label}: {statusText}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
