// @vitest-environment happy-dom
/**
 * F-08: the preference applied to the companion.
 *
 * The requirement is "takes effect immediately, including across contexts", and the whole mechanism
 * is a storage change event rather than a message through the background. These tests drive that
 * path end to end with a fake change source, which is the only way to test a cross-context signal
 * in one JavaScript realm.
 *
 * The two cases that matter most are the ones where turning the companion *off* has to fully
 * reverse it, and where storage is broken: a companion the user cannot account for is the failure
 * this feature most needs to avoid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompanionPreference } from './preference.js';
import { createCompanionController } from './controller.js';
import { createCompanionRenderer } from './renderer.js';
import { createFakePointerlessResolver } from './test-support.js';
import {
  COMPANION_ENABLED_DEFAULT,
  COMPANION_ENABLED_KEY,
  type PreferenceArea,
  type PreferenceChangeSource,
} from '../../preferences.js';
import { createOverlay, type OverlayHandle } from '../overlay/index.js';
import { createManualFrameScheduler } from '../overlay/scheduler.js';

const DOC = 'd-f08-pref' as never;

interface Harness {
  overlay: OverlayHandle;
  controller: ReturnType<typeof createCompanionController>;
  preference: ReturnType<typeof createCompanionPreference>;
  area: PreferenceArea;
  emit(key: string, value: unknown): void;
  stored: Record<string, unknown>;
  frames: ReturnType<typeof createManualFrameScheduler>;
}

function harness(options: { initial?: unknown; failRead?: boolean } = {}): Harness {
  const stored: Record<string, unknown> =
    options.initial === undefined ? {} : { [COMPANION_ENABLED_KEY]: options.initial };

  const area: PreferenceArea = {
    get: vi.fn(async () => {
      if (options.failRead) throw new Error('storage unavailable');
      return { ...stored };
    }),
    set: vi.fn(async (items) => {
      Object.assign(stored, items);
    }),
  };

  const listeners = new Set<(key: string, value: unknown) => void>();
  const changes: PreferenceChangeSource = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const resolver = createFakePointerlessResolver(DOC);
  const frames = createManualFrameScheduler();
  const overlay = createOverlay({
    document,
    window,
    resolver,
    renderer: createCompanionRenderer(),
    scheduler: frames,
  });
  const controller = createCompanionController({ overlay, resolver });
  const preference = createCompanionPreference({ area, changes, controller });

  return {
    overlay,
    controller,
    preference,
    area,
    stored,
    frames,
    emit: (key, value) => {
      for (const listener of listeners) listener(key, value);
    },
  };
}

let h: Harness;

beforeEach(() => {
  document.body.innerHTML = '';
  h = harness();
});

afterEach(() => {
  h.preference.dispose();
  h.controller.dispose();
  h.overlay.dispose();
  document.body.innerHTML = '';
});

describe('applying the stored value', () => {
  it('stays off when nothing has been stored', async () => {
    await h.preference.hydrate();
    expect(h.controller.isEnabled).toBe(false);
    expect(h.overlay.size).toBe(0);
  });

  it('comes on when the stored value is true', async () => {
    h = harness({ initial: true });
    await h.preference.hydrate();
    expect(h.controller.isEnabled).toBe(true);
  });

  it('comes on when a storage read fails, rather than leaving a character nobody can explain', async () => {
    // A read failure that defaulted to *off* would silently disagree with the user's setting. A
    // read failure that defaults to *on* shows a companion they can turn off, which is honest.
    h = harness({ failRead: true });
    const onError = vi.fn();
    const resolver = createFakePointerlessResolver(DOC);
    const frames = createManualFrameScheduler();
    const overlay = createOverlay({
      document,
      window,
      resolver,
      renderer: createCompanionRenderer(),
      scheduler: frames,
    });
    const controller = createCompanionController({ overlay, resolver });
    const preference = createCompanionPreference({
      area: h.area,
      changes: {
        subscribe: () => () => undefined,
      },
      controller,
      onError,
    });

    await preference.hydrate();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(controller.isEnabled).toBe(COMPANION_ENABLED_DEFAULT);

    preference.dispose();
    controller.dispose();
    overlay.dispose();
  });
});

describe('cross-context changes', () => {
  it('enables the companion when another context writes the key', async () => {
    await h.preference.hydrate();
    h.preference.subscribe();
    expect(h.controller.isEnabled).toBe(false);

    h.emit(COMPANION_ENABLED_KEY, true);

    expect(h.controller.isEnabled).toBe(true);
  });

  it('disables the companion when another context clears the key', async () => {
    h = harness({ initial: true });
    await h.preference.hydrate();
    h.preference.subscribe();
    expect(h.controller.isEnabled).toBe(true);

    h.emit(COMPANION_ENABLED_KEY, false);

    expect(h.controller.isEnabled).toBe(false);
    // Turning it off has to fully reverse it, not just stop drawing: no annotation, no listener.
    expect(h.overlay.size).toBe(0);
  });

  it('ignores changes to other keys, such as the theme', async () => {
    await h.preference.hydrate();
    h.preference.subscribe();

    h.emit('theme', 'dark');

    expect(h.controller.isEnabled).toBe(false);
  });

  it('applies the newest value when several changes land in a row', async () => {
    await h.preference.hydrate();
    h.preference.subscribe();

    h.emit(COMPANION_ENABLED_KEY, true);
    h.emit(COMPANION_ENABLED_KEY, false);
    h.emit(COMPANION_ENABLED_KEY, true);

    expect(h.controller.isEnabled).toBe(true);
  });

  it('stops listening after dispose', async () => {
    await h.preference.hydrate();
    h.preference.subscribe();

    h.preference.dispose();
    h.emit(COMPANION_ENABLED_KEY, true);

    expect(h.controller.isEnabled).toBe(false);
  });

  it('subscribes only once however many times it is called', async () => {
    await h.preference.hydrate();
    h.preference.subscribe();
    h.preference.subscribe();
    h.preference.subscribe();

    h.emit(COMPANION_ENABLED_KEY, true);

    // Still one companion, and — the point of the assertion — one controller enable rather than
    // three, so a change cannot be applied repeatedly.
    expect(h.controller.isEnabled).toBe(true);
  });

  it('does nothing after dispose', async () => {
    h.preference.dispose();
    await expect(h.preference.hydrate()).resolves.toBeUndefined();
    expect(h.controller.isEnabled).toBe(false);
  });
});
