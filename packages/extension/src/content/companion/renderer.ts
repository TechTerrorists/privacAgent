/**
 * F-08: the renderer seam.
 *
 * F-02's `OverlayRenderer` is created once per layer and dispatches on `spec.kind`. F-08 therefore
 * cannot add a kind to an existing renderer from outside it — the dispatcher is a closed `switch`
 * over F-03's seven kinds.
 *
 * The answer is a **composite**, not a second host. `createCompanionRenderer` takes the layer's
 * existing renderer and forwards every kind it recognises to it unchanged, handling only
 * `'companion'` itself. F-03's seven primitives keep working through it, the layer still has one
 * host, one closed shadow root, one annotation registry, one frame coalescer and one heartbeat,
 * and the companion is simply one more annotation on it.
 *
 * This is the difference between a feature that extends the layer and a feature that forks it.
 * Nothing here re-implements placement, clamping, lifecycle, or the frame loop; a kind F-08 does
 * not recognise is refused rather than drawn as a blank box.
 */
import { COMPANION_STYLE_SHEET } from './character.js';
import { COMPANION_KIND, CompanionPrimitive } from './primitive.js';
import { markerRenderer } from '../overlay/marker-renderer.js';
import type { OverlayPrimitive, OverlayRenderer } from '../overlay/types.js';

/**
 * Installs the companion's stylesheet into the core's **existing** root.
 *
 * `adoptedStyleSheets` is preferred over a `<style>` element because F-02's host already builds one
 * that way under a page's hostile CSP, and appending a second `<style>` would reintroduce exactly
 * the inline-style rejection that F-02's adopted-stylesheet path exists to survive. The `<style>`
 * branch is the fallback for environments without constructable stylesheets, where F-02's host has
 * already established the same pattern.
 */
function installCompanionStyles(root: ShadowRoot, document: Document): void {
  const supportsAdopted = 'adoptedStyleSheets' in Document.prototype;
  if (supportsAdopted) {
    try {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, new CSSStyleSheet()];
      const sheet = root.adoptedStyleSheets[root.adoptedStyleSheets.length - 1]!;
      sheet.replaceSync(COMPANION_STYLE_SHEET);
      return;
    } catch {
      // Constructable stylesheets are unavailable or rejected. Fall through to the element form
      // rather than leaving the companion unstyled: an unstyled character would still be correct
      // in shape but would inherit page colours and lose its contrast guarantee.
    }
  }
  const style = document.createElement('style');
  style.textContent = COMPANION_STYLE_SHEET;
  root.append(style);
}

/**
 * Wraps `base` so it also draws the companion.
 *
 * `base` defaults to F-02's own marker renderer, so a layer that has not adopted F-03 still gets a
 * working companion — the composite is what makes F-08 usable before and after F-03 independently.
 */
export function createCompanionRenderer(base: OverlayRenderer = markerRenderer): OverlayRenderer {
  return {
    install(root, document) {
      // The base renderer installs its own stylesheet first, then this one, so the two cascade
      // in declaration order and a future overlapping selector resolves predictably.
      base.install(root, document);
      installCompanionStyles(root, document);
    },

    create(document, spec, context): OverlayPrimitive {
      if (spec.kind === COMPANION_KIND) {
        return new CompanionPrimitive(document, spec, context);
      }
      return base.create(document, spec, context);
    },

    /**
     * Reuse is decided by the base renderer for everything it owns. The companion never reuses,
     * even against itself, because the five silhouettes share no geometry and a morph between a
     * chevron and a ring would mean rewriting every path attribute on each state change. A
     * rebuild is a handful of element allocations against a transition the user sees once.
     */
    canReuse(previous, next) {
      if (previous.kind === COMPANION_KIND || next.kind === COMPANION_KIND) return false;
      return base.canReuse(previous, next);
    },
  };
}
