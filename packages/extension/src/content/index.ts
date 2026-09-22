/**
 * Content script entry point (page context, isolated world).
 *
 * Injected on demand via `scripting.executeScript` under the activeTab grant,
 * never declared statically, so that perception is idle until the user invokes
 * the extension. The DOM walk (B-02), element registry (B-05) and action
 * executor (B-10 onwards) are added here in later features.
 */

console.info('[privacAgent] content script injected');

export {};
