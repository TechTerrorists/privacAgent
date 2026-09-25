import browser from 'webextension-polyfill';
import { ElementRegistry } from './index.js';

/** An owner for one on-demand content-script injection. */
export function startRegistrySession(document: Document): {
  registry: ElementRegistry;
  dispose: () => void;
} {
  const registry = new ElementRegistry(document);
  const probe = (
    message: unknown,
    sender: browser.Runtime.MessageSender
  ): Promise<boolean> | undefined => {
    if (
      sender.id === browser.runtime.id &&
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'privacagent:b05:active'
    )
      return Promise.resolve(true);
    return undefined;
  };
  browser.runtime.onMessage.addListener(probe);
  return {
    registry,
    dispose: () => {
      browser.runtime.onMessage.removeListener(probe);
      registry.dispose();
    },
  };
}
