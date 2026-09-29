import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type * as Geometry from '../src/geometry/index.js';

declare global {
  interface Window {
    a08: typeof Geometry;
    a08Capture?: Geometry.Capture;
  }
}
let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/geometry/index.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'a08',
    write: false,
  });
  bundle = result.outputFiles[0]!.text;
});

async function fixture(page: Page): Promise<void> {
  await page.setContent(`<!doctype html><style>
 html,body{margin:0;padding:0;width:1600px;height:2000px;background:white;scrollbar-width:none}
 ::-webkit-scrollbar{display:none}
 #target{position:absolute;left:60.5px;top:280.25px;width:41.5px;height:22.75px;background:rgb(255,0,255)}
 #host{position:absolute;left:100px;top:300px;transform:translate(2.5px,3.25px) scale(1.1,0.9);transform-origin:0 0}
 #outer{position:absolute;left:80.25px;top:20.5px;width:360px;height:260px;border:5px solid black;padding:3px;transform:scale(1.25,0.8);transform-origin:0 0}
 </style><div id="target"></div><div id="host"><iframe id="outer"></iframe></div>`);
  await page.evaluate(() => {
    const outer = document.querySelector<HTMLIFrameElement>('#outer')!;
    const doc = outer.contentDocument!;
    doc.open();
    doc.write(
      `<!doctype html><style>html,body{margin:0;width:1000px;height:1000px;scrollbar-width:none}::-webkit-scrollbar{display:none}#inner{position:absolute;left:40.5px;top:90.25px;width:160px;height:130px;border:3px solid black;padding:2px;transform:scale(0.8,1.5);transform-origin:0 0}</style><iframe id="inner"></iframe>`
    );
    doc.close();
    const inner = doc.querySelector<HTMLIFrameElement>('#inner')!;
    const child = inner.contentDocument!;
    child.open();
    child.write(
      `<!doctype html><style>html,body{margin:0;width:500px;height:600px;scrollbar-width:none}::-webkit-scrollbar{display:none}#leaf{position:absolute;left:25.25px;top:60.5px;width:41.5px;height:22.75px;background:rgb(0,255,255)}</style><div id="leaf"></div>`
    );
    child.close();
    window.scrollTo(10, 220);
    outer.contentWindow!.scrollTo(12, 25);
    inner.contentWindow!.scrollTo(7, 18);
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
}

async function verifyScreenshot(page: Page, info: TestInfo, visual = false): Promise<void> {
  const path = info.outputPath(`${visual ? 'visual' : 'layout'}-${page.viewportSize()?.width}.png`);
  const png = await page.screenshot({ path, animations: 'disabled', scale: 'device' });
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  const geometry = await page.evaluate(
    ({ width, height, visual }) => {
      const g = window.a08;
      const observationId = (window.a08Capture?.metadata.identity.observationId ?? 0) + 1;
      const identity = { docId: 'top', observationId };
      const captureId = `screenshot-${observationId}`;
      const vv = window.visualViewport!;
      const capture = g.createCapture({
        identity,
        captureId,
        scroll: { x: scrollX, y: scrollY },
        layoutViewport: { width: innerWidth, height: innerHeight },
        visualViewport: {
          offsetLeft: vv.offsetLeft,
          offsetTop: vv.offsetTop,
          width: vv.width,
          height: vv.height,
          scale: vv.scale,
        },
        capturedViewport: visual ? 'visual' : 'layout',
        image: { width, height },
        devicePixelRatio,
        browserZoom: 1,
      });
      window.a08Capture = capture;
      const target = document.querySelector('#target')!.getBoundingClientRect();
      const pageBox = g.fromBBox(capture.page, [
        target.x + scrollX,
        target.y + scrollY,
        target.width,
        target.height,
      ]);
      const top = g.toBBox(g.mapRect(capture.pageToImage, pageBox));
      const outer = document.querySelector<HTMLIFrameElement>('#outer')!;
      const inner = outer.contentDocument!.querySelector<HTMLIFrameElement>('#inner')!;
      const leaf = inner.contentDocument!.querySelector('#leaf')!.getBoundingClientRect();
      // Fixture transforms are explicitly axis aligned. Real A-09 metadata must
      // validate ALL ancestors before using measured border-box ratios.
      function frame(
        el: HTMLIFrameElement,
        childDocId: string,
        parentDocId: string
      ): Geometry.FrameLink {
        const win = el.ownerDocument.defaultView!;
        const style = win.getComputedStyle(el),
          box = el.getBoundingClientRect();
        const border = {
          left: parseFloat(style.borderLeftWidth),
          top: parseFloat(style.borderTopWidth),
        };
        const padding = { left: parseFloat(style.paddingLeft), top: parseFloat(style.paddingTop) };
        const borderWidth =
          parseFloat(style.width) +
          border.left +
          parseFloat(style.borderRightWidth) +
          padding.left +
          parseFloat(style.paddingRight);
        const borderHeight =
          parseFloat(style.height) +
          border.top +
          parseFloat(style.borderBottomWidth) +
          padding.top +
          parseFloat(style.paddingBottom);
        return {
          identity,
          captureId,
          childDocId,
          parentDocId,
          childScroll: { x: el.contentWindow!.scrollX, y: el.contentWindow!.scrollY },
          borderBoxOrigin: { x: box.x, y: box.y },
          border,
          padding,
          linear: {
            a: box.width / borderWidth,
            b: 0,
            c: 0,
            d: box.height / borderHeight,
            perspective: false,
          },
        };
      }
      const t = g.frameToPage(capture, [
        frame(inner, 'inner', 'outer'),
        frame(outer, 'outer', 'top'),
      ]);
      const local = g.fromBBox(t.from, [
        leaf.x + inner.contentWindow!.scrollX,
        leaf.y + inner.contentWindow!.scrollY,
        leaf.width,
        leaf.height,
      ]);
      const nested = g.toBBox(g.mapRect(g.compose(t, capture.pageToImage), local));
      return { top, nested, dpr: devicePixelRatio, scale: vv.scale };
    },
    { width, height, visual }
  );
  const pixels = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + data;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const bytes = ctx.getImageData(0, 0, img.width, img.height).data;
    function bounds(r: number, g: number, b: number): number[] {
      let x = Infinity,
        y = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      for (let j = 0; j < img.height; j++)
        for (let i = 0; i < img.width; i++) {
          const k = (j * img.width + i) * 4;
          if (
            Math.abs(bytes[k]! - r) < 128 &&
            Math.abs(bytes[k + 1]! - g) < 128 &&
            Math.abs(bytes[k + 2]! - b) < 128
          ) {
            x = Math.min(x, i);
            y = Math.min(y, j);
            right = Math.max(right, i + 1);
            bottom = Math.max(bottom, j + 1);
          }
        }
      return [x, y, right - x, bottom - y];
    }
    return { top: bounds(255, 0, 255), nested: bounds(0, 255, 255) };
  }, png.toString('base64'));
  await info.attach('pixel-comparison', {
    body: JSON.stringify({ geometry, pixels }),
    contentType: 'application/json',
  });
  // Compare edges, not widths: rounding both edges can double the width error.
  // The nested fixture crosses two separately rasterized frame documents plus
  // a transformed ancestor. Allow 1.5 CSS pixels per edge for compositor snapping;
  // the top-level target allows just one screenshot pixel. Core math is checked
  // at floating-point tolerance in the independent numerical/property tests.
  for (const key of ['top', 'nested'] as const) {
    expect(pixels[key].every(Number.isFinite)).toBe(true);
    const edges = (box: readonly number[]) => [
      box[0]!,
      box[1]!,
      box[0]! + box[2]!,
      box[1]! + box[3]!,
    ];
    const expected = edges(geometry[key]),
      actual = edges(pixels[key]);
    const tolerance = key === 'top' ? 1.01 : 1.5 * geometry.dpr * geometry.scale;
    for (let i = 0; i < 4; i++)
      expect(
        Math.abs(actual[i]! - expected[i]!),
        JSON.stringify({ key, edge: i, expected, actual })
      ).toBeLessThanOrEqual(tolerance);
  }
  await info.attach('capture-metadata', {
    body: JSON.stringify({ width, height, ...geometry }),
    contentType: 'application/json',
  });
}

