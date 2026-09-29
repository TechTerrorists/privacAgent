/** F-02: one owner per on-demand content-script injection. F-08 rides on the same overlay. */
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
import {
  createCompanionController,
  createCompanionPreference,
  createCompanionRenderer,
  createCompanionResolver,
  createPointerSource,
  type CompanionController,
} from '../companion/index.js';
import type { PreferenceArea, PreferenceChangeSource } from '../../preferences.js';

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
  /**
   * F-08's companion, bound to the overlay above rather than to a host of its own. Also starts
   * disabled: `createCompanionPreference` below turns it on only if the user has asked for it, so
   * a session created on a page nobody has enabled it for adds nothing to the DOM and no pointer
   * listener to the window.
   */
  companion: CompanionController;
  dispose: () => void;
}

/** `storage.local` behind the narrow `PreferenceArea` shape, so the preference stays testable. */
const storageArea: PreferenceArea = {
  get: (key) => browser.storage.local.get(key) as Promise<Record<string, unknown>>,
  set: (items) => browser.storage.local.set(items),
};

/** `storage.onChanged` behind the narrow `PreferenceChangeSource` shape. */
const storageChanges: PreferenceChangeSource = {
  subscribe: (listener) => {
    const handler = (changes: Record<string, { newValue?: unknown }>, areaName: string): void => {
      if (areaName !== 'local') return;
      for (const [key, change] of Object.entries(changes)) listener(key, change.newValue);
    };
    browser.storage.onChanged.addListener(handler);
    return () => browser.storage.onChanged.removeListener(handler);
  },
};

export function startContentSession(document: Document): ContentSession {
  const registry = new ElementRegistry(document);
  const win = document.defaultView as Window;

  /**
   * One pointer source, shared. The resolver reads it to turn the cursor into a target rectangle
   * and the controller writes it by attaching the listener, so they must be the same cache — two
   * sources would let the companion resolve against a position the controller is not tracking.
   */
  const pointer = createPointerSource(win);

  const resolver = createCompanionResolver(createRegistryResolver(registry, document), pointer);

  const overlay = createOverlay({
    document,
    window: win,
    // The companion's synthetic anchor is answered from the pointer; every other anchor falls
    // through to the registry exactly as before.
    resolver,
    geometry: createViewportGeometry(document, win),
    // Wraps the layer's default renderer rather than replacing it, so F-03's primitives can be
    // composed in the same host and this remains the only host on the page.
    renderer: createCompanionRenderer(),
  });

  const companion = createCompanionController({ overlay, resolver, pointer });

  /**
   * The companion follows a cursor, and there is only one cursor, so it belongs in the top frame.
   *
   * A subframe gets no companion at all: no preference read, no change subscription, no pointer
   * listener. Comparing window references is safe across origins, unlike touching `top.document`,
   * so this works in a sandboxed third-party iframe where almost nothing else does.
   */
  const isTopFrame = (() => {
    try {
      return win.top === win.self;
    } catch {
      // A frame that refuses the comparison is certainly not the top one.
      return false;
    }
  })();

  // Read the stored value before subscribing, so an enabled companion appears once rather than
  // flashing the default and correcting itself. The default is off, so the failure mode of a
  // storage error is the absence of a character rather than an unexplained one.
  const preference = isTopFrame
    ? createCompanionPreference({
        area: storageArea,
        changes: storageChanges,
        controller: companion,
        onError: () => undefined,
      })
    : null;
  if (preference !== null) {
    void preference.hydrate();
    preference.subscribe();
  }

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
    if (change.scope === 'top') {
      // Order matters: the layer is told first, because it is the one that knows its annotations
      // are gone, and the companion only learns about it second-hand.
      overlay.clear();
      // The companion is still enabled, and enabling is a user setting that survives a navigation,
      // so it has to redraw against the new generation. Pointer movement cannot do this for it:
      // it asks the layer to re-measure what it already holds, and it now holds nothing.
      companion.forgetAnchor();
    } else {
      overlay.refresh();
    }
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
    companion,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      extraction?.dispose();
      browser.runtime.onMessage.removeListener(probe);
      unsubscribeGeneration();
      // Preference first: it holds the only subscription that can turn the companion back on, so
      // it has to be gone before the controller that obeys it is disposed.
      preference?.dispose();
      // The companion releases its own annotation and the pointer listener, which is what lets the
      // overlay's `size` reach zero and stop the layer's heartbeat.
      companion.dispose();
      // Overlay first: its targets are registry nodes, and nothing should be able to resolve
      // an id after the registry that owns it has been disposed.
      overlay.dispose();
      registry.dispose();
    },
  };
}
