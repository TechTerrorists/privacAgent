import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, platform, release } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type * as Walker from '../src/content/dom-extract/index.js';

declare global {
  interface Window {
    domWalker: typeof Walker;
  }
}

let source: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/content/dom-extract/index.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'domWalker',
    platform: 'browser',
    write: false,
  });
  source = result.outputFiles[0]!.text;
});
test.beforeEach(async ({ page }) => {
  // Interception supplies synthetic pages at two origins. No external website is contacted.
  await page.route('http://walker.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head></head><body></body></html>',
    })
  );
  await page.route('http://other.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<button id="private-frame-button">PRIVATE_FRAME_CANARY</button>',
    })
  );
  await page.goto('http://walker.test/');
  await page.addScriptTag({ content: source });
});

test('discovers native/custom controls and context without pruning plain parents', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = `<div><button id="a">Save</button><button id="b">Save</button></div>
      <a id="link" href="#">Link</a><input id="input" disabled><select id="select"></select><textarea id="textarea"></textarea>
      <div id="role" role="button">Role</div><div id="edit" contenteditable>Editor</div><div id="tab" tabindex="-1">Tab</div>
      <div id="pointer" style="cursor:pointer">Pointer</div><h2 id="heading">Title</h2><label id="label">Label</label>
      <span id="error" role="alert">Problem</span><script>IGNORED_SCRIPT_CANARY</script><style>/*IGNORED_STYLE_CANARY*/</style>`;
    const result = await window.domWalker.walkDocument(document);
    if (result.status !== 'complete') throw new Error(result.status);
    return {
      ids: result.candidates.map((c) => c.node.id),
      pointer: result.candidates.find((c) => c.node.id === 'pointer')?.reasons,
      text: result.evidence.textNodes.map((e) => e.node.data).join(' '),
      hasNodeRefs: result.candidates.every((c) => c.node.ownerDocument === c.context.document),
      hasWireIds: result.candidates.some((c) => 'id' in c || 'doc_id' in c),
    };
  });
  expect(result.ids).toEqual([
    'a',
    'b',
    'link',
    'input',
    'select',
    'textarea',
    'role',
    'edit',
    'tab',
    'pointer',
    'heading',
    'label',
    'error',
  ]);
  expect(result.pointer).toContain('pointer');
  expect(result.text).not.toContain('IGNORED_');
  expect(result.hasNodeRefs).toBe(true);
  expect(result.hasWireIds).toBe(false);
});

test('walks nested open roots and slots once, preserving separate attribute evidence', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.innerHTML = '<button id="slotted" aria-label="ATTRIBUTE_CANARY">TEXT_CANARY</button>';
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<slot></slot><button id="shadow">Shadow</button><div id="nested"></div>';
    root.querySelector('#nested')!.attachShadow({ mode: 'open' }).innerHTML =
      '<button id="nested-button">Nested</button>';
    const closed = document.createElement('div');
    document.body.append(closed);
    closed.attachShadow({ mode: 'closed' }).innerHTML = '<button id="closed">Closed</button>';
    const result = await window.domWalker.walkDocument(document);
    if (result.status !== 'complete') throw new Error(result.status);
    return {
      ids: result.candidates.map((c) => c.node.id),
      unique: new Set(result.candidates.map((c) => c.node)).size,
      roots: result.contexts.length,
      text: result.evidence.textNodes.map((t) => t.node.data),
      attributes: result.evidence.attributeElements
        .map((a) => a.node.getAttribute('aria-label'))
        .filter(Boolean),
    };
  });
  expect(result.ids).toEqual(['slotted', 'shadow', 'nested-button']);
  expect(result.unique).toBe(3);
  expect(result.roots).toBe(3);
  expect(result.text).toContain('TEXT_CANARY');
  expect(result.text).not.toContain('ATTRIBUTE_CANARY');
  expect(result.attributes).toEqual(['ATTRIBUTE_CANARY']);
});

