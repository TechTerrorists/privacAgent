/**
 * F-02: the overlay controller.
 *
 * Lifecycle contract, which is the part later features (F-03 primitives, F-08 companion) will
 * lean on:
 *
 * - Nothing is created until the first `update()`. A content script that never annotates adds
 *   no nodes, no observers, and no listeners to the page.
 * - The tracking loop is event-driven and stops when the last annotation goes away, so an idle
 *   page costs nothing. See `scheduler.ts` for why this is not a self-perpetuating rAF loop.
 * - Every frame does all its reads before all its writes, so measuring many targets cannot
 *   trigger layout thrash.
 * - `dispose()` is total and idempotent: no node, observer, listener, pending frame, heartbeat
 *   interval, or target reference survives it.
 */
import { mountOverlayHost, type OverlayHost } from './host.js';
import { markerRenderer, type MarkerSpec } from './marker-renderer.js';
import { computePlacement, intersectsViewport, isRenderable } from './positioner.js';
import { createFrameScheduler, FrameCoalescer, HEARTBEAT_MS } from './scheduler.js';
import type {
  AnchorId,
  AnchorStatus,
  MarkerPosition,
  AnnotationOptions,
  OverlayAnchor,
  OverlayHandle,
  OverlayOptions,
  OverlayPrimitive,
  PrimitiveSpec,
  ResolveResult,
  ViewportRect,
} from './types.js';

/** Internal, mutable counterpart of the read-only {@link OverlayMetrics} it is reported as. */
interface MutableMetrics {
  frames: number;
  updates: number;
  longestFrameMs: number;
}

interface Annotation {
  readonly anchor: OverlayAnchor;
  /** Rebound on cross-kind replacement, so always read through the annotation, never cached. */
  node: HTMLElement;
  primitive: OverlayPrimitive;
  spec: PrimitiveSpec;
  placement: Exclude<AnnotationOptions['placement'], undefined>;
  offset: number;
  /**
   * `unset` until the first measurement, so the first real status is always reported. Seeding
   * it with a plausible status would silently swallow that first transition.
   */
  lastStatus: AnchorStatus | 'unset';
  /** Retained so `positionOf` can answer, and so a draw can be skipped when nothing moved. */
  position: MarkerPosition | null;
}

const DEFAULT_OFFSET = 8;

/**
 * Folds `AnnotationOptions` into the spec the renderer draws from.
 *
 * `label` stays a top-level option because it predates the seam and F-02's own marker uses it;
 * an annotation that supplies its own `primitive` (F-03) carries its text inside that spec
 * instead, and the core does not look inside it. That is the whole contract: the core never
 * reads a spec's fields, so F-03 can add kinds without the core learning their names.
 */
function toSpec(options: AnnotationOptions): PrimitiveSpec {
  if (options.primitive) return options.primitive;
  const spec: MarkerSpec = { kind: 'marker', ...(options.label ? { label: options.label } : {}) };
  return spec;
}

/**
 * Ceiling on simultaneous annotations, so one frame's worth of `getBoundingClientRect` calls
 * can never threaten the 50 ms long-task budget. Guidance overlays address a handful of
 * targets; asking for more is a caller bug and is reported as one.
 */
const MAX_ANNOTATIONS = 64;

function anchorKey(anchor: OverlayAnchor): AnchorId {
  // doc_id is part of the key on purpose: the same element id under a new document generation
  // is a different target, and re-pointing one annotation at it must not be confused with
  // re-asserting the old one.
  return `${anchor.doc_id}/${anchor.element_id}`;
}