for (const dpr of [1, 1.5, 2]) {
  test(`A-08 screenshot/nested-frame geometry at DPR ${dpr}`, async ({ browser }, info) => {
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: dpr,
    });
    try {
      const page = await context.newPage();
      await fixture(page);
      await verifyScreenshot(page, info);
      const old = await page.evaluate(() => {
        const c = window.a08Capture!;
        return window.a08.toBBox(
          window.a08.mapRect(
            c.pageToImage,
            window.a08.fromBBox(c.page, [60.5, 280.25, 41.5, 22.75])
          )
        );
      });
      await page.evaluate(() => window.scrollTo(0, 180));
      await page.setViewportSize({ width: 900, height: 650 });
      const unchanged = await page.evaluate(() => {
        const c = window.a08Capture!;
        return window.a08.toBBox(
          window.a08.mapRect(
            c.pageToImage,
            window.a08.fromBBox(c.page, [60.5, 280.25, 41.5, 22.75])
          )
        );
      });
      expect(unchanged).toEqual(old);
      await verifyScreenshot(page, info);
    } finally {
      await context.close();
    }
  });
}

test('A-08 visual viewport pinch scale in Chromium', async ({ page, browserName }, info) => {
  test.skip(
    browserName !== 'chromium',
    'Firefox has no Playwright CDP pinch-zoom control; pure tests cover visual viewport math.'
  );
  await page.setViewportSize({ width: 800, height: 600 });
  await fixture(page);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(await page.evaluate(() => window.visualViewport!.scale)).toBeGreaterThan(1);
    await verifyScreenshot(page, info, true);
  } finally {
    await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await session.detach();
  }
});
