/**
 * F-02: the overlay host and its closed shadow root.
 *
 * Two properties of this file are load-bearing for other features, so they are deliberate:
 *
 * 1. **The host carries no attributes.** B-02's walker reports an element as raw page
 *    evidence when it has a role, an `on*` handler, or *any* attribute at all. A host with a
 *    `data-` marker, an id, or an inline `style` would show up in the evidence the perception
 *    pipeline reads as if the page had put it there. So the host is a bare `div` and the
 *    extension keeps its only reference in the isolated world. A closed shadow root makes the
 *    contents unreachable to the walker as well: `element.shadowRoot` is `null` for page
 *    script, and a closed root is not traversed by in-page observation.
 *
 * 2. **The host is not interactive and not in flow.** `pointer-events: none` plus a
 *    zero-sized fixed box means the overlay cannot scroll the page, cannot take a click, and
 *    cannot shift layout. Page interactions are unaffected even while annotations are drawn.
 */
/**
 * Critical host properties, declared twice for two different cascade levels.
 *
 * The `:host` rules inside `HOST_STYLES` are what `all: initial` resets and what the `*`
 * click-through reset apply to, and they win against any *ordinary* page rule. They are not
 * sufficient on their own, though, because the cascade reverses importance across the shadow
 * boundary: **an outer-tree `!important` declaration outranks a shadow-tree `!important` one**. A
 * page reset of the very shape a CSS framework actually ships —
 * `html > div { position: static !important; pointer-events: auto !important }` — therefore beats
 * `:host { position: fixed !important; pointer-events: none !important }` outright, which turns the
 * host into a full-width, static, clickable block sitting in the page's own layout. That breaks
 * both halves of rule 3 at once: it takes clicks, and it reflows the page.
 *
 * The fix is a second, outer-tree rule for the host *element*, because within one origin a higher
 * specificity wins at equal importance.
 *
 * Two obvious routes to those outer-tree rules are both unusable, which is worth recording:
 *
 * - **An inline `style` on the host** would win, but a host carrying a `style` attribute is
 *   reported by B-02's walker as raw page evidence, which is the exact leak this file exists to
 *   prevent.
 * - **A `<style>` element in the page** is invisible to the walker (`style` is in its ignored set,
 *   checked before its attribute rule) and has high specificity, but it is inline CSS, so it is
 *   subject to the page's `style-src`. `style-src 'self'` — which most real sites ship — blocks it,
 *   and a blocked `<style>` fails *silently*: `element.sheet` is `null` and its rules simply never
 *   apply. A protection mechanism that quietly does nothing is worse than none.
 *
 * A constructed stylesheet adopted into the document avoids both problems. It is not inline CSS and
 * is not a fetch, so `style-src` does not govern it; it adds no node to the page tree, so the
 * walker has nothing to see; and it lives in the document's own author origin, where specificity
 * settles the comparison with the page's reset. The `<style>` element is kept only as a fallback for
 * an engine without adopted stylesheets, where the same CSP will block it and the `:host` rules
 * remain the only line of defence.
 *
 * The selector matches the host and, on any real document, nothing else: browsers relocate stray
 * element children of `<html>` into `<body>`, so `<html>`'s only element children are `head`,
 * `body`, and this host. `:not([id]):not([class])` narrows it further, since the host deliberately
 * carries neither.
 */
const HOST_ELEMENT_STYLES = `
html > div:nth-of-type(n):not([id]):not([class]) {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 0 !important;
  height: 0 !important;
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  pointer-events: none !important;
  z-index: 2147483647 !important;
  overflow: visible !important;
  isolation: isolate !important;
}
`;

const HOST_STYLES = `
:host {
  all: initial !important;
  display: block !important;
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 0 !important;
  height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  pointer-events: none !important;
  z-index: 2147483647 !important;
  overflow: visible !important;
  isolation: isolate !important;
}
* { box-sizing: border-box; }
/* Rule 3 of the F-03 contract, stated once for the whole tree rather than per primitive: nothing
   in this layer is ever interactive. A full-viewport spotlight is the case that makes this
   structural rather than stylistic — it covers the page by design, and a single primitive that
   forgot pointer-events: none would swallow clicks across the entire screen. Declared !important so an
   author stylesheet cannot re-enable it, matching the rest of this sheet. */
*, *::before, *::after { pointer-events: none !important; }
.marker {
  position: fixed;
  top: 0;
  left: 0;
  pointer-events: none;
  will-change: transform;
  transform: translate3d(-10000px, -10000px, 0);
}
.marker > .dot {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 7px;
  background: #1a56db;
  box-shadow: 0 0 0 2px #ffffff;
}
.marker > .label {
  display: block;
  max-width: 220px;
  margin-top: 2px;
  padding: 1px 4px;
  border-radius: 3px;
  background: #1a56db;
  color: #ffffff;
  font: 500 11px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.marker[data-status="visible"] { display: block; }
/* An off-screen target draws nothing: a marker clamped to the window edge would point at a
   control the user cannot see, and the executor re-observes rather than guessing. */
.marker[data-status="offscreen"],
.marker[data-status="hidden"],
.marker[data-status="stale"],
.marker[data-status="missing"],
.marker[data-status="unsupported"] { display: none; }
`;

