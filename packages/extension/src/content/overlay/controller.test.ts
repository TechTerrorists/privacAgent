// @vitest-environment happy-dom
/** F-02: overlay lifecycle, isolation and cleanup. Geometry is injected; the DOM is real. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentId } from '@privacagent/protocol';
import { createOverlay } from './controller.js';
import { createManualFrameScheduler } from './scheduler.js';
import { MARKER_SIZE } from './host.js';
import type {
  AnchorStatus,
  OverlayAnchor,
  OverlayHandle,
  ResolveResult,
  TargetResolver,
  ViewportRect,
} from './types.js';

const DOC = 'd-test-0001' as DocumentId;
const NEXT_DOC = 'd-test-0002' as DocumentId;
const anchor = (id: string, docId: DocumentId = DOC): OverlayAnchor => ({
  doc_id: docId,
  element_id: id,
});
const anchorKey = (a: OverlayAnchor): string => `${a.doc_id}/${a.element_id}`;
const rect = (x: number, y: number, width = 100, height = 20): ViewportRect => ({
  x,
  y,
  width,
  height,
});

const VIEWPORT: ViewportRect = { x: 0, y: 0, width: 1000, height: 800 };

/** A resolver whose answers the test controls directly, so no browser geometry is involved. */
function createFakeResolver() {
  const state = {
    docId: DOC as DocumentId | null,
    answers: new Map<string, ResolveResult>(),
  };
  const resolver: TargetResolver = {
    currentDocId: () => state.docId,
    resolve(target) {
      const answer = state.answers.get(anchorKey(target));
      if (answer) return answer;
      return { status: 'missing' };
    },
  };
  return { state, resolver };
}

interface Harness {
  handle: OverlayHandle;
  frames: ReturnType<typeof createManualFrameScheduler>;
  statusChanges: Array<[string, AnchorStatus]>;
  /** Answer `resolve()` for one element id from now on. */
  answer: (id: string, answer: ResolveResult) => void;
  /** Move the document generation, as a SPA route change or navigation would. */
  setDocId: (docId: DocumentId | null) => void;
  tick: () => void;
  /**
   * Elements the overlay added directly to <html>, excluding whatever the fixture already had
   * there. A closed-root host is the only thing that should ever show up.
   */
  pageChildren: () => number;
  /** Window listeners the overlay added and removed, by event type. */
  listenerBalance: () => { added: number; removed: number };
  intervalBalance: () => { added: number; removed: number };
  restore: () => void;
}

