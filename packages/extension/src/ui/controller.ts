import { COMPANION_ENABLED_DEFAULT } from '../preferences.js';

export type Theme = 'system' | 'light' | 'dark';
export type Route = 'home' | 'settings';
/**
 * `stopping` is a request, not a fact: it is set the moment a stop is asked for and only left
 * once the run acknowledges the cancellation. Without it the panel has to either call a stop
 * that has not happened "stopped", or leave Stop enabled and accept a second request it cannot
 * honour.
 */
export type RunStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'complete';
export type ActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'stopped';

export interface ActionEntry {
  readonly id: string;
  readonly label: string;
  readonly status: ActionStatus;
}

export interface SidePanelState {
  readonly route: Route;
  readonly theme: Theme;
  readonly task: string;
  readonly status: RunStatus;
  readonly actions: readonly ActionEntry[];
  readonly error: string | null;
  readonly savingTheme: boolean;
  /**
   * F-08: whether the cursor companion is on. The panel is the only place this is set — the
   * companion itself is inert and has no controls — and the value is read by the content script
   * in every open tab, so this flag is the single source of truth for all of them.
   */
  readonly companionEnabled: boolean;
  readonly demo: boolean;
}

export type Unsubscribe = () => void;

export interface SidePanelController {
  getState(): SidePanelState;
  subscribe(listener: () => void): Unsubscribe;
  submitTask(text: string): void;
  stop(): void;
  navigate(route: Route): void;
  setTheme(theme: Theme): Promise<void>;
  /** F-08: turns the companion on or off. Persisted, and applied in every open tab at once. */
  setCompanionEnabled(enabled: boolean): Promise<void>;
  hydrate(): Promise<void>;
  dispose(): void;
}

export interface ThemeStore {
  read(): Promise<Theme>;
  write(theme: Theme): Promise<void>;
}

/**
 * F-08's store. Separate from `ThemeStore` rather than folded into a `Preferences` object because
 * they have different failure semantics: a failed theme read falls back to `system`, which is a
 * cosmetic guess, whereas a failed companion read leaves the companion *off* — a character the
 * user never asked for is one they cannot account for or get rid of. Both stores reject rather
 * than guess, and this class is where the fallback to the default actually happens.
 */
export interface CompanionStore {
  read(): Promise<boolean>;
  write(enabled: boolean): Promise<void>;
}

export interface DemoControllerOptions {
  readonly themeStore?: ThemeStore;
  readonly initialTheme?: Theme;
  /** F-08. Injected alongside the theme store so both preferences persist the same way. */
  readonly companionStore?: CompanionStore;
  readonly initialCompanionEnabled?: boolean;
  /**
   * Resolves once the run acknowledges a stop request. Injected rather than faked inline so the
   * demo still models the real handshake, and so a test can hold a run in `stopping` for as long
   * as it needs instead of racing a timer.
   */
  readonly acknowledgeStop?: () => Promise<void>;
}

const INITIAL_ACTIONS: readonly ActionEntry[] = [];

const DEFAULT_THEME: Theme = 'system';

const STOP_UNCONFIRMED = 'Stop was not confirmed. The task may still be running.';

function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

function cloneActions(actions: readonly ActionEntry[]): readonly ActionEntry[] {
  return actions.map((action) => ({ ...action }));
}

export function createMemoryThemeStore(initialTheme: Theme = DEFAULT_THEME): ThemeStore {
  let theme = isTheme(initialTheme) ? initialTheme : DEFAULT_THEME;
  return {
    async read(): Promise<Theme> {
      return theme;
    },
    async write(nextTheme: Theme): Promise<void> {
      theme = nextTheme;
    },
  };
}

export function createMemoryCompanionStore(
  initial: boolean = COMPANION_ENABLED_DEFAULT
): CompanionStore {
  let enabled = initial;
  return {
    async read(): Promise<boolean> {
      return enabled;
    },
    async write(next: boolean): Promise<void> {
      enabled = next;
    },
  };
}

class DemoSidePanelController implements SidePanelController {
  private state: SidePanelState = {
    route: 'home',
    theme: DEFAULT_THEME,
    task: '',
    status: 'idle',
    actions: INITIAL_ACTIONS,
    error: null,
    savingTheme: false,
    companionEnabled: COMPANION_ENABLED_DEFAULT,
    demo: true,
  };

  private readonly listeners = new Set<() => void>();
  private readonly themeStore: ThemeStore;
  private readonly companionStore: CompanionStore;
  private readonly acknowledgeStop: () => Promise<void>;
  private disposed = false;
  private themeWriteStarted = false;
  private companionWriteStarted = false;

