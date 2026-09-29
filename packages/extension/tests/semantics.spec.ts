import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { fixtures } from '../src/content/semantics/fixtures.js';
import type * as Semantics from './semantics-entry.js';
declare global {
  interface Window {
    semantics: typeof Semantics;
  }
}
let script: string;
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./semantics-entry.ts', import.meta.url))],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'semantics',
    write: false,
  });
  script = bundle.outputFiles[0]!.text;
});
test.beforeEach(async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
});
test('80 independent semantic fixtures', async ({ page }) => {
  for (const fixture of fixtures) {
    const result = await page.evaluate(async (html) => {
      document.body.innerHTML = html;
      const batch = await window.semantics.extractSemantics([document.getElementById('target')!]);
      if (batch.status !== 'complete') throw new Error(batch.status);
      const { role, name, nameSource, fallback, description, status } = batch.results[0]!;
      return { role, name, nameSource, fallback, description, status };
    }, fixture.html);
    expect(result.status, fixture.title).toBe('complete');
    expect(result.role, fixture.title).toBe(fixture.role);
    expect(result.name, fixture.title).toBe(fixture.name);
    if (fixture.source) expect(result.nameSource, fixture.title).toBe(fixture.source);
    expect(result.fallback?.text, fixture.title).toBe(fixture.fallback);
    if (fixture.description !== undefined)
      expect(result.description, fixture.title).toBe(fixture.description);
  }
});
test('scoped roots, frame references, slots and external-label invalidation', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = '<span id="label">OUTER</span><div id="host"></div><iframe></iframe>';
    const host = document.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<span id="label">Shadow</span><button id="target" aria-labelledby="label"></button><button id="slot-button"><slot></slot></button>';
    host.append('Slotted text');
    const frame = document.querySelector('iframe')!;
    const doc = frame.contentDocument!;
    doc.body.innerHTML =
      '<label for="target">Frame</label><input id="target"><button id="missing" aria-labelledby="label"></button>';
    const targets = [
      shadow.getElementById('target')!,
      shadow.getElementById('slot-button')!,
      doc.getElementById('target')!,
      doc.getElementById('missing')!,
    ];
    const first = await window.semantics.extractSemantics(targets);
    if (first.status !== 'complete') throw new Error(first.status);
    shadow.getElementById('label')!.textContent = 'नाम';
    const second = await window.semantics.extractSemantics([targets[0]!]);
    if (second.status !== 'complete') throw new Error(second.status);
    return {
      names: first.results.map((r) => r.name),
      updated: second.results[0]!.name,
      scoped: first.results[0]!.dependencies.references[0]!.scope === shadow,
    };
  });
  expect(result).toEqual({
    names: ['Shadow', 'Slotted text', 'Frame', ''],
    updated: 'नाम',
    scoped: true,
  });
});
test('bounded repeated labels and large descendants', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML =
      '<label id="label">Shared label</label>' +
      Array.from({ length: 400 }, (_, i) => `<input id="i${i}" aria-labelledby="label">`).join('');
    const result = await window.semantics.extractSemantics(
      Array.from(document.querySelectorAll('input')),
      { maxUnitsPerChunk: 256 }
    );
    if (result.status !== 'complete') throw new Error(result.status);
    return {
      count: result.results.length,
      valid: result.results.every((r) => r.name === 'Shared label' && r.status === 'complete'),
      metrics: result.metrics,
    };
  });
  expect(result.count).toBe(400);
  expect(result.valid).toBe(true);
  expect(result.metrics.chunks).toBeGreaterThan(1);
  expect(result.metrics.workUnits).toBeLessThan(40000);
  expect(result.metrics.longestChunkMs).toBeLessThan(50);
  console.log(JSON.stringify({ browser: test.info().project.name, ...result.metrics }));
});

