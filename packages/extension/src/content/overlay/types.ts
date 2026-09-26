/**
 * F-02: overlay anchoring contract.
 *
 * Guidance only. An annotation is a visual hint tied to an element identity, never an
 * approval, a confirmation, or a place to put a secret. Everything the overlay draws is
 * derived from a bounding box; no page text, value, or attribute is read into the overlay.
 *
 * Coordinate convention: every rectangle in this file is in **CSS viewport coordinates**
 * (`getBoundingClientRect` space), the same space `position: fixed` consumes. That is a
 * deliberate, narrow choice. A-08 owns page/viewport/image/frame conversion, so this module
 * never converts, and a target it cannot address in viewport space is reported as
 * `unsupported` instead of being silently reinterpreted.
 */
import type { DocumentId, ElementId } from '@privacagent/protocol';

/** Opaque handle for one annotation, stable for the lifetime of that annotation. */
export type AnchorId = string;

/**
 * A target is only addressable together with the document generation that issued its
 * element id. Caching the id alone is a bug: `doc_id` changing retires every id from the
 * previous generation, including ids that still point at a live, similar-looking node.
 */
export interface OverlayAnchor {
  readonly doc_id: DocumentId;
  readonly element_id: ElementId;
}

/** A rectangle in CSS viewport coordinates. */
export interface ViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What the overlay knows about one annotation. Only `visible` and `offscreen` draw; the
 * rest remove the marker from the page and are reported to the caller so a stale hint is
 * never left on screen.
 *
 * - `stale`: the document generation moved on, so the id no longer identifies this target.
 * - `missing`: the id is unknown to the registry, or its node is detached.
 * - `hidden`: the node is connected but renders no area (`display: none`, `visibility: hidden`,
 *   zero size).
 * - `unsupported`: the target cannot be addressed in viewport coordinates yet. Cross-frame
 *   and vision-only (`v…`) ids land here until A-08/A-09 land; they are never approximated.
 */
export type AnchorStatus = 'visible' | 'offscreen' | 'hidden' | 'stale' | 'missing' | 'unsupported';

export const DRAWING_STATUSES: readonly AnchorStatus[] = ['visible', 'offscreen'];

export type ResolveResult =
  | { readonly status: 'ok'; readonly rect: ViewportRect; readonly element: Element | null }
  /**
   * Connected, but not rendered: `display: none`, or `visibility: hidden`/`collapse`. The node
   * comes back so the caller can keep observing it — a target that gains a box again notifies
   * `ResizeObserver`, which is a faster signal than the heartbeat for a modal or disclosure
   * opening. No rectangle is reported, because a box is not what makes a target visible.
   */
  | { readonly status: 'hidden'; readonly element: Element | null }
  | { readonly status: 'missing' | 'stale' | 'unsupported' };

/**
 * Target resolution is injected so tests can map synthetic ids to known nodes, and so this
 * module never grows a second element registry. The production implementation delegates to
 * the B-05 registry; there is no fallback path that could compete with it.
 */
export interface TargetResolver {
  /**
   * The current document generation, or `null` when the document is no longer addressable
   * (navigated away, disposed, or the overlay was torn down mid-frame).
   */
  currentDocId(): DocumentId | null;
  resolve(anchor: OverlayAnchor): ResolveResult;
}

/** Viewport measurement is injected so headless unit tests need no real window. */
export interface OverlayGeometry {
  viewport(): ViewportRect;
}

export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'auto';

/** A marker's resolved position, as reported by {@link OverlayHandle.positionOf}. */
export interface MarkerPosition {
  readonly x: number;
  readonly y: number;
  readonly placement: Exclude<Placement, 'auto'>;
  /** True when the marker had to be pulled inside the viewport to stay on screen. */
  readonly clamped: boolean;
}

export interface AnnotationOptions {
  /** Defaults to `auto`, which prefers `bottom` and flips when the target is near an edge. */
  readonly placement?: Placement;
  /** Gap between the target edge and the marker, in CSS pixels. Defaults to 8. */
  readonly offset?: number;
  /**
   * Short label drawn inside the marker. Used for test markers and later for F-03's label
   * primitive. Treated as untrusted text and written with `textContent`, never as markup.
   */
  readonly label?: string;
}

export interface OverlayMetrics {
  /** Animation frames the overlay actually ran. */
  readonly frames: number;
  /** Frames that wrote at least one transform. */
  readonly updates: number;
  /** Longest single frame, the number the PRD's "no long task > 50 ms" budget cares about. */
  readonly longestFrameMs: number;
}

export interface OverlayHandle {
  /** Creates the host and its closed shadow root. Idempotent; a no-op after `dispose`. */
  mount(): void;
  /** Adds or re-points an annotation and returns its stable id. */
  update(anchor: OverlayAnchor, options?: AnnotationOptions): AnchorId;
  /**
   * Re-measures on the next frame without any other signal. Needed when something changed that
   * fires no DOM event, such as the document generation advancing: a stale marker must not sit
   * on screen waiting for the next scroll.
   */
  refresh(): void;
  remove(id: AnchorId): void;
  clear(): void;
  /** Tears down nodes, observers, listeners, pending frames and target references. Idempotent. */
  dispose(): void;
  readonly isMounted: boolean;
  readonly isDisposed: boolean;
  /** Live annotation count; zero means no frame loop is running. */
  readonly size: number;
  statusOf(id: AnchorId): AnchorStatus | 'unknown';
  /**
   * Where the marker currently sits, in viewport coordinates, or `null` when it is not being
   * drawn. A closed shadow root means this accessor is the only way to read a marker's
   * position, which later primitives need anyway: F-03 draws leader lines back to a clamped or
   * occluded marker, and F-08 needs the box to place its companion UI.
   */
  positionOf(id: AnchorId): MarkerPosition | null;
  metrics(): OverlayMetrics;
  /**
   * The host element, for the extension's own use and for tests. This is not an in-page
   * escape hatch: the handle never reaches the page, and the shadow root stays closed, so
   * `host.shadowRoot` is `null` for page script.
   */
  readonly host: Element | null;
}

export interface OverlayOptions {
  readonly document: Document;
  readonly window: Window;
  readonly resolver: TargetResolver;
  readonly geometry?: OverlayGeometry;
  /** Frame source. Defaults to `requestAnimationFrame` on the supplied window. */
  readonly scheduler?: FrameScheduler;
  /**
   * How many times a host removed by page script is re-created before the overlay gives up
   * and reports it. Bounded on purpose: a page that deletes the host on every insertion must
   * not be able to start an endless reinsertion loop.
   */
  readonly maxHostRecoveries?: number;
  readonly onStatusChange?: (id: AnchorId, status: AnchorStatus) => void;
  readonly onHostUnrecoverable?: () => void;
}

/** Frame source for position updates. Mirrors the B-02 scheduler shape so fakes look alike. */
export interface FrameScheduler {
  now(): number;
  /** Must invoke asynchronously at most once per requested frame; returns a canceller. */
  request(callback: (timestamp: number) => void): () => void;
}