  constructor(options: DemoControllerOptions = {}) {
    this.themeStore = options.themeStore ?? createMemoryThemeStore(options.initialTheme);
    this.companionStore =
      options.companionStore ?? createMemoryCompanionStore(options.initialCompanionEnabled);
    this.acknowledgeStop = options.acknowledgeStop ?? (() => Promise.resolve());
    if (options.initialTheme !== undefined && isTheme(options.initialTheme)) {
      this.state = { ...this.state, theme: options.initialTheme };
    }
    if (options.initialCompanionEnabled !== undefined) {
      this.state = { ...this.state, companionEnabled: options.initialCompanionEnabled };
    }
  }

  getState(): SidePanelState {
    return this.state;
  }

  subscribe(listener: () => void): Unsubscribe {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  submitTask(text: string): void {
    if (this.disposed) return;
    // A live run owns the panel until it ends, and a stop still in flight must not be overtaken
    // by a new start: the pending acknowledgement would land on the wrong run.
    if (this.state.status === 'running' || this.state.status === 'stopping') return;
    const task = text.trim();
    if (!task) {
      this.update({ error: 'Enter a task before starting.' });
      return;
    }

    this.update({
      task,
      status: 'running',
      error: null,
      actions: [
        { id: 'read', label: 'Read the current page', status: 'done' },
        { id: 'plan', label: 'Decide the next step', status: 'done' },
        { id: 'confirm', label: 'Wait for your confirmation', status: 'running' },
        { id: 'report', label: 'Report back to you', status: 'pending' },
      ],
    });
  }

  stop(): void {
    if (this.disposed || this.state.status !== 'running') return;
    // Only `running` may be stopped, so a second press while this one is pending is a duplicate
    // request rather than a second cancellation.
    this.update({ status: 'stopping' });
    void this.confirmStop();
  }

  navigate(route: Route): void {
    if (this.disposed) return;
    this.update({ route });
  }

  async setTheme(theme: Theme): Promise<void> {
    if (this.disposed || !isTheme(theme)) return;
    this.themeWriteStarted = true;
    this.update({ theme, savingTheme: true, error: null });
    try {
      await this.themeStore.write(theme);
      if (!this.disposed) this.update({ savingTheme: false });
    } catch {
      if (!this.disposed) {
        this.update({ savingTheme: false, error: 'Theme could not be saved.' });
      }
    }
  }

  async setCompanionEnabled(enabled: boolean): Promise<void> {
    if (this.disposed || typeof enabled !== 'boolean') return;
    this.companionWriteStarted = true;
    // Applied to the panel before the write lands, and the content script hears about the change
    // from storage rather than from this controller. Deliberately not optimistic-then-reverted:
    // the companion's state is driven by one write, so there is nothing to roll back.
    this.update({ companionEnabled: enabled });
    try {
      await this.companionStore.write(enabled);
    } catch {
      if (!this.disposed) {
        this.update({ error: 'Companion setting could not be saved.' });
      }
    }
  }

  async hydrate(): Promise<void> {
    if (this.disposed) return;
    try {
      const theme = await this.themeStore.read();
      if (!this.disposed && !this.themeWriteStarted && isTheme(theme)) {
        this.update({ theme });
      }
    } catch {
      if (!this.disposed) this.update({ error: 'Saved settings could not be loaded.' });
    }

    try {
      const enabled = await this.companionStore.read();
      if (!this.disposed && !this.companionWriteStarted) {
        this.update({ companionEnabled: enabled });
      }
    } catch {
      if (!this.disposed) this.update({ error: 'Saved settings could not be loaded.' });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
  }

  private async confirmStop(): Promise<void> {
    try {
      await this.acknowledgeStop();
    } catch {
      // Unacknowledged: the run may still be going, so the panel says exactly that instead of
      // reporting a stop that never happened.
      if (!this.disposed && this.state.status === 'stopping') {
        this.update({ status: 'running', error: STOP_UNCONFIRMED });
      }
      return;
    }
    // Re-read the status rather than assuming: a dispose, or a state the caller changed while the
    // request was in flight, must not be overwritten by a late acknowledgement.
    if (this.disposed || this.state.status !== 'stopping') return;
    this.update({
      status: 'stopped',
      actions: this.state.actions.map((action) =>
        action.status === 'running' ? { ...action, status: 'stopped' } : action
      ),
    });
  }

  private update(patch: Partial<SidePanelState>): void {
    if (this.disposed) return;
    this.state = {
      ...this.state,
      ...patch,
      actions: patch.actions ?? cloneActions(this.state.actions),
    };
    for (const listener of this.listeners) listener();
  }
}

export function createDemoController(options: DemoControllerOptions = {}): SidePanelController {
  return new DemoSidePanelController(options);
}
