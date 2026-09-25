import browser from 'webextension-polyfill';
import { NAVIGATION_HINT } from '../content/element-registry/index.js';

export const REGISTRY_PROBE = 'privacagent:b05:active';

/** Narrow local lifecycle signal, not the A-03 application message bus. */
export function installRegistryNavigation(): void {
  const hint = (details: { tabId: number; frameId: number }) => {
    // A stateless probe survives service-worker restarts. Only an on-demand
    // registry can opt in; no tab history, URLs, ports or timers are retained.
    void browser.tabs
      .sendMessage(details.tabId, { type: REGISTRY_PROBE }, { frameId: 0 })
      .then(async (active: unknown) => {
        if (active !== true) return;
        // A data-free notification in the affected isolated document, under
        // existing activeTab/optional host access. No page history API patch,
        // URL relay, static injection, frame scan, or polling.
        await browser.scripting.executeScript({
          target: { tabId: details.tabId, frameIds: [details.frameId] },
          func: (eventName: string) => {
            if (!(window as Window & { navigation?: EventTarget }).navigation) {
              document.dispatchEvent(new Event(eventName));
            }
          },
          args: [NAVIGATION_HINT],
        });
      })
      .catch(() => {
        // No registry, closed tab, inaccessible frame or revoked access.
        // Resolution also checks live document, connectivity and URL locally.
      });
  };
  browser.webNavigation.onHistoryStateUpdated.addListener(hint);
  browser.webNavigation.onReferenceFragmentUpdated.addListener(hint);
}
