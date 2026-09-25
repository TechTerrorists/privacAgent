import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
  ActionTraceList,
  applyTheme,
  Button,
  ErrorState,
  ThemeToggle,
  type ThemeName,
} from '@privacagent/ui-kit';
import type { Route, SidePanelController, SidePanelState, Theme } from './controller.js';

const BUILD_TARGET = typeof __BROWSER__ === 'undefined' ? 'test' : __BROWSER__;

export interface SidePanelHandle {
  /** Re-render from the controller's current state. */
  render(): void;
  /**
   * Detach this view: unmount the tree, drop the controller subscription, and stop
   * listening for hash routes.
   *
   * The controller is injected, so the view does not own it and never disposes it. The
   * owner that created the controller decides its lifetime, which is what lets a future
   * session controller outlive a closed panel and hand the reopened panel a fresh snapshot.
   */
  dispose(): void;
}

function routeFromHash(doc: Document): Route {
  return doc.defaultView?.location.hash === '#settings' ? 'settings' : 'home';
}

function setRouteInUrl(doc: Document, route: Route): void {
  const view = doc.defaultView;
  if (!view) return;
  const nextHash = route === 'settings' ? '#settings' : '';
  if (view.location.hash === nextHash) return;
  try {
    const url = nextHash || `${view.location.pathname}${view.location.search}`;
    view.history.replaceState(null, '', url);
  } catch {
    view.location.hash = nextHash;
  }
}

function statusText(state: SidePanelState): string {
  switch (state.status) {
    case 'running':
      return 'Task running';
    case 'stopped':
      return 'Task stopped';
    case 'complete':
      return 'Task complete';
    case 'idle':
      return 'Ready for a task';
  }
}

function Header(props: {
  readonly state: SidePanelState;
  readonly onNavigate: (route: Route) => void;
}): JSX.Element {
  const { state, onNavigate } = props;
  return (
    <header class="flex items-start justify-between gap-2 border-b border-pa-border bg-pa-surface px-3 py-2">
      <div class="flex flex-col gap-0.5">
        <h1 class="text-sm font-semibold text-pa-text">privacAgent</h1>
        <span class="pa-build-target text-xs text-pa-muted">Build target: {BUILD_TARGET}</span>
      </div>
      <nav aria-label="Panel navigation">
        {state.route === 'settings' ? (
          <Button
            label="Back"
            variant="ghost"
            class="w-auto px-2 py-1"
            testId="back-home"
            onClick={() => onNavigate('home')}
          />
        ) : (
          <Button
            label="Settings"
            variant="ghost"
            class="w-auto px-2 py-1"
            testId="open-settings"
            onClick={() => onNavigate('settings')}
          />
        )}
      </nav>
    </header>
  );
}

function Home(props: {
  readonly state: SidePanelState;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
}): JSX.Element {
  const { state, draft, onDraftChange, onSubmit, onStop } = props;
  const running = state.status === 'running';

  return (
    <section class="flex flex-col gap-3 p-3">
      <h2 class="text-sm font-semibold text-pa-text">Ask for a task</h2>

      <p class="text-xs text-pa-muted" role="status" data-testid="status">
        {statusText(state)}
      </p>

      {state.task ? (
        <p class="text-xs text-pa-muted" data-testid="current-task">
          Current task: {state.task}
        </p>
      ) : null}

      <form
        class="flex flex-col gap-2"
        data-testid="task-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label class="text-xs font-medium text-pa-text" htmlFor="task-input">
          What should I do?
        </label>
        <input
          class="min-h-9 w-full rounded-pa border border-pa-border bg-pa-surface px-3 py-2 text-sm text-pa-text placeholder:text-pa-muted disabled:cursor-not-allowed disabled:opacity-60"
          id="task-input"
          name="task"
          type="text"
          placeholder="Find the order status on this page"
          autocomplete="off"
          value={draft}
          disabled={running}
          data-testid="task-input"
          onInput={(event) => onDraftChange(event.currentTarget.value)}
        />
        <Button
          label="Start task"
          variant="primary"
          type="submit"
          disabled={running}
          testId="start-task"
        />
      </form>

      <Button
        label="Stop task"
        variant="danger"
        disabled={!running}
        testId="stop-task"
        onClick={onStop}
      />

      {state.error ? (
        <ErrorState title="Something needs attention" message={state.error} testId="panel-error" />
      ) : null}

      <h3 class="text-xs font-semibold uppercase tracking-wide text-pa-muted">Action trace</h3>
      <ActionTraceList
        items={state.actions}
        ariaLabel="Action trace"
        emptyDescription="Start a task to see the local action trace."
        testId="action-list"
      />
    </section>
  );
}

