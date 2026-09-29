// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoController, type ThemeStore } from './controller.js';
import { mountSidePanel, type SidePanelHandle } from './sidepanel-view.js';

/**
 * Preact batches renders into a microtask, so an interaction is only visible in the DOM
 * after the queue drains. The controller stays synchronous; only rendering is deferred.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createRoot(): HTMLElement {
  document.body.replaceChildren();
  window.location.hash = '';
  const root = document.createElement('main');
  root.id = 'root';
  document.body.append(root);
  return root;
}

async function submitTask(root: HTMLElement, value: string): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('[data-testid="task-input"]');
  const form = root.querySelector<HTMLFormElement>('[data-testid="task-form"]');
  if (!input || !form) throw new Error('Task form was not rendered');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  // The controlled input only reaches the panel after a render, exactly as it would between
  // two real user interactions.
  await tick();
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await tick();
}

describe('side-panel shell', () => {
  let handle: SidePanelHandle | undefined;

  afterEach(() => {
    handle?.dispose();
    handle = undefined;
    document.body.replaceChildren();
    window.location.hash = '';
  });

  it('renders the task input, empty action trace and demo notice', () => {
    const root = createRoot();
    handle = mountSidePanel(root, createDemoController());

    expect(root.querySelector('[data-testid="demo-banner"]')?.textContent).toContain(
      'no network calls'
    );
    expect(root.querySelector('[data-testid="status"]')?.textContent).toBe('Ready for a task');
    expect(root.querySelector('[data-testid="task-input"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="action-list"]')).toBeNull();
    expect(root.querySelector('[data-testid="pa-trace-empty"]')?.textContent).toContain(
      'Start a task to see the local action trace.'
    );
  });

  it('submits a task, renders the kit action trace and stops it', async () => {
    const root = createRoot();
    handle = mountSidePanel(root, createDemoController());

    await submitTask(root, 'Find the order status');

    expect(root.querySelector('[data-testid="status"]')?.textContent).toBe('Task running');
    expect(root.querySelector('[data-testid="current-task"]')?.textContent).toContain(
      'Find the order status'
    );
    expect(root.querySelectorAll('[data-testid="pa-trace-item"]')).toHaveLength(4);
    expect(root.querySelector('[data-status="running"]')?.getAttribute('aria-current')).toBe(
      'step'
    );

    const stop = root.querySelector<HTMLButtonElement>('[data-testid="stop-task"]');
    expect(stop?.disabled).toBe(false);
    stop?.click();
    await tick();

    expect(root.querySelector('[data-testid="status"]')?.textContent).toBe('Task stopped');
    expect(root.querySelector('[data-testid="stop-task"]')?.hasAttribute('disabled')).toBe(true);
    expect(root.querySelectorAll('[data-status="stopped"]')).toHaveLength(1);
  });

  it('disables Stop and shows the pending state until a stop is acknowledged', async () => {
    const root = createRoot();
    // The run never acknowledges, which is exactly the window a user can press Stop twice in.
    const controller = createDemoController({
      acknowledgeStop: () => new Promise<void>(() => undefined),
    });
    handle = mountSidePanel(root, controller);

    await submitTask(root, 'Find the order status');
    const stop = root.querySelector<HTMLButtonElement>('[data-testid="stop-task"]');
    stop?.click();
    await tick();

    expect(root.querySelector('[data-testid="status"]')?.textContent).toBe('Stopping…');
    const pending = root.querySelector<HTMLButtonElement>('[data-testid="stop-task"]');
    expect(pending?.disabled).toBe(true);
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending?.textContent).toContain('Stopping');
    // The run is not over, so the task form stays locked.
    expect(root.querySelector<HTMLInputElement>('[data-testid="task-input"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-testid="start-task"]')?.disabled).toBe(
      true
    );
  });

  it('keeps the settings route real and persists the selected theme', async () => {
    const store: ThemeStore = {
      read: vi.fn().mockResolvedValue('dark'),
      write: vi.fn().mockResolvedValue(undefined),
    };
    const root = createRoot();
    const controller = createDemoController({ themeStore: store });
    handle = mountSidePanel(root, controller);
    await vi.waitFor(() => expect(controller.getState().theme).toBe('dark'));

    root.querySelector<HTMLButtonElement>('[data-testid="open-settings"]')?.click();
    await tick();
    expect(root.querySelector('[data-testid="theme-select"]')).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>('input[value="dark"]')?.checked).toBe(true);
    expect(window.location.hash).toBe('#settings');

    root.querySelector<HTMLInputElement>('input[value="light"]')?.click();
    await vi.waitFor(() => expect(store.write).toHaveBeenCalledWith('light'));
    await tick();

    expect(root.querySelector('[data-testid="theme-status"]')?.textContent).toContain(
      'saved locally'
    );
    expect(root.getAttribute('data-pa-theme')).toBe('light');
  });

  it('surfaces a kit error state and drops it once a task starts', async () => {
    const root = createRoot();
    handle = mountSidePanel(root, createDemoController());

    await submitTask(root, '   ');

    const alert = root.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Enter a task before starting.');
    expect(alert?.getAttribute('data-testid')).toBe('panel-error');

    await submitTask(root, 'A real task');
    expect(root.querySelector('[data-testid="panel-error"]')).toBeNull();
  });

  it('disposes listeners and does not duplicate submissions after reopen', async () => {
    const root = createRoot();
    const first = mountSidePanel(root, createDemoController());
    first.dispose();

    const secondController = createDemoController();
    const submitSpy = vi.spyOn(secondController, 'submitTask');
    handle = mountSidePanel(root, secondController);

    await submitTask(root, 'Only one submission');

    expect(submitSpy).toHaveBeenCalledOnce();
    expect(root.querySelectorAll('[data-testid="pa-trace-item"]')).toHaveLength(4);
  });

  it('keeps the injected controller alive across a remount and rehydrates it', async () => {
    const root = createRoot();
    const controller = createDemoController();
    const first = mountSidePanel(root, controller);
    first.dispose();

    await controller.submitTask('Survives a remount');
    handle = mountSidePanel(root, controller);
    await tick();

    expect(root.querySelector('[data-testid="status"]')?.textContent).toBe('Task running');
    expect(root.querySelector('[data-testid="current-task"]')?.textContent).toBe(
      'Current task: Survives a remount'
    );
    expect(root.querySelectorAll('[data-testid="pa-trace-item"]')).toHaveLength(4);
  });

  it('reacts to the settings hash route and removes the hash listener on dispose', async () => {
    const root = createRoot();
    const first = mountSidePanel(root, createDemoController());
    window.location.hash = '#settings';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await tick();

    expect(root.querySelector('[data-testid="theme-select"]')).not.toBeNull();
    first.dispose();
    window.location.hash = '';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(root.querySelector('[data-testid="theme-select"]')).toBeNull();
  });
});

describe('the cursor companion toggle', () => {
  // A handle local to this block: the outer `handle` belongs to another describe's scope, and a
  // second mounted panel would fight the first for the same root.
  let companionHandle: SidePanelHandle | undefined;

  afterEach(() => {
    companionHandle?.dispose();
    companionHandle = undefined;
  });

  /**
   * Mounts the panel on the settings route and hands the handle to this block's `afterEach`.
   *
   * The handle is deliberately *not* disposed here. Disposing unmounts the tree, so a test that
   * disposed in the helper and then queried the root for status text would find an empty document
   * and conclude the text was missing.
   */
  async function openSettings(initialEnabled = false): Promise<{
    root: HTMLElement;
    input: HTMLInputElement;
  }> {
    const root = createRoot();
    window.location.hash = '#settings';
    companionHandle?.dispose();
    companionHandle = mountSidePanel(
      root,
      createDemoController({ initialCompanionEnabled: initialEnabled })
    );
    await tick();
    const input = root.querySelector<HTMLInputElement>('[data-testid="companion-input"]');
    if (!input) throw new Error('Companion toggle was not rendered');
    return { root, input };
  }

  it('renders in settings, checked only when enabled', async () => {
    const off = await openSettings(false);
    expect(off.input.checked).toBe(false);

    const on = await openSettings(true);
    expect(on.input.checked).toBe(true);
  });

  it('is off by default', async () => {
    const { input } = await openSettings();
    expect(input.checked).toBe(false);
  });

  it('is a real checkbox inside a label, so it is focusable and keyboard-operable', async () => {
    const { input } = await openSettings();
    // A hand-rolled div with role="switch" would fail all three of these and would be a
    // regression in the one control the user relies on to make this feature go away.
    expect(input.tagName).toBe('INPUT');
    expect(input.type).toBe('checkbox');
    expect(input.closest('label')).not.toBeNull();
  });

  it('explains what it does, in the panel, without claiming to capture anything', async () => {
    const { root } = await openSettings(true);
    const status = root.querySelector('[data-testid="companion-status"]')?.textContent ?? '';
    expect(status).toContain('follows your cursor');
    expect(status).toContain('cannot be clicked');
  });

  it('says plainly that nothing is drawn when off', async () => {
    const { root } = await openSettings(false);
    const status = root.querySelector('[data-testid="companion-status"]')?.textContent ?? '';
    expect(status).toContain('off');
    expect(status).toContain('Nothing is drawn');
  });

  it('persists the choice through the controller', async () => {
    const root = createRoot();
    window.location.hash = '#settings';
    let written: boolean | undefined;
    companionHandle = mountSidePanel(
      root,
      createDemoController({
        companionStore: {
          read: async () => false,
          write: async (enabled) => {
            written = enabled;
          },
        },
      })
    );
    await tick();

    const input = root.querySelector<HTMLInputElement>('[data-testid="companion-input"]');
    input?.click();
    await tick();

    expect(written).toBe(true);
    expect(input?.checked).toBe(true);
  });
});
