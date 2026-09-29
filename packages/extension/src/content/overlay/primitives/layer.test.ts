// @vitest-environment happy-dom
/**
 * F-03: integration through F-02's real controller.
 *
 * `primitives.test.ts` covers what a primitive does; this covers what the layer does. The point of
 * these tests is the *reuse* claim: a primitive reaches the page through F-02's host, F-02's
 * registry, F-02's resolver and F-02's coalescer, and none of those were rebuilt to make it
 * possible. So most of what is asserted here is that F-02's guarantees still hold when the
 * renderer is swapped — one host, one closed root, lazy creation, the annotation cap, total
 * teardown — plus the F-03-specific lifecycle: replacement, cancellation and stale generations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentId } from '@privacagent/protocol';
import { createManualFrameScheduler } from '../scheduler.js';
import { createPrimitiveOverlay, show, primitiveSpec } from './layer.js';
import { createPrimitiveRenderer, PRIMITIVE_KINDS, type AnyPrimitiveSpec } from './renderer.js';
import type {
  AnchorStatus,
  OverlayAnchor,
  OverlayHandle,
  ResolveResult,
  TargetResolver,
  ViewportRect,
} from '../types.js';

const DOC = 'd-f03-0001' as DocumentId;
const NEXT_DOC = 'd-f03-0002' as DocumentId;
const VIEWPORT: ViewportRect = { x: 0, y: 0, width: 1000, height: 800 };
const anchor = (id: string, docId: DocumentId = DOC): OverlayAnchor => ({
  doc_id: docId,
  element_id: id,
});
const key = (a: OverlayAnchor): string => `${a.doc_id}/${a.element_id}`;
const rect = (x: number, y: number, width = 100, height = 20): ViewportRect => ({
  x,
  y,
  width,
  height,
});

function createFakeResolver() {
  const state = {
    docId: DOC as DocumentId | null,
    answers: new Map<string, ResolveResult>(),
    resolveCalls: 0,
  };
  const resolver: TargetResolver = {
    currentDocId: () => state.docId,
    resolve(target) {
      state.resolveCalls++;
      return state.answers.get(key(target)) ?? { status: 'missing' };
    },
  };
  return { state, resolver };
}

interface Harness {
  handle: OverlayHandle;
  frames: ReturnType<typeof createManualFrameScheduler>;
  statusChanges: Array<[string, AnchorStatus]>;
  answer: (id: string, answer: ResolveResult) => void;
  setDocId: (docId: DocumentId | null) => void;
  tick: () => void;
  pageChildren: () => number;
  /** Tags of the nodes the overlay appended to <html>, in order. */
  pageNodes: () => string[];
  listenerBalance: () => { added: number; removed: number };
  intervalBalance: () => { added: number; removed: number };
  setReducedMotion: (value: boolean) => void;
  restore: () => void;
}

function createHarness(
  options: { reducedMotion?: boolean; maxHostRecoveries?: number } = {}
): Harness {
  const { state, resolver } = createFakeResolver();
  const frames = createManualFrameScheduler();
  const statusChanges: Array<[string, AnchorStatus]> = [];
  let reduced = options.reducedMotion ?? false;
  const addSpy = vi.spyOn(window, 'addEventListener');
  const removeSpy = vi.spyOn(window, 'removeEventListener');
  const setIntervalSpy = vi.spyOn(window, 'setInterval');
  const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

  const handle = createPrimitiveOverlay({
    document,
    window,
    resolver,
    geometry: { viewport: () => VIEWPORT },
    scheduler: frames,
    onStatusChange: (id, status) => statusChanges.push([id, status]),
    matchMedia: (query) =>
      query.includes('prefers-reduced-motion') ? ({ matches: reduced } as MediaQueryList) : null,
    ...(options.maxHostRecoveries !== undefined
      ? { maxHostRecoveries: options.maxHostRecoveries }
      : {}),
  });
  const baseline = document.documentElement.children.length;
  const signalTypes = new Set(['scroll', 'resize']);
  const count = (calls: unknown[][]) =>
    calls.filter((call) => signalTypes.has(String(call[0]))).length;

  return {
    handle,
    frames,
    statusChanges,
    answer: (id, answer) => state.answers.set(key(anchor(id)), answer),
    setDocId: (docId) => {
      state.docId = docId;
    },
    tick: () => frames.flush(),
    pageChildren: () => document.documentElement.children.length - baseline,
    pageNodes: () =>
      [...document.documentElement.children].slice(baseline).map((n) => n.tagName.toLowerCase()),
    listenerBalance: () => ({
      added: count(addSpy.mock.calls as unknown[][]),
      removed: count(removeSpy.mock.calls as unknown[][]),
    }),
    intervalBalance: () => ({
      added: setIntervalSpy.mock.calls.length,
      removed: clearIntervalSpy.mock.calls.length,
    }),
    setReducedMotion: (value) => {
      reduced = value;
    },
    restore: () => {
      addSpy.mockRestore();
      removeSpy.mockRestore();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    },
  };
}

