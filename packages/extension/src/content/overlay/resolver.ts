/**
 * F-02: the production {@link TargetResolver}, delegating to the B-05 element registry.
 *
 * This file exists to make one rule structural rather than aspirational: the overlay does not
 * own element identity. It has no id table, no id generation, and no way to revalidate an id;
 * every lookup goes through the registry that B-02 already registered elements with. Deleting
 * this file and the one line that constructs it would remove the entire coupling.
 */
import type { ElementRegistry } from '../element-registry/index.js';
import type { OverlayAnchor, ResolveResult, TargetResolver } from './types.js';

/** Vision-only ids are executed by coordinates (A-08/A-09); there is no node to anchor to. */
function isVisionOnly(id: string): boolean {
  return id.startsWith('v');
}

export function createRegistryResolver(
  registry: ElementRegistry,
  topDocument: Document
): TargetResolver {
  return {
    currentDocId() {
      return registry.isDisposed ? null : registry.docId;
    },

    resolve(anchor: OverlayAnchor): ResolveResult {
      if (registry.isDisposed) return { status: 'stale' };
      if (isVisionOnly(anchor.element_id)) return { status: 'unsupported' };

      const resolution = registry.resolve(anchor.element_id, anchor.doc_id);
      if (resolution.status !== 'ok') {
        // A disposed registry is a retired document, which is a staleness problem for the
        // caller rather than a missing element.
        return { status: resolution.status === 'disposed' ? 'stale' : resolution.status };
      }

      const { element } = resolution;
      if (!element.isConnected) return { status: 'missing' };

      // Defence in depth for the coordinate contract below. The registry scopes registrations
      // to its own document set, so a node from another document is never resolvable today;
      // asserting it here keeps the invariant local to the code that depends on it, so a future
      // registry that widens its scope cannot silently start feeding frame-local rectangles
      // into a viewport-coordinate positioner.
      if (element.ownerDocument !== topDocument) return { status: 'unsupported' };

      const rect = element.getBoundingClientRect();
      return {
        status: 'ok',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        element,
      };
    },
  };
}

/**
 * Measures the box that `position: fixed` resolves against: the initial containing block.
 * That is the document element's client box, not `innerWidth`/`innerHeight`, which disagree
 * when a scrollbar or a pinch-zoom viewport is in play, and not `visualViewport`, which
 * tracks the pinch-zoomed area rather than the layout viewport a fixed marker belongs to.
 */
export function createViewportGeometry(document: Document, win: Window) {
  return {
    viewport(): { x: 0; y: 0; width: number; height: number } {
      const element = document.documentElement;
      const width = element?.clientWidth || win.innerWidth;
      const height = element?.clientHeight || win.innerHeight;
      return { x: 0, y: 0, width, height };
    },
  };
}
