/**
 * Background entry point (Chrome service worker / Firefox event page).
 *
 * Scope for A-01 is only that this builds and loads in both browsers. The
 * background context stays thin by design: routing (A-03), screenshot capture
 * (A-07) and the single network chokepoint plus Egress Guard (A-06, D-11) land
 * here in later features, and no other context is allowed to hold a network
 * client.
 */

import browser from 'webextension-polyfill';
import { installRegistryNavigation } from './registry-navigation.js';
import { MessageBus, ExtensionTransport } from '../messaging/index.js';
import { HostManager } from '../host/index.js';
import { activePlatform } from '../platform/active.js';

installRegistryNavigation();

const BUILD_TARGET = __BROWSER__;

// Background messaging bus
const offscreenUrl = browser.runtime.getURL('src/host/offscreen.html');
const sidepanelUrl = browser.runtime.getURL('src/ui/sidepanel.html');

const bgTransport = new ExtensionTransport(
  { context: 'background' },
  {
    extensionPeers: {
      [offscreenUrl]: { context: 'offscreen' },
      [sidepanelUrl]: { context: 'ui' },
    },
    workerRelayUrls: [offscreenUrl],
  }
);
const bgBus = new MessageBus({ context: 'background' }, bgTransport);

// Host lifecycle manager (A-04)
const hostManager = new HostManager(bgBus);
/**
 * Makes the toolbar button open the side panel.
 *
 * Declaring `side_panel.default_path` only registers the panel; Chrome leaves
 * `openPanelOnActionClick` false, so without this the icon does nothing and the
 * panel is reachable only by URL. Firefox's `sidebar_action` button toggles its
 * sidebar unaided, which is why this is guarded by capability rather than
 * called unconditionally.
 */
function installSidePanelOpener(): void {
  if (!activePlatform.capabilities.sidePanel) return;

  void activePlatform.setSidePanelBehavior({ openOnActionClick: true }).catch(() => {
    // Not fatal: the panel is still reachable from the browser's own side-panel
    // picker, and a failure here must not take down the background context.
  });
}

installSidePanelOpener();

browser.runtime.onInstalled.addListener(() => {
  console.info(`[privacAgent] background ready (${BUILD_TARGET})`);
});

// Keep reference alive for service worker
(globalThis as Record<string, unknown>).__privacagent_host = hostManager;