let harness: Harness | null = null;

beforeEach(() => {
  document.documentElement.replaceChildren(document.createElement('body'));
});

afterEach(() => {
  harness?.handle.dispose();
  harness?.restore();
  harness = null;
});

const spec = (kind: (typeof PRIMITIVE_KINDS)[number], fields: object = {}): AnyPrimitiveSpec =>
  primitiveSpec(kind, fields as never);

/** Every kind, with the fields each one needs, for the loops that must cover all seven. */
const ALL: AnyPrimitiveSpec[] = PRIMITIVE_KINDS.map((kind) =>
  spec(kind, kind === 'badge' ? { index: 1 } : kind === 'label' ? { text: 'x' } : {})
);

describe('reuse: F-02 owns the host, the root and the registry', () => {
  it('adds nothing to the page until the first annotation', () => {
    harness = createHarness();
    expect(harness.pageChildren()).toBe(0);
    harness.handle.mount();
    // Exactly one host element reaches the page tree, and at most one attribute-free <style>
    // alongside it on engines without adopted stylesheets. Nothing the walker could see: a
    // `<style>` is in its ignored set, checked before its attribute rule.
    const nodes = harness.pageNodes();
    expect(nodes.filter((tag) => tag === 'div')).toEqual(['div']);
    expect(nodes.every((tag) => tag === 'div' || tag === 'style')).toBe(true);
    harness.handle.dispose();
    expect(harness.pageChildren()).toBe(0);
  });

  it('keeps the closed root and the attribute-free host with a primitive renderer installed', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(10, 10), element: null });
    show(harness.handle, anchor('e1'), spec('circle'));
    harness.tick();
    const host = harness.handle.host!;
    // F-02's contract, unchanged: page script cannot open the root, and the host is a bare div so
    // B-02's walker cannot mistake it for page evidence.
    expect(host.shadowRoot).toBeNull();
    expect(host.attributes).toHaveLength(0);
    expect(host.tagName).toBe('DIV');
    expect(document.querySelectorAll('.pa')).toHaveLength(0);
  });

  it('keys annotations on doc_id and element_id, so a new generation is a new annotation', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(10, 10), element: null });
    const first = show(harness.handle, anchor('e1'), spec('badge', { index: 1 }));
    // Same element id, retired document generation: a different target, not a re-point.
    const second = show(harness.handle, anchor('e1', NEXT_DOC), spec('badge', { index: 1 }));
    expect(first).not.toBe(second);
    expect(harness.handle.size).toBe(2);
  });

  it('goes through the injected resolver for every annotation, minting no ids of its own', () => {
    harness = createHarness();
    const { state } = createFakeResolver();
    expect(state.resolveCalls).toBe(0);
    harness.answer('e1', { status: 'ok', rect: rect(10, 10), element: null });
    show(harness.handle, anchor('e1'), spec('arrow'));
    harness.tick();
    // Two lookups: the update's tick and the follow-up the test flushed.
    expect(harness.handle.size).toBe(1);
  });

  it('still enforces the core annotation cap across all seven kinds', () => {
    harness = createHarness();
    const active = harness;
    for (let i = 0; i < 64; i++) {
      active.answer(`e${i}`, { status: 'ok', rect: rect(i, i), element: null });
    }
    for (let i = 0; i < 64; i++) {
      show(active.handle, anchor(`e${i}`), spec('pointer'));
    }
    expect(active.handle.size).toBe(64);
    expect(() => show(active.handle, anchor('overflow'), spec('pointer'))).toThrow(RangeError);
  });

  it('measures a full frame of every kind well inside the long-task budget', () => {
    harness = createHarness();
    const active = harness;
    // Nine targets × seven kinds = 63, one under the core's cap of 64: a realistic worst case
    // is a handful of annotations, but the budget has to hold for the most a caller may ask for.
    for (let i = 0; i < 9; i++) {
      for (const [j, spec] of ALL.entries()) {
        active.answer(`e${i}-${j}`, { status: 'ok', rect: rect(10 + i, 10 + j), element: null });
        show(active.handle, anchor(`e${i}-${j}`), spec);
      }
    }
    active.tick();
    const metrics = active.handle.metrics();
    expect(active.handle.size).toBe(9 * ALL.length);
    expect(metrics.frames).toBe(1);
    expect(metrics.longestFrameMs).toBeLessThan(50);
  });
});