function createHarness(
  options: { maxHostRecoveries?: number; onHostUnrecoverable?: () => void } = {}
): Harness {
  const { state, resolver } = createFakeResolver();
  const frames = createManualFrameScheduler();
  const statusChanges: Array<[string, AnchorStatus]> = [];
  const addSpy = vi.spyOn(window, 'addEventListener');
  const removeSpy = vi.spyOn(window, 'removeEventListener');
  const setIntervalSpy = vi.spyOn(window, 'setInterval');
  const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

  const handle = createOverlay({
    document,
    window,
    resolver,
    geometry: { viewport: () => VIEWPORT },
    scheduler: frames,
    onStatusChange: (id, status) => statusChanges.push([id, status]),
    ...(options.onHostUnrecoverable ? { onHostUnrecoverable: options.onHostUnrecoverable } : {}),
    ...(options.maxHostRecoveries !== undefined
      ? { maxHostRecoveries: options.maxHostRecoveries }
      : {}),
  });
  const baseline = document.documentElement.children.length;

  // Only the overlay's own signal listeners matter: happy-dom itself registers unrelated ones.
  const signalTypes = new Set(['scroll', 'resize']);
  const count = (calls: unknown[][]) =>
    calls.filter((call) => signalTypes.has(String(call[0]))).length;

  return {
    handle,
    frames,
    statusChanges,
    answer: (id, answer) => state.answers.set(anchorKey(anchor(id)), answer),
    setDocId: (docId) => {
      state.docId = docId;
    },
    tick: () => {
      frames.flush();
    },
    pageChildren: () => document.documentElement.children.length - baseline,
    listenerBalance: () => ({
      added: count(addSpy.mock.calls as unknown[][]),
      removed: count(removeSpy.mock.calls as unknown[][]),
    }),
    intervalBalance: () => ({
      added: setIntervalSpy.mock.calls.length,
      removed: clearIntervalSpy.mock.calls.length,
    }),
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

describe('host isolation', () => {
  it('adds nothing to the page until the first annotation', () => {
    harness = createHarness();
    expect(harness.pageChildren()).toBe(0);
    harness.handle.mount();
    expect(harness.pageChildren()).toBe(1);
    harness.handle.dispose();
    expect(harness.pageChildren()).toBe(0);
  });

  it('uses a closed shadow root, so page script cannot reach the overlay', () => {
    harness = createHarness();
    harness.handle.update(anchor('e1'));
    const host = harness.handle.host as Element;
    expect(host).not.toBeNull();
    expect(host.shadowRoot).toBeNull();
  });

  it('leaves the host with no attributes at all, keeping B-02 evidence clean', () => {
    harness = createHarness();
    harness.handle.update(anchor('e1'));
    const host = harness.handle.host as Element;
    // B-02 reports any element carrying an attribute as raw page evidence, so the host must
    // have none: no id, no data- marker, not even an inline style.
    expect(host.attributes).toHaveLength(0);
    expect(host.tagName).toBe('DIV');
    expect(host.parentElement).toBe(document.documentElement);
  });

  it('keeps every marker inside the closed root, out of the page tree', () => {
    harness = createHarness();
    harness.handle.update(anchor('e1'), { label: 'hello' });
    harness.tick();
    // Nothing in the page tree can be selected, and the walker only ever sees the bare host.
    expect(document.querySelectorAll('.marker')).toHaveLength(0);
    expect(harness.pageChildren()).toBe(1);
  });

  it('writes a label as text and never as markup', () => {
    harness = createHarness();
    harness.handle.update(anchor('e1'), { label: '<img src=x onerror="globalThis.pwned=1">' });
    harness.tick();
    // The closed root is the safety property: if the label were ever parsed as markup, the
    // resulting node would have to land in the page tree to become page script.
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain('onerror');
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });
});

describe('positioning', () => {
  it('places a marker below the target and reports it visible', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(400, 400), element: null });
    const id = harness.handle.update(anchor('e1'));
    harness.tick();
    expect(harness.handle.statusOf(id)).toBe('visible');
    expect(harness.statusChanges).toContainEqual([id, 'visible']);
  });

  it('suppresses a target that has left the viewport', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(400, 5000), element: null });
    const id = harness.handle.update(anchor('e1'));
    harness.tick();
    expect(harness.handle.statusOf(id)).toBe('offscreen');
  });

  it('reports a zero-area target as hidden rather than pinning a marker to it', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(400, 400, 0, 0), element: null });
    const id = harness.handle.update(anchor('e1'));
    harness.tick();
    expect(harness.handle.statusOf(id)).toBe('hidden');
  });

  it('re-points an existing annotation instead of adding a second marker', () => {
    harness = createHarness();
    const first = harness.handle.update(anchor('e1'), { label: 'one' });
    const second = harness.handle.update(anchor('e1'), { label: 'two' });
    expect(first).toBe(second);
    expect(harness.handle.size).toBe(1);
  });

  it('keeps the same element id under a new document generation as a separate annotation', () => {
    harness = createHarness();
    const first = harness.handle.update(anchor('e1'));
    const second = harness.handle.update(anchor('e1', NEXT_DOC));
    expect(first).not.toBe(second);
    expect(harness.handle.size).toBe(2);
  });
});

describe('staleness and unsupported targets', () => {
  it('marks every annotation stale once the document generation moves on', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(400, 400), element: null });
    const id = harness.handle.update(anchor('e1'));
    harness.tick();
    expect(harness.handle.statusOf(id)).toBe('visible');

    harness.statusChanges.length = 0;
    harness.setDocId(NEXT_DOC);
    harness.handle.refresh();
    harness.tick();
    // A retired id identifies nothing, even though a similar node is still in the page.
    expect(harness.handle.statusOf(id)).toBe('stale');
    expect(harness.statusChanges).toContainEqual([id, 'stale']);
  });

  it('marks annotations stale when the document is no longer addressable at all', () => {
    harness = createHarness();
    const id = harness.handle.update(anchor('e1'));
    harness.setDocId(null);
    harness.handle.refresh();
    harness.tick();
    expect(harness.handle.statusOf(id)).toBe('stale');
  });

  it('passes through missing and unsupported statuses from the resolver', () => {
    harness = createHarness();
    const missing = harness.handle.update(anchor('gone'));
    const cross = harness.handle.update(anchor('cross'));
    harness.tick();
    expect(harness.handle.statusOf(missing)).toBe('missing');
    expect(harness.handle.statusOf(cross)).toBe('missing');

    harness.answer('cross', { status: 'unsupported' });
    harness.handle.refresh();
    harness.tick();
    expect(harness.handle.statusOf(cross)).toBe('unsupported');
  });

  it('emits a status change only when the status actually changes', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(400, 400), element: null });
    const id = harness.handle.update(anchor('e1'));
    harness.tick();
    harness.tick();
    harness.tick();
    expect(harness.statusChanges.filter(([key]) => key === id)).toEqual([[id, 'visible']]);
  });
});

