// Test-only page driver; never included in a production manifest/build.
// Bundled by overlay.spec.ts and injected with addScriptTag, so it runs in the page world
// rather than the isolated world. That is fine for exercising the overlay core itself: the
// isolation properties under test are properties of the overlay's DOM (closed root, no host
// attributes), not of which world holds the reference.
import { ElementRegistry } from '../src/content/element-registry/index.js';
import { walkRegisteredDocument } from '../src/content/element-registry/walk.js';
import {
  createOverlay,
  createRegistryResolver,
  createViewportGeometry,
  type OverlayHandle,
} from '../src/content/overlay/index.js';

const registry = new ElementRegistry(document);
const overlay: OverlayHandle = createOverlay({
  document,
  window,
  resolver: createRegistryResolver(registry, document),
  geometry: createViewportGeometry(document, window),
});

function register(selector: string): { id: string; doc_id: string } {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`overlay-driver: no node for ${selector}`);
  const registration = registry.register(node, registry.docId);
  if (registration.status !== 'ok') throw new Error(`overlay-driver: ${registration.status}`);
  return { id: registration.id, doc_id: registration.doc_id };
}

/**
 * Waits for the frames the overlay needs before reporting anything.
 *
 * `refresh()` queues work for the next animation frame, so a measurement is not available
 * synchronously afterwards. Two frames cover the tick plus the `ResizeObserver` delivery that
 * can queue a follow-up tick; a third absorbs the heartbeat if it lands in between.
 */
function settleFrames(): Promise<void> {
  return new Promise((resolve) => {
    let remaining = 3;
    const step = () => {
      if (--remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

const api = {
  register,
  async annotate(selector: string, label?: string) {
    const { id, doc_id } = register(selector);
    const annotationId = overlay.update({ doc_id, element_id: id }, label ? { label } : {});
    overlay.refresh();
    await settleFrames();
    return { annotationId, elementId: id, docId: doc_id };
  },
  statusOf(annotationId: string) {
    return overlay.statusOf(annotationId);
  },
  positionOf(annotationId: string) {
    return overlay.positionOf(annotationId);
  },
  async statusOfElement(selector: string) {
    const { id, doc_id } = register(selector);
    const annotationId = overlay.update({ doc_id, element_id: id });
    overlay.refresh();
    await settleFrames();
    return overlay.statusOf(annotationId);
  },
  /** Measures the marker box inside the closed root, via elementFromPoint-independent maths. */
  markerBox() {
    const host = overlay.host;
    if (!host) return null;
    // The root is closed, so the marker is located the only way an outside observer can: the
    // rendered pixels. `getBoundingClientRect` of the host is 0x0 by design.
    return {
      hostTag: host.tagName,
      hostAttributeCount: host.attributes.length,
      hostShadowRootOpen: host.shadowRoot !== null,
      hostConnected: host.isConnected,
      hostRect: host.getBoundingClientRect().toJSON(),
    };
  },
  /**
   * Asks the page what is hit-tested at a point. Returns whether that is the overlay host, which
   * is the property that matters: with `pointer-events: none` the host must never be hit, so a
   * click reaches the page element underneath.
   */
  probeHitsHost(x: number, y: number) {
    const hit = document.elementFromPoint(x, y);
    return hit !== null && hit === overlay.host;
  },
  settle: settleFrames,
  metrics() {
    return overlay.metrics();
  },
  size() {
    return overlay.size;
  },
  isMounted() {
    return overlay.isMounted;
  },
  hostChildCount() {
    return document.documentElement.children.length;
  },
  refresh() {
    overlay.refresh();
  },
  dispose() {
    overlay.dispose();
  },
  async walk() {
    const result = await walkRegisteredDocument(document, registry);
    if (result.status !== 'complete') return { status: result.status };
    const host = overlay.host;
    return {
      status: result.status,
      targetCount: result.targets.length,
      // A host with no attributes must not reach the attribute evidence stream, and a closed
      // root must not reach the candidate or text streams. All three are asserted by identity
      // against the real walker rather than by pattern-matching ids.
      hostInAttributeEvidence: result.walk.evidence.attributeElements.some((e) => e.node === host),
      hostIsCandidate: result.walk.candidates.some((c) => c.node === host),
      textHasOverlayLabel: JSON.stringify(
        result.walk.evidence.textNodes.map((e) => e.node.data)
      ).includes('overlay-label-canary'),
      markerInPageTree: document.querySelectorAll('.marker').length,
    };
  },
  registryDocId() {
    return registry.docId;
  },
};

Object.defineProperty(window, '__overlayTest', { value: api, configurable: true });
document.documentElement.setAttribute('data-overlay-ready', 'true');