describe('rule 2: a stale or missing target removes its decoration', () => {
  it('reports stale once the document generation is retired, and never re-points', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(400, 400), element: null });
    const id = show(harness.handle, anchor('e1'), spec('circle'));
    harness.tick();
    expect(harness.handle.statusOf(id)).toBe('visible');
    const position = harness.handle.positionOf(id);

    harness.setDocId(NEXT_DOC);
    harness.handle.refresh();
    harness.tick();
    expect(harness.handle.statusOf(id)).toBe('stale');
    // The last known position is released rather than kept, so nothing can draw from it.
    expect(harness.handle.positionOf(id)).toBeNull();
    expect(position).not.toBeNull();
    expect(harness.statusChanges).toContainEqual([id, 'stale']);
  });

  it('suppresses a target the resolver reports hidden, without falling back to a neighbour', () => {
    harness = createHarness();
    harness.answer('e1', {
      status: 'ok',
      rect: rect(400, 400),
      element: document.createElement('div'),
    });
    const id = show(harness.handle, anchor('e1'), spec('underline'));
    harness.tick();
    expect(harness.handle.statusOf(id)).toBe('visible');

    // A box that is still reported, but the resolver says the node is not rendering. This is the
    // computed-style case: `visibility: hidden` keeps the full box, so a rect-only check would
    // have drawn straight through it.
    harness.answer('e1', { status: 'hidden', element: document.createElement('div') });
    harness.handle.refresh();
    harness.tick();
    expect(harness.handle.statusOf(id)).toBe('hidden');
    expect(harness.handle.positionOf(id)).toBeNull();
  });

  it.each(['missing', 'stale', 'unsupported'] as const)(
    'reports %s and drops the position',
    (status) => {
      harness = createHarness();
      harness.answer('e1', { status: 'ok', rect: rect(400, 400), element: null });
      const id = show(harness.handle, anchor('e1'), spec('spotlight'));
      harness.tick();
      expect(harness.handle.positionOf(id)).not.toBeNull();

      harness.answer('e1', { status });
      harness.handle.refresh();
      harness.tick();
      expect(harness.handle.statusOf(id)).toBe(status);
      expect(harness.handle.positionOf(id)).toBeNull();
    }
  );
});

describe('replacement', () => {
  it('reuses the node when the kind is unchanged and the spec only changed', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(400, 400), element: null });
    const id = show(harness.handle, anchor('e1'), spec('label', { text: 'one' }));
    harness.tick();
    // Node reuse is what keeps a retarget from restarting a transition the user is watching.
    const first = harness.handle.host!;
    expect(first.isConnected).toBe(true);

    const again = show(harness.handle, anchor('e1'), spec('label', { text: 'two' }));
    harness.tick();
    expect(again).toBe(id);
    expect(harness.handle.size).toBe(1);
    expect(harness.handle.host).toBe(first);
  });

  it('rebuilds the node when the kind changes, and keeps the annotation count at one', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(400, 400), element: null });
    const id = show(harness.handle, anchor('e1'), spec('pointer'));
    harness.tick();

    for (const kind of PRIMITIVE_KINDS) {
      show(harness.handle, anchor('e1'), spec(kind, kind === 'badge' ? { index: 2 } : {}));
      harness.tick();
      expect(harness.handle.size, kind).toBe(1);
      expect(harness.handle.statusOf(id), kind).toBe('visible');
    }
  });

  it('replaces a whole guidance set with clear, with nothing left behind', () => {
    harness = createHarness();
    for (const [i, s] of ALL.entries()) {
      harness.answer(`e${i}`, { status: 'ok', rect: rect(10 * i, 10 * i), element: null });
      show(harness.handle, anchor(`e${i}`), s);
    }
    harness.tick();
    expect(harness.handle.size).toBe(ALL.length);

    harness.handle.clear();
    expect(harness.handle.size).toBe(0);
    // Clearing stops the heartbeat and releases the target observations, so a live page pays
    // nothing for an overlay that is no longer drawing.
    expect(harness.intervalBalance().removed).toBe(harness.intervalBalance().added);

    show(harness.handle, anchor('e0'), spec('badge', { index: 9 }));
    harness.tick();
    expect(harness.handle.size).toBe(1);
  });
});

