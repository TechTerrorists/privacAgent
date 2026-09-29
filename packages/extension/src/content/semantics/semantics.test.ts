// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  extractSemantics,
  extractRegisteredTarget,
  toElementRole,
  walkSemanticDocument,
} from './index.js';
import { ElementRegistry } from '../element-registry/index.js';
import { fixtures } from './fixtures.js';
import type { WorkScheduler } from '../dom-extract/scheduler.js';
const scheduler: WorkScheduler = {
  now: () => performance.now(),
  request: (callback) => {
    const timer = setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 8 }), 0);
    return () => clearTimeout(timer);
  },
};
async function extract(html: string) {
  document.body.innerHTML = html;
  const target = document.getElementById('target')!;
  const result = await extractSemantics([target], { scheduler });
  expect(result.status).toBe('complete');
  if (result.status !== 'complete') throw new Error('Extraction failed');
  return result.results[0]!;
}
describe('B-03 hand-authored semantics', () => {
  for (const fixture of fixtures)
    it(fixture.title, async () => {
      const result = await extract(fixture.html);
      expect(result.status).toBe('complete');
      expect(result.role).toBe(fixture.role);
      expect(result.name).toBe(fixture.name);
      if (fixture.source) expect(result.nameSource).toBe(fixture.source);
      expect(result.fallback?.text).toBe(fixture.fallback);
      if (fixture.description !== undefined) expect(result.description).toBe(fixture.description);
    });
});
it('records external and unresolved reference dependencies and recomputes changed labels', async () => {
  const result = await extract(
    '<span id="a">Old</span><button id="target" aria-labelledby="a missing"></button>'
  );
  expect(result.dependencies.nodes).toContain(document.getElementById('a'));
  expect(result.dependencies.references.map((r) => r.id)).toEqual(['a', 'missing']);
  expect(result.dependencies.scopes).toContain(document);
  document.getElementById('a')!.textContent = 'New';
  const next = await extractSemantics([document.getElementById('target')!], { scheduler });
  if (next.status !== 'complete') throw new Error('Extraction failed');
  expect(next.results[0]!.name).toBe('New');
});
it('withholds over-budget results rather than silently truncating them', async () => {
  document.body.innerHTML = '<button id="target">' + '<span>x</span>'.repeat(200) + '</button>';
  const result = await extractSemantics([document.getElementById('target')!], {
    scheduler,
    maxWork: 20,
  });
  if (result.status !== 'complete') throw new Error('Extraction failed');
  expect(result.results[0]).toMatchObject({ status: 'limited', name: '', role: null });
  expect(toElementRole(result.results[0]!)).toBe('generic');
});
it('rejects invalid limits and discards cancelled partial work', async () => {
  document.body.innerHTML = '<button id="target">Name</button>';
  const target = document.getElementById('target')!;
  await expect(extractSemantics([target], { scheduler, maxWork: 0 })).rejects.toThrow(RangeError);
  const controller = new AbortController();
  controller.abort();
  expect(await extractSemantics([target], { scheduler, signal: controller.signal })).toMatchObject({
    status: 'cancelled',
  });
});
it('does not read password values, even as an embedded label control', async () => {
  document.body.innerHTML =
    '<label for="target">Safe<input type="password"></label><input id="target">';
  const password = document.querySelector('input[type=password]')!;
  Object.defineProperty(password, 'value', {
    get() {
      throw new Error('Password read');
    },
  });
  const result = await extractSemantics([document.getElementById('target')!], { scheduler });
  if (result.status !== 'complete') throw new Error('Extraction failed');
  expect(result.results[0]!.name).toBe('Safe');
});
it('composes with the real walker and registry without losing independent evidence', async () => {
  document.body.innerHTML =
    '<label for="target">Public</label><input id="target" aria-label="Selected" data-private="CANARY">';
  const registry = new ElementRegistry(document);
  try {
    const first = await walkSemanticDocument(document, registry, { scheduler });
    if (first.status !== 'complete') throw new Error('Walk failed');
    const target = first.targets.find((t) => t.node.id === 'target')!;
    expect(target.semantics.name).toBe('Selected');
    expect(first.registered.walk.evidence.textNodes.some((t) => t.node.data === 'Public')).toBe(
      true
    );
    expect(
      first.registered.walk.evidence.attributeElements.some(
        (t) => t.node.getAttribute('data-private') === 'CANARY'
      )
    ).toBe(true);
    document.querySelector('label')!.textContent = 'Updated';
    document.getElementById('target')!.removeAttribute('aria-label');
    const next = await extractRegisteredTarget(registry, target.id, first.registered.doc_id, {
      scheduler,
    });
    expect(next).toMatchObject({
      status: 'complete',
      id: target.id,
      semantics: { name: 'Updated' },
    });
    registry.invalidate();
    expect(
      await extractRegisteredTarget(registry, target.id, first.registered.doc_id, { scheduler })
    ).toMatchObject({ status: 'stale' });
  } finally {
    registry.dispose();
  }
});
