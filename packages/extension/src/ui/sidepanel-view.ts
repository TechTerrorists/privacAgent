import type { Route, SidePanelController, SidePanelState, Theme } from './controller.js';
import { createActionTraceList, createButton, createErrorState } from './kit.js';

const BUILD_TARGET = typeof __BROWSER__ === 'undefined' ? 'test' : __BROWSER__;

export interface SidePanelHandle {
  render(): void;
  dispose(): void;
}

function isTheme(value: string): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
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

function createTextElement(
  doc: Document,
  tag: string,
  className: string,
  text: string
): HTMLElement {
  const element = doc.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function findAction(event: Event): string | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('[data-action]')?.dataset.action ?? null;
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

function renderHeader(doc: Document, state: SidePanelState): HTMLElement {
  const header = doc.createElement('header');
  header.className = 'pa-header';

  const brand = doc.createElement('div');
  brand.className = 'pa-brand';
  const title = createTextElement(doc, 'h1', 'pa-title', 'privacAgent');
  const target = createTextElement(doc, 'span', 'pa-build-target', `Build target: ${BUILD_TARGET}`);
  brand.append(title, target);

  const navigation = doc.createElement('nav');
  navigation.setAttribute('aria-label', 'Panel navigation');
  if (state.route === 'settings') {
    navigation.append(
      createButton(doc, {
        label: 'Back',
        action: 'navigate-home',
        variant: 'ghost',
        testId: 'back-home',
      })
    );
  } else {
    navigation.append(
      createButton(doc, {
        label: 'Settings',
        action: 'open-settings',
        variant: 'ghost',
        testId: 'open-settings',
      })
    );
  }

  header.append(brand, navigation);
  return header;
}

function renderDemoNotice(doc: Document): HTMLElement {
  const notice = doc.createElement('p');
  notice.className = 'pa-demo-notice';
  notice.setAttribute('role', 'note');
  notice.dataset['testid'] = 'demo-banner';
  notice.textContent = 'Demo controller · synthetic local state · no network calls';
  return notice;
}

function renderHome(doc: Document, state: SidePanelState, draft: string): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'pa-view';

  section.append(createTextElement(doc, 'h2', 'pa-view__title', 'Ask for a task'));

  const status = createTextElement(doc, 'p', 'pa-status', statusText(state));
  status.dataset['testid'] = 'status';
  status.setAttribute('role', 'status');
  section.append(status);

  if (state.task) {
    const task = createTextElement(doc, 'p', 'pa-current-task', `Current task: ${state.task}`);
    task.dataset['testid'] = 'current-task';
    section.append(task);
  }

  const form = doc.createElement('form');
  form.className = 'pa-task-form';
  form.dataset['testid'] = 'task-form';
  const label = doc.createElement('label');
  label.className = 'pa-label';
  label.htmlFor = 'task-input';
  label.textContent = 'What should I do?';
  const input = doc.createElement('input');
  input.className = 'pa-input';
  input.id = 'task-input';
  input.name = 'task';
  input.type = 'text';
  input.placeholder = 'Find the order status on this page';
  input.autocomplete = 'off';
  input.value = draft;
  input.disabled = state.status === 'running';
  input.dataset['testid'] = 'task-input';
  const submit = createButton(doc, {
    label: 'Start task',
    action: 'submit-task',
    variant: 'primary',
    type: 'submit',
    disabled: state.status === 'running',
    testId: 'start-task',
  });
  form.append(label, input, submit);
  section.append(form);

  const controls = doc.createElement('div');
  controls.className = 'pa-controls';
  controls.append(
    createButton(doc, {
      label: 'Stop task',
      action: 'stop-task',
      variant: 'danger',
      disabled: state.status !== 'running',
      testId: 'stop-task',
    })
  );
  section.append(controls);

  if (state.error) section.append(createErrorState(doc, state.error));

  const traceHeading = createTextElement(doc, 'h3', 'pa-section-title', 'Action trace');
  section.append(traceHeading, createActionTraceList(doc, state.actions));

  return section;
}

