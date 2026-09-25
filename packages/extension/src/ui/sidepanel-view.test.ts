// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoController, type ThemeStore } from './controller.js';
import { mountSidePanel, type SidePanelHandle } from './sidepanel-view.js';

function createRoot(): HTMLElement {
  document.body.replaceChildren();
  window.location.hash = '';
  const root = document.createElement('main');
  root.id = 'root';
  document.body.append(root);
  return root;
}

function submitTask(root: HTMLElement, value: string): void {
  const input = root.querySelector<HTMLInputElement>('[data-testid="task-input"]');
  const form = root.querySelector<HTMLFormElement>('[data-testid="task-form"]');
  if (!input || !form) throw new Error('Task form was not rendered');
  input.value = value;
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('side-panel shell', () => {
  let handle: SidePanelHandle | undefined;

  afterEach(() => {
    handle?.dispose();
    handle = undefined;
    document.body.replaceChildren();
    window.location.hash = '';
  });

  it('renders the task input, action trace and demo notice', () => {
    const root = createRoot();
    handle = mountSidePanel(root, createDemoController());

    expect(root.querySelector('[data-testid="demo-banner"]')?.textContent).toContain(
      'no network calls'
    );
    expect(root.querySelector('[data-testid="status"]')?.textContent).toBe('Ready for a task');
    expect(root.querySelector('[data-testid="task-input"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="action-list"]')).toBeNull();
  });

  it('submits a task, renders the synthetic action list and stops it', () => {
    const root = createRoot();
    handle = mountSidePanel(root, createDemoController());

    submitTask(root, 'Find the order status');

    expect(root.querySelector('[data-testid="status"]')?.textContent).toBe('Task running');
    expect(root.querySelector('[data-testid="current-task"]')?.textContent).toContain(
      'Find the order status'
    );
    expect(root.querySelectorAll('[data-action-status]')).toHaveLength(4);

    const stop = root.querySelector<HTMLButtonElement>('[data-testid="stop-task"]');
    expect(stop?.disabled).toBe(false);
    stop?.click();

    expect(root.querySelector('[data-testid="status"]')?.textContent).toBe('Task stopped');
    expect(root.querySelector('[data-testid="stop-task"]')?.hasAttribute('disabled')).toBe(true);
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
    const select = root.querySelector<HTMLSelectElement>('[data-testid="theme-select"]');
    expect(select?.value).toBe('dark');
    expect(window.location.hash).toBe('#settings');

    if (!select) throw new Error('Theme select was not rendered');
    select.value = 'light';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(store.write).toHaveBeenCalledWith('light');
    expect(root.querySelector('[data-testid="theme-status"]')?.textContent).toContain(
      'saved locally'
    );
  });

  it('disposes listeners and does not duplicate submissions after reopen', () => {
    const root = createRoot();
    const first = mountSidePanel(root, createDemoController());
    first.dispose();

    const secondController = createDemoController();
    const submitSpy = vi.spyOn(secondController, 'submitTask');
    handle = mountSidePanel(root, secondController);

    submitTask(root, 'Only one submission');

    expect(submitSpy).toHaveBeenCalledOnce();
    expect(root.querySelectorAll('[data-action-status]')).toHaveLength(4);
  });

  it('reacts to the settings hash route and removes the hash listener on dispose', () => {
    const root = createRoot();
    const first = mountSidePanel(root, createDemoController());
    window.location.hash = '#settings';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(root.querySelector('[data-testid="theme-select"]')).not.toBeNull();
    first.dispose();
    window.location.hash = '';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(root.querySelector('[data-testid="theme-select"]')).toBeNull();
  });
});