test('walks nested same-origin frames and shadow roots while leaving other origins opaque', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    const loaded = new Promise<void>((resolve) => {
      frame.onload = () => resolve();
    });
    frame.srcdoc =
      '<button id="frame-button">Frame</button><div id="host"></div><iframe srcdoc="<button id=inner>Inner</button>"></iframe>';
    document.body.append(frame);
    await loaded;
    frame.contentDocument!.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML =
      '<button id="frame-shadow">Shadow</button>';
    const opaque = document.createElement('iframe');
    const opaqueLoaded = new Promise<void>((resolve) => {
      opaque.onload = () => resolve();
    });
    opaque.src = 'http://other.test/';
    document.body.append(opaque);
    await opaqueLoaded;
    const result = await window.domWalker.walkDocument(document);
    if (result.status !== 'complete') throw new Error(result.status);
    return {
      ids: result.candidates.map((c) => c.node.id).filter(Boolean),
      access: result.frames.map((f) => f.access),
      contextsCorrect: result.candidates
        .filter((c) => c.node.id)
        .every(
          (c) => c.context.frameElement !== null && c.context.document === c.node.ownerDocument
        ),
      text: result.evidence.textNodes.map((t) => t.node.data).join(' '),
    };
  });
  expect(result.ids).toEqual(['frame-button', 'frame-shadow', 'inner']);
  expect(result.access).toEqual(['same-origin', 'opaque', 'same-origin']);
  expect(result.contextsCorrect).toBe(true);
  expect(result.text).not.toContain('PRIVATE_FRAME_CANARY');
});

test('does not stop at the outbound 300-element cap and releases cancellation work', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = '<button>Target</button>'.repeat(650);
    const complete = await window.domWalker.walkDocument(document, { maxUnitsPerChunk: 25 });
    const controller = new AbortController();
    const pending = window.domWalker.walkDocument(document, {
      signal: controller.signal,
      maxUnitsPerChunk: 1,
    });
    controller.abort();
    const cancelled = await pending;
    return {
      status: complete.status,
      count: complete.status === 'complete' ? complete.candidates.length : 0,
      chunks: complete.metrics.chunks,
      cancelled,
    };
  });
  expect(result.status).toBe('complete');
  expect(result.count).toBe(650);
  expect(result.chunks).toBeGreaterThan(1);
  expect(result.cancelled.status).toBe('cancelled');
  expect(result.cancelled).not.toHaveProperty('candidates');
});

test('handles removed cursor nodes, unloaded frames and pagehide without partial success', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = '<button id="remove">Remove</button><button>Remain</button>';
    let cursor: TreeWalker | undefined;
    const original = document.createTreeWalker.bind(document);
    document.createTreeWalker = (root, whatToShow, filter) => {
      cursor = original(root, whatToShow, filter);
      return cursor;
    };
    const pending = window.domWalker.walkDocument(document, {
      maxUnitsPerChunk: 1,
      scheduler: {
        now: () => performance.now(),
        request(callback) {
          const id = setTimeout(() => {
            if (cursor?.currentNode === document.querySelector('#remove')) {
              document.querySelector('#remove')?.remove();
            }
            callback({ didTimeout: true, timeRemaining: () => 0 });
          }, 0);
          return () => clearTimeout(id);
        },
      },
    });
    const removed = await pending;
    document.createTreeWalker = original;
    const hiding = window.domWalker.walkDocument(document);
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    const hidden = await hiding;
    const frame = document.createElement('iframe');
    document.body.append(frame);
    frame.contentDocument!.open();
    const unloaded = await window.domWalker.walkDocument(document);
    const accesses = unloaded.status === 'complete' ? unloaded.frames.map((f) => f.access) : [];
    frame.remove();
    return { removed: removed.status, hidden: hidden.status, accesses };
  });
  expect(result.removed).toBe('stale');
  expect(result.hidden).toBe('stale');
  expect(result.accesses).toEqual(['unloaded']);
});

test('timer fallback finishes the same walk', async ({ page }) => {
  const result = await page.evaluate(async () => {
    Object.defineProperty(window, 'requestIdleCallback', { value: undefined, configurable: true });
    document.body.innerHTML = '<button>One</button><input><label>Two</label>';
    const result = await window.domWalker.walkDocument(document, { maxUnitsPerChunk: 2 });
    return {
      status: result.status,
      count: result.status === 'complete' ? result.candidates.length : 0,
      chunks: result.metrics.chunks,
    };
  });
  expect(result.status).toBe('complete');
  expect(result.count).toBe(3);
  expect(result.chunks).toBeGreaterThan(1);
});

