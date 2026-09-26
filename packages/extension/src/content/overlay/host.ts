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
 * Critical host properties are declared `!important` on purpose. Shadow-tree `:host` rules
 * already outrank ordinary page rules, but an author stylesheet using `!important` (a
 * `div { pointer-events: auto !important }` reset is not unusual in a CSS framework) would
 * otherwise be able to make the overlay clickable and block the page. Nothing about the
 * overlay's appearance justifies weakening that.
 */
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

  // Attached to <html>, not <body>: a page that replaces or empties <body> during a
  // navigation or a single-page-app re-render cannot silently take the overlay with it.
  const container = document.documentElement;
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
    },
  };
}