test('real walker composition retains IDs and independent evidence', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML =
      '<label for="target">UNSELECTED_CANARY</label><input id="target" aria-label="Chosen" data-private="ATTRIBUTE_CANARY">';
    const registry = new window.semantics.ElementRegistry(document);
    try {
      const first = await window.semantics.walkSemanticDocument(document, registry);
      if (first.status !== 'complete') throw new Error(first.status);
      const target = first.targets.find((t) => t.node.id === 'target')!;
      const node = document.getElementById('target')!;
      node.removeAttribute('aria-label');
      document.querySelector('label')!.textContent = 'बदला हुआ नाम';
      const second = await window.semantics.extractRegisteredTarget(
        registry,
        target.id,
        first.registered.doc_id
      );
      registry.invalidate();
      const stale = await window.semantics.extractRegisteredTarget(
        registry,
        target.id,
        first.registered.doc_id
      );
      return {
        firstName: target.semantics.name,
        hasLabelEvidence: first.registered.walk.evidence.textNodes.some(
          (t) => t.node.data === 'UNSELECTED_CANARY'
        ),
        hasAttributeEvidence: first.registered.walk.evidence.attributeElements.some(
          (t) => t.node.getAttribute('data-private') === 'ATTRIBUTE_CANARY'
        ),
        secondName: 'semantics' in second ? second.semantics.name : null,
        sameId: 'id' in second && second.id === target.id,
        stale: stale.status,
      };
    } finally {
      registry.dispose();
    }
  });
  expect(result).toEqual({
    firstName: 'Chosen',
    hasLabelEvidence: true,
    hasAttributeEvidence: true,
    secondName: 'बदला हुआ नाम',
    sameId: true,
    stale: 'stale',
  });
});

test('detached frames are skipped without discarding valid top-document semantics', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = '<button id="top">Top</button><iframe></iframe>';
    const frame = document.querySelector('iframe')!;
    frame.contentDocument!.body.innerHTML = '<button id="child">Child</button>';
    const registry = new window.semantics.ElementRegistry(document);
    let requests = 0;
    try {
      const result = await window.semantics.walkSemanticDocument(document, registry, {
        maxUnitsPerChunk: 1,
        scheduler: {
          now: () => performance.now(),
          request(callback) {
            const timer = setTimeout(() => {
              if (++requests === 35) frame.remove();
              callback({ didTimeout: true, timeRemaining: () => 8 });
            }, 0);
            return () => clearTimeout(timer);
          },
        },
      });
      if (result.status !== 'complete') throw new Error(result.status);
      return { detached: !frame.isConnected, names: result.targets.map((t) => t.semantics.name) };
    } finally {
      registry.dispose();
    }
  });
  expect(result.detached).toBe(true);
  expect(result.names).toContain('Top');
  expect(result.names).not.toContain('Child');
});

test('large labels yield and oversized text is withheld', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = `<button id="target">${'<span>x</span>'.repeat(2000)}</button>`;
    const target = document.getElementById('target')!;
    const large = await window.semantics.extractSemantics([target], {
      maxUnitsPerChunk: 128,
      maxWork: 100000,
    });
    if (large.status !== 'complete') throw new Error(large.status);
    target.textContent = 'x'.repeat(9000);
    const capped = await window.semantics.extractSemantics([target]);
    if (capped.status !== 'complete') throw new Error(capped.status);
    return {
      largeStatus: large.results[0]!.status,
      length: large.results[0]!.name.length,
      metrics: large.metrics,
      capped: { status: capped.results[0]!.status, name: capped.results[0]!.name },
    };
  });
  expect(result.largeStatus).toBe('complete');
  expect(result.length).toBe(2000);
  expect(result.metrics.chunks).toBeGreaterThan(1);
  expect(result.metrics.longestChunkMs).toBeLessThan(50);
  expect(result.capped).toEqual({ status: 'limited', name: '' });
  console.log(
    JSON.stringify({ browser: test.info().project.name, case: 'large-label', ...result.metrics })
  );
});
