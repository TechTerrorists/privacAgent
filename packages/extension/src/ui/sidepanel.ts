import { createDemoController } from './controller.js';
import { createStorageCompanionStore, createStorageThemeStore } from './settings.js';
import { mountSidePanel } from './sidepanel-view.js';
// The shell's own stylesheet: the kit's tokens plus the sources for the classes this shell uses.
import './sidepanel.css';
import { activePlatform } from '../platform/active.js';

const root = document.querySelector<HTMLElement>('#root');

if (root) {
  const controller = createDemoController({
    themeStore: createStorageThemeStore(activePlatform.browser.storage.local),
    // F-08: the companion's toggle has to be storage-backed for the same reason the theme is. The
    // content script watches `browser.storage`, not this controller, so a toggle that only moved
    // in-memory state would leave every open tab untouched and the checkbox lying about the page.
    // Omitting this silently falls back to an in-memory store, which is a working-looking panel
    // that controls nothing.
    companionStore: createStorageCompanionStore(activePlatform.browser.storage.local),
  });
  const handle = mountSidePanel(root, controller);
  const dispose = (): void => {
    window.removeEventListener('pagehide', dispose);
    handle.dispose();
    controller.dispose();
  };
  window.addEventListener('pagehide', dispose, { once: true });
}

export {};
