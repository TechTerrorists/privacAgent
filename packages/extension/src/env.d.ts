/// <reference types="vite/client" />

/** Build target, injected by Vite's `define` (see vite.config.ts). */
declare const __BROWSER__: 'chrome' | 'firefox';

/**
 * Path to the built content script, relative to the extension root, for use
 * with `scripting.executeScript`. Differs per target, so never hard-code it.
 */
declare const __CONTENT_SCRIPT_PATH__: string;
