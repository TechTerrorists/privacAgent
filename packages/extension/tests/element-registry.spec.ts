import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { ElementRegistry } from '../src/content/element-registry/index.js';
import type * as RegistryModule from '../src/content/element-registry/index.js';
import type * as RegisteredWalk from '../src/content/element-registry/walk.js';

declare global {
  interface Window {
    registryModule: typeof RegistryModule;
    registeredWalk: typeof RegisteredWalk;
    registry: ElementRegistry;
  }
}
let sources: string[];
test.beforeAll(async () => {
  sources = await Promise.all(
    [
      ['../src/content/element-registry/index.ts', 'registryModule'],
      ['../src/content/element-registry/walk.ts', 'registeredWalk'],
    ].map(async ([path, globalName]) => {
      const bundle = await build({
        entryPoints: [fileURLToPath(new URL(path!, import.meta.url))],
        bundle: true,
        format: 'iife',
        globalName: globalName!,
        write: false,
      });
      return bundle.outputFiles[0]!.text;
    })
  );
});
test.beforeEach(async ({ page }) => {
  await page.route('http://registry.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><button id="a">Same</button><button id="b">Same</button><div id="host"></div>',
    })
  );
  await page.goto('http://registry.test/');
  for (const source of sources) await page.addScriptTag({ content: source });
  await page.evaluate(() => {
    window.registry = new window.registryModule.ElementRegistry(document);
  });
});

test('real B-02 walks reuse IDs, distinguish identical controls and retire replacements', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const before = document.documentElement.outerHTML;
    const first = await window.registeredWalk.walkRegisteredDocument(document, window.registry);
    const second = await window.registeredWalk.walkRegisteredDocument(document, window.registry);
    if (first.status !== 'complete' || second.status !== 'complete') throw new Error('walk');
    const a = first.targets.find((t) => t.node.id === 'a')!;
    const b = first.targets.find((t) => t.node.id === 'b')!;
    const stable = first.targets.every((t, i) => t.id === second.targets[i]!.id);
    const unchanged = before === document.documentElement.outerHTML;
    a.node.replaceWith(a.node.cloneNode(true));
    const third = await window.registeredWalk.walkRegisteredDocument(document, window.registry);
    if (third.status !== 'complete') throw new Error('walk');
    return {
      stable,
      unchanged,
      distinct: a.id !== b.id,
      removed: window.registry.resolve(a.id, first.doc_id).status,
      replacement: third.targets.find((t) => t.node.id === 'a')!.id !== a.id,
      surviving: window.registry.resolve(b.id, first.doc_id).status,
    };
  });
  expect(result).toEqual({
    stable: true,
    unchanged: true,
    distinct: true,
    removed: 'missing',
    replacement: true,
    surviving: 'ok',
  });
});

test('validates nested open roots, removed hosts, adoption and closed roots', async ({ page }) => {
  const result = await page.evaluate(() => {
    const registry = window.registry;
    const register = (element: Element) => {
      const value = registry.register(element, registry.docId);
      if (value.status !== 'ok') throw new Error('registration');
      return value;
    };
    const top = register(document.querySelector('#a')!);
    const host = document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div id="inner"></div>';
    const inner = shadow.querySelector('#inner')!.attachShadow({ mode: 'open' });
    inner.innerHTML = '<button>Shadow</button>';
    const button = inner.querySelector('button')!;
    const item = register(button);
    const live = registry.resolve(item.id, item.doc_id).status;
    host.remove();
    const removed = registry.resolve(item.id, item.doc_id).status;
    const adopted = document.implementation.createHTMLDocument();
    adopted.adoptNode(document.querySelector('#a')!);
    const adoption = registry.resolve(top.id, top.doc_id).status;
    const closedHost = document.createElement('div');
    document.body.append(closedHost);
    const closed = closedHost.attachShadow({ mode: 'closed' });
    closed.innerHTML = '<button>Private</button>';
    return {
      live,
      removed,
      adoption,
      closed: registry.register(closed.firstElementChild!, registry.docId).status,
    };
  });
  expect(result).toEqual({ live: 'ok', removed: 'missing', adoption: 'missing', closed: 'stale' });
});

