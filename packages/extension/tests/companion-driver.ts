// Test-only page driver; never included in a production manifest/build.
//
// Bundled by companion.spec.ts and injected with addScriptTag, so it runs in the page world. For the
// properties under test that is acceptable, and is what F-03's driver already does: what matters is
// the overlay's DOM, its computed style, and its effect on the page — not which world holds the
// reference. A real content script runs these same modules in the isolated world against the same
// B-05 registry.
//
// The provider here is the *test* provider. A-11 (#46) and F-09 (#106) do not exist, so this stands
// in for them, and it is unreachable from production: `startContentSession` wires the unavailable
// adapter, and nothing in the shipped path constructs this one.
import { ElementRegistry } from '../src/content/element-registry/index.js';
import { walkRegisteredDocument } from '../src/content/element-registry/walk.js';
import {
  createOverlay,
  createRegistryResolver,
  createViewportGeometry,
  type AnchorStatus,
  type MarkerPosition,
  type OverlayHandle,
  type OverlayMetrics,
} from '../src/content/overlay/index.js';
import {
  createCompanionController,
  createCompanionRenderer,
  createCompanionResolver,
  createPointerSource,
  type CompanionEvent,
  type CompanionIdentity,
  type CompanionSnapshot,
  type CompanionState,
  type PointerSource,
} from '../src/content/companion/index.js';
import type { OverlayPrimitive } from '../src/content/overlay/index.js';

const TASK = 'task-driver';

const registry = new ElementRegistry(document);
const pointer: PointerSource = createPointerSource(window);
const resolver = createCompanionResolver(createRegistryResolver(registry, document), pointer);

/**
 * The live companion primitive, kept so a test can measure the character itself.
 *
 * The host's root is closed, so nothing in the page world can reach the character by query. Holding
 * the reference here is how the browser suite gets at the real box: `getBoundingClientRect` on the
 * node the layer actually created, which is a stronger instrument than anything the DOM exposes
 * from outside. It is also why the pixel assertions below are about what was painted rather than
 * about what the markup says.
 */
let primitive: OverlayPrimitive | null = null;

// The real frame source, not a manual clock: a browser test that drove its own frames would not be
// testing the claim that the companion runs on the layer's existing scheduler.
const companionRenderer = createCompanionRenderer();

const overlay: OverlayHandle = createOverlay({
  document,
  window,
  resolver,
  geometry: createViewportGeometry(document, window),
  renderer: {
    // Delegating to the real composite and keeping the instance it hands back: the wrapper is
    // test-only, and everything about *how* the character is drawn still comes from production
    // code.
    install: (root, doc) => companionRenderer.install(root, doc),
    create: (doc, spec, context) => {
      const created = companionRenderer.create(doc, spec, context);
      primitive = created;
      return created;
    },
    canReuse: (previous, next) => companionRenderer.canReuse(previous, next),
  },
});

const sinks = new Set<(event: CompanionEvent) => void>();

/** The test provider. `available: true` is the only thing that lets events reach the reducer. */
const adapter = {
  available: true,
  label: 'driver test provider',
  deliver: (event: CompanionEvent) => {
    for (const sink of sinks) sink(event);
  },
  subscribe: (sink: (event: CompanionEvent) => void) => {
    sinks.add(sink);
    return () => {
      sinks.delete(sink);
    };
  },
};

const controller = createCompanionController({ overlay, resolver, pointer, adapter });

/**
 * The page's own click handler, installed from the driver.
 *
 * It lives here rather than as an inline `<script>` in the fixture because the mock-site pack sends
 * `script-src 'self'`, and a page that cannot run its own scripts is not a realistic page. The
 * handler is ordinary page code: what the test proves is that a real, trusted click travels from
 * Playwright, past the companion, and reaches it.
 */
document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.id !== 't-button') return;
  const out = document.getElementById('t-clicks');
  if (out) out.textContent = String(Number(out.textContent ?? '0') + 1);
});

/**
 * The event sequence a real provider would send to reach each state, in order.
 *
 * `listening` is only ever reached by confirming a capture first, which is the point: the gallery
 * cannot reach it any other way, so a regression that let `task-started` imply a live microphone
 * would fail here rather than quietly drawing a privacy claim.
 */
const SEQUENCES: Record<CompanionState, readonly CompanionEvent['type'][]> = {
  idle: ['audio-capture-ended', 'task-cancelled'],
  listening: ['audio-capture-confirmed'],
  thinking: ['audio-capture-confirmed', 'task-started'],
  acting: ['audio-capture-confirmed', 'task-started', 'thinking', 'acting'],
  'needs-approval': [
    'audio-capture-confirmed',
    'task-started',
    'thinking',
    'acting',
    'approval-requested',
  ],
};

function send(type: CompanionEvent['type'], identity: CompanionIdentity): void {
  controller.accept({ type, identity });
}

