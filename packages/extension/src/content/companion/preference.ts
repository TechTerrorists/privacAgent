/**
 * F-08: the preference's content-script half.
 *
 * The side panel writes the boolean; this reads it and keeps the companion in step. It is the whole
 * of the "applies immediately, including across contexts" requirement: `storage.onChanged` fires in
 * every context sharing the area, so flipping the toggle in one window enables or disables the
 * companion in every open tab with no reload and no message through the background.
 *
 * Written as a small subscribe/apply pair rather than folded into the controller, because the
 * controller must not know that storage exists — it takes a boolean, and everything upstream of
 * that is somebody else's problem. That split is what lets the same controller be driven by a
 * test, by the preference, and later by a real provider, with no flag combination that only works
 * in one of them.
 */
import {
  COMPANION_ENABLED_DEFAULT,
  readCompanionEnabled,
  subscribeToCompanionEnabled,
  type PreferenceArea,
  type PreferenceChangeSource,
} from '../../preferences.js';
import type { CompanionController } from './controller.js';

export interface CompanionPreferenceOptions {
  readonly area: PreferenceArea;
  readonly changes: PreferenceChangeSource;
  readonly controller: CompanionController;
  /**
   * Called once with the persisted value before any change is applied. Lets a caller report a
   * storage failure without having to catch it, and gives tests a single point to assert that the
   * initial state came from storage rather than from the default.
   */
  readonly onError?: (error: unknown) => void;
}

export interface CompanionPreference {
  /** Reads the stored value and applies it. Safe to call more than once. */
  hydrate(): Promise<void>;
  /**
   * Applies every subsequent change until disposed. Separate from `hydrate` so a caller can read
   * the initial value *before* the companion appears, rather than flashing the default and then
   * correcting it.
   */
  subscribe(): void;
  dispose(): void;
}

export function createCompanionPreference(
  options: CompanionPreferenceOptions
): CompanionPreference {
  const { area, changes, controller } = options;
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  /**
   * A single funnel for every change, whatever its source. Defaulting on a read failure is the
   * right way round: the companion is a status indicator, and failing to load its preference
   * should not mean the user is left with a character frozen in a stale state.
   */
  const apply = (enabled: boolean): void => {
    if (disposed) return;
    controller.setEnabled(enabled);
  };

  return {
    async hydrate() {
      if (disposed) return;
      try {
        apply(await readCompanionEnabled(area));
      } catch (error) {
        options.onError?.(error);
        apply(COMPANION_ENABLED_DEFAULT);
      }
    },

    subscribe() {
      if (disposed || unsubscribe !== null) return;
      unsubscribe = subscribeToCompanionEnabled(changes, apply);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
