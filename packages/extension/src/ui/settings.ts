import {
  readCompanionEnabled,
  writeCompanionEnabled,
  type PreferenceArea,
} from '../preferences.js';
import type { CompanionStore, Theme, ThemeStore } from './controller.js';

const THEME_KEY = 'theme';

/** A-10's name for the storage shape, now the shared {@link PreferenceArea}. */
export type StorageAreaLike = PreferenceArea;

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

/**
 * F-08: the companion's on/off, stored the way the theme is and sharing its key constant with the
 * content script that reads it.
 *
 * A boolean and nothing else. No position, no opacity, no animation preference: a companion
 * configurable into existence several different ways would be several times as much code to get
 * right, for a feature whose goal is to not be in the way. The motion preference is honoured from
 * `prefers-reduced-motion` instead — a signal the user has already set system-wide, and one that
 * cannot drift out of sync with the OS.
 */
export function createStorageCompanionStore(area: StorageAreaLike): CompanionStore {
  return {
    read: () => readCompanionEnabled(area),
    write: (enabled: boolean) => writeCompanionEnabled(area, enabled),
  };
}
