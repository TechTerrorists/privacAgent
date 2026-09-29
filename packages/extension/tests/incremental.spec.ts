import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type * as Incremental from './incremental-entry.js';
declare global {
  interface Window {
    incremental: typeof Incremental;
  }
}
let script: string;
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./incremental-entry.ts', import.meta.url))],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'incremental',
    write: false,
  });
  script = bundle.outputFiles[0]!.text + '\nglobalThis.incremental = incremental;';
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: script });
  await page.goto('/');
});
test('diffs reproduce fresh extraction after edits, labels, moves and replacements', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML =
      '<section id="labels"><span id="label">Name</span></section><section id="a"><input aria-labelledby="label"><button>Before</button></section><section id="b"></section>';
    const session = new window.incremental.IncrementalSession(document);
    const base = new Map<string, Incremental.CandidateSnapshot>();
    const evidence = new Map<string, Incremental.EvidenceSnapshot>();
    const settle = async (owner = session) => {
      for (let i = 0; i < 5; i++) {
        const r = await owner.extract();
        if (r.status === 'complete') return r;
        if (r.status !== 'unstable') throw new Error(r.status);
      }
      throw new Error('Unstable fixture');
    };
    const check = async () => {
      const delta = await settle();
      if (delta.baseline === null) {
        base.clear();
        evidence.clear();
      }
      for (const id of delta.evidence.removed) evidence.delete(id);
      for (const entry of [...delta.evidence.added, ...delta.evidence.changed])
        evidence.set(entry.id, entry);
      for (const id of delta.candidates.removed) base.delete(id);
      for (const entry of [...delta.candidates.added, ...delta.candidates.changed])
        base.set(entry.id, entry);
      const fresh = new window.incremental.IncrementalSession(document, {}, session.registry);
      try {
        const expected = await settle(fresh);
        const sorted = (entries: Iterable<Incremental.CandidateSnapshot>) =>
          [...entries].sort((a, b) => a.id.localeCompare(b.id));
        if (
          JSON.stringify(sorted(base.values())) !==
          JSON.stringify(sorted(expected.candidates.added))
        )
          throw new Error('Incremental/fresh mismatch');
        const normalized = (items: Iterable<Incremental.EvidenceSnapshot>) =>
          [...items]
            .map(({ kind, text, attributes }) => JSON.stringify({ kind, text, attributes }))
            .sort();
        if (
          JSON.stringify(normalized(evidence.values())) !==
          JSON.stringify(normalized(expected.evidence.added))
        )
          throw new Error('Evidence/fresh mismatch');
      } finally {
        fresh.dispose();
      }
      return delta;
    };
    try {
      await check();
      document.querySelector('button')!.firstChild!.textContent = 'After';
      const small = await check();
      document.getElementById('label')!.firstChild!.textContent = 'External';
      await check();
      const input = document.querySelector('input')!;
      input.value = 'Live';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await check();
      document.getElementById('b')!.append(input);
      await check();
      input.outerHTML = '<input aria-label="Replacement">';
      await check();
      document.getElementById('a')!.remove();
      await check();
      const noop = await check();
      return {
        small: small.metrics.extracted,
        noop: noop.metrics.extracted,
        walks: noop.metrics.fullWalks + noop.metrics.subtreeWalks,
      };
    } finally {
      session.dispose();
    }
  });
  expect(result).toEqual({ small: 1, noop: 0, walks: 0 });
});
test('observes shadows and frames, drops detached roots, discovers navigation and resets SPA baseline', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = '<button>Top</button><div id="host"></div><iframe></iframe>';
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Shadow</button>';
    const frame = document.querySelector('iframe')!;
    frame.contentDocument!.body.innerHTML = '<button>Frame</button><div id="nested"></div>';
    frame.contentDocument!.getElementById('nested')!.attachShadow({ mode: 'open' }).innerHTML =
      '<button>Nested</button>';
    const session = new window.incremental.IncrementalSession(document);
    const settle = async () => {
      for (let i = 0; i < 6; i++) {
        const r = await session.extract();
        if (r.status === 'complete') return r;
        if (r.status !== 'unstable') throw new Error(r.status);
      }
      throw new Error('Unstable');
    };
    try {
      const first = await settle();
      const roots = session.diagnostics().roots;
      shadow.querySelector('button')!.firstChild!.textContent = 'Shadow edited';
      const edit = await settle();
      await new Promise<void>((resolve) => {
        frame.onload = () => resolve();
        frame.srcdoc = '<button>Navigated</button>';
      });
      const navigation = await settle();
      const afterNavigation = session.diagnostics().roots;
      frame.remove();
      const removed = await settle();
      const afterRemoval = session.diagnostics().roots;
      const late = document.createElement('div');
      document.body.append(late);
      late.attachShadow({ mode: 'open' }).innerHTML = '<button>Late shadow</button>';
      const added = await settle();
      history.pushState({}, '', '?spa=b06');
      const spa = await settle();
      return {
        names: first.candidates.added.map((x) => x.semantics.name),
        roots,
        edited: edit.candidates.changed.some((x) => x.semantics.name === 'Shadow edited'),
        navigated: navigation.candidates.added.some((x) => x.semantics.name === 'Navigated'),
        afterNavigation,
        removed: removed.candidates.removed.length,
        afterRemoval,
        late: added.candidates.added.some((x) => x.semantics.name === 'Late shadow'),
        reset: spa.baseline === null,
      };
    } finally {
      session.dispose();
    }
  });
  expect(result.names).toEqual(expect.arrayContaining(['Top', 'Shadow', 'Frame', 'Nested']));
  expect(result).toMatchObject({
    roots: 4,
    edited: true,
    navigated: true,
    afterNavigation: 3,
    afterRemoval: 2,
    late: true,
    reset: true,
  });
  expect(result.removed).toBeGreaterThan(0);
});
test('racing scans, overflow, abort, CSSOM invalidation and disposal are bounded', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML =
      '<button>Initial</button><input type="radio" name="g" checked><input type="radio" name="g">';
    const session = new window.incremental.IncrementalSession(document, {
      maxRecords: 2,
      maxUnitsPerChunk: 16,
    });
    const settle = async () => {
      for (let i = 0; i < 5; i++) {
        const r = await session.extract();
        if (r.status === 'complete') return r;
        if (r.status !== 'unstable') throw new Error(r.status);
      }
      throw new Error('Unstable');
    };
    const initial = session.extract();
    document.querySelector('button')!.setAttribute('title', 'Initial race');
    const initialRace = (await initial).status;
    await settle();
    const pending = session.extract();
    document.querySelector('button')!.textContent = 'Raced';
    const race = await pending;
    const after = await settle();
    const radios = document.querySelectorAll('input');
    radios[1]!.click();
    const radio = await settle();
    const controller = new AbortController();
    controller.abort();
    const aborted = await session.extract(controller.signal);
    for (let i = 0; i < 8; i++) document.querySelector('button')!.setAttribute('title', String(i));
    const overflow = await settle();
    session.invalidate('layout');
    const layout = await settle();
    session.dispose();
    return {
      initialRace,
      race: race.status,
      changed: after.candidates.changed.some((x) => x.semantics.name === 'Raced'),
      radio: radio.candidates.changed.filter((x) => 'checked' in x.state).length,
      aborted: aborted.status,
      overflow: overflow.full,
      layout: layout.full,
      disposed: session.diagnostics(),
    };
  });
  expect(result).toMatchObject({
    initialRace: 'unstable',
    race: 'unstable',
    changed: true,
    radio: 2,
    aborted: 'cancelled',
    overflow: true,
    layout: true,
    disposed: { roots: 0, candidates: 0, evidence: 0, queued: 0 },
  });
});
test('benchmark: 2000-node baseline, small edit and no-op work counters', async ({
  page,
}, testInfo) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = Array.from(
      { length: 1000 },
      (_, i) => `<button>Item ${i}</button>`
    ).join('');
    const session = new window.incremental.IncrementalSession(document);
    const settle = async () => {
      for (let i = 0; i < 5; i++) {
        const r = await session.extract();
        if (r.status === 'complete') return r;
        if (r.status !== 'unstable') throw new Error(r.status);
      }
      throw new Error('Unstable');
    };
    try {
      const full = await settle();
      document.querySelector('button')!.textContent = 'Edited';
      const edit = await settle();
      const noop = await settle();
      return {
        full: full.metrics,
        edit: edit.metrics,
        noop: noop.metrics,
        changed: edit.candidates.changed.length,
      };
    } finally {
      session.dispose();
    }
  });
  await testInfo.attach('b06-counters', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  expect(result.changed).toBe(1);
  expect(result.edit).toMatchObject({ fullWalks: 0, subtreeWalks: 1, extracted: 1 });
  expect(result.noop).toMatchObject({ fullWalks: 0, subtreeWalks: 0, extracted: 0 });
  expect(result.edit.longestChunkMs).toBeLessThan(50);
  expect(result.noop.longestChunkMs).toBeLessThan(50);
});
