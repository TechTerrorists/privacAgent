/**
 * Chrome platform adapter implementation (feature A-02).
 *
 * Implements PlatformAdapter for Chrome MV3 using chrome.* APIs (offscreen, sidePanel)
 * and webextension-polyfill for cross-browser WebExtension APIs.
 */

import browser from 'webextension-polyfill';
import { UnsupportedPlatformCapabilityError } from './errors.js';
import type {
  OffscreenDocumentOptions,
  PlatformAdapter,
  SidePanelOpenOptions,
  SidePanelOptions,
} from './types.js';

export const chromePlatform: PlatformAdapter = {
  name: 'chrome',
  capabilities: {
    offscreen: true,
    sidePanel: true,
    sidebarAction: false,
  },
  browser,

  async openSidePanel(options?: SidePanelOpenOptions): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.sidePanel?.open) {
      if (options?.tabId !== undefined) {
        return chrome.sidePanel.open({ tabId: options.tabId });
      }
      if (options?.windowId !== undefined) {
        return chrome.sidePanel.open({ windowId: options.windowId });
      }
      const currentWindow = await browser.windows.getCurrent();
      if (currentWindow?.id !== undefined) {
        return chrome.sidePanel.open({ windowId: currentWindow.id });
      }
      throw new Error('Unable to determine target window for chrome.sidePanel.open');
    }
    throw new Error('chrome.sidePanel.open is not available in the current context');
  },

  async setSidePanelOptions(options: SidePanelOptions): Promise<void> {
    if (options.windowId !== undefined) {
      throw new UnsupportedPlatformCapabilityError('setSidePanelOptions.windowId', 'chrome');
    }
    if (typeof chrome !== 'undefined' && chrome.sidePanel?.setOptions) {
      const chromeOptions: chrome.sidePanel.PanelOptions = {};
      if (options.path !== undefined) chromeOptions.path = options.path;
      if (options.enabled !== undefined) chromeOptions.enabled = options.enabled;
      if (options.tabId !== undefined) chromeOptions.tabId = options.tabId;
      return chrome.sidePanel.setOptions(chromeOptions);
    }
    throw new Error('chrome.sidePanel.setOptions is not available in the current context');
  },

  async createOffscreenDocument(options: OffscreenDocumentOptions): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.offscreen?.createDocument) {
      return chrome.offscreen.createDocument({
        url: options.url,
        reasons: options.reasons as chrome.offscreen.Reason[],
        justification: options.justification,
      });
    }
    throw new Error('chrome.offscreen.createDocument is not available in the current context');
  },

  async closeOffscreenDocument(): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.offscreen?.closeDocument) {
      return chrome.offscreen.closeDocument();
    }
    throw new Error('chrome.offscreen.closeDocument is not available in the current context');
  },

  async hasOffscreenDocument(): Promise<boolean> {
    if (typeof chrome !== 'undefined' && chrome.offscreen?.hasDocument) {
      return chrome.offscreen.hasDocument();
    }
    return false;
  },
};
