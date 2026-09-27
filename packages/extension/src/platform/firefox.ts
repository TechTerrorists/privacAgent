/**
 * Firefox platform adapter implementation (feature A-02).
 *
 * Implements PlatformAdapter for Firefox MV3 using browser.sidebarAction and
 * webextension-polyfill for cross-browser WebExtension APIs.
 * Firefox does not support chrome.offscreen (the background page hosts workers directly).
 * Unsupported capabilities reject explicitly with UnsupportedPlatformCapabilityError.
 */

import browser from 'webextension-polyfill';
import { UnsupportedPlatformCapabilityError } from './errors.js';
import type {
  OffscreenDocumentOptions,
  PlatformAdapter,
  SidePanelOpenOptions,
  SidePanelOptions,
} from './types.js';

interface SidebarActionApi {
  open?: () => Promise<void>;
  close?: () => Promise<void>;
  toggle?: () => Promise<void>;
  setPanel?: (details: {
    panel: string | null;
    tabId?: number;
    windowId?: number;
  }) => Promise<void>;
}

function getSidebarAction(): SidebarActionApi | undefined {
  return (browser as unknown as { sidebarAction?: SidebarActionApi }).sidebarAction;
}

export const firefoxPlatform: PlatformAdapter = {
  name: 'firefox',
  capabilities: {
    offscreen: false,
    sidePanel: false,
    sidebarAction: true,
  },
  browser,

  async openSidePanel(options?: SidePanelOpenOptions): Promise<void> {
    if (options?.windowId !== undefined) {
      throw new UnsupportedPlatformCapabilityError('openSidePanel.windowId', 'firefox');
    }
    if (options?.tabId !== undefined) {
      throw new UnsupportedPlatformCapabilityError('openSidePanel.tabId', 'firefox');
    }
    const sidebarAction = getSidebarAction();
    if (sidebarAction?.open) {
      return sidebarAction.open();
    }
    throw new Error('browser.sidebarAction.open is not available in the current context');
  },

  async setSidePanelOptions(options: SidePanelOptions): Promise<void> {
    if (options.enabled !== undefined) {
      throw new UnsupportedPlatformCapabilityError('setSidePanelOptions.enabled', 'firefox');
    }
    const sidebarAction = getSidebarAction();
    if (sidebarAction?.setPanel && options.path !== undefined) {
      const details: {
        panel: string | null;
        tabId?: number;
        windowId?: number;
      } = {
        panel: options.path,
      };
      if (options.tabId !== undefined) details.tabId = options.tabId;
      if (options.windowId !== undefined) details.windowId = options.windowId;
      return sidebarAction.setPanel(details);
    }
    throw new Error('browser.sidebarAction.setPanel is not available in the current context');
  },

  async setSidePanelBehavior(): Promise<void> {
    // Firefox's sidebar_action toolbar button toggles the sidebar on its own,
    // so there is no behaviour to configure.
    throw new UnsupportedPlatformCapabilityError('setSidePanelBehavior', 'firefox');
  },

  async createOffscreenDocument(_options: OffscreenDocumentOptions): Promise<void> {
    throw new UnsupportedPlatformCapabilityError('offscreen', 'firefox');
  },

  async closeOffscreenDocument(): Promise<void> {
    throw new UnsupportedPlatformCapabilityError('offscreen', 'firefox');
  },

  async hasOffscreenDocument(): Promise<boolean> {
    return false;
  },
};
