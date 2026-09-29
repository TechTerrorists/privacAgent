// Test-only page driver; never included in a production manifest/build.
//
// Bundled by primitives.spec.ts and injected with addScriptTag, so it runs in the page world. That
// is fine for the properties under test here: what matters is the overlay's own DOM and its
// effect on the page, not which world holds the reference. A real content script would run this
// same code in the isolated world against the same B-05 registry.
//
// It drives the B-08 overlay gallery deterministically: named scenarios, each of which puts the
// layer into one specific state, so a browser test names a state rather than scripting a sequence
// of DOM mutations that could drift.
import type { DocumentId } from '@privacagent/protocol';
import { ElementRegistry } from '../src/content/element-registry/index.js';
import { walkRegisteredDocument } from '../src/content/element-registry/walk.js';
import {
  createPrimitiveOverlay,
  primitiveSpec,
  show,
  type AnyPrimitiveSpec,
  type PrimitiveKind,
} from '../src/content/overlay/primitives/index.js';
import {
  createRegistryResolver,
  createViewportGeometry,
  type AnchorId,
  type AnchorStatus,
  type MarkerPosition,
  type OverlayHandle,
  type TargetResolver,
} from '../src/content/overlay/index.js';

const registry = new ElementRegistry(document);
const registryResolver = createRegistryResolver(registry, document);

/**
 * A generation the registry has never issued, so a test can retire the document without
 * navigating. Navigation itself is covered by a real page load in the spec; this is the
 * "SPA route change" shape, where the same nodes stay on screen and every id becomes meaningless.
 */
const RETIRED = 'd-f03-retired-0001' as DocumentId;
let retired = false;

/**
 * A resolver the driver can retire.
 *
 * It adds no identity logic of its own — `resolve` is the registry's, untouched. It only exists
 * so a test can make `currentDocId()` report a different generation, which is the one input the
 * core uses to decide that every existing annotation is stale. That decision belongs to the core,
 * so it is exercised through the core's own seam rather than by faking its outputs.
 */
const resolver: TargetResolver = {
  currentDocId: () => (retired ? RETIRED : registryResolver.currentDocId()),
  resolve: (anchor) => registryResolver.resolve(anchor),
};

const overlay: OverlayHandle = createPrimitiveOverlay({
  document,
  window,
  resolver,
  geometry: createViewportGeometry(document, window),
});

/** Per-annotation ids, so scenarios can address a specific one without the caller doing the keying. */
const issued = new Map<string, AnchorId>();

function register(selector: string): { id: string; doc_id: string } {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`primitives-driver: no node for ${selector}`);
  const registration = registry.register(node, registry.docId);
  if (registration.status !== 'ok') throw new Error(`primitives-driver: ${registration.status}`);
  return { id: registration.id, doc_id: registration.doc_id };
}

/**
 * The core answers `unknown` for an id it is not tracking. The driver surfaces that as a plain
 * string rather than widening the status type, so a test asserting a real status cannot
 * accidentally accept `unknown`.
 */
function expectStatus(status: AnchorStatus | 'unknown'): AnchorStatus | 'unknown' {
  return status;
}

/** Typed lookup, so the driver's page mutations are checked rather than `any`-ed past. */
function need<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`primitives-driver: no node for ${selector}`);
  return node;
}

function annotate(
  selector: string,
  spec: AnyPrimitiveSpec,
  options: { placement?: 'top' | 'bottom' | 'left' | 'right' | 'auto'; offset?: number } = {}
): { annotationId: AnchorId; elementId: string; docId: string } {
  const { id, doc_id } = register(selector);
  const annotationId = show(overlay, { doc_id, element_id: id }, spec, options);
  issued.set(selector, annotationId);
  return { annotationId, elementId: id, docId: doc_id };
}

