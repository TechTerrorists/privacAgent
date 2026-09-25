import { createDemoController } from './controller.js';
import { createStorageThemeStore } from './settings.js';
import { mountSidePanel } from './sidepanel-view.js';
import '@privacagent/ui-kit/tokens.css';
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
