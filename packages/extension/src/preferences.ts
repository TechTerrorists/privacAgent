/**
 * Shared browser-storage preferences.
 *
 * A preference is one thing here: the companion is on or off. It is a single boolean under a single
 * key, and that is deliberate — a richer record (position, opacity, animation) would mean a
 * migration and a validation surface for a feature whose whole point is that it is not noticed.
 *
 * This module exists at the root of `src/` because two very different contexts need the same key:
 * the side panel writes it, and the content script reads it and watches for it changing. Neither
 * should import the other — a content script has no business pulling in UI code, and the panel
 * should not bundle the content script's pointer tracking — so the key and the change subscription
 * live in the one place both can reach.
 *
 * `storage.local` only. Not `sync`: nothing about a companion belongs on Google's servers, and
 * the project's one rule would prefer a setting that never leaves the machine at all.
 */

/** The one and only key. Namespaced so a future preference cannot collide with it. */
export const COMPANION_ENABLED_KEY = 'pa:companionEnabled';

/**
 * The default when the key has never been written: **off**.
 *
 * Deliberate, and the reasoning is about truth rather than caution for its own sake. The companion
 * is injected into a page the user did not ask to have anything added to, and the state owner it
 * reports on (A-11, #46) does not exist yet, so an enabled-by-default companion would draw a
 * permanent idle ring that reports nothing at all — a status indicator with no status, on every
 * page the agent touches. Opt-in keeps it honest and costs the user one toggle, which is
 * discoverable in Settings.
 *
 * If A-11 lands and the companion has something real to say, revisiting this is a one-line change
 * and belongs in that issue rather than here.
 */
export const COMPANION_ENABLED_DEFAULT = false;

/** Narrowest possible reader, matching A-10's `StorageAreaLike`, so both sides can be tested. */
export interface PreferenceArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/**
 * `storage.onChanged` has no injectable interface in the platform layer yet, so it is passed in as
 * a subscribe function. A test passes a fake; production passes the extension API.
 */
export interface PreferenceChangeSource {
  /** Returns an unsubscribe. Must not be called before or after the source is closed. */
  subscribe(listener: (key: string, value: unknown) => void): () => void;
}

/** Reads the companion preference, defaulting rather than throwing on a malformed value. */
export async function readCompanionEnabled(area: PreferenceArea): Promise<boolean> {
  const result = await area.get(COMPANION_ENABLED_KEY);
  const stored = result[COMPANION_ENABLED_KEY];
  // A value that is not a boolean is treated as absent rather than coerced. `Boolean('false')` is
  // `true`, and a preference that reads the opposite of what was stored is worse than a default.
  return typeof stored === 'boolean' ? stored : COMPANION_ENABLED_DEFAULT;
}

export async function writeCompanionEnabled(area: PreferenceArea, enabled: boolean): Promise<void> {
  await area.set({ [COMPANION_ENABLED_KEY]: enabled });
}

/**
 * Calls `onChange` with the current value whenever the companion key changes.
 *
 * This is what makes the setting take effect immediately in every already-open tab: toggling it in
 * the panel of one window updates the companions in all of them, without a reload. Content scripts
 * in different tabs are separate JavaScript realms sharing one storage area, so a change event is
 * the only cross-context signal that does not involve a message round trip through the background.
 *
 * The listener is a function, not a set: a preference has exactly one consumer per context, and a
 * single callback makes the "exactly one thing to unsubscribe" property obvious at the call site.
 */
export function subscribeToCompanionEnabled(
  source: PreferenceChangeSource,
  onChange: (enabled: boolean) => void
): () => void {
  return source.subscribe((key, value) => {
    if (key !== COMPANION_ENABLED_KEY) return;
    onChange(typeof value === 'boolean' ? value : COMPANION_ENABLED_DEFAULT);
  });
}
