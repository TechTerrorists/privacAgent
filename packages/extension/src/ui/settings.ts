import type { Theme, ThemeStore } from './controller.js';

const THEME_KEY = 'theme';

export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function createStorageThemeStore(area: StorageAreaLike): ThemeStore {
  return {
    async read(): Promise<Theme> {
      const result = await area.get(THEME_KEY);
      const theme = result[THEME_KEY];
      return isTheme(theme) ? theme : 'system';
    },
    async write(theme: Theme): Promise<void> {
      await area.set({ [THEME_KEY]: theme });
    },
  };
}
