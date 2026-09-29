/**
 * The bug these tests exist for: `sidepanel.ts` shipped without passing `companionStore`, and
 * every other test in the repo stayed green. Nothing asserted that the *entry point* wires the
 * store — only that the store itself works — so the panel was a working-looking checkbox over an
 * in-memory object while the content script, which listens for the same key, never heard a word
 * about it. The failure lived entirely between the two halves and nothing covered the seam.
 *
 * So these drive the store the way production does and assert on the other end: a subscriber
 * attached the way the content script attaches one, plus the value a second panel instance reads
 * back after a reload.
 */
import { describe, expect, it, vi } from 'vitest';
import { createStorageCompanionStore, type StorageAreaLike } from './settings.js';
import {
  COMPANION_ENABLED_DEFAULT,
  COMPANION_ENABLED_KEY,
  subscribeToCompanionEnabled,
  type PreferenceChangeSource,
} from '../preferences.js';

interface FakeStorage {
  readonly area: StorageAreaLike;
  /**
   * The `browser.storage.local` notification, as the content script's source wraps it. Stands in
   * for the cross-context signal, so a store that writes without notifying still fails here.
   */
  readonly source: PreferenceChangeSource;
  readonly data: Record<string, unknown>;
}

function fakeStorage(initial: Record<string, unknown> = {}): FakeStorage {
  const data: Record<string, unknown> = { ...initial };
  const listeners = new Set<(key: string, value: unknown) => void>();

  const area: StorageAreaLike = {
    async get(key) {
      // Mirrors the real API: asking for a key returns a record, absent keys simply missing.
      return key in data ? { [key]: data[key] } : {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        // Queued like `storage.onChanged`, which is async. A listener that ran synchronously here
        // would be testing a race production does not have.
        queueMicrotask(() => {
          for (const listener of listeners) listener(key, value);
        });
        data[key] = value;
      }
    },
  };

  return {
    area,
    data,
    source: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

describe('the companion toggle is reachable from the other end of the extension', () => {
  it('notifies a content-script subscriber when the panel toggles the companion', async () => {
    const storage = fakeStorage();
    const seen: boolean[] = [];
    const off = subscribeToCompanionEnabled(storage.source, (enabled) => seen.push(enabled));

    await createStorageCompanionStore(storage.area).write(true);
    await Promise.resolve();
    await Promise.resolve();

    // The write landed and it landed *loudly*. A subscriber that sees nothing here is the missing
    // `companionStore`, in miniature: the panel believes it toggled, and nothing else ever finds out.
    expect(storage.data[COMPANION_ENABLED_KEY]).toBe(true);
    expect(seen).toEqual([true]);
    off();
  });

  it('carries the off case too, so the subscriber can actually turn the companion off', async () => {
    // `write(true)` alone would pass a suite where the notification always said "on". The whole
    // point of the setting is that the user can remove the character as easily as add it.
    const storage = fakeStorage({ [COMPANION_ENABLED_KEY]: true });
    const seen: boolean[] = [];
    const off = subscribeToCompanionEnabled(storage.source, (enabled) => seen.push(enabled));

    await createStorageCompanionStore(storage.area).write(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual([false]);
    off();
  });

  it('round-trips so a reopened panel shows the companion still enabled', async () => {
    const storage = fakeStorage();
    await createStorageCompanionStore(storage.area).write(true);

    // A second panel instance reads the same key, which is what a reload does.
    await expect(createStorageCompanionStore(storage.area).read()).resolves.toBe(true);
  });

  it('stays off when the key is missing, because a character nobody asked for is worse', async () => {
    // The off-by-default rule, and the reason this store is not folded into `Preferences`: a theme
    // miss can fall back quietly, but a companion that appeared on a storage miss would be the user
    // looking at something they never enabled and cannot account for.
    expect(COMPANION_ENABLED_DEFAULT).toBe(false);
    await expect(createStorageCompanionStore(fakeStorage().area).read()).resolves.toBe(false);
  });

  it('stays off when the stored value is not a boolean, rather than coercing it', async () => {
    // `Boolean('false')` is `true`, so a naive coercion reads the opposite of what was stored.
    const storage = fakeStorage({ [COMPANION_ENABLED_KEY]: 'false' });
    await expect(createStorageCompanionStore(storage.area).read()).resolves.toBe(false);
  });

  it('propagates a failed read, leaving the fallback to the panel', async () => {
    // The store is a thin pass-through and is *meant* to reject here: the controller catches it and
    // shows "Saved settings could not be loaded" (controller.ts). Pinning this so the contract is
    // explicit — a silent fallback inside the store would make that branch dead code.
    const area: StorageAreaLike = {
      get: vi.fn().mockRejectedValue(new Error('quota')),
      set: vi.fn().mockResolvedValue(undefined),
    };
    await expect(createStorageCompanionStore(area).read()).rejects.toThrow('quota');
  });

  it('propagates a failed write, so the panel cannot claim a change that was never saved', async () => {
    // The controller deliberately does not roll the toggle back on a failed write. If the store
    // swallowed this, the checkbox would sit showing "on" for a setting that does not exist in any
    // tab — the exact silent-failure the panel toggle is not allowed to have.
    const area: StorageAreaLike = {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockRejectedValue(new Error('quota')),
    };
    await expect(createStorageCompanionStore(area).write(true)).rejects.toThrow('quota');
  });
});
