import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => {
  const mockBrowser = {
    runtime: { id: 'mock-extension-id' },
    windows: {
      getCurrent: vi.fn().mockResolvedValue({ id: 101 }),
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
    },
    sidebarAction: {
      open: vi.fn().mockResolvedValue(undefined),
      setPanel: vi.fn().mockResolvedValue(undefined),
    },
  };
  return {
    default: mockBrowser,
    ...mockBrowser,
  };
});

import {
  chromePlatform,
  firefoxPlatform,
  getPlatformAdapter,
  platform,
  UnsupportedPlatformCapabilityError,
} from './index.js';

describe('Platform Adapter (A-02)', () => {
  describe('UnsupportedPlatformCapabilityError', () => {
    it('sets capability, browser, and a meaningful error message', () => {
      const err = new UnsupportedPlatformCapabilityError('offscreen', 'firefox');
      expect(err.name).toBe('UnsupportedPlatformCapabilityError');
      expect(err.capability).toBe('offscreen');
      expect(err.browser).toBe('firefox');
      expect(err.message).toContain('offscreen');
      expect(err.message).toContain('firefox');
    });

    it('allows a custom message override', () => {
      const err = new UnsupportedPlatformCapabilityError('offscreen', 'firefox', 'Custom message');
      expect(err.message).toBe('Custom message');
    });
  });

  describe('getPlatformAdapter selection', () => {
    it('returns chromePlatform when requested explicitly', () => {
      const adapter = getPlatformAdapter('chrome');
      expect(adapter.name).toBe('chrome');
      expect(adapter.capabilities.offscreen).toBe(true);
      expect(adapter.capabilities.sidePanel).toBe(true);
      expect(adapter.capabilities.sidebarAction).toBe(false);
    });

    it('returns firefoxPlatform when requested explicitly', () => {
      const adapter = getPlatformAdapter('firefox');
      expect(adapter.name).toBe('firefox');
      expect(adapter.capabilities.offscreen).toBe(false);
      expect(adapter.capabilities.sidePanel).toBe(false);
      expect(adapter.capabilities.sidebarAction).toBe(true);
    });

    it('exposes a valid default platform singleton with browser wired', () => {
      expect(platform).toBeDefined();
      expect(['chrome', 'firefox']).toContain(platform.name);
      expect(platform.browser).toBeDefined();
    });
  });

  describe('Firefox Platform Adapter', () => {
    it('declares correct capabilities', () => {
      expect(firefoxPlatform.name).toBe('firefox');
      expect(firefoxPlatform.capabilities.offscreen).toBe(false);
      expect(firefoxPlatform.capabilities.sidePanel).toBe(false);
      expect(firefoxPlatform.capabilities.sidebarAction).toBe(true);
    });

    it('rejects createOffscreenDocument with UnsupportedPlatformCapabilityError', async () => {
      await expect(
        firefoxPlatform.createOffscreenDocument({
          url: 'src/offscreen/index.html',
          reasons: ['TEST' as chrome.offscreen.Reason],
          justification: 'testing',
        })
      ).rejects.toThrow(UnsupportedPlatformCapabilityError);
    });

    it('rejects closeOffscreenDocument with UnsupportedPlatformCapabilityError', async () => {
      await expect(firefoxPlatform.closeOffscreenDocument()).rejects.toThrow(
        UnsupportedPlatformCapabilityError
      );
    });

    it('returns false for hasOffscreenDocument', async () => {
      const hasDoc = await firefoxPlatform.hasOffscreenDocument();
      expect(hasDoc).toBe(false);
    });

    it('wires openSidePanel to browser.sidebarAction.open', async () => {
      const openMock = vi.fn().mockResolvedValue(undefined);
      (
        firefoxPlatform.browser as unknown as { sidebarAction: { open: () => Promise<void> } }
      ).sidebarAction = {
        open: openMock,
      };

      await firefoxPlatform.openSidePanel();
      expect(openMock).toHaveBeenCalledOnce();
    });

    it('wires setSidePanelOptions to browser.sidebarAction.setPanel', async () => {
      const setPanelMock = vi.fn().mockResolvedValue(undefined);
      (
        firefoxPlatform.browser as unknown as {
          sidebarAction: { setPanel: (details: { panel: string }) => Promise<void> };
        }
      ).sidebarAction = {
        setPanel: setPanelMock,
      };

      await firefoxPlatform.setSidePanelOptions({ path: 'src/ui/sidepanel.html' });
      expect(setPanelMock).toHaveBeenCalledWith({
        panel: 'src/ui/sidepanel.html',
      });
    });

    it('preserves asynchronous rejections from sidebarAction.open', async () => {
      const failingMock = vi.fn().mockRejectedValue(new Error('Sidebar cannot open'));
      (
        firefoxPlatform.browser as unknown as { sidebarAction: { open: () => Promise<void> } }
      ).sidebarAction = {
        open: failingMock,
      };

      await expect(firefoxPlatform.openSidePanel()).rejects.toThrow('Sidebar cannot open');
    });
  });

  describe('Chrome Platform Adapter', () => {
    const originalChrome = (globalThis as unknown as { chrome?: unknown }).chrome;

    beforeEach(() => {
      (globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {};
    });

    afterEach(() => {
      (globalThis as unknown as { chrome?: unknown }).chrome = originalChrome;
    });

    it('declares correct capabilities', () => {
      expect(chromePlatform.name).toBe('chrome');
      expect(chromePlatform.capabilities.offscreen).toBe(true);
      expect(chromePlatform.capabilities.sidePanel).toBe(true);
      expect(chromePlatform.capabilities.sidebarAction).toBe(false);
    });

    it('delegates createOffscreenDocument to chrome.offscreen.createDocument', async () => {
      const createDocMock = vi.fn().mockResolvedValue(undefined);
      (
        globalThis as unknown as { chrome: { offscreen: { createDocument: typeof createDocMock } } }
      ).chrome = {
        offscreen: {
          createDocument: createDocMock,
        },
      };

      const options = {
        url: 'src/offscreen/index.html',
        reasons: ['TEST' as chrome.offscreen.Reason],
        justification: 'unit test',
      };

      await chromePlatform.createOffscreenDocument(options);
      expect(createDocMock).toHaveBeenCalledWith(options);
    });

    it('delegates closeOffscreenDocument to chrome.offscreen.closeDocument', async () => {
      const closeDocMock = vi.fn().mockResolvedValue(undefined);
      (
        globalThis as unknown as { chrome: { offscreen: { closeDocument: typeof closeDocMock } } }
      ).chrome = {
        offscreen: {
          closeDocument: closeDocMock,
        },
      };

      await chromePlatform.closeOffscreenDocument();
      expect(closeDocMock).toHaveBeenCalledOnce();
    });

    it('delegates hasOffscreenDocument to chrome.offscreen.hasDocument', async () => {
      const hasDocMock = vi.fn().mockResolvedValue(true);
      (
        globalThis as unknown as { chrome: { offscreen: { hasDocument: typeof hasDocMock } } }
      ).chrome = {
        offscreen: {
          hasDocument: hasDocMock,
        },
      };

      const hasDoc = await chromePlatform.hasOffscreenDocument();
      expect(hasDoc).toBe(true);
      expect(hasDocMock).toHaveBeenCalledOnce();
    });

    it('preserves asynchronous rejections from chrome.offscreen.createDocument', async () => {
      const failingMock = vi.fn().mockRejectedValue(new Error('Offscreen document already exists'));
      (
        globalThis as unknown as { chrome: { offscreen: { createDocument: typeof failingMock } } }
      ).chrome = {
        offscreen: {
          createDocument: failingMock,
        },
      };

      await expect(
        chromePlatform.createOffscreenDocument({
          url: 'src/offscreen/index.html',
          reasons: ['TEST' as chrome.offscreen.Reason],
          justification: 'test',
        })
      ).rejects.toThrow('Offscreen document already exists');
    });

    it('delegates openSidePanel with tabId to chrome.sidePanel.open', async () => {
      const openMock = vi.fn().mockResolvedValue(undefined);
      (globalThis as unknown as { chrome: { sidePanel: { open: typeof openMock } } }).chrome = {
        sidePanel: {
          open: openMock,
        },
      };

      await chromePlatform.openSidePanel({ tabId: 42 });
      expect(openMock).toHaveBeenCalledWith({ tabId: 42 });
    });

    it('delegates openSidePanel with windowId to chrome.sidePanel.open', async () => {
      const openMock = vi.fn().mockResolvedValue(undefined);
      (globalThis as unknown as { chrome: { sidePanel: { open: typeof openMock } } }).chrome = {
        sidePanel: {
          open: openMock,
        },
      };

      await chromePlatform.openSidePanel({ windowId: 99 });
      expect(openMock).toHaveBeenCalledWith({ windowId: 99 });
    });

    it('delegates openSidePanel without options to chrome.sidePanel.open with current window ID', async () => {
      const openMock = vi.fn().mockResolvedValue(undefined);
      (globalThis as unknown as { chrome: { sidePanel: { open: typeof openMock } } }).chrome = {
        sidePanel: {
          open: openMock,
        },
      };

      await chromePlatform.openSidePanel();
      expect(openMock).toHaveBeenCalledWith({ windowId: 101 });
    });

    it('delegates setSidePanelOptions to chrome.sidePanel.setOptions', async () => {
      const setOptionsMock = vi.fn().mockResolvedValue(undefined);
      (
        globalThis as unknown as { chrome: { sidePanel: { setOptions: typeof setOptionsMock } } }
      ).chrome = {
        sidePanel: {
          setOptions: setOptionsMock,
        },
      };

      await chromePlatform.setSidePanelOptions({ path: 'src/ui/sidepanel.html', enabled: true });
      expect(setOptionsMock).toHaveBeenCalledWith({
        path: 'src/ui/sidepanel.html',
        enabled: true,
      });
    });

    it('throws error when chrome.sidePanel.open is not available in the environment', async () => {
      (globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {};
      await expect(chromePlatform.openSidePanel()).rejects.toThrow(
        'chrome.sidePanel.open is not available in the current context'
      );
    });
  });
});