test('rejects a queued frame document that navigates before traversal', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    const loaded = new Promise<void>((resolve) => {
      frame.onload = () => resolve();
    });
    frame.srcdoc = '<button>Old document</button>';
    document.body.append(frame);
    await loaded;
    const child = frame.contentDocument!;
    const createWalker = child.createTreeWalker.bind(child);
    let queued = false;
    let navigated = false;
    child.createTreeWalker = (root, show, filter) => {
      queued = true;
      return createWalker(root, show, filter);
    };
    return window.domWalker.walkDocument(document, {
      maxUnitsPerChunk: 1,
      scheduler: {
        now: () => performance.now(),
        request(callback) {
          const id = setTimeout(async () => {
            if (queued && !navigated) {
              navigated = true;
              const reloaded = new Promise<void>((resolve) => {
                frame.onload = () => resolve();
              });
              frame.srcdoc = '<button>New document</button>';
              await reloaded;
            }
            callback({ didTimeout: true, timeRemaining: () => 0 });
          }, 0);
          return () => clearTimeout(id);
        },
      },
    });
  });
  expect(result.status).toBe('stale');
  expect(result).not.toHaveProperty('evidence');
});

test('discards accumulated results on mid-walk cancellation and processing error', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = '<button>First</button><button>Second</button>';
    const controller = new AbortController();
    const original = document.createTreeWalker.bind(document);
    let cursor: TreeWalker | undefined;
    document.createTreeWalker = (root, show, filter) => (cursor = original(root, show, filter));
    const cancelled = await window.domWalker.walkDocument(document, {
      signal: controller.signal,
      maxUnitsPerChunk: 1,
      scheduler: {
        now: () => performance.now(),
        request(callback) {
          const id = setTimeout(() => {
            if (cursor?.currentNode.nodeName === 'BUTTON') controller.abort();
            callback({ didTimeout: true, timeRemaining: () => 0 });
          }, 0);
          return () => clearTimeout(id);
        },
      },
    });
    document.createTreeWalker = original;
    const getStyle = window.getComputedStyle;
    window.getComputedStyle = () => {
      throw new Error('PRIVATE_ERROR_CANARY');
    };
    const failed = await window.domWalker.walkDocument(document);
    window.getComputedStyle = getStyle;
    return { cancelled, failed };
  });
  expect(result.cancelled.status).toBe('cancelled');
  expect(result.failed.status).toBe('error');
  expect(result.cancelled).not.toHaveProperty('candidates');
  expect(result.failed).not.toHaveProperty('candidates');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_ERROR_CANARY');
});

test('benchmark: 2,000-node document', async ({ page, browser }, testInfo) => {
  const runs = await page.evaluate(async () => {
    document.body.replaceChildren();
    // Count document + doctype + html + head + body + the injected script/text.
    const countNodes = () => {
      const walker = document.createTreeWalker(document);
      let count = 1;
      while (walker.nextNode()) count++;
      return count;
    };
    const remaining = 2000 - countNodes();
    for (let i = 0; i < remaining; i++) {
      const node = document.createElement(i % 2 ? 'button' : 'div');
      node.setAttribute('aria-label', 'Synthetic control');
      document.body.append(node);
    }
    document.body.getBoundingClientRect();
    const results = [];
    for (let i = 0; i < 6; i++) {
      const result = await window.domWalker.walkDocument(document);
      if (result.status !== 'complete') throw new Error(result.status);
      results.push({
        ...result.metrics,
        candidates: result.candidates.length,
        nodeCount: countNodes(),
      });
    }
    return results;
  });
  expect(runs.every((r) => r.nodeCount === 2000 && r.candidates > 300)).toBe(true);
  const report = {
    layout: 'pre-settled',
    browser: testInfo.project.name,
    version: browser.version(),
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    ramGiB: totalmem() / 2 ** 30,
    runs,
  };
  const reportPath = testInfo.outputPath('benchmark.json');
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await testInfo.attach('dom-walker-benchmark', {
    path: reportPath,
    contentType: 'application/json',
  });
  console.info(JSON.stringify(report));
});
