/**
 * F-02: isolated overlay core.
 *
 * A guidance-only overlay anchored to element identity. Consumers (F-03 visual primitives,
 * F-08 companion) add or move annotations by `(doc_id, element_id)`; the core owns the host,
 * the closed shadow root, the frame budget, and the cleanup.
 *
 * See `README.md` for the host/layer contract and the coordinate-space limitation.
 */
export { createOverlay } from './controller.js';
export { createRegistryResolver, createViewportGeometry } from './resolver.js';
export {
  createFrameScheduler,
  createManualFrameScheduler,
  FrameCoalescer,
  HEARTBEAT_MS,
} from './scheduler.js';
export { computePlacement, intersectsViewport, isRenderable } from './positioner.js';
export { mountOverlayHost, MARKER_SIZE } from './host.js';
export { DRAWING_STATUSES } from './types.js';
export type {
  AnchorId,
  AnchorStatus,
  AnnotationOptions,
  FrameScheduler,
  MarkerPosition,
  OverlayAnchor,
  OverlayGeometry,
  OverlayHandle,
  OverlayMetrics,
  OverlayOptions,
  Placement,
  ResolveResult,
  TargetResolver,
  ViewportRect,
} from './types.js';
export type { MarkerSize, PlacementResult } from './positioner.js';
export type { OverlayHost } from './host.js';
