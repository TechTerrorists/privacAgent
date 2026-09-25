// Test-only content script; never included in a production manifest/build.
import browser from 'webextension-polyfill';
import '../src/content/index.js';
import { walkRegisteredDocument } from '../src/content/element-registry/walk.js';
import type { ElementRegistry } from '../src/content/element-registry/index.js';

const owner = globalThis as typeof globalThis & {
  __privacAgentRegistry: { registry: ElementRegistry };
};
let prior: { id: string; doc_id: string } | undefined;
let changes = 0;
let persisted = false;
addEventListener('pageshow', (event) => {
  persisted = event.persisted;
});
let registry = owner.__privacAgentRegistry.registry;
registry.onGenerationChange(() => changes++);
document.addEventListener('b05:test:request', () => {
  void (async () => {
    const command = document.documentElement.getAttribute('data-b05-command');
    const walk = command === 'walk' ? await walkRegisteredDocument(document, registry) : undefined;
    const targetCount = walk?.status === 'complete' ? walk.targets.length : undefined;
    const oldRegistry = registry;
    if (command === 'fallback') {
      registry.dispose();
      Object.defineProperty(window, 'navigation', { value: undefined, configurable: true });
    }
    if (command === 'reinject' || command === 'fallback')
      await browser.runtime.sendMessage({ type: 'b05:test:reinject' });
    registry = owner.__privacAgentRegistry.registry;
    const target = document.querySelector('#b05-target') ?? document.querySelector('button');
    if (!target) throw new Error('Test fixture needs a button');
    const item = registry.register(target, registry.docId);
    const previousStatus = prior ? registry.resolve(prior.id, prior.doc_id).status : null;
    const disposed = prior
      ? oldRegistry.resolve(prior.id, prior.doc_id).status === 'disposed'
      : false;
    if (item.status === 'ok') prior = item;
    document.documentElement.setAttribute(
      'data-b05-result',
      JSON.stringify({ item, previousStatus, changes, disposed, persisted, targetCount })
    );
  })().catch(() =>
    document.documentElement.setAttribute('data-b05-result', JSON.stringify({ error: true }))
  );
});
document.documentElement.setAttribute('data-b05-ready', 'true');