for (const change of ['detach', 'navigate', 'route'] as const) {
  test(`child frame ${change} retires its IDs but preserves other documents`, async ({ page }) => {
    const result = await page.evaluate(async (change) => {
      const registry = window.registry;
      const load = async () => {
        const frame = document.createElement('iframe');
        frame.src = '/frame';
        const ready = new Promise<void>((resolve) => {
          frame.onload = () => resolve();
        });
        document.body.append(frame);
        await ready;
        return frame;
      };
      const frame = await load();
      const other = await load();
      const childDoc = frame.contentDocument!;
      const shadow = childDoc.querySelector('#host')!.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<button>Child shadow</button>';
      const register = (element: Element) => {
        const value = registry.register(element, registry.docId);
        if (value.status !== 'ok') throw new Error('registration');
        return value;
      };
      const top = register(document.querySelector('#a')!);
      const child = register(childDoc.querySelector('#a')!);
      const nested = register(shadow.firstElementChild!);
      const valid = register(other.contentDocument!.querySelector('#a')!);
      if (change === 'detach') frame.remove();
      if (change === 'navigate') {
        const ready = new Promise<void>((resolve) => {
          frame.onload = () => resolve();
        });
        frame.src = '/next';
        await ready;
      }
      if (change === 'route') childDoc.defaultView!.history.pushState({}, '', '/child-route');
      registry.sweep();
      return {
        sameGeneration: registry.docId === top.doc_id,
        statuses: [top, child, nested, valid].map((v) => registry.resolve(v.id, v.doc_id).status),
        unique: new Set([top.id, child.id, nested.id, valid.id]).size,
      };
    }, change);
    expect(result).toEqual({
      sameGeneration: true,
      statuses: ['ok', 'missing', 'missing', 'ok'],
      unique: 4,
    });
  });
}

test('route changes invalidate surviving nodes; back/forward, hash, query and same-URL state', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const registry = window.registry;
    const node = document.querySelector('#a')!;
    const changes: string[] = [];
    registry.onGenerationChange((change) => changes.push(change.scope));
    const ids: string[] = [];
    const step = () => {
      const item = registry.register(node, registry.docId);
      if (item.status !== 'ok') throw new Error('register');
      ids.push(item.doc_id);
      return item;
    };
    const first = step();
    history.pushState({}, '', '?query=1');
    step();
    history.replaceState({}, '', '?query=2');
    step();
    location.hash = 'section';
    await new Promise((resolve) => setTimeout(resolve, 30));
    step();
    const back = new Promise<void>((resolve) =>
      addEventListener('popstate', () => resolve(), { once: true })
    );
    history.back();
    await back;
    step();
    const forward = new Promise<void>((resolve) =>
      addEventListener('popstate', () => resolve(), { once: true })
    );
    history.forward();
    await forward;
    step();
    history.replaceState({ value: 1 }, '', location.href);
    step();
    return {
      unique: new Set(ids).size,
      total: ids.length,
      stale: registry.resolve(first.id, first.doc_id).status,
      changes,
    };
  });
  expect(result.unique).toBe(result.total);
  expect(result.stale).toBe('stale');
  expect(result.changes.length).toBeGreaterThanOrEqual(6);
  expect(result.changes.every((s) => s === 'top')).toBe(true);
});

test('pagehide and persisted pageshow retire IDs and disposal removes callbacks', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const r = window.registry;
    const doc = r.docId;
    let calls = 0;
    r.onGenerationChange(() => calls++);
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    const hiding = r.register(document.querySelector('#a')!, r.docId).status;
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    const restored =
      r.docId !== doc && r.register(document.querySelector('#a')!, r.docId).status === 'ok';
    r.dispose();
    const count = calls;
    history.pushState({}, '', '/after-dispose');
    dispatchEvent(new PageTransitionEvent('pagehide'));
    return { hiding, restored, stopped: calls === count };
  });
  expect(result).toEqual({ hiding: 'stale', restored: true, stopped: true });
});

test('registered walk rejects wrong owners, disposal, cancellation and mid-walk route changes', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const r = window.registry;
    const walk = window.registeredWalk.walkRegisteredDocument;
    const wrong = await walk(document.implementation.createHTMLDocument(), r);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await walk(document, r, { signal: controller.signal });
    let turns = 0;
    const stale = await walk(document, r, {
      maxUnitsPerChunk: 1,
      scheduler: {
        now: () => performance.now(),
        request(callback) {
          const timer = setTimeout(() => {
            if (++turns === 2) history.pushState({}, '', '/changed-during-walk');
            callback({ didTimeout: true, timeRemaining: () => 0 });
          }, 0);
          return () => clearTimeout(timer);
        },
      },
    });
    r.dispose();
    const disposed = await walk(document, r);
    return {
      wrong: wrong.status,
      cancelled: cancelled.status,
      stale: stale.status,
      disposed: disposed.status,
    };
  });
  expect(result).toEqual({
    wrong: 'stale',
    cancelled: 'cancelled',
    stale: 'stale',
    disposed: 'disposed',
  });
});