/**
 * Waits for the frames the overlay needs before reporting anything.
 *
 * `show()` queues work for the next animation frame, so a measurement is not available
 * synchronously afterwards. Two frames cover the tick plus a `ResizeObserver` delivery that can
 * queue a follow-up tick; the extra ones let a glide finish so a settled overlay can be measured
 * as settled rather than mid-flight.
 */
function settleFrames(count = 3): Promise<void> {
  return new Promise((resolve) => {
    let remaining = count;
    const step = () => {
      if (--remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Removes the synthetic saturation fixture, so a scenario can rebuild it cleanly. */
function removeSaturationFixture(): void {
  document.getElementById('f03-saturated')?.remove();
}

const SPECS: Record<string, AnyPrimitiveSpec> = {
  pointer: primitiveSpec('pointer', { durationMs: 160 }),
  circle: primitiveSpec('circle', {}),
  arrow: primitiveSpec('arrow', {}),
  badge1: primitiveSpec('badge', { index: 1 }),
  label: primitiveSpec('label', { text: 'Start here' }),
  labelUnsafe: primitiveSpec('label', {
    text: '<img src=x onerror="window.__primitivesTest.pwned=1">',
  }),
  labelLong: primitiveSpec('label', { text: 'L'.repeat(400) }),
  spotlight: primitiveSpec('spotlight', {}),
  underline: primitiveSpec('underline', {}),
};

interface ProbeResult {
  annotationId: AnchorId | null;
  status: AnchorStatus | 'unknown';
  position: MarkerPosition | null;
  /** Whether the overlay host is what a hit-test at this point returns. Must always be false. */
  hitsHost: boolean;
  /** The tag of whatever a hit-test at this point *does* return. */
  hitsTag: string;
  /** The id of that element, so a test can prove the click reached the page control underneath. */
  hitsId: string;
}

const api = {
  /** Every scenario is explicit, so a test reads as a list of states rather than a DOM script. */
  async scenario(name: string): Promise<{ annotationIds: string[]; status: string }> {
    overlay.clear();
    issued.clear();

    const each = async (
      selector: string,
      spec: AnyPrimitiveSpec,
      options?: { placement?: 'top' | 'bottom' | 'left' | 'right' | 'auto'; offset?: number }
    ): Promise<AnchorId> => {
      const { annotationId } = annotate(selector, spec, options ?? {});
      return annotationId;
    };

    let annotationIds: AnchorId[];
    switch (name) {
      // ---- every primitive on its own target, all live at once
      case 'all':
        annotationIds = await Promise.all([
          each('#t-pointer', SPECS.pointer!),
          each('#t-circle', SPECS.circle!),
          each('#t-arrow', SPECS.arrow!),
          each('#t-badge', SPECS.badge1!),
          each('#t-label', SPECS.label!),
          each('#t-underline', SPECS.underline!),
          each('#t-spotlight', SPECS.spotlight!),
        ]);
        break;

      case 'single':
        annotationIds = [await each('#t-pointer', SPECS.pointer!)];
        break;
      case 'spotlight':
        annotationIds = [await each('#t-spotlight', SPECS.spotlight!)];
        break;
      case 'label-unsafe':
        annotationIds = [await each('#t-label', SPECS.labelUnsafe!)];
        break;
      case 'label-long':
        annotationIds = [await each('#t-label', SPECS.labelLong!)];
        break;

      // ---- several annotations on one layer
      case 'multi':
        annotationIds = await Promise.all([
          each('#t-multi-a', SPECS.badge1!),
          each('#t-multi-b', primitiveSpec('badge', { index: 2 })),
          each('#t-multi-c', SPECS.circle!),
        ]);
        break;

      // ---- viewport edges: the positioner flips, clamps, and the arrow bridges back
      case 'edges':
        annotationIds = await Promise.all([
          each('#t-edge-top', SPECS.arrow!),
          each('#t-edge-bottom', SPECS.arrow!),
          each('#t-edge-left', SPECS.pointer!),
          each('#t-edge-right', SPECS.pointer!),
        ]);
        break;
      case 'edge-top':
        annotationIds = [await each('#t-edge-top', SPECS.arrow!)];
        break;
      case 'edge-left':
        annotationIds = [await each('#t-edge-left', primitiveSpec('label', { text: 'Clamped' }))];
        break;

      // ---- scroll: page and nested container
      case 'nested':
        annotationIds = [await each('#t-nested', SPECS.circle!)];
        break;
      case 'far':
        annotationIds = [await each('#t-label', SPECS.label!)];
        break;

      // ---- lifecycle
      case 'replace-from':
        annotationIds = [await each('#t-replace', SPECS.badge1!)];
        break;
      case 'detach':
        annotationIds = [await each('#t-detach', SPECS.circle!)];
        break;
      case 'hidden':
        annotationIds = [await each('#t-hidden', SPECS.circle!)];
        break;
      case 'visibility-hidden':
        annotationIds = [await each('#t-hidden', SPECS.circle!)];
        break;

      // ---- a full layer: the core's cap, with every kind represented
      case 'saturated':
        annotationIds = await api.saturate();
        break;

      default:
        throw new Error(`primitives-driver: unknown scenario ${name}`);
    }
    overlay.refresh();
    // Four frames: the tick, a ResizeObserver follow-up, and enough for a glide to settle.
    await settleFrames(4);
    return { annotationIds, status: 'ok' };
  },

  /** Re-annotates one target with a different kind: the replacement path. */
  async replace(selector: string, kind: PrimitiveKind, fields: object = {}): Promise<AnchorId> {
    const existing = issued.get(selector);
    const { id, doc_id } = register(selector);
    const annotationId = show(
      overlay,
      { doc_id, element_id: id },
      primitiveSpec(kind, fields as never),
      {}
    );
    // The key is doc/element based, so this must be the same id as before.
    if (existing && existing !== annotationId) {
      throw new Error('primitives-driver: replacement changed the annotation id');
    }
    issued.set(selector, annotationId);
    overlay.refresh();
    await settleFrames(3);
    return annotationId;
  },

  /** Retargets the same annotation with a new spec of the same kind. */
  async retarget(selector: string, kind: PrimitiveKind, fields: object = {}): Promise<AnchorId> {
    return api.replace(selector, kind, fields);
  },

  async annotate(selector: string, kind: PrimitiveKind, fields: object = {}) {
    const { annotationId } = annotate(selector, primitiveSpec(kind, fields as never));
    overlay.refresh();
    await settleFrames(4);
    return { annotationId, elementId: register(selector).id, docId: registry.docId };
  },

  statusOf(annotationId: AnchorId): AnchorStatus | 'unknown' {
    return expectStatus(overlay.statusOf(annotationId));
  },
  positionOf(annotationId: AnchorId): MarkerPosition | null {
    return overlay.positionOf(annotationId);
  },
  size(): number {
    return overlay.size;
  },
  metrics() {
    return overlay.metrics();
  },
  isMounted(): boolean {
    return overlay.isMounted;
  },
  prefersReducedMotion(): boolean {
    return overlay.prefersReducedMotion();
  },

  // ---- page state changes the driver performs, so tests do not script them

  hideTarget(selector: string, mode: 'display' | 'visibility'): void {
    const node = need<HTMLElement>(selector);
    node.style.setProperty(
      mode === 'display' ? 'display' : 'visibility',
      mode === 'display' ? 'none' : 'hidden'
    );
  },
  showTarget(selector: string): void {
    const node = need<HTMLElement>(selector);
    node.style.removeProperty('display');
    node.style.removeProperty('visibility');
  },
  detachTarget(selector: string): void {
    need(selector).remove();
  },
  /** Moves a target without scrolling, so only the heartbeat can notice. */
  moveTarget(selector: string, dy: number): void {
    need<HTMLElement>(selector).style.transform = `translateY(${dy}px)`;
  },

  /**
   * Scrolls a target to the middle of the viewport.
   *
   * The gallery is ~2800px tall in a 720px viewport, so most of its targets start below the fold
   * and would legitimately be `offscreen` at scroll 0. A test that wants to assert a *visible*
   * decoration says so by bringing the control into view, rather than by assuming it was there.
   */
  async scrollTargetIntoView(selector: string): Promise<void> {
    need<HTMLElement>(selector).scrollIntoView({ block: 'center', inline: 'center' });
    await settleFrames(3);
  },

  // ---- hit-testing: the property that decides whether the overlay is click-through

  /**
   * Asks the page what is hit-tested at a point, and reports both whether it landed on the
   * overlay host and what it landed on instead.
   *
   * `document.elementFromPoint` is the real answer rather than a computed-style check, because
   * `pointer-events: none` can be expressed in several ways and only a hit-test proves the
   * element is genuinely transparent to input.
   */
  probe(x: number, y: number, annotationId?: AnchorId): ProbeResult {
    const id = annotationId ?? [...issued.values()][0] ?? null;
    const hit = document.elementFromPoint(x, y);
    return {
      annotationId: id,
      status: id === null ? 'unknown' : expectStatus(overlay.statusOf(id)),
      position: id === null ? null : overlay.positionOf(id),
      hitsHost: hit !== null && hit === overlay.host,
      hitsTag: hit?.tagName ?? 'none',
      hitsId: hit?.id ?? '',
    };
  },

  /** Centre of a target, in viewport coordinates, for hit-testing through an overlay. */
  targetCentre(selector: string): { x: number; y: number } {
    const rect = need(selector).getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  },

  markerCentre(annotationId: AnchorId): { x: number; y: number } | null {
    const position = overlay.positionOf(annotationId);
    return position ? { x: position.x + 7, y: position.y + 7 } : null;
  },

  // ---- isolation and cleanup

  markerBox() {
    const host = overlay.host;
    if (!host) return null;
    return {
      hostTag: host.tagName,
      hostAttributeCount: host.attributes.length,
      hostShadowRootOpen: host.shadowRoot !== null,
      hostConnected: host.isConnected,
      hostRect: host.getBoundingClientRect().toJSON(),
      /** The whole page tree must contain no primitive node and no node with a tabindex. */
      paInPageTree: document.querySelectorAll('[class^="pa-"]').length,
      focusableInPageTree: document.querySelectorAll('[tabindex]').length,
    };
  },

  hostChildCount(): number {
    return document.documentElement.children.length;
  },

  /**
   * What the page tree contains, independent of the overlay.
   *
   * The gallery is a full page with its own tabbable scroller, form controls and scripts, so an
   * absolute count of "focusable elements" or "script tags" says nothing about whether the overlay
   * added any. A test takes this once before annotating and again after, and asserts the two are
   * identical — which is the claim that actually matters: the overlay is a picture, and a picture
   * does not change what is on the page.
   */
  pageFootprint(): {
    pa: number;
    tabindex: number;
    scripts: number;
    imgs: number;
    forms: number;
    controls: number;
    dialogs: number;
    ariaModal: number;
    liveRegions: number;
    roles: string[];
  } {
    return {
      pa: document.querySelectorAll('[class^="pa-"]').length,
      tabindex: document.querySelectorAll('[tabindex]').length,
      scripts: document.querySelectorAll('script').length,
      imgs: document.querySelectorAll('img').length,
      forms: document.querySelectorAll('form').length,
      controls: document.querySelectorAll('input, textarea, select, button, a[href]').length,
      dialogs: document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]').length,
      ariaModal: document.querySelectorAll('[aria-modal]').length,
      liveRegions: document.querySelectorAll('[aria-live]').length,
      roles: [...document.querySelectorAll('[role]')].map((node) => node.getAttribute('role')!),
    };
  },

  /**
   * How many of the overlay's bare hosts are attached to `<html>`. F-02's host is a zero-attribute
   * `<div>` with a closed root and no light children, so it is counted by shape rather than by a
   * marker attribute: a host must not be identifiable to the page, and that includes to us.
   */
  overlayHostCount(): number {
    return [...document.documentElement.children].filter(
      (node) =>
        node.tagName === 'DIV' &&
        node.attributes.length === 0 &&
        node.shadowRoot === null &&
        node.childElementCount === 0
    ).length;
  },

  /**
   * The interactive surface of the page tree, split by origin so the two cannot be conflated.
   *
   * `pageTabindex` is the gallery's own — its scroll container is deliberately keyboard-reachable
   * — and `focusable` counts every tabindex in the page. The overlay contributes nothing to
   * either, which is only meaningful because it draws into a closed root that the page tree does
   * not contain.
   */
  accessibilityRoles(): { roles: string[]; focusable: number; pageTabindex: number } {
    const roles = [...document.querySelectorAll('button, a, input, select, textarea, [role]')].map(
      (node) => node.getAttribute('role') ?? node.tagName.toLowerCase()
    );
    return {
      roles,
      focusable: document.querySelectorAll('[tabindex]').length,
      pageTabindex: document.querySelectorAll('[tabindex]').length,
    };
  },

  async walk() {
    const result = await walkRegisteredDocument(document, registry);
    if (result.status !== 'complete') return { status: result.status };
    const host = overlay.host;
    return {
      status: result.status,
      targetCount: result.targets.length,
      hostInAttributeEvidence: result.walk.evidence.attributeElements.some((e) => e.node === host),
      hostIsCandidate: result.walk.candidates.some((c) => c.node === host),
      // The label canary must not reach the text evidence stream: a closed root is what stops it,
      // and the label is the one primitive that carries caller-supplied content.
      textHasOverlayLabel: JSON.stringify(
        result.walk.evidence.textNodes.map((e) => e.node.data)
      ).includes('Start here'),
      paInPageTree: document.querySelectorAll('[class^="pa-"]').length,
    };
  },

  // ---- the probe form, so a test can prove page input is untouched

  inputValue(): string {
    return need<HTMLInputElement>('#probe-input').value;
  },
  /**
   * A stable description of whatever currently has focus.
   *
   * Falls back to the tag and label text, not the tag alone: the gallery's four nav links are
   * four distinct tab stops that share a tag and carry no id, so a tag-only descriptor would make
   * a working tab order look like one stuck stop.
   */
  activeElementId(): string {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return 'BODY';
    const label = (active.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
    return `${active.tagName}#${active.id || active.className || label}`;
  },
  /**
   * Samples an annotation's y-position once per animation frame, for `count` frames.
   *
   * A glide shows up here as a long run of distinct intermediate values; a reduced-motion move
   * shows up as a single jump and then flat. Counting distinct values is a far better discriminator
   * than "did it arrive in time", because a glide and a snap both arrive eventually and only one
   * of them is animated.
   */
  positionTrace(annotationId: AnchorId, count: number): Promise<number[]> {
    return new Promise((resolve) => {
      const samples: number[] = [];
      const step = () => {
        const position = overlay.positionOf(annotationId);
        samples.push(position ? Math.round(position.y * 100) / 100 : Number.NaN);
        if (samples.length >= count) resolve(samples);
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  },

  /**
   * Where the focused element sits in the document's own tab order, or -1 if nothing is focused.
   *
   * A better probe than a descriptor for "did Tab move": four nav links share a tag and carry no
   * id, so a name-based walk can look stuck while the focus is in fact advancing correctly.
   */
  activeIndex(): number {
    const focusables = [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [tabindex]'
      ),
    ];
    return focusables.indexOf(document.activeElement as HTMLElement);
  },

  clickCount(): number {
    return Number(document.querySelector('#probe-status')?.getAttribute('data-clicks') ?? '0');
  },
  installProbe(): void {
    const form = document.querySelector('#probe-form');
    const input = document.querySelector('#probe-input') as HTMLInputElement;
    const status = document.querySelector('#probe-status');
    if (!form || !input || !status) return;
    // A real listener, not a synthetic one: the point is to observe the browser's own input
    // pipeline reaching the page, so nothing here may dispatch anything itself.
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const clicks = Number(status.getAttribute('data-clicks') ?? '0') + 1;
      status.setAttribute('data-clicks', String(clicks));
      status.textContent = `submitted ${input.value.length} chars`;
    });
    input.addEventListener('input', () => {
      status.textContent = `typing: ${input.value.length}`;
    });
  },

  clear(): void {
    overlay.clear();
    issued.clear();
  },
  refresh(): void {
    overlay.refresh();
  },
  async refreshAndSettle(): Promise<void> {
    overlay.refresh();
    await settleFrames(3);
  },
  /**
   * Fills the layer to the core's 64-annotation cap.
   *
   * Built from synthetic targets rather than the gallery's eighteen, because an annotation is
   * keyed by doc_id/element_id and a layer cannot put two annotations on one control. The targets
   * are viewport-fixed in a dense grid so that all 64 are genuinely on screen: an off-screen
   * target is suppressed, so a saturated layer built from off-screen targets would measure the
   * cheap path and prove nothing.
   */
  async saturate(): Promise<AnchorId[]> {
    removeSaturationFixture();
    const host = document.createElement('div');
    host.id = 'f03-saturated';
    host.style.cssText =
      'position:fixed;inset:0;display:grid;grid-template-columns:repeat(16,1fr);' +
      'grid-auto-rows:16px;gap:2px;pointer-events:none;z-index:0';
    for (let i = 0; i < 64; i++) {
      const cell = document.createElement('div');
      cell.id = `sat-${i}`;
      cell.style.cssText = 'background:#cfe3d8;border-radius:2px';
      host.append(cell);
    }
    document.body.append(host);

    const kinds: AnyPrimitiveSpec[] = [
      SPECS.pointer!,
      SPECS.circle!,
      SPECS.arrow!,
      SPECS.badge1!,
      SPECS.label!,
      SPECS.underline!,
      SPECS.spotlight!,
    ];
    return Array.from(
      { length: 64 },
      (_, i) => annotate(`#sat-${i}`, kinds[i % kinds.length]!).annotationId
    );
  },

  /**
   * Oscillates every live target for `frames` animation frames.
   *
   * This is the only way to keep a glide in flight on every frame, which is the configuration the
   * idle assertion exists to distinguish from: a layer that settles and a layer that animates
   * forever look identical in a total frame count, and only this makes the difference visible.
   */
  async churnAll(frames: number): Promise<void> {
    const cells = [...document.querySelectorAll<HTMLElement>('[id^="sat-"]')];
    if (cells.length === 0)
      throw new Error('primitives-driver: churnAll needs the saturated fixture');
    for (let frame = 0; frame < frames; frame++) {
      const offset = Math.round(6 * Math.sin(frame / 3));
      for (const cell of cells) cell.style.transform = `translateY(${offset}px)`;
      await new Promise((done) => requestAnimationFrame(() => done(null)));
    }
    for (const cell of cells) cell.style.transform = '';
  },

  settle: settleFrames,
  dispose(): void {
    overlay.dispose();
    issued.clear();
  },

  /**
   * Retires the current document generation, as an SPA route change would. Every id issued under
   * the previous generation now identifies nothing, even though the nodes are still on screen.
   */
  retireGeneration(): void {
    retired = true;
  },
  restoreGeneration(): void {
    retired = false;
  },
  /** The generation the core currently believes is live. */
  currentDocId(): string | null {
    return resolver.currentDocId();
  },

  registryDocId(): string {
    return registry.docId;
  },
};

Object.defineProperty(window, '__primitivesTest', { value: api, configurable: true });
api.installProbe();
document.documentElement.setAttribute('data-primitives-ready', 'true');
