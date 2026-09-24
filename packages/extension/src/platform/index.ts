/**
 * Platform adapter entry point (feature A-02).
 *
 * Exposes a unified `platform` object configured at build time via the `__BROWSER__`
 * constant. Individual implementations (`chromePlatform`, `firefoxPlatform`) and types
 * are also exported for testing and targeted usage.
 */

import { chromePlatform } from './chrome.js';
import { firefoxPlatform } from './firefox.js';
import type { BrowserName, PlatformAdapter } from './types.js';

export * from './types.js';
export * from './errors.js';
export { chromePlatform } from './chrome.js';
export { firefoxPlatform } from './firefox.js';

/**
 * Resolves a platform adapter for the given target, defaulting to `__BROWSER__`.
 *
 * @param target Optional browser target override ('chrome' | 'firefox').
 * @returns The matching PlatformAdapter implementation.
 */
export function getPlatformAdapter(target?: BrowserName): PlatformAdapter {
  const resolvedTarget: BrowserName =
    target ?? (typeof __BROWSER__ !== 'undefined' ? __BROWSER__ : 'chrome');
  return resolvedTarget === 'firefox' ? firefoxPlatform : chromePlatform;
}

/**
 * The platform adapter for the active build target.
 */
export const platform: PlatformAdapter = getPlatformAdapter();