const api = {
  /**
   * Walks the document, which is what issues the registry a document generation.
   *
   * Required before enabling: the companion mints its anchor from the live generation, and a
   * registry that has not walked yet has none, so an un-walked session correctly draws nothing.
   * Doing it here rather than in the driver means the ordering constraint is visible in the test.
   */
  async walk(): Promise<number> {
    const result = await walkRegisteredDocument(document, registry);
    return result.status === 'complete' ? result.targets.length : 0;
  },

  /** Puts the companion into one named state, so a test names a state instead of scripting steps. */
  state(name: CompanionState): CompanionSnapshot {
    // A fresh generation per call, so repeated calls never collide with a previous sequence.
    const identity: CompanionIdentity = { generation: Date.now() + name.length, taskId: TASK };
    for (const type of SEQUENCES[name]) send(type, identity);
    return controller.snapshot();
  },

  /** Delivers one raw event, for the staleness and precedence assertions. */
  event(type: CompanionEvent['type'], generation: number, taskId = TASK): CompanionSnapshot {
    send(type, { generation, taskId });
    return controller.snapshot();
  },

  setEnabled(enabled: boolean): boolean {
    controller.setEnabled(enabled);
    return controller.isEnabled;
  },

  isEnabled(): boolean {
    return controller.isEnabled;
  },

  snapshot(): CompanionSnapshot {
    return controller.snapshot();
  },

  size(): number {
    return overlay.size;
  },

  isMounted(): boolean {
    return overlay.isMounted;
  },

  position(): MarkerPosition | null {
    const id = controller.anchorId();
    return id === null ? null : overlay.positionOf(id);
  },

  status(): AnchorStatus | 'unknown' {
    const id = controller.anchorId();
    return id === null ? 'unknown' : overlay.statusOf(id);
  },

  metrics(): OverlayMetrics {
    return overlay.metrics();
  },

  prefersReducedMotion(): boolean {
    return overlay.prefersReducedMotion();
  },

  /**
   * What a click at these coordinates would actually reach.
   *
   * This is the click-through assertion, and it deliberately does not ask what the overlay
   * *declares* about `pointer-events`: it asks the engine's own hit testing, which is the only
   * thing that decides whether a real click gets through.
   */
  hitTest(x: number, y: number): { tag: string; id: string; text: string } {
    const target = document.elementFromPoint(x, y);
    if (!target) return { tag: '', id: '', text: '' };
    return {
      tag: target.tagName,
      id: target.id,
      text: (target.textContent ?? '').trim().slice(0, 40),
    };
  },

  /**
   * Waits for the overlay's next painted frame.
   *
   * The overlay coalesces work into an animation frame, so a state set in one `evaluate` is not on
   * screen until the frame after it. Any test that reads pixels or hit tests has to cross that gap,
   * and doing it in one place means every test crosses exactly the same one.
   */
  async settle(): Promise<void> {
    // Three frames, not one and not two: the pointer event has to reach the controller, the
    // controller has to ask the layer to re-place, and the layer has to coalesce that into a frame
    // which then writes the transform. One frame per link in that chain is the minimum that
    // cannot be short, and settling for fewer would make these tests read the previous frame.
    await new Promise<void>((resolve) => {
      let frames = 3;
      const tick = (): void => {
        if (--frames === 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  },

  /**
   * The character's real on-screen box, in document coordinates, for a pixel comparison.
   *
   * Measured from the node the layer created, so it is the box the engine laid out rather than the
   * box the positioner reserved. A reserved box is not the same thing: the layer's host node is
   * zero-sized by design and the primitive draws itself around the point the core translated it to,
   * so a reserved box is a guess and a measured rect is not.
   */
  characterBox(): { x: number; y: number; width: number; height: number } | null {
    const node = primitive?.node;
    if (node === null || node === undefined || !node.isConnected) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // A margin for the motion the animated states add, which is drawn outside the static box.
    const margin = 10;
    return {
      x: rect.left + window.scrollX - margin,
      y: rect.top + window.scrollY - margin,
      width: rect.width + margin * 2,
      height: rect.height + margin * 2,
    };
  },

  /**
   * A trace of the geometry chain, for diagnosing a placement claim.
   *
   * Pointer rect in, position out, with the character's measured box alongside: the positioner
   * reasons about a reserved box and the primitive paints somewhere inside it, so a claim like "it
   * stayed on screen" can only be settled by looking at all three at once.
   */
  /** Whether the extension's host is a bare, attribute-free, closed-root element. */
  isolation(): { tag: string; attributes: number; shadowOpen: boolean; inPageTree: number } {
    const host = overlay.host;
    return {
      tag: host?.tagName ?? '',
      attributes: host?.attributes.length ?? 0,
      shadowOpen: (host?.shadowRoot ?? null) !== null,
      inPageTree: host ? document.querySelectorAll('div[style*="privacagent"]').length : 0,
    };
  },

  dispose(): void {
    controller.dispose();
    overlay.dispose();
  },
};

(window as unknown as { __companionTest: typeof api }).__companionTest = api;
// The readiness flag the spec waits on, matching F-03's driver: it distinguishes "the driver
// loaded" from "the page merely finished parsing", which matters because the driver installs a
// listener and creates the overlay as a side effect of loading.
document.documentElement.dataset.companionReady = 'true';