describe('teardown', () => {
  it('removes the host and drops every annotation on dispose', () => {
    harness = createHarness();
    harness.handle.update(anchor('e1'));
    harness.handle.update(anchor('e2'));
    harness.tick();
    expect(harness.handle.host).not.toBeNull();

    harness.handle.dispose();
    expect(harness.pageChildren()).toBe(0);
    expect(harness.handle.host).toBeNull();
    expect(harness.handle.size).toBe(0);
    expect(harness.handle.isDisposed).toBe(true);
  });

  it('leaves no window scroll or resize listener behind', () => {
    harness = createHarness();
    expect(harness.listenerBalance().added).toBe(0);
    harness.handle.update(anchor('e1'));
    const listening = harness.listenerBalance();
    expect(listening.added).toBeGreaterThan(0);
    harness.handle.dispose();
    expect(harness.listenerBalance().removed).toBe(listening.added);
  });

  it('leaves no heartbeat interval behind', () => {
    harness = createHarness();
    harness.handle.update(anchor('e1'));
    expect(harness.intervalBalance().added).toBe(1);
    harness.handle.dispose();
    expect(harness.intervalBalance().removed).toBe(1);
  });

  it('drops the listeners and the heartbeat when the last annotation is removed', () => {
    harness = createHarness();
    const id = harness.handle.update(anchor('e1'));
    const listening = harness.listenerBalance();
    harness.handle.remove(id);
    expect(harness.listenerBalance().removed).toBe(listening.added);
    expect(harness.intervalBalance().removed).toBe(1);
  });

  it('is idempotent and refuses work afterwards', () => {
    harness = createHarness();
    harness.handle.dispose();
    harness.handle.dispose();
    expect(harness.handle.isDisposed).toBe(true);
    expect(() => harness!.handle.update(anchor('e1'))).toThrow();
    expect(harness.pageChildren()).toBe(0);
  });

  it('mounts only once however often mount is called', () => {
    harness = createHarness();
    harness.handle.mount();
    harness.handle.mount();
    const host = harness.handle.host;
    harness.handle.mount();
    expect(harness.handle.host).toBe(host);
    expect(harness.pageChildren()).toBe(1);
  });

  it('stops measuring once the last annotation is removed', () => {
    harness = createHarness();
    const id = harness.handle.update(anchor('e1'));
    harness.tick();
    const before = harness.handle.metrics().frames;
    harness.handle.remove(id);
    harness.tick();
    expect(harness.handle.metrics().frames).toBe(before);
    expect(harness.handle.statusOf(id)).toBe('unknown');
  });

  it('clears annotations and their nodes', () => {
    harness = createHarness();
    harness.handle.update(anchor('e1'));
    harness.handle.update(anchor('e2'));
    harness.tick();
    harness.handle.clear();
    expect(harness.handle.size).toBe(0);
  });
});

describe('host removal by page script', () => {
  it('re-attaches a host the page removed', async () => {
    harness = createHarness();
    harness.handle.update(anchor('e1'));
    const host = harness.handle.host as Element;
    host.remove();
    expect(host.isConnected).toBe(false);
    // The MutationObserver callback lands on a microtask.
    await Promise.resolve();
    expect(host.isConnected).toBe(true);
    expect(harness.pageChildren()).toBe(1);
  });

  it('gives up after the recovery budget and reports it instead of looping', async () => {
    let exhausted = false;
    harness = createHarness({
      maxHostRecoveries: 1,
      onHostUnrecoverable: () => {
        exhausted = true;
      },
    });
    harness.handle.update(anchor('e1'));
    const host = harness.handle.host as Element;

    host.remove();
    await Promise.resolve();
    expect(host.isConnected).toBe(true);

    // A page that keeps deleting the host must not be able to keep the overlay busy.
    host.remove();
    await Promise.resolve();
    expect(exhausted).toBe(true);
    expect(host.isConnected).toBe(false);
  });
});

describe('budgets', () => {
  it('refuses more simultaneous annotations than one frame can safely measure', () => {
    harness = createHarness();
    for (let i = 0; i < 64; i++) harness.handle.update(anchor(`e${i}`));
    expect(() => harness!.handle.update(anchor('e64'))).toThrow(RangeError);
  });

  it('measures a full frame of annotations well inside the long-task budget', () => {
    harness = createHarness();
    for (let i = 0; i < 32; i++) {
      harness.answer(`e${i}`, { status: 'ok', rect: rect(10 + i, 10 + i), element: null });
      harness.handle.update(anchor(`e${i}`));
    }
    harness.tick();
    const metrics = harness.handle.metrics();
    expect(metrics.frames).toBe(1);
    expect(metrics.updates).toBe(1);
    expect(metrics.longestFrameMs).toBeLessThan(50);
  });

  it('coalesces many signals in one frame into a single measurement pass', () => {
    harness = createHarness();
    harness.answer('e1', { status: 'ok', rect: rect(10, 10), element: null });
    harness.handle.update(anchor('e1'));
    harness.handle.update(anchor('e1'));
    harness.handle.update(anchor('e1'));
    harness.tick();
    expect(harness.handle.metrics().frames).toBe(1);
  });

  it('exposes a marker size the positioner can clamp against', () => {
    expect(MARKER_SIZE.width).toBeGreaterThan(0);
    expect(MARKER_SIZE.height).toBeGreaterThan(0);
  });
});
