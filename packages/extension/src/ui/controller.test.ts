import { describe, expect, it, vi } from 'vitest';
import {
  createDemoController,
  createMemoryCompanionStore,
  createMemoryThemeStore,
  type SidePanelController,
  type CompanionStore,
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

  it('reports a pending stop before the run acknowledges it', async () => {
    let acknowledge: (() => void) | undefined;
    const controller = createDemoController({
      acknowledgeStop: () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    });
    controller.submitTask('Summarize the page');

    controller.stop();

    // The request is in flight and nothing has been cancelled yet.
    expect(controller.getState().status).toBe('stopping');
    expect(controller.getState().actions.find((action) => action.id === 'confirm')?.status).toBe(
      'running'
    );

    acknowledge?.();
    await vi.waitFor(() => expect(controller.getState().status).toBe('stopped'));
    expect(controller.getState().actions.find((action) => action.id === 'confirm')?.status).toBe(
      'stopped'
    );
  });

  it('ignores a repeated stop while the first is still pending', async () => {
    const acknowledgeStop = vi.fn().mockResolvedValue(undefined);
    const controller = createDemoController({ acknowledgeStop });
    controller.submitTask('Summarize the page');

    controller.stop();
    controller.stop();
    controller.stop();

    expect(controller.getState().status).toBe('stopping');
    expect(acknowledgeStop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(controller.getState().status).toBe('stopped'));
    expect(acknowledgeStop).toHaveBeenCalledOnce();
  });

  it('does not start a new task while a stop is still pending', async () => {
    const controller = createDemoController({
      acknowledgeStop: () => new Promise<void>(() => undefined),
    });
    controller.submitTask('Summarize the page');
    controller.stop();

    controller.submitTask('Something else entirely');

    expect(controller.getState().status).toBe('stopping');
    expect(controller.getState().task).toBe('Summarize the page');
  });

  it('reports a stop the run never acknowledged instead of claiming it stopped', async () => {
    const controller = createDemoController({
      acknowledgeStop: () => Promise.reject(new Error('no acknowledgement')),
    });
    controller.submitTask('Summarize the page');

    controller.stop();

    // Nothing confirmed the cancellation, so the panel must not report one.
    await vi.waitFor(() => expect(controller.getState().status).toBe('running'));
    expect(controller.getState().error).toBe(
      'Stop was not confirmed. The task may still be running.'
    );
  });

  it('stops a running task and marks the active action stopped', async () => {
    const controller = createDemoController();
    controller.submitTask('Summarize the page');

    controller.stop();
    await vi.waitFor(() => expect(controller.getState().status).toBe('stopped'));

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

describe('the companion preference in the side panel', () => {
  it('starts off, and does not write anything until asked', () => {
    const store = createMemoryCompanionStore();
    const write = vi.spyOn(store, 'write');
    const controller = createDemoController({ companionStore: store });

    expect(controller.getState().companionEnabled).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('persists the value the user chose', async () => {
    const store = createMemoryCompanionStore();
    const controller = createDemoController({ companionStore: store });

    await controller.setCompanionEnabled(true);

    expect(controller.getState().companionEnabled).toBe(true);
    expect(await store.read()).toBe(true);
  });

  it('applies to the panel immediately, before the write resolves', async () => {
    // The companion's state comes from storage, so the panel must not wait on the write to show
    // the user's choice — and because the content script hears about the change from storage too,
    // there is nothing to roll back if the write later fails.
    let release: (() => void) | undefined;
    const store: CompanionStore = {
      read: async () => false,
      write: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    const controller = createDemoController({ companionStore: store });

    const pending = controller.setCompanionEnabled(true);
    expect(controller.getState().companionEnabled).toBe(true);

    release?.();
    await pending;
  });

  it('reports a failed write without flipping the value back', async () => {
    const store: CompanionStore = {
      read: async () => false,
      write: async () => {
        throw new Error('quota exceeded');
      },
    };
    const controller = createDemoController({ companionStore: store });

    await controller.setCompanionEnabled(true);

    // The panel keeps showing what the user asked for and surfaces the failure, rather than
    // silently reverting a control they deliberately operated.
    expect(controller.getState().companionEnabled).toBe(true);
    expect(controller.getState().error).toContain('Companion');
  });

  it('restores the stored value on hydrate', async () => {
    const controller = createDemoController({
      companionStore: createMemoryCompanionStore(true),
    });

    await controller.hydrate();

    expect(controller.getState().companionEnabled).toBe(true);
  });

  it('does not let a late hydrate overwrite a choice the user just made', async () => {
    // The panel is created and the user can reach the toggle before storage has answered, so the
    // read has to lose to a deliberate write.
    let releaseRead: (() => void) | undefined;
    const store: CompanionStore = {
      read: () =>
        new Promise<boolean>((resolve) => {
          releaseRead = () => resolve(false);
        }),
      write: async () => undefined,
    };
    const controller = createDemoController({ companionStore: store });

    const hydrating = controller.hydrate();
    await controller.setCompanionEnabled(true);
    releaseRead?.();
    await hydrating;

    expect(controller.getState().companionEnabled).toBe(true);
  });

  it('ignores a non-boolean', async () => {
    const store = createMemoryCompanionStore();
    const write = vi.spyOn(store, 'write');
    const controller = createDemoController({ companionStore: store });

    await controller.setCompanionEnabled('yes' as unknown as boolean);

    expect(write).not.toHaveBeenCalled();
  });

  it('applies an explicit initial value', () => {
    const controller = createDemoController({ initialCompanionEnabled: true });
    expect(controller.getState().companionEnabled).toBe(true);
  });
});
