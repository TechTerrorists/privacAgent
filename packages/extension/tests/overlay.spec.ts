/**
 * F-02: overlay core in real browsers (Chromium and Firefox).
 *
 * The unit tests inject geometry; this suite cannot, and that is the point: positioning,
 * scrolling, viewport resize, layout movement, style isolation and pointer transparency are all
 * properties of a real engine, not of a mock. Fixtures are served by request interception, so no
 * external site is ever contacted.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { MarkerPosition, AnchorStatus } from '../src/content/overlay/index.js';

declare global {
  interface Window {
    __overlayTest: {
      register(selector: string): { id: string; doc_id: string };
      annotate(
        selector: string,
        label?: string
      ): {
        annotationId: string;
        elementId: string;
        docId: string;
      };
      statusOf(annotationId: string): AnchorStatus;
      statusOfElement(selector: string): AnchorStatus;
      positionOf(annotationId: string): MarkerPosition | null;
      markerBox(): {
        hostTag: string;
        hostAttributeCount: number;
        hostShadowRootOpen: boolean;
        hostConnected: boolean;
        hostRect: DOMRect;
      } | null;
      probeHitsHost(x: number, y: number): boolean;
      settle(): Promise<void>;
      metrics(): { frames: number; updates: number; longestFrameMs: number };
      size(): number;
      isMounted(): boolean;
      hostChildCount(): number;
      refresh(): void;
      dispose(): void;
      walk(): Promise<{
        status: string;
        targetCount?: number;
        hostInAttributeEvidence?: boolean;
        hostIsCandidate?: boolean;
        textHasOverlayLabel?: boolean;
        markerInPageTree?: number;
      }>;
      registryDocId(): string;
    };
  }
}

let source: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./overlay-driver.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  });
  source = result.outputFiles[0]!.text;
});

test.beforeEach(async ({ page }) => {
  await page.route('http://overlay.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><style>
        body { margin: 0; font-family: sans-serif; }
        .lead { height: 600px; }
        .tall { height: 2400px; }
        #scroller { width: 300px; height: 200px; overflow: auto; border: 1px solid #ccc; }
        #inner { height: 1200px; }
      </style></head><body>
        <div class="lead"></div>
        <button id="target">Target</button>
        <div class="lead"></div>
        <button id="one">One</button><button id="two">Two</button>
        <button id="three">Three</button><button id="four">Four</button>
        <button id="five">Five</button><button id="six">Six</button>
        <div class="tall"></div>
        <div id="scroller"><div id="inner"><button id="nested">Nested</button></div></div>
      </body></html>`,
    })
  );
  await page.goto('http://overlay.test/');
  await page.addScriptTag({ content: source });
  await expect(page.locator('html')).toHaveAttribute('data-overlay-ready', 'true');
});

const annotate = async (page: Page, selector: string, label?: string) =>
  page.evaluate(
    ([sel, text]) => window.__overlayTest.annotate(sel as string, text as string | undefined),
    [selector, label] as const
  );

test.beforeEach(async ({ page }) => {
  // Page styles that would wreck an unreset overlay, including `!important` on the two
  // properties that decide whether the overlay can steal interaction.
  await page.addStyleTag({
    content: `div { position: static !important; pointer-events: auto !important; }
      * { color: rgb(255, 0, 0) !important; font-size: 40px !important; margin: 0 !important; }`,
  });
});

test('draws a marker in a closed shadow root that page script cannot open', async ({ page }) => {
  const { annotationId } = await annotate(page, '#target');
  const box = await page.evaluate(() => window.__overlayTest.markerBox());
  expect(box).not.toBeNull();
  expect(box!.hostTag).toBe('DIV');
  // A closed root is the isolation guarantee; an open one would let the page restyle or read it.
  expect(box!.hostShadowRootOpen).toBe(false);
  expect(box!.hostConnected).toBe(true);
  // No attributes at all, so B-02's walker cannot mistake the overlay for page content.
  expect(box!.hostAttributeCount).toBe(0);
  // Out of normal flow and zero-sized, so it cannot shift the page or add scrollbars.
  expect(box!.hostRect.width).toBe(0);
  expect(box!.hostRect.height).toBe(0);
  expect(await page.evaluate((id) => window.__overlayTest.statusOf(id), annotationId)).toBe(
    'visible'
  );
});

test('resets inherited page styles on the host so hostile CSS cannot reposition it', async ({
  page,
}) => {
  const { annotationId } = await annotate(page, '#target');
  const style = await page.evaluate(() => {
    const host = [...document.documentElement.children].find(
      (el) => el.tagName === 'DIV' && el.attributes.length === 0
    );
    if (!host) return null;
    const computed = getComputedStyle(host);
    return {
      position: computed.position,
      pointerEvents: computed.pointerEvents,
      zIndex: computed.zIndex,
    };
  });
  // The page set `div { position: static !important; pointer-events: auto !important }`.
  expect(style).not.toBeNull();
  expect(style!.position).toBe('fixed');
  expect(style!.pointerEvents).toBe('none');
  expect(Number(style!.zIndex)).toBeGreaterThanOrEqual(2147483647);
  expect(
    await page.evaluate((id) => window.__overlayTest.positionOf(id), annotationId)
  ).not.toBeNull();
});

test('leaves the page itself unstyled by the overlay', async ({ page }) => {
  // Isolation runs both ways: the overlay resets the page's influence on itself, and the
  // overlay's own sheet must not reach back into the page. Comparing the same element before
  // and after annotating is the honest form of that check.
  const read = () =>
    page.evaluate(() => {
      const button = document.querySelector('#target');
      if (!button) throw new Error('fixture needs #target');
      const computed = getComputedStyle(button);
      return {
        background: computed.backgroundColor,
        position: computed.position,
        fontSize: computed.fontSize,
        color: computed.color,
      };
    });
  const before = await read();
  await annotate(page, '#target');
  const after = await read();
  expect(after).toEqual(before);
});

test('is invisible to the page walker and contributes no evidence', async ({ page }) => {
  await annotate(page, '#target', 'overlay-label-canary');
  await page.evaluate(() => window.__overlayTest.refresh());
  const walk = await page.evaluate(() => window.__overlayTest.walk());
  expect(walk.status).toBe('complete');
  expect(walk.targetCount).toBeGreaterThan(0);
  // The host is attribute-free, so it never enters the attribute evidence stream, and its
  // closed root keeps both the marker and its label out of reach.
  expect(walk.hostInAttributeEvidence).toBe(false);
  expect(walk.hostIsCandidate).toBe(false);
  expect(walk.textHasOverlayLabel).toBe(false);
  expect(walk.markerInPageTree).toBe(0);
});

test('never intercepts a click: the page stays fully interactive', async ({ page }) => {
  await annotate(page, '#target');
  const { annotationId } = await annotate(page, '#target');
  const position = await page.evaluate((id) => window.__overlayTest.positionOf(id), annotationId);
  expect(position).not.toBeNull();

  // A trusted Playwright click on the annotated control must land on the control. If the
  // overlay were interactive, this would hit the host instead and the page would not respond.
  await page.evaluate(() => {
    const window_ = window as unknown as { clicks: number };
    window_.clicks = 0;
    document.querySelector('#target')!.addEventListener('click', () => {
      window_.clicks++;
    });
  });
  await page.locator('#target').click();
  expect(await page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);

  // `elementFromPoint` honours pointer-events, so hit-testing the marker's own position must
  // land on the page element underneath and never on the overlay host.
  const hitsHost = await page.evaluate(
    ([x, y]) => window.__overlayTest.probeHitsHost(x as number, y as number),
    [position!.x + 7, position!.y + 7] as const
  );
  expect(hitsHost).toBe(false);
});

test('follows a page scroll', async ({ page }) => {
  const { annotationId } = await annotate(page, '#target');
  const before = await page.evaluate((id) => window.__overlayTest.positionOf(id), annotationId);
  expect(before!.y).toBeGreaterThan(0);

  // A modest scroll keeps the target on screen; a large one would (correctly) suppress the
  // marker entirely, which the off-screen test covers.
  await page.evaluate(() => window.scrollTo(0, 200));
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.__overlayTest.positionOf(id), annotationId))?.y
    )
    .toBe(before!.y - 200);
});

test('follows a scroll inside a nested container', async ({ page }) => {
  await page.locator('#scroller').scrollIntoViewIfNeeded();
  const { annotationId } = await annotate(page, '#nested');
  const before = await page.evaluate((id) => window.__overlayTest.positionOf(id), annotationId);
  expect(before).not.toBeNull();
  // The scroller's own scroll event does not reach the window without a capture-phase listener.
  await page.evaluate(() => (document.querySelector('#scroller')!.scrollTop = 200));
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.__overlayTest.positionOf(id), annotationId))!.y
    )
    .toBeLessThan(before!.y);
});

test('follows a viewport resize', async ({ page }) => {
  const size = page.viewportSize()!;
  // Park the target low in a tall viewport, then shorten the viewport underneath it. The
  // marker must be measured against the *new* viewport, so it disappears when the target no
  // longer fits and comes back when it does. A resize alone decides this; no scroll occurs.
  await page.evaluate(() => {
    const target = document.querySelector('#target') as HTMLElement;
    window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - 600);
  });
  const { annotationId } = await annotate(page, '#target');
  await expect
    .poll(async () => page.evaluate((id) => window.__overlayTest.statusOf(id), annotationId))
    .toBe('visible');

  await page.setViewportSize({ width: size.width, height: 400 });
  await expect
    .poll(async () => page.evaluate((id) => window.__overlayTest.statusOf(id), annotationId))
    .toBe('offscreen');

  await page.setViewportSize({ width: size.width, height: size.height });
  await expect
    .poll(async () => page.evaluate((id) => window.__overlayTest.statusOf(id), annotationId))
    .toBe('visible');
});

test('follows layout movement that fires no scroll, resize, or resize event', async ({ page }) => {
  // Park the target near the top of the viewport with a deterministic scroll, then annotate.
  // This test is about an event-less reflow, so nothing between the annotation and the
  // measurement may generate an event of its own.
  await page.evaluate(() => {
    const target = document.querySelector('#target') as HTMLElement;
    window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - 200);
  });
  const { annotationId } = await annotate(page, '#target');
  const before = await page.evaluate((id) => window.__overlayTest.positionOf(id), annotationId);
  expect(before).not.toBeNull();

  // Push the target down by inserting a sibling above it. This fires no scroll (the scroll
  // offset does not change), no resize, and no `ResizeObserver` callback (the target's own box
  // is untouched), so a periodic re-measurement is the only thing that can notice it.
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '150px';
    document.querySelector('#target')!.before(spacer);
  });
  // The heartbeat, not an event, has to notice this one.
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.__overlayTest.positionOf(id), annotationId))?.y,
      { timeout: 5000 }
    )
    .toBeGreaterThan(before!.y);
});

test('suppresses a target that scrolls out of view and restores it on the way back', async ({
  page,
}) => {
  const { annotationId } = await annotate(page, '#target');
  expect(await page.evaluate((id) => window.__overlayTest.statusOf(id), annotationId)).toBe(
    'visible'
  );
  await page.evaluate(() => window.scrollTo(0, 2400));
  await expect
    .poll(async () => page.evaluate((id) => window.__overlayTest.statusOf(id), annotationId))
    .toBe('offscreen');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(async () => page.evaluate((id) => window.__overlayTest.statusOf(id), annotationId))
    .toBe('visible');
});

test('reports a hidden target instead of pinning a marker to it', async ({ page }) => {
  const status = await page.evaluate(async () => {
    const button = document.querySelector('#target') as HTMLElement;
    button.style.display = 'none';
    // Restoring `display` before the await would let the frame measure a visible button.
    const value = await window.__overlayTest.statusOfElement('#target');
    button.style.display = '';
    return value;
  });
  expect(status).toBe('hidden');
});

test('marks annotations stale once the document generation is retired', async ({ page }) => {
  const { annotationId } = await annotate(page, '#target');
  expect(await page.evaluate((id) => window.__overlayTest.statusOf(id), annotationId)).toBe(
    'visible'
  );

  // The real production path: an SPA route change plus the navigation hint the content script
  // dispatches, which makes the registry retire the generation the id was minted in.
  await page.evaluate(() => {
    history.pushState({}, '', '/overlay.test?route=1');
    window.dispatchEvent(new CustomEvent('privacagent:b05:navigation'));
  });
  await expect
    .poll(async () => page.evaluate((id) => window.__overlayTest.statusOf(id), annotationId))
    .toBe('stale');
});

test('re-attaches a host that page script removed', async ({ page }) => {
  const { annotationId } = await annotate(page, '#target');
  const removed = await page.evaluate(() => {
    const host = [...document.documentElement.children].find(
      (el) => el.tagName === 'DIV' && el.attributes.length === 0
    );
    host?.remove();
    return host?.isConnected ?? false;
  });
  expect(removed).toBe(false);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const host = [...document.documentElement.children].find(
          (el) => el.tagName === 'DIV' && el.attributes.length === 0
        );
        return host?.isConnected ?? false;
      })
    )
    .toBe(true);
  await expect
    .poll(async () => page.evaluate((id) => window.__overlayTest.statusOf(id), annotationId))
    .toBe('visible');
});

test('leaves the page clean after dispose', async ({ page }) => {
  const before = await page.evaluate(() => document.documentElement.children.length);
  await annotate(page, '#target');
  expect(await page.evaluate(() => window.__overlayTest.hostChildCount())).toBe(before + 1);
  await page.evaluate(() => window.__overlayTest.dispose());
  expect(await page.evaluate(() => window.__overlayTest.hostChildCount())).toBe(before);
  expect(await page.evaluate(() => window.__overlayTest.isMounted())).toBe(false);
  // Disposing stops all measurement: the frame count cannot move again.
  const frames = await page.evaluate(() => window.__overlayTest.metrics().frames);
  await page.evaluate(() => window.scrollTo(0, 200));
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__overlayTest.metrics().frames)).toBe(frames);
});

test('keeps a frame inside the long-task budget with several annotations', async ({ page }) => {
  // Eight *distinct* targets: re-annotating one element is a re-point, not a new annotation.
  for (const selector of [
    '#target',
    '#nested',
    '#one',
    '#two',
    '#three',
    '#four',
    '#five',
    '#six',
  ]) {
    await page.evaluate((sel) => window.__overlayTest.annotate(sel), selector);
  }
  await page.evaluate(() => window.__overlayTest.refresh());
  await page.evaluate(() => window.__overlayTest.settle());
  const metrics = await page.evaluate(() => window.__overlayTest.metrics());
  expect(metrics.frames).toBeGreaterThan(0);
  expect(metrics.longestFrameMs).toBeLessThan(50);
  expect(await page.evaluate(() => window.__overlayTest.size())).toBe(8);
});