/** Marker box, including the label column, used by the positioner for edge clamping. */
export const MARKER_SIZE = { width: 14, height: 14 } as const;

export interface OverlayHost {
  readonly host: HTMLElement;
  /** Closed root. Never handed to page script, and `host.shadowRoot` stays `null`. */
  readonly root: ShadowRoot;
  /** Re-appends the host after page script removed it. Returns false once the budget is spent. */
  recover(): boolean;
  readonly recoveries: number;
  /** Detaches the host and stops watching for its removal. */
  destroy(): void;
}

interface CriticalHostStyle {
  /** Re-applies the style if the page removed the sheet, the node, or replaced the whole list. */
  reinstall(): void;
  /** Total removal, so `dispose()` leaves the document exactly as it found it. */
  remove(): void;
}

/**
 * Installs the outer-tree half of the critical host style, preferring a constructed stylesheet.
 *
 * The adopted-stylesheet path is the one that actually works on a locked-down page, and the
 * fallback exists only for engines that predate it. Whichever path is taken, the caller gets the
 * same two verbs, and both are safe to call more than once — the reconciler below re-adds rather
 * than duplicates, because a page that clears `adoptedStyleSheets` is a page to be resilient to
 * rather than to fight.
 */
function installCriticalHostStyle(doc: Document): CriticalHostStyle {
  const supportsAdopted =
    'adoptedStyleSheets' in doc &&
    typeof CSSStyleSheet === 'function' &&
    'replaceSync' in CSSStyleSheet.prototype;

  if (supportsAdopted) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(HOST_ELEMENT_STYLES);
    const adopt = (): void => {
      if (!doc.adoptedStyleSheets.includes(sheet)) {
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      }
    };
    adopt();
    return {
      reinstall: adopt,
      remove: () => {
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((entry) => entry !== sheet);
      },
    };
  }

  // Firefox below 101. A page with `style-src 'self'` will block this silently, which leaves the
  // `:host` rules as the only defence — the documented position, not a pretend guarantee.
  const element = doc.createElement('style');
  element.textContent = HOST_ELEMENT_STYLES;
  const parent = doc.head ?? doc.documentElement;
  parent.append(element);
  return {
    reinstall: () => {
      if (!element.isConnected) parent.append(element);
    },
    remove: () => element.remove(),
  };
}

export function mountOverlayHost(
  document: Document,
  {
    maxRecoveries = 3,
    onUnrecoverable,
  }: { maxRecoveries?: number; onUnrecoverable?: () => void } = {}
): OverlayHost {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = HOST_STYLES;
  root.append(style);

  const container = document.documentElement;

  // The outer-tree half of the critical host style. See the note on HOST_ELEMENT_STYLES for why
  // this is an adopted stylesheet and not an inline style attribute or a page `<style>`.
  const critical = installCriticalHostStyle(document);

  // The host itself is attached to <html>, not <body>: a page that replaces or empties <body>
  // during a navigation or a single-page-app re-render cannot silently take the overlay with it.
  container.append(host);

  let recoveries = 0;
  let destroyed = false;
  const budget = Number.isInteger(maxRecoveries) && maxRecoveries >= 0 ? maxRecoveries : 3;
  let exhausted = false;

  // Page script that removes the host is treated as a hostile or self-cleaning document. The
  // overlay re-creates itself a bounded number of times and then reports and stops, rather
  // than fighting the page in a loop that would burn frames forever.
  const observer = new MutationObserver(() => {
    if (destroyed || exhausted || host.isConnected) return;
    if (recoveries >= budget) {
      exhausted = true;
      observer.disconnect();
      onUnrecoverable?.();
      return;
    }
    if (recover()) recoveries++;
  });
  observer.observe(container, { childList: true });

  function recover(): boolean {
    if (destroyed || host.isConnected) return false;
    // A page that removed one of these has shown it will remove the other, and a host with no
    // critical style behind it is a page-perturbing block rather than an overlay.
    critical.reinstall();
    container.append(host);
    return host.isConnected;
  }

  return {
    host,
    root,
    recover,
    get recoveries() {
      return recoveries;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      host.remove();
      critical.remove();
    },
  };
}
