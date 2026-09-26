import { createDemoController } from './controller.js';
import { createStorageThemeStore } from './settings.js';
import { mountSidePanel } from './sidepanel-view.js';
// The shell's own stylesheet: the kit's tokens plus the sources for the classes this shell uses.
import './sidepanel.css';
import { activePlatform } from '../platform/active.js';

const root = document.querySelector<HTMLElement>('#root');

if (root) {
  const controller = createDemoController({
    themeStore: createStorageThemeStore(activePlatform.browser.storage.local),
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
