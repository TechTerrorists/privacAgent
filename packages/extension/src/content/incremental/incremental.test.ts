// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { IncrementalSession } from './index.js';
import type { CandidateSnapshot, Observation, ObservationResult } from './types.js';
import type { WorkScheduler } from '../dom-extract/scheduler.js';
const scheduler: WorkScheduler = {
  now: () => performance.now(),
  request: (callback) => {
    const timer = setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 8 }), 0);
    return () => clearTimeout(timer);
  },
};
async function settled(session: IncrementalSession): Promise<Observation> {
  for (let i = 0; i < 4; i++) {
    const result = await session.extract();
    if (result.status === 'complete') return result;
    if (result.status !== 'unstable') throw new Error(result.status);
  }
  throw new Error('Unstable fixture');
}
function apply(base: Map<string, CandidateSnapshot>, change: Observation) {
  if (change.baseline === null) base.clear();
  for (const id of change.candidates.removed) base.delete(id);
  for (const item of [...change.candidates.added, ...change.candidates.changed])
    base.set(item.id, item);
}
async function equalsFresh(session: IncrementalSession, base: Map<string, CandidateSnapshot>) {
  const fresh = new IncrementalSession(document, { scheduler }, session.registry);
  try {
    const observation = await settled(fresh);
    expect([...base.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...observation.candidates.added].sort((a, b) => a.id.localeCompare(b.id))
    );
  } finally {
    fresh.dispose();
  }
}
describe('B-06 immutable local observations', () => {
  it('no-op avoids walking or re-extracting and a text edit selects one target', async () => {
    document.body.innerHTML = '<button>One</button><button>Two</button>';
    const session = new IncrementalSession(document, { scheduler });
    try {
      const first = await settled(session);
      const base = new Map<string, CandidateSnapshot>();
      apply(base, first);
      const noop = await settled(session);
      expect(noop.metrics).toMatchObject({ fullWalks: 0, subtreeWalks: 0, extracted: 0 });
      expect(noop.candidates).toEqual({ added: [], changed: [], removed: [] });
      document.querySelector('button')!.firstChild!.textContent = 'Changed';
      const edit = await settled(session);
      expect(edit.metrics.extracted).toBe(1);
      expect(edit.candidates.changed).toHaveLength(1);
      expect(first.candidates.added[0]!.semantics.name).toBe('One');
      apply(base, edit);
      await equalsFresh(session, base);
    } finally {
      session.dispose();
    }
  });
  it('add, move, remove/reinsert, replacement and removal reproduce fresh extraction', async () => {
    document.body.innerHTML =
      '<section id="a"><button>One</button></section><section id="b"></section>';
    const session = new IncrementalSession(document, { scheduler });
    const base = new Map<string, CandidateSnapshot>();
    try {
      apply(base, await settled(session));
      const oldId = [...base.keys()][0]!;
      const button = document.querySelector('button')!;
      document.getElementById('b')!.append(button);
      let diff = await settled(session);
      apply(base, diff);
      expect(base.has(oldId)).toBe(true);
      await equalsFresh(session, base);
      button.remove();
      document.getElementById('a')!.append(button);
      diff = await settled(session);
      apply(base, diff);
      expect(diff.candidates.removed).not.toContain(oldId);
      await equalsFresh(session, base);
      button.outerHTML = '<button>One</button><input aria-label="New">';
      diff = await settled(session);
      apply(base, diff);
      expect(diff.candidates.removed).toContain(oldId);
      expect(diff.candidates.added).toHaveLength(2);
      await equalsFresh(session, base);
      document.getElementById('a')!.replaceChildren();
      apply(base, await settled(session));
      expect(base.size).toBe(0);
      await equalsFresh(session, base);
    } finally {
      session.dispose();
    }
  });
  it('tracks external labels, missing IDREF additions and independent evidence', async () => {
    document.body.innerHTML =
      '<div id="labels"><span id="label">Old</span></div><input aria-labelledby="label missing" data-private="RAW">';
    const session = new IncrementalSession(document, { scheduler });
    try {
      const first = await settled(session);
      document.getElementById('label')!.firstChild!.textContent = 'New';
      let edit = await settled(session);
      expect(edit.candidates.changed[0]!.semantics.name).toBe('New');
      expect(edit.evidence.changed.some((e) => e.text === 'New')).toBe(true);
      const span = document.createElement('span');
      span.id = 'missing';
      span.textContent = 'Added';
      document.getElementById('labels')!.append(span);
      edit = await settled(session);
      expect(edit.candidates.changed.some((e) => e.semantics.name === 'New Added')).toBe(true);
      document.querySelector('input')!.setAttribute('data-private', 'NEW_RAW');
      edit = await settled(session);
      expect(
        edit.evidence.changed.some((e) =>
          e.attributes.some(([k, v]) => k === 'data-private' && v === 'NEW_RAW')
        )
      ).toBe(true);
      expect(first.evidence.added.some((e) => e.attributes.some(([, v]) => v === 'RAW'))).toBe(
        true
      );
    } finally {
      session.dispose();
    }
  });
  it('tracks events and explicit live-property/layout invalidation and periodic reconciliation', async () => {
    document.body.innerHTML = '<input aria-label="Value"><input type="checkbox">';
    const session = new IncrementalSession(document, { scheduler, reconcileEvery: 3 });
    try {
      await settled(session);
      const input = document.querySelector('input')!;
      input.value = 'live';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect((await settled(session)).candidates.changed.some((e) => e.value === 'live')).toBe(
        true
      );
      input.value = 'explicit';
      session.invalidate('input', input);
      expect((await settled(session)).candidates.changed.some((e) => e.value === 'explicit')).toBe(
        true
      );
      input.value = 'silent';
      const periodic = await settled(session);
      expect(periodic.full).toBe(true);
      expect(periodic.candidates.changed.some((e) => e.value === 'silent')).toBe(true);
      session.invalidate('layout');
      expect((await settled(session)).full).toBe(true);
    } finally {
      session.dispose();
    }
  });
  it('does not commit aborted or racing scans and retries without losing mutations', async () => {
    document.body.innerHTML = '<button>Initial</button>';
    const session = new IncrementalSession(document, { scheduler, maxUnitsPerChunk: 1 });
    try {
      const pending = session.extract();
      expect((await session.extract()).status).toBe('busy');
      document.querySelector('button')!.textContent = 'Raced';
      const result = await pending;
      expect(['unstable', 'complete']).toContain(result.status);
      const first = await settled(session);
      const previous = first.observation;
      const controller = new AbortController();
      controller.abort();
      expect((await session.extract(controller.signal)).status).toBe('cancelled');
      document.querySelector('button')!.textContent = 'After abort';
      const next = await settled(session);
      expect(next.baseline).toBe(previous);
      expect(next.candidates.changed.some((e) => e.semantics.name === 'After abort')).toBe(true);
    } finally {
      session.dispose();
    }
  });
  it('overflow refreshes, top generations reset and disposal releases references', async () => {
    document.body.innerHTML = '<button>One</button>';
    const session = new IncrementalSession(document, { scheduler, maxRecords: 2 });
    await settled(session);
    const button = document.querySelector('button')!;
    for (let i = 0; i < 8; i++) button.setAttribute('aria-label', String(i));
    expect((await settled(session)).full).toBe(true);
    session.registry.invalidate();
    expect((await settled(session)).baseline).toBeNull();
    session.dispose();
    expect(session.diagnostics()).toMatchObject({
      roots: 0,
      candidates: 0,
      evidence: 0,
      queued: 0,
      disposed: true,
    });
    expect(await session.extract()).toEqual({ status: 'disposed' });
  });
  it('ignores exact owned nodes but keeps mixed page mutations', async () => {
    document.body.innerHTML = '<button>Page</button>';
    const owned = new WeakSet<Node>();
    const session = new IncrementalSession(document, { scheduler, ownedNodes: owned });
    try {
      await settled(session);
      const overlay = document.createElement('div');
      owned.add(overlay);
      document.body.append(overlay);
      expect((await settled(session)).metrics.extracted).toBe(0);
      const page = document.createElement('button');
      page.textContent = 'New';
      document.body.append(page);
      expect(
        (await settled(session)).candidates.added.some((e) => e.semantics.name === 'New')
      ).toBe(true);
    } finally {
      session.dispose();
    }
  });
  it('limits caches without committing a partial baseline', async () => {
    document.body.innerHTML = '<button>A</button><button>B</button>';
    const session = new IncrementalSession(document, { scheduler, maxEntries: 1 });
    try {
      const result: ObservationResult = await session.extract();
      expect(result.status).toBe('limited');
      expect(session.diagnostics().candidates).toBe(0);
    } finally {
      session.dispose();
    }
  });
});
