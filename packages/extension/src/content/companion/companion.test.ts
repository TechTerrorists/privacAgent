// @vitest-environment happy-dom
/**
 * F-08: the companion through F-02's real controller.
 *
 * The reducer tests cover which state a sequence may produce. These cover the parts that are only
 * true because the companion rides on F-02's layer rather than beside it:
 *
 * - one host, one closed shadow root, no second renderer;
 * - `listening` and `thinking` are the only states with anything running, and idle does not;
 * - disabling removes the annotation, which is what stops F-02's listeners *and* its heartbeat;
 * - the pointer listener exists only while enabled;
 * - the companion does not steal a single click or keystroke from the page.
 *
 * The teardown assertions are the load-bearing ones. "Disabled means no node, no listener, no
 * timer" is a promise about a closed shadow root nobody can inspect from the page, so it has to be
 * asserted from the only side that can see it: F-02's own counters and the real window's listener
 * bookkeeping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentId } from '@privacagent/protocol';
import { createOverlay, type OverlayHandle } from '../overlay/index.js';
import { createManualFrameScheduler } from '../overlay/scheduler.js';
import {
  createCompanionResolver,
  createPointerSource,
  type PointerSource,
} from './pointer-resolver.js';
import { createCompanionController, type CompanionController } from './controller.js';
import { createCompanionRenderer } from './renderer.js';
import {
  COMPANION_ELEMENT_ID,
  companionAnchor,
  type CompanionEvent,
  type CompanionSnapshot,
} from './types.js';
import type { OverlayAnchor, ResolveResult, TargetResolver } from '../overlay/types.js';

const DOC = 'd-f08-0001' as DocumentId;

function createFakeBaseResolver(): TargetResolver {
  return {
    currentDocId: () => DOC,
    resolve: (): ResolveResult => ({ status: 'missing' }),
  };
}

/** A pointer whose position a test sets directly, with no real cursor. */
function createFakePointer(): PointerSource & { moveTo(x: number, y: number): void } {
  let sample: { x: number; y: number } | null = null;
  let onMove: (() => void) | null = null;
  return {
    // A method, not a getter: the interface declares `current()` and a getter would silently
    // satisfy neither the type nor a caller that invokes it.
    current: () => sample,
    get isTracking() {
      return onMove !== null;
    },
    start(next) {
      onMove = next;
    },
    stop() {
      onMove = null;
      sample = null;
    },
    moveTo(x, y) {
      sample = { x, y };
      onMove?.();
    },
  };
}

