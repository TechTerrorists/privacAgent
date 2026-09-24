/**
 * Shared platform adapter interfaces and types (feature A-02).
 *
 * Provides a single unified interface for Chrome and Firefox extensions under MV3.
 * Cross-browser APIs are backed by webextension-polyfill, while browser-specific
 * capabilities (e.g. Chrome offscreen documents vs. Firefox background scripts,
 * sidePanel vs. sidebarAction) are isolated behind this interface.
 */

import type { Browser as WebExtBrowser } from 'webextension-polyfill';

export type BrowserName = 'chrome' | 'firefox';

/**
 * Feature flags detailing platform-level capabilities supported by the current browser.
 */
export interface PlatformCapabilities {
  /**
   * Whether the browser supports `chrome.offscreen` API to spawn offscreen DOM documents.
   * True on Chrome (used to host local ML workers); false on Firefox (event page has DOM access).
   */
  readonly offscreen: boolean;

  /**
   * Whether the browser supports the `chrome.sidePanel` API.
   * True on Chrome; false on Firefox.
   */
  readonly sidePanel: boolean;

  /**
   * Whether the browser supports the `browser.sidebarAction` API.
   * True on Firefox; false on Chrome.
   */
  readonly sidebarAction: boolean;
}

/**
 * Parameters for creating an offscreen document (Chrome only).
 */
export interface OffscreenDocumentOptions {
  /** Relative URL of the offscreen HTML document inside the extension */
  url: string;
  /** Reasons for creating the offscreen document */
  reasons: chrome.offscreen.Reason[] | string[];
  /** Human-readable explanation of why the document is needed */
  justification: string;
}

/**
 * Options when opening the side panel (Chrome) or sidebar (Firefox).
 */
export interface SidePanelOpenOptions {
  /** Window ID to open the side panel in */
  windowId?: number;
  /** Tab ID to open the side panel for (Chrome only) */
  tabId?: number;
}

/**
 * Options for configuring side panel or sidebar behavior and target paths.
 */
export interface SidePanelOptions {
  /** Path to the HTML document to render in the panel */
  path?: string;
  /** Whether the side panel is enabled */
  enabled?: boolean;
  /** Tab ID this configuration applies to */
  tabId?: number;
  /** Window ID this configuration applies to */
  windowId?: number;
}

/**
 * Unified platform interface implemented by chrome.ts and firefox.ts.
 */
export interface PlatformAdapter {
  /** The name of the browser target */
  readonly name: BrowserName;

  /** Platform capability map */
  readonly capabilities: PlatformCapabilities;

  /** Direct access to webextension-polyfill instance for cross-browser standard APIs */
  readonly browser: WebExtBrowser;

  /**
   * Opens the side panel (Chrome) or sidebar (Firefox).
   * Preserves asynchronous rejection if the browser API fails or context is invalid.
   */
  openSidePanel(options?: SidePanelOpenOptions): Promise<void>;

  /**
   * Sets options or document path for the side panel / sidebar.
   */
  setSidePanelOptions(options: SidePanelOptions): Promise<void>;

  /**
   * Creates an offscreen document (Chrome only).
   * On Firefox, rejects with an UnsupportedPlatformCapabilityError.
   */
  createOffscreenDocument(options: OffscreenDocumentOptions): Promise<void>;

  /**
   * Closes the active offscreen document (Chrome only).
   * On Firefox, rejects with an UnsupportedPlatformCapabilityError.
   */
  closeOffscreenDocument(): Promise<void>;

  /**
   * Checks whether an offscreen document currently exists.
   * Returns false on Firefox.
   */
  hasOffscreenDocument(): Promise<boolean>;
}
