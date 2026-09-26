import { describe, expect, it, vi } from 'vitest';
import { createStorageThemeStore, type StorageAreaLike } from './settings.js';

describe('storage theme store', () => {
  it('reads and writes the theme key in local storage', async () => {
    const area: StorageAreaLike = {
      get: vi.fn().mockResolvedValue({ theme: 'dark' }),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const store = createStorageThemeStore(area);

    expect(await store.read()).toBe('dark');
    await store.write('light');

    expect(area.get).toHaveBeenCalledWith('theme');
    expect(area.set).toHaveBeenCalledWith({ theme: 'light' });
  });

  it('falls back to system for an absent or invalid stored value', async () => {
    const area: StorageAreaLike = {
      get: vi.fn().mockResolvedValue({ theme: 'not-a-theme' }),
      set: vi.fn().mockResolvedValue(undefined),
    };

    expect(await createStorageThemeStore(area).read()).toBe('system');
  });
});