function Settings(props: {
  readonly state: SidePanelState;
  readonly onThemeChange: (theme: Theme) => void;
}): JSX.Element {
  const { state, onThemeChange } = props;
  return (
    <section class="flex flex-col gap-3 p-3">
      <h2 class="text-sm font-semibold text-pa-text">Settings</h2>
      <p class="text-xs text-pa-muted">
        Theme is stored locally in this browser. No account or server is involved.
      </p>

      <ThemeToggle
        value={state.theme as ThemeName}
        onChange={(theme) => onThemeChange(theme as Theme)}
        testId="theme-select"
      />

      <p class="text-xs text-pa-muted" data-testid="theme-status">
        {state.savingTheme ? 'Saving theme…' : 'Theme saved locally in this browser.'}
      </p>

      {state.error ? (
        <ErrorState title="Something needs attention" message={state.error} testId="panel-error" />
      ) : null}
    </section>
  );
}

function Panel(props: {
  readonly controller: SidePanelController;
  readonly root: HTMLElement;
  readonly onNavigate: (route: Route) => void;
  readonly revision: number;
}): JSX.Element {
  const { controller, root, onNavigate, revision } = props;
  const [state, setState] = useState<SidePanelState>(() => controller.getState());
  const [draft, setDraft] = useState('');

  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);
  useEffect(() => setState(controller.getState()), [controller, revision]);
  useEffect(() => applyTheme(root, state.theme), [root, state.theme]);

  return (
    <div class="flex min-h-full w-full flex-col bg-pa-canvas font-pa text-pa-text">
      <Header state={state} onNavigate={onNavigate} />
      {state.demo ? (
        <p
          class="border-b border-pa-border bg-pa-elevated px-3 py-1.5 text-xs text-pa-muted"
          role="note"
          data-testid="demo-banner"
        >
          Demo controller · synthetic local state · no network calls
        </p>
      ) : null}
      <main class="flex-1">
        {state.route === 'settings' ? (
          <Settings
            state={state}
            onThemeChange={(theme) => {
              void controller.setTheme(theme);
            }}
          />
        ) : (
          <Home
            state={state}
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={() => {
              controller.submitTask(draft);
              setDraft('');
            }}
            onStop={() => controller.stop()}
          />
        )}
      </main>
    </div>
  );
}

export function mountSidePanel(
  root: HTMLElement,
  controller: SidePanelController
): SidePanelHandle {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  let revision = 0;
  let disposed = false;

  const onNavigate = (route: Route): void => {
    controller.navigate(route);
    setRouteInUrl(doc, route);
  };

  const onHashChange = (): void => {
    const route = routeFromHash(doc);
    if (route !== controller.getState().route) onNavigate(route);
  };

  const draw = (): void => {
    if (disposed) return;
    revision += 1;
    render(
      <Panel controller={controller} root={root} onNavigate={onNavigate} revision={revision} />,
      root
    );
  };

  view?.addEventListener('hashchange', onHashChange);
  const initialRoute = routeFromHash(doc);
  if (initialRoute !== controller.getState().route) controller.navigate(initialRoute);
  draw();
  void controller.hydrate();

  return {
    render: draw,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      view?.removeEventListener('hashchange', onHashChange);
      render(null, root);
    },
  };
}
