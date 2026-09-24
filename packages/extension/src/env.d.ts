/// <reference types="vite/client" />

/** Build target, injected by Vite's `define` (see vite.config.ts). */
declare const __BROWSER__: 'chrome' | 'firefox';

/**
 * Path to the built content script, relative to the extension root, for use
 * with `scripting.executeScript`. Owned by vite.content.config.ts — read it
 * from here rather than hard-coding the path at the call site.
 */
declare const __CONTENT_SCRIPT_PATH__: string;
