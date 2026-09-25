import { describe, expect, it, vi } from 'vitest';
import {
  createDemoController,
  createMemoryThemeStore,
  type SidePanelController,
  type ThemeStore,
} from './controller.js';

describe('demo side-panel controller', () => {
  it('starts idle and publishes state changes to subscribers', () => {
    const controller = createDemoController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    expect(controller.getState().status).toBe('idle');
    controller.submitTask('Find the order status');

    expect(controller.getState()).toMatchObject({
      task: 'Find the order status',
      status: 'running',
      error: null,
    });
    expect(controller.getState().actions).toHaveLength(4);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    controller.stop();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('rejects an empty task without starting a run', () => {
    const controller = createDemoController();

    controller.submitTask('   ');

    expect(controller.getState().status).toBe('idle');
    expect(controller.getState().error).toBe('Enter a task before starting.');
    expect(controller.getState().actions).toHaveLength(0);
  });

  it('stops a running task and marks the active action stopped', () => {
    const controller = createDemoController();
    controller.submitTask('Summarize the page');

    controller.stop();

    expect(controller.getState().status).toBe('stopped');
    expect(controller.getState().actions.find((action) => action.id === 'confirm')?.status).toBe(
      'stopped'
    );
  });

  it('hydrates and persists the real theme setting', async () => {
    const store: ThemeStore = {
      read: vi.fn().mockResolvedValue('dark'),
      write: vi.fn().mockResolvedValue(undefined),
    };
    const controller = createDemoController({ themeStore: store });

    await controller.hydrate();
    expect(controller.getState().theme).toBe('dark');

    await controller.setTheme('light');
    expect(store.write).toHaveBeenCalledWith('light');
    expect(controller.getState().theme).toBe('light');
    expect(controller.getState().savingTheme).toBe(false);
  });

  it('does not apply a late hydrate result after a local theme write', async () => {
    let resolveRead: ((theme: 'dark') => void) | undefined;
    const store: ThemeStore = {
      read: vi.fn(
        () =>
          new Promise<'dark'>((resolve) => {
            resolveRead = resolve;
          })
      ),
      write: vi.fn().mockResolvedValue(undefined),
    };
    const controller = createDemoController({ themeStore: store });
    const hydrating = controller.hydrate();

    await controller.setTheme('light');
    resolveRead?.('dark');
    await hydrating;

    expect(controller.getState().theme).toBe('light');
  });

  it('disposes subscriptions and ignores later mutations', () => {
    const controller: SidePanelController = createDemoController();
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.dispose();
    controller.submitTask('Should not start');

    expect(listener).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe('idle');
  });

  it('uses an in-memory store that round-trips themes', async () => {
    const store = createMemoryThemeStore('light');
    expect(await store.read()).toBe('light');
    await store.write('dark');
    expect(await store.read()).toBe('dark');
  });
});
