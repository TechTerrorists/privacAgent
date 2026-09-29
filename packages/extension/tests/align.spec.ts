import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type * as Align from '../src/content/align/dom-range.js';
import type * as Geometry from '../src/geometry/index.js';

declare global {
  interface Window {
    a08: typeof Geometry;
    d12: typeof Align;
  }
}

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/content/align/dom-range.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'd12',
    write: false,
  });
  bundle = result.outputFiles[0]!.text;

  const geometryResult = await build({
    entryPoints: [fileURLToPath(new URL('../src/geometry/index.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'a08',
    write: false,
  });
  bundle = `${geometryResult.outputFiles[0]!.text}\n${bundle}`;
});

async function loadFixture(page: Page, bodyHtml: string): Promise<void> {
  await page.setContent(`<!doctype html><style>
    html,body{margin:0;padding:0}
    #target{width:120px;font:16px/20px sans-serif}
  </style><body>${bodyHtml}</body>`);
  await page.addScriptTag({ content: bundle });
}

function buildCapture(page: Page) {
  return page.evaluate(() => {
    const g = window.a08;
    return g.createCapture({
      identity: { docId: 'top', observationId: 1 },
      captureId: 'capture-1',
      scroll: { x: scrollX, y: scrollY },
      layoutViewport: { width: innerWidth, height: innerHeight },
      visualViewport: {
        offsetLeft: 0,
        offsetTop: 0,
        width: innerWidth,
        height: innerHeight,
        scale: 1,
      },
      capturedViewport: 'layout',
      image: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      browserZoom: 1,
    });
  });
}

test('a span crossing a wrapped line produces multiple client rects, all page-space', async ({
  page,
}) => {
  await loadFixture(page, '<div id="target">a b c d e f g h i j k l m n o p q r s t</div>');
  const capture = await buildCapture(page);

  const result = await page.evaluate((capture) => {
    const target = document.querySelector('#target')!;
    const text = target.textContent!;
    return window.d12.alignDomSpan(
      target,
      {
        docId: 'top',
        observationId: 1,
        elementId: 'e1',
        sourceText: text,
        span: { start: 0, end: text.length },
      },
      { topDocument: document, capture }
    );
  }, capture);

  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  expect(result.regions.length).toBeGreaterThan(1);
  for (const region of result.regions) {
    expect(region.provenance).toBe('exact_span');
    expect(region.rect.width).toBeGreaterThan(0);
    expect(region.rect.height).toBeGreaterThan(0);
  }
});

test('text inside an open shadow root aligns correctly', async ({ page }) => {
  await loadFixture(page, '<div id="host"></div>');
  await page.evaluate(() => {
    const host = document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    const span = document.createElement('span');
    span.textContent = 'shadow secret value';
    shadow.appendChild(span);
  });
  const capture = await buildCapture(page);

  const result = await page.evaluate((capture) => {
    const host = document.querySelector('#host')!;
    const text = 'shadow secret value';
    const start = text.indexOf('secret');
    return window.d12.alignDomSpan(
      host,
      {
        docId: 'top',
        observationId: 1,
        elementId: 'e1',
        sourceText: text,
        span: { start, end: start + 6 },
      },
      { topDocument: document, capture }
    );
  }, capture);

  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  expect(result.regions).toHaveLength(1);
  expect(result.regions[0]!.rect.width).toBeGreaterThan(0);
});

test('a mutated DOM after capture is rejected rather than aligned to stale coordinates', async ({
  page,
}) => {
  await loadFixture(page, '<div id="target">original sensitive text</div>');
  const capture = await buildCapture(page);

  await page.evaluate(() => {
    document.querySelector('#target')!.textContent = 'replaced text';
  });

  const result = await page.evaluate((capture) => {
    const target = document.querySelector('#target')!;
    return window.d12.alignDomSpan(
      target,
      {
        docId: 'top',
        observationId: 1,
        elementId: 'e1',
        sourceText: 'original sensitive text',
        span: { start: 0, end: 8 },
      },
      { topDocument: document, capture }
    );
  }, capture);

  expect(result).toEqual({ status: 'withhold', reason: 'text_mismatch' });
});

test('scrolling between capture and alignment still yields page-space rects consistent with document position', async ({
  page,
}) => {
  await loadFixture(
    page,
    '<div style="height:2000px"></div><div id="target">scrolled sensitive text</div>'
  );
  const capture = await buildCapture(page);

  const result = await page.evaluate((capture) => {
    const target = document.querySelector('#target')!;
    const text = target.textContent!;
    return window.d12.alignDomSpan(
      target,
      {
        docId: 'top',
        observationId: 1,
        elementId: 'e1',
        sourceText: text,
        span: { start: 0, end: text.length },
      },
      { topDocument: document, capture }
    );
  }, capture);

  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  const pageY = result.regions[0]!.rect.y;
  expect(pageY).toBeGreaterThan(1900);
});