export function createOverlay(options: OverlayOptions): OverlayHandle {
  const {
    document,
    window: win,
    resolver,
    geometry,
    scheduler = createFrameScheduler(win),
    maxHostRecoveries = 3,
    onStatusChange,
    onHostUnrecoverable,
    renderer = markerRenderer,
    matchMedia = (query) => (win.matchMedia ? win.matchMedia(query) : null),
  } = options;

  const measure = geometry ?? {
    viewport: () => {
      const element = document.documentElement;
      return {
        x: 0,
        y: 0,
        width: element?.clientWidth || win.innerWidth,
        height: element?.clientHeight || win.innerHeight,
      };
    },
  };

  const annotations = new Map<AnchorId, Annotation>();
  const observed = new Set<Element>();
  const metrics: MutableMetrics = { frames: 0, updates: 0, longestFrameMs: 0 };
  const coalescer = new FrameCoalescer(scheduler);

  let host: OverlayHost | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let heartbeat: number | undefined;
  let listening = false;
  let disposed = false;

  const now = (): number => scheduler.now();

  // ---------------------------------------------------------------- frame

  const tick = (): void => {
    if (disposed || annotations.size === 0) return;
    const startedAt = now();
    metrics.frames++;

    // --- read phase: no writes, so no layout is forced between measurements
    const currentDocId = resolver.currentDocId();
    const viewport = measure.viewport();
    const plan: Array<{
      annotation: Annotation;
      status: AnchorStatus;
      placement: ReturnType<typeof computePlacement> | null;
      /** The measured target box, or `null` for every status that does not draw. */
      target: ViewportRect | null;
    }> = [];
    const targets = new Set<Element>();

    for (const annotation of annotations.values()) {
      // An id from a retired document generation identifies nothing, even if some node still
      // looks like the target. Suppress the marker instead of re-pointing it.
      if (currentDocId === null || annotation.anchor.doc_id !== currentDocId) {
        plan.push({ annotation, status: 'stale', placement: null, target: null });
        continue;
      }

      const resolution = resolver.resolve(annotation.anchor);
      if (resolution.status !== 'ok') {
        // A hidden target is still observed: it notifies `ResizeObserver` the moment it gains a
        // box, which beats waiting for the heartbeat when a modal or disclosure opens.
        if (resolution.status === 'hidden' && resolution.element) targets.add(resolution.element);
        plan.push({
          annotation,
          status: fromResolution(resolution),
          placement: null,
          target: null,
        });
        continue;
      }

      if (resolution.element) targets.add(resolution.element);
      const rect = resolution.rect;
      if (!isRenderable(rect)) {
        plan.push({ annotation, status: 'hidden', placement: null, target: null });
        continue;
      }
      if (!intersectsViewport(rect, viewport)) {
        // Off screen: keep the measurement so the next frame can tell "moved out" from
        // "disappeared", but draw nothing rather than pinning a marker to an edge.
        plan.push({ annotation, status: 'offscreen', placement: null, target: null });
        continue;
      }
      plan.push({
        annotation,
        status: 'visible',
        placement: computePlacement(rect, viewport, {
          placement: annotation.placement,
          offset: annotation.offset,
          // A primitive that knows its own box (a measured label, a wide arrow) is clamped
          // against that box; the core's dot marker keeps the default.
          size: annotation.primitive.size,
        }),
        target: rect,
      });
    }

    // `ResizeObserver` catches a target changing size without any other signal. It cannot
    // catch a target that only *moved*, which is what the heartbeat is for; the observer is
    // here to keep the common resize case off the heartbeat's latency.
    if (targets.size > 0) ensureResizeObserver();
    if (resizeObserver) {
      for (const element of observed) {
        if (!targets.has(element)) resizeObserver.unobserve(element);
      }
      for (const element of targets) {
        if (!observed.has(element)) resizeObserver.observe(element);
      }
    }
    for (const element of [...observed]) if (!targets.has(element)) observed.delete(element);
    for (const element of targets) observed.add(element);

    // --- write phase: one style batch, no reads left to interleave
    let wrote = false;
    for (const { annotation, status, placement, target } of plan) {
      if (annotation.lastStatus !== status) {
        annotation.lastStatus = status;
        onStatusChange?.(anchorKey(annotation.anchor), status);
      }
      // `data-status` is the single visibility switch: the sheet hides everything that is not
      // `visible`, so a stale, missing, hidden, off-screen or unsupported target removes its own
      // decoration without the primitive having to special-case any of them. The primitive still
      // receives every status, because an animation that is in flight has to be stopped rather
      // than left running against a target that is no longer there.
      if (annotation.node.dataset.status !== status) annotation.node.dataset.status = status;

      annotation.position =
        status === 'visible' && placement
          ? {
              x: Math.round(placement.x),
              y: Math.round(placement.y),
              placement: placement.placement,
              clamped: placement.clamped,
            }
          : null;

      // Transform and opacity only. The primitive reads nothing from the DOM here: it has the
      // measured box and the viewport, so a layer of annotations writes a batch of transforms
      // with no interleaved read to force a second layout.
      const before = annotation.node.style.transform;
      annotation.primitive.update({ status, target, viewport, placement: annotation.position });
      if (annotation.node.style.transform !== before) wrote = true;
    }

    if (wrote) metrics.updates++;
    const elapsed = now() - startedAt;
    if (elapsed > metrics.longestFrameMs) metrics.longestFrameMs = elapsed;
  };

  const scheduleTick = (): void => {
    if (disposed || annotations.size === 0) return;
    coalescer.schedule(tick);
  };

  function fromResolution(resolution: ResolveResult): AnchorStatus {
    return resolution.status === 'ok' ? 'visible' : resolution.status;
  }

  function ensureResizeObserver(): void {
    // The observer is an optimisation for target resize; the heartbeat already covers that
    // case. Environments without it (and the unit-test DOM) simply run heartbeat-only.
    if (!resizeObserver && typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => scheduleTick());
    }
  }

  /**
   * Unobserves every target and drops the stored references. Only for the paths that end
   * tracking altogether — the last annotation, `clear()`, `dispose()`. While any annotation
   * remains the heartbeat and the next frame re-derive both, so a partial `remove()` is pruned
   * by the next tick instead.
   */
  function releaseTargets(): void {
    if (resizeObserver) {
      for (const element of observed) resizeObserver.unobserve(element);
    }
    observed.clear();
  }

  // ---------------------------------------------------------------- signals

  const onGeometrySignal = (): void => {
    scheduleTick();
  };

  function startListening(): void {
    if (listening || disposed) return;
    listening = true;
    // Capture phase: a scroll inside any nested container reaches the window, so a scrolling
    // panel moves its markers without the overlay needing to know the container exists.
    win.addEventListener('scroll', onGeometrySignal, { capture: true, passive: true });
    win.addEventListener('resize', onGeometrySignal, { passive: true });
    win.visualViewport?.addEventListener('scroll', onGeometrySignal, { passive: true });
    win.visualViewport?.addEventListener('resize', onGeometrySignal, { passive: true });
    // The only gap the events above leave is movement caused by a third party reflowing the
    // target's surroundings, so an active overlay re-measures on a slow heartbeat.
    heartbeat = win.setInterval(scheduleTick, HEARTBEAT_MS);
  }

  function stopListening(): void {
    if (!listening) return;
    listening = false;
    win.removeEventListener('scroll', onGeometrySignal, { capture: true });
    win.removeEventListener('resize', onGeometrySignal);
    win.visualViewport?.removeEventListener('scroll', onGeometrySignal);
    win.visualViewport?.removeEventListener('resize', onGeometrySignal);
    if (heartbeat !== undefined) {
      win.clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }

  // ---------------------------------------------------------------- handle

  const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

  function prefersReducedMotion(): boolean {
    // Re-read every time rather than cached at mount: the preference can change while the tab
    // is open, and a cached answer would leave a user who turns it on mid-session with a
    // decorative animation already in flight.
    return matchMedia(REDUCED_MOTION_QUERY)?.matches === true;
  }

  /**
   * The one context object handed to every primitive. Both halves are the core's, not the
   * primitive's: frames come from the coalescer that already drives tracking, and the motion
   * answer is the layer's, so a primitive cannot disagree with the layer it runs in.
   */
  const primitiveContext = {
    requestFrame(callback: (timestamp: number) => void): () => void {
      coalescer.schedule(callback);
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        coalescer.unsubscribe(callback);
      };
    },
    prefersReducedMotion,
  };

  const handle: OverlayHandle = {
    mount() {
      if (disposed || host) return;
      host = mountOverlayHost(document, {
        maxRecoveries: maxHostRecoveries,
        ...(onHostUnrecoverable ? { onUnrecoverable: onHostUnrecoverable } : {}),
      });
      // Installed into the root the host just made, so there is exactly one shadow tree whether
      // the caller uses F-02's marker or F-03's primitives.
      renderer.install(host.root, document);
    },

    update(anchor: OverlayAnchor, annotationOptions: AnnotationOptions = {}): AnchorId {
      if (disposed) throw new Error('Overlay has been disposed');
      const id = anchorKey(anchor);
      handle.mount();
      const shadow = host!.root;
      const spec = toSpec(annotationOptions);

      let annotation = annotations.get(id);
      if (!annotation) {
        if (annotations.size >= MAX_ANNOTATIONS) {
          throw new RangeError(`Overlay is limited to ${MAX_ANNOTATIONS} simultaneous annotations`);
        }
        const primitive = renderer.create(document, spec, primitiveContext);
        shadow.append(primitive.node);
        primitive.attach?.();
        annotation = {
          anchor,
          node: primitive.node,
          primitive,
          spec,
          placement: 'auto',
          offset: DEFAULT_OFFSET,
          lastStatus: 'unset',
          position: null,
        };
        annotations.set(id, annotation);
      } else if (!renderer.canReuse(annotation.spec, spec)) {
        // Replacement across incompatible kinds: the old primitive is released before the new
        // one is built, so its animation frames and timers go with it rather than being orphaned
        // behind a node nobody will ever update again.
        annotation.primitive.release();
        annotation.node.remove();
        const primitive = renderer.create(document, spec, primitiveContext);
        shadow.append(primitive.node);
        primitive.attach?.();
        annotation.primitive = primitive;
        annotation.node = primitive.node;
        annotation.spec = spec;
      } else if (annotation.spec !== spec) {
        // Same shape, new inputs: the node is reused (a new node per retarget would churn the
        // shadow tree and restart any transition the user is already looking at).
        annotation.primitive.retarget(spec);
        annotation.spec = spec;
      }

      const placement = annotationOptions.placement ?? 'auto';
      const offset = annotationOptions.offset ?? DEFAULT_OFFSET;
      if (annotation.placement !== placement || annotation.offset !== offset) {
        annotation.placement = placement;
        annotation.offset = offset;
      }
      // Existing annotation: re-assert the signal in case the document generation moved.
      startListening();
      scheduleTick();
      return id;
    },

    refresh() {
      scheduleTick();
    },

    remove(id: AnchorId) {
      const annotation = annotations.get(id);
      if (!annotation) return;
      annotations.delete(id);
      // `release` before `remove`: the primitive owns its animation frames, and detaching the
      // node first would leave those frames running against a node nothing can see or update.
      annotation.primitive.release();
      annotation.node.remove();
      if (annotations.size === 0) {
        stopListening();
        // Nothing will run another frame to prune the observation, so it is released here.
        releaseTargets();
      }
      coalescer.unsubscribe(tick);
    },

    clear() {
      for (const annotation of annotations.values()) {
        annotation.primitive.release();
        annotation.node.remove();
      }
      annotations.clear();
      stopListening();
      // Markers are gone, so their targets must be unobserved and unreferenced here rather than
      // waiting for a `dispose()` that a live page may never reach.
      releaseTargets();
      coalescer.unsubscribe(tick);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopListening();
      // Total: the coalescer is disposed after every primitive has unsubscribed itself, so a
      // primitive that forgets cannot survive it, and one that remembers still ends up cleared.
      for (const annotation of annotations.values()) {
        annotation.primitive.release();
        annotation.node.remove();
      }
      coalescer.dispose();
      resizeObserver?.disconnect();
      resizeObserver = null;
      observed.clear();
      annotations.clear();
      host?.destroy();
      host = null;
    },

    get isMounted() {
      return host !== null;
    },
    get isDisposed() {
      return disposed;
    },
    get size() {
      return annotations.size;
    },
    positionOf(id: AnchorId) {
      return annotations.get(id)?.position ?? null;
    },

    statusOf(id: AnchorId) {
      const status = annotations.get(id)?.lastStatus;
      return status === 'unset' ? 'unknown' : (status ?? 'unknown');
    },
    prefersReducedMotion,
    metrics() {
      return { ...metrics };
    },
    get host() {
      return host?.host ?? null;
    },
  };

  return handle;
}
