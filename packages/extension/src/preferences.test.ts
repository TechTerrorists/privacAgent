/**
 * F-08: the stored preference.
 *
 * The interesting cases are the malformed ones. A preference is read from a store that anything
 * can write — the user, a future feature, a half-finished migration, an attacker with local
 * storage access — so the question is not "does it store a boolean" but "what does it do when it
 * finds something that is not one". The answer everywhere is the same: the default, never a
 * coercion.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COMPANION_ENABLED_DEFAULT,
  COMPANION_ENABLED_KEY,
  readCompanionEnabled,
  subscribeToCompanionEnabled,
  writeCompanionEnabled,
  type PreferenceArea,
  type PreferenceChangeSource,
} from './preferences.js';
import { createStorageCompanionStore } from './ui/settings.js';

const areaReturning = (value: unknown): PreferenceArea => ({
  get: vi.fn().mockResolvedValue(value === undefined ? {} : { [COMPANION_ENABLED_KEY]: value }),
  set: vi.fn().mockResolvedValue(undefined),
});

describe('the companion preference', () => {
  it('is off by default', () => {
    // Asserted as a value rather than left implicit: if this ever flips, a companion appears on
    // every page the agent touches, and that should be a deliberate change in the open.
    expect(COMPANION_ENABLED_DEFAULT).toBe(false);
  });

  it('reads a stored boolean', async () => {
    expect(await readCompanionEnabled(areaReturning(true))).toBe(true);
    expect(await readCompanionEnabled(areaReturning(false))).toBe(false);
  });

  it('defaults when the key has never been written', async () => {
    expect(await readCompanionEnabled(areaReturning(undefined))).toBe(false);
  });

  it.each([
    ['the string "true"', 'true'],
    ['the string "false"', 'false'],
    ['zero', 0],
    ['one', 1],
    ['null', null],
    ['an object', { enabled: true }],
  ])('refuses to coerce %s', async (_label, stored) => {
    // `Boolean('false')` is `true`, so coercion would read the opposite of what was written. A
    // preference that disagrees with its own stored value is worse than one that resets.
    expect(await readCompanionEnabled(areaReturning(stored))).toBe(COMPANION_ENABLED_DEFAULT);
  });

  it('writes the boolean under the shared key', async () => {
    const area = areaReturning(undefined);
    await writeCompanionEnabled(area, true);
    expect(area.set).toHaveBeenCalledWith({ [COMPANION_ENABLED_KEY]: true });
  });

  it('is reachable through the settings store, so both preferences persist the same way', async () => {
    const area = areaReturning(true);
    const store = createStorageCompanionStore(area);
    expect(await store.read()).toBe(true);
    await store.write(false);
    expect(area.set).toHaveBeenCalledWith({ [COMPANION_ENABLED_KEY]: false });
  });
});

describe('change notification', () => {
  function createSource() {
    const listeners = new Set<(key: string, value: unknown) => void>();
    const source: PreferenceChangeSource = {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return {
      source,
      emit: (key: string, value: unknown) => {
        for (const listener of listeners) listener(key, value);
      },
      get count() {
        return listeners.size;
      },
    };
  }

  it('applies a change to the companion key', () => {
    const { source, emit } = createSource();
    const seen: boolean[] = [];
    subscribeToCompanionEnabled(source, (enabled) => seen.push(enabled));

    emit(COMPANION_ENABLED_KEY, true);
    expect(seen).toEqual([true]);
  });

  it('ignores changes to any other key', () => {
    const { source, emit } = createSource();
    const seen: boolean[] = [];
    subscribeToCompanionEnabled(source, (enabled) => seen.push(enabled));

    emit('theme', 'dark');
    expect(seen).toEqual([]);
  });

  it('falls back to the default when a change carries a non-boolean', () => {
    const { source, emit } = createSource();
    const seen: boolean[] = [];
    subscribeToCompanionEnabled(source, (enabled) => seen.push(enabled));

    emit(COMPANION_ENABLED_KEY, 'yes');
    expect(seen).toEqual([COMPANION_ENABLED_DEFAULT]);
  });

  it('stops calling back once unsubscribed', () => {
    // The teardown that matters for a content script: a session that ends must not leave a
    // storage listener behind, or every future change would reach a disposed controller.
    // The object is kept whole rather than destructured: `count` is a live getter over a Set, and
    // destructuring would read it once and freeze a stale 0.
    const changes = createSource();
    const seen: boolean[] = [];
    const unsubscribe = subscribeToCompanionEnabled(changes.source, (enabled) =>
      seen.push(enabled)
    );
    expect(changes.count).toBe(1);

    unsubscribe();
    changes.emit(COMPANION_ENABLED_KEY, true);

    expect(changes.count).toBe(0);
    expect(seen).toEqual([]);
  });
});
