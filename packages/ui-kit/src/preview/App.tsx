import { useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import {
  ActionTraceList,
  type ActionTraceItem,
  applyTheme,
  Button,
  EmptyState,
  ErrorState,
  readTheme,
  ThemeToggle,
  type ThemeName,
} from '../index.js';

const TRACE_ITEMS: readonly ActionTraceItem[] = [
  { id: 'a1', label: 'Open dashboard', status: 'done', detail: 'element #12', meta: '120ms' },
  { id: 'a2', label: 'Read active form fields', status: 'done', detail: '3 fields', meta: '48ms' },
  { id: 'a3', label: 'Summarise page context', status: 'running', detail: 'streaming…' },
  { id: 'a4', label: 'Draft reply', status: 'pending' },
  { id: 'a5', label: 'Send confirmation email', status: 'stopped', detail: 'cancelled by user' },
  { id: 'a6', label: 'Export page snapshot', status: 'failed', detail: 'permission denied' },
];

function Section(props: {
  readonly title: string;
  readonly description: string;
  readonly children: ComponentChildren;
}): JSX.Element {
  return (
    <section class="flex flex-col gap-3 rounded-pa border border-pa-border bg-pa-surface p-4">
      <header class="flex flex-col gap-1">
        <h2 class="text-sm font-semibold text-pa-text">{props.title}</h2>
        <p class="text-xs text-pa-muted">{props.description}</p>
      </header>
      {props.children}
    </section>
  );
}

function Frame(props: {
  readonly label: string;
  readonly width?: string;
  readonly children: ComponentChildren;
}): JSX.Element {
  return (
    <div class="flex flex-col gap-2">
      <p class="text-xs font-medium text-pa-muted">{props.label}</p>
      <div
        class={[
          'flex max-w-full flex-col gap-3 rounded-pa border border-pa-border bg-pa-canvas p-3',
          props.width ?? 'w-full',
        ].join(' ')}
      >
        {props.children}
      </div>
    </div>
  );
}

export function App(): JSX.Element {
  const [theme, setTheme] = useState<ThemeName>(readTheme(document.documentElement));
  const [clicks, setClicks] = useState(0);
  const [loading, setLoading] = useState(false);
  const [lastAction, setLastAction] = useState('none');
  const [showError, setShowError] = useState(true);
  const [items, setItems] = useState<readonly ActionTraceItem[]>(TRACE_ITEMS);

  const onThemeChange = (next: ThemeName): void => {
    setTheme(next);
    applyTheme(document.documentElement, next);
  };

  return (
    <div class="mx-auto flex max-w-3xl flex-col gap-4 p-4 font-pa sm:p-6">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h1 class="text-base font-semibold text-pa-text">privacAgent UI kit</h1>
          <p class="text-xs text-pa-muted">
            F-01 preview: every component and state, deterministic and offline.
          </p>
        </div>
        <ThemeToggle value={theme} onChange={onThemeChange} class="w-48" />
      </header>

      <div class="flex flex-col gap-4">
        <Section title="Button" description="Variants, disabled, loading, keyboard focus, events.">
          <Frame label="Default width">
            <Button label="Primary" variant="primary" onClick={() => setClicks((n) => n + 1)} />
            <Button label="Secondary" variant="secondary" onClick={() => setClicks((n) => n + 1)} />
            <Button label="Ghost" variant="ghost" onClick={() => setClicks((n) => n + 1)} />
            <Button label="Danger" variant="danger" onClick={() => setClicks((n) => n + 1)} />
            <Button label="Disabled" variant="primary" disabled />
            <Button
              label="Run agent"
              variant="primary"
              loading={loading}
              loadingLabel="Running…"
              onClick={() => setClicks((n) => n + 1)}
            />
            <Button
              label={loading ? 'Running…' : 'Toggle loading'}
              variant="ghost"
              onClick={() => setLoading((value) => !value)}
            />
            <p class="text-xs text-pa-muted" data-testid="preview-click-count">
              onClick fired {clicks} time{clicks === 1 ? '' : 's'}
            </p>
          </Frame>
        </Section>

        <Section title="ActionTraceList" description="Static, interactive, and empty renderings.">
          <Frame label="All statuses">
            <ActionTraceList items={items} ariaLabel="Recent agent actions" />
            <Button
              label="Reset trace"
              variant="ghost"
              onClick={() => setItems(TRACE_ITEMS)}
              testId="preview-reset-trace"
            />
          </Frame>
          <Frame label="Interactive (onItemActivate)">
            <ActionTraceList
              items={items.slice(0, 3)}
              onItemActivate={(item) => setLastAction(item.label)}
              renderItemAction={(item) => (
                <span class="shrink-0 text-xs text-pa-muted">{item.id.toUpperCase()}</span>
              )}
            />
            <p class="text-xs text-pa-muted">Activated: {lastAction}</p>
          </Frame>
          <Frame label="Empty">
            <ActionTraceList items={[]} />
            <Button
              label="Clear trace"
              variant="ghost"
              onClick={() => setItems([])}
              testId="preview-clear-trace"
            />
          </Frame>
        </Section>

        <Section title="EmptyState" description="Neutral placeholder with optional action.">
          <Frame label="With description and action">
            <EmptyState
              title="No saved tasks"
              description="Tasks you run from this panel will be listed here."
              icon="◎"
            >
              <Button label="New task" variant="secondary" class="w-auto" />
            </EmptyState>
          </Frame>
        </Section>

        <Section title="ErrorState" description="Announced via role=alert with retry and dismiss.">
          <Frame label="Error">
            {showError ? (
              <ErrorState
                title="Agent request failed"
                message="The local agent did not respond within 30s. Check that it is running, then try again."
                onRetry={() => setShowError(false)}
                onDismiss={() => setShowError(false)}
              />
            ) : (
              <EmptyState title="Recovered" description="Retry and dismiss both clear the error." />
            )}
            <Button
              label={showError ? 'Hide error' : 'Show error'}
              variant="ghost"
              onClick={() => setShowError((value) => !value)}
              testId="preview-toggle-error"
            />
          </Frame>
        </Section>

        <Section title="Narrow panel" description="Layout at 320px and 360px panel widths.">
          <Frame label="320px" width="w-80 max-w-full">
            <Button label="Summarise page" variant="primary" />
            <ActionTraceList items={items.slice(0, 2)} />
          </Frame>
          <Frame label="360px" width="w-96 max-w-full">
            <Button label="Summarise page" variant="primary" />
            <ActionTraceList items={items.slice(0, 2)} />
          </Frame>
        </Section>
      </div>
    </div>
  );
}