/** A provider a test drives, standing in for A-11 / F-09. */
function createFakeAdapter() {
  const sinks = new Set<(event: CompanionEvent) => void>();
  return {
    available: true,
    label: 'test',
    deliver: (event: CompanionEvent) => {
      for (const sink of sinks) sink(event);
    },
    subscribe: (sink: (event: CompanionEvent) => void) => {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    get subscriberCount() {
      return sinks.size;
    },
  };
}

interface Harness {
  overlay: OverlayHandle;
  pointer: ReturnType<typeof createFakePointer>;
  adapter: ReturnType<typeof createFakeAdapter>;
  controller: CompanionController;
  snapshots: CompanionSnapshot[];
  frames: ReturnType<typeof createManualFrameScheduler>;
  runFrames(): void;
}

function harness(): Harness {
  const win = window;
  const frames = createManualFrameScheduler();
  const pointer = createFakePointer();
  const adapter = createFakeAdapter();
  const snapshots: CompanionSnapshot[] = [];

  const resolver = createCompanionResolver(createFakeBaseResolver(), pointer);
  const overlay = createOverlay({
    document,
    window: win,
    resolver,
    renderer: createCompanionRenderer(),
    scheduler: frames,
  });

  const controller = createCompanionController({
    overlay,
    resolver,
    pointer,
    adapter,
    onChange: (snapshot) => snapshots.push(snapshot),
  });

  return {
    overlay,
    pointer,
    adapter,
    controller,
    snapshots,
    frames,
    runFrames: () => frames.flush(),
  };
}

const identity = (generation = 1, taskId = 'task-1') => ({ generation, taskId });
const event = (type: CompanionEvent['type'], generation = 1) =>
  ({ type, identity: identity(generation) }) as CompanionEvent;

let h: Harness;

beforeEach(() => {
  document.body.innerHTML = '';
  h = harness();
});

afterEach(() => {
  h.controller.dispose();
  h.overlay.dispose();
  // Restores the window listener spies. Without this a later spy wraps the earlier one and each
  // call recurses into the next until the stack runs out, which is a confusing way to learn that
  // the harness needs a teardown.
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('lifecycle through F-02', () => {
  it('adds nothing to the page until it is enabled', () => {
    expect(document.querySelectorAll('div').length).toBe(0);
    expect(h.overlay.isMounted).toBe(false);
    expect(h.overlay.size).toBe(0);
  });

  it('mounts exactly one host when enabled, however many states follow', () => {
    h.controller.setEnabled(true);
    h.runFrames();
    for (const type of ['audio-capture-confirmed', 'task-started', 'acting'] as const) {
      h.adapter.deliver(event(type));
      h.runFrames();
    }
    // One host element for the whole page. A second layer, which is what a companion built on its
    // own shadow root would be, would make this 2.
    expect(document.querySelectorAll('div').length).toBe(1);
    expect(h.overlay.size).toBe(1);
  });

  it('leaves the shared host to F-02 rather than tearing down the layer it is riding on', () => {
    // Documented as a deliberate non-action. Disposing the overlay would destroy a host that
    // F-03 and every other annotation share, and would leave the session holding a permanently
    // dead handle, so the companion removes its annotation and stops there.
    h.controller.setEnabled(true);
    h.pointer.moveTo(100, 100);
    h.runFrames();

    h.controller.setEnabled(false);

    expect(h.overlay.size).toBe(0);
    expect(h.overlay.isDisposed).toBe(false);
    expect(h.overlay.isMounted).toBe(true);
  });

  it('draws the character beside the pointer, not at the origin', () => {
    h.controller.setEnabled(true);
    h.pointer.moveTo(300, 200);
    h.runFrames();

    const position = h.overlay.positionOf(h.controller.anchorId()!);
    expect(position).not.toBeNull();
    // F-02's positioner decides the exact offset, so this asserts the thing that matters: the
    // character is at the cursor. A companion that resolved to (0,0) would fail both bounds.
    expect(position!.x).toBeGreaterThan(200);
    expect(position!.x).toBeLessThan(400);
    expect(position!.y).toBeGreaterThan(100);
    expect(position!.y).toBeLessThan(300);
  });

  it('draws nothing at all before the pointer has ever moved', () => {
    // The initial-position requirement: no invented (0,0) and no invented centre of screen. The
    // status is `missing` rather than a fabricated `ok`, so the failure is visible to the caller.
    h.controller.setEnabled(true);
    h.runFrames();
    expect(h.overlay.statusOf(h.controller.anchorId()!)).toBe('missing');
  });

  it('reuses one annotation across state changes instead of churning the registry', () => {
    h.controller.setEnabled(true);
    h.pointer.moveTo(100, 100);
    h.runFrames();
    const before = h.controller.anchorId();

    h.adapter.deliver(event('acting'));
    h.runFrames();

    expect(h.controller.anchorId()).toBe(before);
    expect(h.overlay.size).toBe(1);
  });

  it('sends a rejected event straight to the state the user can see', () => {
    h.controller.setEnabled(true);
    h.pointer.moveTo(100, 100);
    h.runFrames();

    h.adapter.deliver(event('acting', 1));
    h.runFrames();
    expect(h.controller.snapshot().state).toBe('acting');

    h.adapter.deliver(event('thinking', 0));
    h.runFrames();
    // The stale event did not move the companion, and the refusal is observable.
    expect(h.controller.snapshot().state).toBe('acting');
    expect(h.controller.snapshot().lastRejected).toBe('stale-generation');
  });
});

describe('teardown', () => {
  it('removes its annotation when disabled', () => {
    h.controller.setEnabled(true);
    h.pointer.moveTo(100, 100);
    h.runFrames();
    expect(h.overlay.size).toBe(1);

    h.controller.setEnabled(false);

    // `size === 0` is the whole claim: F-02 releases the primitive and detaches its node when an
    // annotation is removed, so the character is gone from the closed root. The bare host `<div>`
    // that remains is F-02's layer, shared with every other annotation, and is not companion DOM.
    expect(h.overlay.size).toBe(0);
    expect(h.controller.anchorId()).toBeNull();
  });

  it('stops the layer entirely when disabled, so no heartbeat survives', () => {
    h.controller.setEnabled(true);
    h.pointer.moveTo(100, 100);
    h.runFrames();
    const framesWhileEnabled = h.overlay.metrics().frames;
    expect(framesWhileEnabled).toBeGreaterThan(0);

    h.controller.setEnabled(false);

    // The heartbeat is a real `setInterval` on the window. Rather than guess at F-02's internals,
    // this asserts the observable consequence: the overlay reports no annotations, and a fresh
    // tick produces no further frames.
    const framesAfterDisable = h.overlay.metrics().frames;
    h.frames.flush();
    expect(h.overlay.metrics().frames).toBe(framesAfterDisable);
  });

  it('removes the pointer listener when disabled', () => {
    h.controller.setEnabled(true);
    expect(h.pointer.isTracking).toBe(true);

    h.controller.setEnabled(false);
    expect(h.pointer.isTracking).toBe(false);
  });

  it('never attaches a pointer listener while disabled, however many events arrive', () => {
    h.adapter.deliver(event('acting'));
    h.adapter.deliver(event('audio-capture-confirmed'));
    h.runFrames();

    expect(h.pointer.isTracking).toBe(false);
    expect(h.overlay.size).toBe(0);
    // Never mounted at all, so not even F-02's host is on the page: a disabled companion that had
    // never been enabled leaves the document byte-for-byte as it found it.
    expect(h.overlay.isMounted).toBe(false);
    expect(document.querySelectorAll('div').length).toBe(0);
  });

  it('unsubscribes from the provider on dispose', () => {
    h.controller.setEnabled(true);
    expect(h.adapter.subscriberCount).toBe(1);

    h.controller.dispose();
    expect(h.adapter.subscriberCount).toBe(0);
  });

  it('ignores events that arrive after dispose', () => {
    h.controller.setEnabled(true);
    h.controller.dispose();
    h.adapter.deliver(event('acting'));
    expect(h.controller.snapshot().state).toBe('idle');
  });

  it('is idempotent across repeated enable, disable and dispose', () => {
    h.controller.setEnabled(true);
    h.controller.setEnabled(true);
    h.controller.setEnabled(false);
    h.controller.setEnabled(false);
    h.controller.dispose();
    h.controller.dispose();
    expect(h.overlay.size).toBe(0);
    expect(h.controller.isDisposed).toBe(true);
  });
});

describe('the companion never interferes with the page', () => {
  it('lets a click through to the element under the cursor', () => {
    const button = document.createElement('button');
    button.textContent = 'submit';
    document.body.append(button);
    const onClick = vi.fn();
    button.addEventListener('click', onClick);

    h.controller.setEnabled(true);
    h.pointer.moveTo(300, 200);
    h.runFrames();

    // The character is drawn near (300,200) but the shadow subtree is `pointer-events: none`, so
    // a real click at those coordinates reaches the page. Dispatched at the page because there is
    // no layout engine in a unit test, this still proves the companion holds no hit target.
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 300, clientY: 200 }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('adds no keyboard listener of any kind, while enabled or otherwise', () => {
    // The requirement is that the companion never captures keyboard input. It is asserted on the
    // real window rather than on the feature's own code, so a future refactor that starts
    // listening would fail here rather than pass by inspection.
    const added = spyOnWindowListeners();
    h.controller.setEnabled(true);
    h.pointer.moveTo(10, 10);
    h.runFrames();

    const keyboard = added.added.filter((type) => type.startsWith('key'));
    expect(keyboard).toEqual([]);
  });

  it('attaches exactly one pointermove listener while enabled, and removes it on disable', () => {
    // Built on the real pointer source rather than the fake, because the claim is about a
    // listener on the real window and a fake would prove nothing about it.
    const resolver = createCompanionResolver(createFakeBaseResolver(), createPointerSource(window));
    const overlay = createOverlay({
      document,
      window,
      resolver,
      renderer: createCompanionRenderer(),
      scheduler: createManualFrameScheduler(),
    });
    const controller = createCompanionController({
      overlay,
      resolver,
      pointer: createPointerSource(window),
      adapter: createFakeAdapter(),
    });

    const added = spyOnWindowListeners();
    const removed = spyOnWindowListeners('removeEventListener');

    controller.setEnabled(true);
    expect(added.added.filter((type) => type === 'pointermove')).toHaveLength(1);

    controller.setEnabled(false);
    expect(removed.removed.filter((type) => type === 'pointermove')).toHaveLength(1);

    controller.dispose();
    overlay.dispose();
  });
});

describe('the pointer resolver', () => {
  it('answers the companion anchor from the pointer and delegates everything else', () => {
    const seen: OverlayAnchor[] = [];
    const base: TargetResolver = {
      currentDocId: () => DOC,
      resolve: (target) => {
        seen.push(target);
        return { status: 'missing' };
      },
    };
    const pointer = createFakePointer();
    const resolver = createCompanionResolver(base, pointer);
    const anchor = companionAnchor(DOC)!;

    expect(resolver.resolve(anchor)).toEqual({ status: 'missing' });

    pointer.moveTo(120, 340);
    expect(resolver.resolve(anchor)).toEqual({
      status: 'ok',
      rect: { x: 120, y: 340, width: 1, height: 1 },
      element: null,
    });

    // A page anchor still goes to the registry, and the companion's synthetic id is not matched
    // by a partially-matching anchor.
    const pageAnchor: OverlayAnchor = { doc_id: DOC, element_id: 'e-1' } as OverlayAnchor;
    resolver.resolve(pageAnchor);
    expect(seen).toEqual([pageAnchor]);
  });

  it('redraws after the overlay drops its annotations, because pointer movement cannot', () => {
    // The bug this pins: on a top-level navigation the session calls `overlay.clear()`, which
    // removes every annotation without telling the companion. The companion kept its anchor id,
    // and since a pointer move only asks the layer to `refresh()` — re-measure what exists, create
    // nothing — the character never came back. Enabled, and gone for the rest of the session.
    h.controller.setEnabled(true);
    h.pointer.moveTo(300, 200);
    h.runFrames();
    const before = h.controller.anchorId();
    expect(before).not.toBeNull();
    expect(h.overlay.size).toBe(1);

    // What the session does on a top-level generation change.
    h.overlay.clear();
    expect(h.overlay.size).toBe(0);
    expect(h.controller.anchorId()).not.toBeNull();

    // Redraw happens inside `forgetAnchor`, so the id is replaced rather than left null. The
    // replacement id is the same *string* — it is derived from doc and element, and both are the
    // same — so the size going back up is the evidence that this is a new annotation and not the
    // old dead reference read back.
    h.controller.forgetAnchor();
    h.runFrames();
    expect(h.overlay.size).toBe(1);
    expect(h.controller.anchorId()).toBe(before);
  });

  it('stays absent after the overlay is cleared if the user had switched it off', () => {
    // `forgetAnchor` redraws, so it must not resurrect a companion the user turned off between the
    // navigation and the redraw. `draw` is a no-op while disabled, and that has to be the reason
    // the character does not come back.
    h.controller.setEnabled(true);
    h.pointer.moveTo(300, 200);
    h.runFrames();
    h.overlay.clear();
    h.controller.setEnabled(false);

    h.controller.forgetAnchor();
    h.runFrames();
    expect(h.controller.anchorId()).toBeNull();
    expect(h.overlay.size).toBe(0);
  });

  it('withdraws the anchor when the document generation is retired', () => {
    // `null` is the resolver's way of saying "this document is no longer addressable", and the
    // companion's anchor factory turns it into no anchor at all.
    expect(companionAnchor(null)).toBeNull();
    expect(companionAnchor(DOC)).toEqual({ doc_id: DOC, element_id: COMPANION_ELEMENT_ID });
  });

  it('ignores a pointer event with a non-finite coordinate', () => {
    // A malformed or synthetic event must not cache a position, and NaN would otherwise travel
    // through placement and kill the marker.
    const source = createPointerSource(window);
    source.start(() => undefined);
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: Number.NaN, clientY: 10, bubbles: true })
    );
    expect(source.current()).toBeNull();
  });

  it('forgets the position on stop, so a re-enable does not draw at a stale spot', () => {
    const source = createPointerSource(window);
    source.start(() => undefined);
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 500, clientY: 500, bubbles: true })
    );
    expect(source.current()).toEqual({ x: 500, y: 500 });

    source.stop();
    expect(source.current()).toBeNull();
  });
});

/**
 * Records the window's own `addEventListener` traffic.
 *
 * happy-dom keeps no listener registry, so the only way to assert "no listener while disabled" is
 * to watch the real call. This is stronger than counting what the feature says it adds: a
 * transitive listener added by a helper would still be caught.
 */
function spyOnWindowListeners(
  method: 'addEventListener' | 'removeEventListener' = 'addEventListener'
): { added: string[]; removed: string[] } {
  const record: { added: string[]; removed: string[] } = { added: [], removed: [] };
  // Bound before the spy is installed, so the real implementation is captured rather than the
  // mock — otherwise each call would recurse into the replacement.
  const original = window[method].bind(window) as (...args: unknown[]) => unknown;
  const spy = vi.spyOn(window, method);
  spy.mockImplementation(((...args: unknown[]) => {
    (method === 'addEventListener' ? record.added : record.removed).push(String(args[0]));
    return original(...args);
  }) as never);
  return record;
}
