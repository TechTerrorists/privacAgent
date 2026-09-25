export type Theme = 'system' | 'light' | 'dark';
export type Route = 'home' | 'settings';
export type RunStatus = 'idle' | 'running' | 'stopped' | 'complete';
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
  hydrate(): Promise<void>;
  dispose(): void;
}

export interface ThemeStore {
  read(): Promise<Theme>;
  write(theme: Theme): Promise<void>;
}

export interface DemoControllerOptions {
  readonly themeStore?: ThemeStore;
  readonly initialTheme?: Theme;
}

const INITIAL_ACTIONS: readonly ActionEntry[] = [];

const DEFAULT_THEME: Theme = 'system';

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

class DemoSidePanelController implements SidePanelController {
  private state: SidePanelState = {
    route: 'home',
    theme: DEFAULT_THEME,
    task: '',
    status: 'idle',
    actions: INITIAL_ACTIONS,
    error: null,
    savingTheme: false,
    demo: true,
  };

  private readonly listeners = new Set<() => void>();
  private readonly themeStore: ThemeStore;
  private disposed = false;
  private themeWriteStarted = false;

  constructor(options: DemoControllerOptions = {}) {
    this.themeStore = options.themeStore ?? createMemoryThemeStore(options.initialTheme);
    if (options.initialTheme !== undefined && isTheme(options.initialTheme)) {
      this.state = { ...this.state, theme: options.initialTheme };
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
    this.update({
      status: 'stopped',
      actions: this.state.actions.map((action) =>
        action.status === 'running' ? { ...action, status: 'stopped' } : action
      ),
    });
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
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
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