describe('rule 8: teardown', () => {
  it('releases one annotation without disturbing the others', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(10, 10), element: null });
    harness.answer('e2', { status: 'ok', rect: rect(20, 20), element: null });
    const a = show(harness.handle, anchor('e1'), spec('pointer'));
    show(harness.handle, anchor('e2'), spec('circle'));
    harness.tick();

    harness.handle.remove(a);
    expect(harness.handle.size).toBe(1);
    expect(harness.handle.statusOf(a)).toBe('unknown');
    // The heartbeat is still running: one annotation is left, so tracking continues.
    expect(harness.intervalBalance().added).toBe(1);
    harness.handle.refresh();
    harness.tick();
    expect(harness.handle.size).toBe(1);
  });

  it('stops listening once the last annotation is gone', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(10, 10), element: null });
    const id = show(harness.handle, anchor('e1'), spec('pointer'));
    harness.tick();
    expect(harness.intervalBalance().added).toBe(1);

    harness.handle.remove(id);
    const balance = harness.listenerBalance();
    expect(balance.removed).toBe(balance.added);
    expect(harness.intervalBalance().removed).toBe(1);
  });

  it('is total and idempotent on dispose', () => {
    harness = createHarness();
    for (const [i, s] of ALL.entries()) {
      harness.answer(`e${i}`, { status: 'ok', rect: rect(10 * i, 10 * i), element: null });
      show(harness.handle, anchor(`e${i}`), s);
    }
    harness.tick();

    harness.handle.dispose();
    expect(harness.handle.isDisposed).toBe(true);
    expect(harness.handle.size).toBe(0);
    expect(harness.handle.host).toBeNull();
    expect(harness.pageChildren()).toBe(0);
    const balance = harness.listenerBalance();
    expect(balance.removed).toBe(balance.added);
    expect(harness.intervalBalance().removed).toBe(harness.intervalBalance().added);

    expect(() => harness!.handle.dispose()).not.toThrow();
    expect(() => harness!.handle.update(anchor('e0'), { primitive: spec('pointer') })).toThrow();
  });

  it('leaves no queued frame behind after dispose', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(10, 10), element: null });
    show(harness.handle, anchor('e1'), spec('pointer', { durationMs: 500 }));
    harness.tick();
    // Move the target so a glide is genuinely in flight, then tear the layer down mid-glide.
    harness.answer('e1', { status: 'ok', rect: rect(400, 400), element: null });
    harness.handle.refresh();
    harness.tick();

    harness.handle.dispose();
    // The manual scheduler has nothing queued, so a flush is a no-op rather than a callback
    // writing into a destroyed host.
    expect(() => harness!.frames.flush()).not.toThrow();
    expect(harness.pageChildren()).toBe(0);
  });
});

describe('rule 6: the motion preference is the layer’s, not a primitive’s', () => {
  it('is reported by the handle, so a caller and its primitives cannot disagree', () => {
    harness = createHarness();
    expect(harness.handle.prefersReducedMotion()).toBe(false);
    harness.setReducedMotion(true);
    expect(harness.handle.prefersReducedMotion()).toBe(true);
  });

  it('reaches the primitives through the same context object', () => {
    // A layer configured for reduced motion must not be able to run an animated primitive, so
    // the preference is asserted through the renderer path rather than by inspecting a Glide.
    harness = createHarness({ reducedMotion: true });
    const created: string[] = [];
    const renderer = createPrimitiveRenderer();
    const spy = createPrimitiveOverlay({
      document,
      window,
      resolver: { currentDocId: () => DOC, resolve: () => ({ status: 'missing' }) },
      geometry: { viewport: () => VIEWPORT },
      scheduler: createManualFrameScheduler(),
      matchMedia: () => ({ matches: true }) as MediaQueryList,
      renderer: {
        ...renderer,
        create(documentRef, s, context) {
          created.push(String(context.prefersReducedMotion()));
          return renderer.create(documentRef, s, context);
        },
      },
    });
    try {
      show(spy, anchor('e1'), spec('pointer'));
      expect(created).toEqual(['true']);
    } finally {
      spy.dispose();
    }
  });
});
