// Test-only on-demand reinjection control; absent from production bundles.
import browser from 'webextension-polyfill';
browser.runtime.onMessage.addListener((message: unknown, sender: browser.Runtime.MessageSender) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'b05:test:reinject' &&
    sender.tab?.id !== undefined
  ) {
    return browser.scripting
      .executeScript({
        target: { tabId: sender.tab.id, frameIds: [0] },
        files: ['content/index.js'],
      })
      .then(() => true);
  }
  return undefined;
});