function renderSettings(doc: Document, state: SidePanelState): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'pa-view';

  section.append(createTextElement(doc, 'h2', 'pa-view__title', 'Settings'));

  const description = createTextElement(
    doc,
    'p',
    'pa-settings-description',
    'Theme is stored locally in this browser. No account or server is involved.'
  );
  section.append(description);

  const field = doc.createElement('div');
  field.className = 'pa-field';
  const label = doc.createElement('label');
  label.className = 'pa-label';
  label.htmlFor = 'theme-select';
  label.textContent = 'Theme';
  const select = doc.createElement('select');
  select.className = 'pa-select';
  select.id = 'theme-select';
  select.dataset['setting'] = 'theme';
  select.dataset['testid'] = 'theme-select';
  for (const [value, labelText] of [
    ['system', 'System default'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ] as const) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = labelText;
    select.append(option);
  }
  select.value = state.theme;
  select.disabled = state.savingTheme;
  field.append(label, select);
  section.append(field);

  const saveStatus = createTextElement(
    doc,
    'p',
    'pa-settings-status',
    state.savingTheme ? 'Saving theme…' : 'Theme saved locally in this browser.'
  );
  saveStatus.dataset['testid'] = 'theme-status';
  section.append(saveStatus);

  if (state.error) section.append(createErrorState(doc, state.error));

  return section;
}

function renderView(doc: Document, state: SidePanelState, draft: string): HTMLElement {
  const shell = doc.createElement('div');
  shell.className = 'pa-shell';
  shell.append(renderHeader(doc, state));
  if (state.demo) shell.append(renderDemoNotice(doc));
  const main = doc.createElement('main');
  main.className = 'pa-main';
  main.append(
    state.route === 'settings' ? renderSettings(doc, state) : renderHome(doc, state, draft)
  );
  shell.append(main);
  return shell;
}

export function mountSidePanel(
  root: HTMLElement,
  controller: SidePanelController
): SidePanelHandle {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  let draft = '';
  let disposed = false;

  const render = (): void => {
    if (disposed) return;
    const state = controller.getState();
    root.dataset['theme'] = state.theme;
    root.style.colorScheme = state.theme === 'system' ? 'light dark' : state.theme;
    root.replaceChildren(renderView(doc, state, draft));
  };

  const onClick = (event: Event): void => {
    const action = findAction(event);
    if (action === null) return;
    if (action === 'open-settings') {
      controller.navigate('settings');
      setRouteInUrl(doc, 'settings');
    } else if (action === 'navigate-home') {
      controller.navigate('home');
      setRouteInUrl(doc, 'home');
    } else if (action === 'stop-task') {
      controller.stop();
    }
  };

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const input = form.querySelector<HTMLInputElement>('[data-testid="task-input"]');
    draft = input?.value ?? '';
    controller.submitTask(draft);
    draft = '';
  };

  const onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.dataset['setting'] !== 'theme') return;
    const value = target.value;
    if (isTheme(value)) void controller.setTheme(value);
  };

  const onInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.dataset['testid'] !== 'task-input') return;
    draft = target.value;
  };

  const onHashChange = (): void => {
    const route = routeFromHash(doc);
    if (route !== controller.getState().route) controller.navigate(route);
  };

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  view?.addEventListener('hashchange', onHashChange);
  const controllerUnsubscribe = controller.subscribe(render);

  const initialRoute = routeFromHash(doc);
  if (initialRoute !== controller.getState().route) controller.navigate(initialRoute);
  render();
  void controller.hydrate();

  return {
    render,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      controllerUnsubscribe();
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      root.removeEventListener('change', onChange);
      root.removeEventListener('input', onInput);
      view?.removeEventListener('hashchange', onHashChange);
      controller.dispose();
      root.replaceChildren();
    },
  };
}
