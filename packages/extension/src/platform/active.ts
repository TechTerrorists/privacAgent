import { chromePlatform } from './chrome.js';
import { firefoxPlatform } from './firefox.js';
import type { PlatformAdapter } from './types.js';

/**
 * The adapter for the build target, without pulling in the other target's code.
 *
 * `index.ts` re-exports both adapters for tests and callers that compare targets, which
 * means a consumer that only needs the active adapter still bundles the inactive one. The
 * Chrome adapter calls `chrome.sidePanel` and `chrome.offscreen`, so in the Firefox panel
 * that surfaces as `UNSUPPORTED_API` warnings from `web-ext lint`. Keeping the choice in a
 * single constant expression lets the bundler drop the untaken branch.
 */
export const activePlatform: PlatformAdapter =
  typeof __BROWSER__ !== 'undefined' && __BROWSER__ === 'firefox'
    ? firefoxPlatform
    : chromePlatform;
