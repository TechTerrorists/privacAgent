/** F-02: one owner per on-demand content-script injection. */
import browser from 'webextension-polyfill';
import { IncrementalSession } from '../incremental/index.js';
import { ownedNodes } from '../owned-nodes.js';
import { ElementRegistry } from './index.js';
import {
  createOverlay,
  createRegistryResolver,
  createViewportGeometry,
  type OverlayHandle,
} from '../overlay/index.js';

export interface ContentSession {
  registry: ElementRegistry;
  /** Lazily installed, on-demand B-06 observation owner. */
  readonly extraction: IncrementalSession;
  /**
   * The overlay core, owned here so it is torn down with the session that created it. It is
   * constructed but not mounted: a page that never annotates gets no nodes, no observers and
   * no listeners, and `update()` is what brings the host to life.
   */
  overlay: OverlayHandle;
  dispose: () => void;
}

export function startContentSession(document: Document): ContentSession {
  const registry = new ElementRegistry(document);
  const overlay = createOverlay({
    document,
    window: document.defaultView as Window,
    resolver: createRegistryResolver(registry, document),
    geometry: createViewportGeometry(document, document.defaultView as Window),
  });
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

  // A retired document generation invalidates every element id at once. A top-level change is a
  // navigation, so the annotations are dropped outright; a child document change only
  // invalidates that subtree's ids, so the survivors are re-measured instead. Without this the
  // overlay would keep drawing against ids that no longer mean anything until the next scroll.
  const unsubscribeGeneration = registry.onGenerationChange((change) => {
    if (change.scope === 'top') overlay.clear();
    else overlay.refresh();
  });

  let extraction: IncrementalSession | undefined;
  let disposed = false;
  return {
    get extraction() {
      if (disposed) throw new Error('Content session disposed');
      return (extraction ??= new IncrementalSession(document, { ownedNodes }, registry));
    },
    registry,
    overlay,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      extraction?.dispose();
      browser.runtime.onMessage.removeListener(probe);
      unsubscribeGeneration();
      // Overlay first: its targets are registry nodes, and nothing should be able to resolve
      // an id after the registry that owns it has been disposed.
      overlay.dispose();
      registry.dispose();
    },
  };
}
