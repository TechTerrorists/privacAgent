import type { ActionEntry } from './controller.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonOptions {
  readonly label: string;
  readonly action: string;
  readonly variant?: ButtonVariant;
  readonly type?: 'button' | 'submit';
  readonly disabled?: boolean;
  readonly testId?: string;
}

function setData(element: HTMLElement, key: string, value: string): void {
  element.dataset[key] = value;
}

export function createButton(doc: Document, options: ButtonOptions): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = options.type ?? 'button';
  button.className = `pa-button pa-button--${options.variant ?? 'secondary'}`;
  button.textContent = options.label;
  button.disabled = options.disabled ?? false;
  setData(button, 'action', options.action);
  if (options.testId !== undefined) setData(button, 'testid', options.testId);
  return button;
}

export function createEmptyState(
  doc: Document,
  title: string,
  description: string
): HTMLDivElement {
  const state = doc.createElement('div');
  state.className = 'pa-state pa-state--empty';
  const heading = doc.createElement('h3');
  heading.textContent = title;
  const detail = doc.createElement('p');
  detail.textContent = description;
  state.append(heading, detail);
  return state;
}

export function createErrorState(doc: Document, message: string): HTMLDivElement {
  const state = doc.createElement('div');
  state.className = 'pa-state pa-state--error';
  state.setAttribute('role', 'alert');
  const heading = doc.createElement('h3');
  heading.textContent = 'Something needs attention';
  const detail = doc.createElement('p');
  detail.textContent = message;
  state.append(heading, detail);
  return state;
}

const STATUS_LABELS: Record<ActionEntry['status'], string> = {
  pending: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

export function createActionTraceList(doc: Document, actions: readonly ActionEntry[]): HTMLElement {
  if (actions.length === 0) {
    return createEmptyState(doc, 'No actions yet', 'Start a task to see the local action trace.');
  }

  const list = doc.createElement('ol');
  list.className = 'pa-action-list';
  setData(list, 'testid', 'action-list');

  for (const action of actions) {
    const item = doc.createElement('li');
    item.className = `pa-action pa-action--${action.status}`;
    setData(item, 'actionStatus', action.status);

    const marker = doc.createElement('span');
    marker.className = 'pa-action__marker';
    marker.setAttribute('aria-hidden', 'true');

    const label = doc.createElement('span');
    label.className = 'pa-action__label';
    label.textContent = action.label;

    const status = doc.createElement('span');
    status.className = 'pa-action__status';
    status.textContent = STATUS_LABELS[action.status];

    item.append(marker, label, status);
    list.append(item);
  }

  return list;
}
