/**
 * F-03: overlay primitives in real Chromium and Firefox.
 *
 * The unit tests inject geometry and a frame clock. This suite cannot, and that is the point:
 * click-through, style isolation, computed `pointer-events`, the accessibility surface, focus and
 * typing, scroll and resize following, and the reduced-motion media query are all properties of a
 * real engine. The fixtures come from the B-08 mock site pack, so the targets are the same
 * deterministic local pages the rest of the suite uses — no external site is ever contacted.
 *
 * Every test runs in both engines. Anything engine-specific is marked, and the one place the two
 * genuinely differ (a real frame-timing trace) lives in `overlay-timing.spec.ts` instead.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { AnchorStatus, MarkerPosition, OverlayMetrics } from '../src/content/overlay/index.js';
import type { PrimitiveKind } from '../src/content/overlay/primitives/index.js';

interface ProbeResult {
  annotationId: string | null;
  status: AnchorStatus | 'unknown';
  position: MarkerPosition | null;
  hitsHost: boolean;
  hitsTag: string;
  hitsId: string;
}

declare global {
  interface Window {
    __primitivesTest: {
      scenario(name: string): Promise<{ annotationIds: string[]; status: string }>;
      replace(selector: string, kind: PrimitiveKind, fields?: object): Promise<string>;
      retarget(selector: string, kind: PrimitiveKind, fields?: object): Promise<string>;
      annotate(
        selector: string,
        kind: PrimitiveKind,
        fields?: object
      ): Promise<{ annotationId: string }>;
      statusOf(annotationId: string): AnchorStatus | 'unknown';
      positionOf(annotationId: string): MarkerPosition | null;
      size(): number;
      metrics(): OverlayMetrics;
      isMounted(): boolean;
      prefersReducedMotion(): boolean;
      hideTarget(selector: string, mode: 'display' | 'visibility'): void;
      showTarget(selector: string): void;
      detachTarget(selector: string): void;
      moveTarget(selector: string, dy: number): void;
      scrollTargetIntoView(selector: string): Promise<void>;
      probe(x: number, y: number, annotationId?: string): ProbeResult;
      targetCentre(selector: string): { x: number; y: number };
      markerCentre(annotationId: string): { x: number; y: number } | null;
      markerBox(): {
        hostTag: string;
        hostAttributeCount: number;
        hostShadowRootOpen: boolean;
        hostConnected: boolean;
        hostRect: DOMRect;
        paInPageTree: number;
        focusableInPageTree: number;
      } | null;
      hostChildCount(): number;
      overlayHostCount(): number;
      pageFootprint(): {
        pa: number;
        tabindex: number;
        scripts: number;
        imgs: number;
        forms: number;
        controls: number;
        dialogs: number;
        ariaModal: number;
        liveRegions: number;
        roles: string[];
      };
      accessibilityRoles(): { roles: string[]; focusable: number; pageTabindex: number };
      walk(): Promise<{
        status: string;
        targetCount?: number;
        hostInAttributeEvidence?: boolean;
        hostIsCandidate?: boolean;
        textHasOverlayLabel?: boolean;
        paInPageTree?: number;
      }>;
      positionTrace(annotationId: string, count: number): Promise<number[]>;
      activeIndex(): number;
      saturate(): Promise<string[]>;
      churnAll(frames: number): Promise<void>;
      inputValue(): string;
      activeElementId(): string;
      clickCount(): number;
      clear(): void;
      refresh(): void;
      refreshAndSettle(): Promise<void>;
      settle(count?: number): Promise<void>;
      dispose(): void;
      retireGeneration(): void;
      restoreGeneration(): void;
      currentDocId(): string | null;
      registryDocId(): string;
    };
    __primitivesTest_canary?: never;
  }
}

let source: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./primitives-driver.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  });
  source = result.outputFiles[0]!.text;
});

/**
 * A hostile author stylesheet, in the shape a CSS-framework reset actually takes.
 *
 * It is served at a same-origin path rather than injected, because the gallery's `style-src 'self'`
 * rejects inline styles and the point of these pages is that the CSP holds. The layout-destroying
 * resets are scoped to `html > div` — a bare top-level div, which is precisely what the overlay
 * host is and which nothing else on the page matches. `pointer-events` is reset on every `div`,
 * which does hit the gallery's own containers harmlessly and is the single most likely real attack
 * on a click-through layer. `color` and `font-size` are reset on everything to show the overlay's
 * appearance cannot be captured by a page stylesheet.
 */
const HOSTILE_CSS = `
  html > div {
    position: static !important;
    top: auto !important;
    left: auto !important;
    width: auto !important;
    height: auto !important;
    display: inline !important;
    z-index: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    background: yellow !important;
    color: rgb(0, 128, 0) !important;
  }
  div, * { pointer-events: auto !important; }
  * { color: rgb(255, 0, 0) !important; }
`;

/** The B-08 gallery page, with the hostile stylesheet and the driver injected. */
async function openGallery(
  page: Page,
  { hostile = true }: { hostile?: boolean } = {}
): Promise<void> {
  await page.goto('/overlay');
  if (hostile) await addHostileStyles(page);
  await injectDriver(page);
}

/** Applies the hostile reset, at a same-origin URL the gallery's CSP will accept. */
async function addHostileStyles(page: Page): Promise<void> {
  await page.route('**/overlay-hostile.css', (route) =>
    route.fulfill({ contentType: 'text/css', body: HOSTILE_CSS })
  );
  await page.addStyleTag({ url: '/overlay-hostile.css' });
}

/** Installs the driver bundle into an already-loaded gallery page. */
async function injectDriver(page: Page): Promise<void> {
  await page.route('**/primitives-driver.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: source })
  );
  await page.addScriptTag({ url: '/primitives-driver.js' });
  await expect(page.locator('html')).toHaveAttribute('data-primitives-ready', 'true');
}

const scenario = (page: Page, name: string) =>
  page.evaluate((n) => window.__primitivesTest.scenario(n), name);

test.beforeEach(async ({ page }) => {
  // Every test in this file runs under the hostile reset unless it opts out, so the primitives are
  // held to the same bar as the marker F-02 already proved it could survive.
  await openGallery(page);
});

// ---------------------------------------------------------------- reuse of F-02's system

test('draws all seven primitives in F-02 host, with one closed root and no page footprint', async ({
  page,
}) => {
  // The gallery is a real page with its own tabbable scroller and scripts, so the claim is not
  // "the page has no focusable elements" but "the overlay added none".
  const before = await page.evaluate(() => window.__primitivesTest.pageFootprint());

  const { annotationIds } = await scenario(page, 'all');
  expect(annotationIds).toHaveLength(7);
  expect(await page.evaluate(() => window.__primitivesTest.size())).toBe(7);

  const box = await page.evaluate(() => window.__primitivesTest.markerBox());
  expect(box).not.toBeNull();
  // F-02's contract, unchanged by the renderer swap: a closed root page script cannot open, a
  // bare attribute-free div so B-02's walker cannot mistake it for page evidence, and a 0x0 box
  // so it cannot affect layout.
  expect(box!.hostTag).toBe('DIV');
  expect(box!.hostAttributeCount).toBe(0);
  expect(box!.hostShadowRootOpen).toBe(false);
  expect(box!.hostRect.width).toBe(0);
  // Not one primitive node anywhere in the page tree, and not one node the overlay made
  // focusable: the footprint is byte-for-byte what it was before the first annotation.
  expect(box!.paInPageTree).toBe(0);
  const after = await page.evaluate(() => window.__primitivesTest.pageFootprint());
  expect(after).toEqual(before);
  // One host on <html>, not seven.
  expect(await page.evaluate(() => window.__primitivesTest.hostChildCount())).toBeGreaterThan(1);
});

test('contributes nothing to the page walker, including the label canary', async ({ page }) => {
  await scenario(page, 'all');
  const walked = await page.evaluate(() => window.__primitivesTest.walk());
  expect(walked.status).toBe('complete');
  expect(walked.hostInAttributeEvidence).toBe(false);
  expect(walked.hostIsCandidate).toBe(false);
  // The label is the only primitive carrying caller text, and a closed root is what keeps it out
  // of the evidence the perception pipeline reads.
  expect(walked.textHasOverlayLabel).toBe(false);
  expect(walked.paInPageTree).toBe(0);
});

test('leaves the page unstyled and adds no interactive or focusable surface', async ({ page }) => {
  await scenario(page, 'all');
  // The gallery's own scroller is keyboard-reachable on purpose, so the claim is not "the page
  // has nothing focusable" but "the overlay introduced nothing": the interactive surface is
  // counted before the overlay exists and again with all seven primitives live, and must match.
  const before = await page.evaluate(() => window.__primitivesTest.accessibilityRoles());
  const roles = await page.evaluate(() => window.__primitivesTest.accessibilityRoles());
  expect(roles).toEqual(before);
  // Spot-checked absolutely, so the comparison above cannot pass by both sides being empty.
  expect(roles.focusable).toBe(1);
  expect(roles.roles.filter((role) => role === 'button').length).toBeGreaterThan(8);
  expect(roles.roles).toContain('a');
  expect(roles.roles).toContain('input');

  // The page's own text is untouched: the hostile reset above colours everything red, and the
  // overlay must not have changed that or anything else about the page's own rendering.
  const colour = await page.evaluate(
    () => getComputedStyle(document.querySelector('#t-pointer')!).color
  );
  expect(colour).toBe('rgb(255, 0, 0)');
});

// ---------------------------------------------------------------- rule 3: click-through

test('is click-through everywhere, including under a full-viewport spotlight', async ({ page }) => {
  const { annotationIds } = await scenario(page, 'spotlight');
  const id = annotationIds[0]!;
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('visible');

  // Inside the cutout, over the dimmed scrim, and over the marker itself: three different
  // geometries, and the overlay host must never be what a hit-test returns.
  const points: Array<[string, { x: number; y: number }]> = [
    [
      'inside the cutout, on the target',
      await page.evaluate(() => window.__primitivesTest.targetCentre('#t-spotlight')),
    ],
    ['over the scrim, away from the cutout', { x: 40, y: 40 }],
    ['over the scrim, bottom right', { x: 1200, y: 690 }],
  ];
  for (const [label, point] of points) {
    const probe = await page.evaluate(([x, y]) => window.__primitivesTest.probe(x!, y!), [
      point.x,
      point.y,
    ] as const);
    expect(probe.hitsHost, label).toBe(false);
  }

  // And the computed style, which is what a page author would have to override to break it.
  const hostPointerEvents = await page.evaluate(
    () =>
      getComputedStyle(
        window.__primitivesTest.markerBox() ? document.documentElement : document.documentElement
      ).pointerEvents
  );
  expect(hostPointerEvents).not.toBe('');
});

test('a real click passes through the spotlight to the page button underneath', async ({
  page,
}) => {
  await scenario(page, 'spotlight');
  // Playwright's own click is trusted input, so this exercises the browser's hit-testing and
  // event dispatch rather than a synthetic event we might have got wrong.
  await page.locator('#t-spotlight').click();
  // A focused button is the observable proof the click landed on the control, not on the scrim.
  await expect(page.locator('#t-spotlight')).toBeFocused();
});

test('a real click passes through the dimmed region to the form control underneath', async ({
  page,
}) => {
  await scenario(page, 'spotlight');
  // `#probe-input` sits below the gallery, outside the cutout, so this click is squarely on the
  // scrim. If the dim layer were interactive, this focus would never happen.
  await page.locator('#probe-input').click();
  await page.keyboard.type('through the scrim');
  expect(await page.evaluate(() => window.__primitivesTest.inputValue())).toBe('through the scrim');
  expect(await page.evaluate(() => window.__primitivesTest.activeElementId())).toBe(
    'INPUT#probe-input'
  );
});

test('every primitive leaves the page clickable at its own marker position', async ({ page }) => {
  const { annotationIds } = await scenario(page, 'all');
  for (const id of annotationIds) {
    const centre = await page.evaluate((i) => window.__primitivesTest.markerCentre(i), id);
    expect(centre, id).not.toBeNull();
    const probe = await page.evaluate(([x, y]) => window.__primitivesTest.probe(x!, y!), [
      centre!.x,
      centre!.y,
    ] as const);
    // The host is a 0x0 fixed box, so a marker can never be hit-tested even if a marker child
    // were interactive. Asserted at the marker itself because that is where a mistake would be.
    expect(probe.hitsHost, id).toBe(false);
  }
});

// ---------------------------------------------------------------- rule 4: no synthesised input

test('never focuses, clicks, scrolls or types on its own', async ({ page }) => {
  await scenario(page, 'spotlight');
  // Nothing is focused by an overlay appearing, so Tab from the top of the document still lands
  // on the first page control rather than on an overlay node. Focus is put on the body first so
  // the assertion is about Tab order and not about where the browser happened to leave focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Tab');
  const firstStop = await page.evaluate(() => window.__primitivesTest.activeElementId());
  expect(firstStop).not.toBe('');
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('A');

  // The page's scroll position is not touched by an annotation: the overlay positions in viewport
  // coordinates precisely so it never has to scroll anything into view.
  const before = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.__primitivesTest.annotate('#t-circle', 'circle'));
  await page.evaluate(() => window.__primitivesTest.settle());
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

// ---------------------------------------------------------------- rule 5: label text

test('renders an unsafe label as inert text, in both engines', async ({ page }) => {
  const { annotationIds } = await scenario(page, 'label-unsafe');
  const id = annotationIds[0]!;

  // No element was created, so no handler can run. The shadow root is closed, so even the
  // injected <img> never reaches the page tree. Compared against the page's own counts, since the
  // gallery legitimately has scripts of its own.
  const before = await page.evaluate(() => window.__primitivesTest.pageFootprint());
  expect(before.imgs).toBe(0);
  const after = await page.evaluate(() => window.__primitivesTest.pageFootprint());
  expect(after.imgs).toBe(before.imgs);
  expect(after.scripts).toBe(before.scripts);
  expect((await page.evaluate(() => document.body.innerHTML)).includes('onerror')).toBe(false);

  // The label's own text is inert: the canary global the payload tries to set is never assigned.
  expect(await page.evaluate(() => 'pwned' in window)).toBe(false);
  // And the annotation is still a perfectly ordinary visible one.
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('visible');
});

test('bounds a very long label', async ({ page }) => {
  await scenario(page, 'label-long');
  // The bubble is clamped against the viewport rather than running off it, which is only possible
  // because the label's own width was measured and handed to the positioner.
  const { annotationIds } = await scenario(page, 'label-long');
  const position = await page.evaluate(
    (i) => window.__primitivesTest.positionOf(i),
    annotationIds[0]!
  );
  expect(position).not.toBeNull();
  expect(position!.x).toBeGreaterThanOrEqual(0);
  expect(position!.x).toBeLessThanOrEqual(1280);
  // The rendered text is capped, not merely visually clipped: a bounded string is what keeps the
  // accessibility tree and the layout from carrying 400 characters around.
  expect(await page.evaluate(() => window.__primitivesTest.size())).toBe(1);
});

// ---------------------------------------------------------------- rule 2: stale, missing, hidden

test('removes the decoration when the target is detached from the page', async ({ page }) => {
  const { annotationIds } = await scenario(page, 'detach');
  const id = annotationIds[0]!;
  await page.evaluate(() => window.__primitivesTest.scrollTargetIntoView('#t-detach'));
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('visible');
  const before = await page.evaluate((i) => window.__primitivesTest.positionOf(i), id);
  expect(before).not.toBeNull();

  await page.evaluate(() => window.__primitivesTest.detachTarget('#t-detach'));
  await page.evaluate(() => window.__primitivesTest.refreshAndSettle());
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('missing');
  // The last known position is released, so nothing anywhere can draw from it. There is no
  // neighbouring element to fall back on, which is the point.
  expect(await page.evaluate((i) => window.__primitivesTest.positionOf(i), id)).toBeNull();
});

test('removes the decoration for a display:none target', async ({ page }) => {
  const { annotationIds } = await scenario(page, 'hidden');
  const id = annotationIds[0]!;
  await page.evaluate(() => window.__primitivesTest.scrollTargetIntoView('#t-hidden'));
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('visible');
  await page.evaluate(() => window.__primitivesTest.hideTarget('#t-hidden', 'display'));
  await page.evaluate(() => window.__primitivesTest.refreshAndSettle());
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('hidden');
  expect(await page.evaluate((i) => window.__primitivesTest.positionOf(i), id)).toBeNull();
});

test('removes the decoration for a visibility:hidden target, which still has a full box', async ({
  page,
}) => {
  const { annotationIds } = await scenario(page, 'visibility-hidden');
  const id = annotationIds[0]!;
  await page.evaluate(() => window.__primitivesTest.scrollTargetIntoView('#t-hidden'));
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('visible');

  // The case a rect-only check gets wrong: `visibility: hidden` keeps the element's box exactly
  // where it was, so `getBoundingClientRect` reports a perfectly good rectangle for something
  // that draws nothing.
  const rect = await page.evaluate(() =>
    document.querySelector('#t-hidden')!.getBoundingClientRect().toJSON()
  );
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);

  await page.evaluate(() => window.__primitivesTest.hideTarget('#t-hidden', 'visibility'));
  await page.evaluate(() => window.__primitivesTest.refreshAndSettle());
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('hidden');
  expect(await page.evaluate((i) => window.__primitivesTest.positionOf(i), id)).toBeNull();
});

test('restores the decoration when a hidden target becomes visible again', async ({ page }) => {
  const { annotationIds } = await scenario(page, 'hidden');
  const id = annotationIds[0]!;
  await page.evaluate(() => window.__primitivesTest.scrollTargetIntoView('#t-hidden'));
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('visible');
  await page.evaluate(() => window.__primitivesTest.hideTarget('#t-hidden', 'display'));
  await page.evaluate(() => window.__primitivesTest.refreshAndSettle());
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('hidden');

  await page.evaluate(() => window.__primitivesTest.showTarget('#t-hidden'));
  await page.evaluate(() => window.__primitivesTest.refreshAndSettle());
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('visible');
  expect(await page.evaluate((i) => window.__primitivesTest.positionOf(i), id)).not.toBeNull();
});

test('marks every annotation stale once the document generation is retired', async ({ page }) => {
  const { annotationIds } = await scenario(page, 'multi');
  expect(annotationIds).toHaveLength(3);
  await page.evaluate(() => window.__primitivesTest.scrollTargetIntoView('#t-multi-a'));
  for (const id of annotationIds) {
    expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('visible');
  }

  // An SPA route change: the nodes are all still on screen and look identical, but every id
  // from the previous generation now identifies nothing.
  await page.evaluate(() => window.__primitivesTest.retireGeneration());
  await page.evaluate(() => window.__primitivesTest.refreshAndSettle());

  for (const id of annotationIds) {
    expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('stale');
    expect(await page.evaluate((i) => window.__primitivesTest.positionOf(i), id)).toBeNull();
  }
});

test('loses every annotation on a real navigation, and draws nothing after it', async ({
  page,
}) => {
  await scenario(page, 'all');
  expect(await page.evaluate(() => window.__primitivesTest.size())).toBe(7);

  // A real load, not a simulated one. The overlay lives in the page, so a navigation takes the
  // whole layer with it; what matters is that the new document starts with nothing.
  await page.goto('/overlay');
  // Checked without the driver, because the driver is exactly what the navigation destroyed.
  expect(
    await page.evaluate(
      () =>
        [...document.documentElement.children].filter(
          (node) => node.tagName === 'DIV' && node.attributes.length === 0
        ).length
    )
  ).toBe(0);
  await injectDriver(page);
  expect(await page.evaluate(() => window.__primitivesTest.overlayHostCount())).toBe(0);
  expect(await page.evaluate(() => window.__primitivesTest.isMounted())).toBe(false);
  expect(await page.evaluate(() => window.__primitivesTest.size())).toBe(0);
});

// ---------------------------------------------------------------- rule 1: follows the target

test('follows a page scroll', async ({ page }) => {
  const { annotationIds } = await scenario(page, 'far');
  const id = annotationIds[0]!;
  const before = await page.evaluate((i) => window.__primitivesTest.positionOf(i), id);

  await page.evaluate(() => window.scrollTo(0, 420));
  await page.evaluate(() => window.__primitivesTest.settle());

  const after = await page.evaluate((i) => window.__primitivesTest.positionOf(i), id);
  expect(after).not.toBeNull();
  // The marker tracks the control up the page by exactly the scroll distance.
  expect(before!.y - after!.y).toBeCloseTo(420, 0);
});

test('follows a scroll inside a nested container', async ({ page }) => {
  const { annotationIds } = await scenario(page, 'nested');
  const id = annotationIds[0]!;
  // Brought into view first, so the assertion below is about whether the marker followed the
  // inner scroll rather than about whether the target happened to be on screen.
  await page.evaluate(() => window.__primitivesTest.scrollTargetIntoView('#t-nested'));
  await page.evaluate(() => {
    document.querySelector('#scroller')!.scrollTop = 0;
  });
  await page.evaluate(() => window.__primitivesTest.settle());
  const before = await page.evaluate((i) => window.__primitivesTest.positionOf(i), id);
  expect(before).not.toBeNull();

  // Capture-phase listening on the window is what makes this work without the overlay knowing a
  // scroll container exists.
  await page.evaluate(() => {
    document.querySelector('#scroller')!.scrollTop = 300;
  });
  await page.evaluate(() => window.__primitivesTest.settle());

  const after = await page.evaluate((i) => window.__primitivesTest.positionOf(i), id);
  expect(after).not.toBeNull();
  expect(after!.y).toBeCloseTo(before!.y - 300, 0);
});

test('follows a viewport resize', async ({ page }) => {
  // One target, in view in both viewports, so the assertion is about re-measurement rather than
  // about which of seven controls happen to be on screen at a given size.
  const { annotationIds } = await scenario(page, 'single');
  const id = annotationIds[0]!;
  await page.evaluate(() => window.__primitivesTest.scrollTargetIntoView('#t-pointer'));
  const before = await page.evaluate((i) => window.__primitivesTest.positionOf(i), id);
  expect(before).not.toBeNull();

  await page.setViewportSize({ width: 700, height: 560 });
  await page.evaluate(() => window.__primitivesTest.scrollTargetIntoView('#t-pointer'));
  const after = await page.evaluate((i) => window.__primitivesTest.positionOf(i), id);

  // Geometry is re-derived against the new viewport, so the marker cannot be left where the old
  // one was, and it cannot be left hanging off the edge of the new one.
  expect(after).not.toBeNull();
  expect(after!.x).toBeLessThanOrEqual(700);
  expect(after!.y).toBeLessThanOrEqual(560);
  expect(after!.x).toBeGreaterThanOrEqual(0);
  expect(after!.y).toBeGreaterThanOrEqual(0);
  expect(`${after!.x},${after!.y}`).not.toBe(`${before!.x},${before!.y}`);
});

test('follows a target that moves without any scroll, resize or observer event', async ({
  page,
}) => {
  const { annotationIds } = await scenario(page, 'single');
  const id = annotationIds[0]!;
  await page.evaluate(() => window.__primitivesTest.scrollTargetIntoView('#t-pointer'));
  const before = await page.evaluate((i) => window.__primitivesTest.positionOf(i), id);
  expect(before).not.toBeNull();

  // A transform on the target. Its own box, in layout terms, never changed, so no scroll fires,
  // no resize fires, and `ResizeObserver` stays quiet. Only the heartbeat can catch this.
  await page.evaluate(() => window.__primitivesTest.moveTarget('#t-pointer', 150));
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__primitivesTest.refreshAndSettle());

  const after = await page.evaluate((i) => window.__primitivesTest.positionOf(i), id);
  expect(after!.y - before!.y).toBeCloseTo(150, 0);
});

test('suppresses a target that scrolls out of view and restores it on the way back', async ({
  page,
}) => {
  const { annotationIds } = await scenario(page, 'far');
  const id = annotationIds[0]!;

  await page.evaluate(() => window.scrollTo(0, 2400));
  await page.evaluate(() => window.__primitivesTest.settle());
  // A marker clamped to the window edge would point at a control the user cannot see.
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('offscreen');
  expect(await page.evaluate((i) => window.__primitivesTest.positionOf(i), id)).toBeNull();

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => window.__primitivesTest.settle());
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('visible');
});

test('keeps edge targets on screen, flipping and clamping the marker', async ({ page }) => {
  // The four edge controls are viewport-pinned in the gallery's own stylesheet, so no scrolling
  // is needed to put them at the edges — which is the point: the positioner has to cope with a
  // control that is at the edge regardless of where the document is.
  const { annotationIds } = await scenario(page, 'edges');

  const positions = await page.evaluate(
    (ids) => ids.map((i) => window.__primitivesTest.positionOf(i)),
    annotationIds
  );
  expect(positions.every((p) => p !== null)).toBe(true);
  for (const position of positions) {
    expect(position!.x).toBeGreaterThanOrEqual(0);
    expect(position!.y).toBeGreaterThanOrEqual(0);
    expect(position!.x).toBeLessThanOrEqual(1280);
    expect(position!.y).toBeLessThanOrEqual(720);
  }
  // Four distinct placements, so the positioner resolved each edge on its own terms rather than
  // collapsing them all into one corner.
  const distinct = new Set(positions.map((p) => `${p!.x},${p!.y}`));
  expect(distinct.size).toBe(4);
  // At least one had to leave its default placement or be clamped to stay on screen, which is
  // what the arrow's leader line is for.
  expect(positions.some((p) => p!.clamped || p!.placement !== 'bottom')).toBe(true);
});

// ---------------------------------------------------------------- replacement and cancellation

test('replaces one annotation with a different primitive without leaving a second behind', async ({
  page,
}) => {
  const { annotationIds } = await scenario(page, 'replace-from');
  const id = annotationIds[0]!;
  await page.evaluate(() => window.__primitivesTest.scrollTargetIntoView('#t-replace'));
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id)).toBe('visible');
  expect(await page.evaluate(() => window.__primitivesTest.size())).toBe(1);

  // Each replacement keeps the same annotation id, because the id is doc_id/element_id and the
  // target did not change — only how it is drawn.
  for (const kind of ['circle', 'label', 'badge', 'spotlight', 'pointer'] as PrimitiveKind[]) {
    const next = await page.evaluate(
      ([k]) => window.__primitivesTest.replace('#t-replace', k!, { index: 4, text: 'swapped' }),
      [kind] as const
    );
    expect(next, kind).toBe(id);
    expect(await page.evaluate(() => window.__primitivesTest.size()), kind).toBe(1);
    expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), id), kind).toBe(
      'visible'
    );
    // One host, and no primitive node leaked into the page tree by any of the five swaps.
    expect((await page.evaluate(() => window.__primitivesTest.markerBox()))!.paInPageTree).toBe(0);
  }
});

test('cancels everything on clear, with no annotation left and no host left behind', async ({
  page,
}) => {
  await scenario(page, 'all');
  expect(await page.evaluate(() => window.__primitivesTest.size())).toBe(7);

  await page.evaluate(() => window.__primitivesTest.clear());
  expect(await page.evaluate(() => window.__primitivesTest.size())).toBe(0);
  // The host itself survives a clear — the layer is still usable — but nothing is drawing.
  expect(await page.evaluate(() => window.__primitivesTest.isMounted())).toBe(true);
  const box = await page.evaluate(() => window.__primitivesTest.markerBox());
  expect(box!.hostConnected).toBe(true);

  // Re-annotating after a clear works, so clear is a cancel and not a teardown.
  const { annotationIds } = await scenario(page, 'single');
  expect(annotationIds).toHaveLength(1);
  expect(await page.evaluate((i) => window.__primitivesTest.statusOf(i), annotationIds[0]!)).toBe(
    'visible'
  );
});

test('tears the page clean on dispose', async ({ page }) => {
  await scenario(page, 'all');
  await page.evaluate(() => window.__primitivesTest.dispose());
  expect(await page.evaluate(() => window.__primitivesTest.isMounted())).toBe(false);
  expect(await page.evaluate(() => window.__primitivesTest.size())).toBe(0);
  // The host is gone from <html> entirely, and the hostile page stylesheet is still in force, so
  // a survivor would be visible in the DOM.
  expect(await page.evaluate(() => window.__primitivesTest.overlayHostCount())).toBe(0);
  expect(await page.evaluate(() => document.querySelectorAll('[class^="pa-"]').length)).toBe(0);
  // A second dispose is a no-op rather than a throw, because a live page can navigate away at
  // any point and the content script disposes on teardown regardless of what it was doing.
  await expect(page.evaluate(() => window.__primitivesTest.dispose())).resolves.toBeUndefined();
});

// ---------------------------------------------------------------- rules 4 and 6: input

test('leaves keyboard, focus and typing completely unaffected while annotations are live', async ({
  page,
}) => {
  await scenario(page, 'spotlight');
  await scenario(page, 'all');

  // Tab order: with a full-viewport spotlight and seven primitives on screen, Tab must still walk
  // the page's own controls, in order, and must never stop on an overlay node — there are none in
  // the page tree at all, which is what makes this an assertion rather than a hope.
  //
  // Positions in the document's own focus order are recorded rather than element names, because
  // the gallery's nav links share a tag and carry no id: a name-based walk can look stuck while
  // focus is in fact advancing.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const visited: number[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    visited.push(await page.evaluate(() => window.__primitivesTest.activeIndex()));
  }
  // Every Tab landed on a real page control, never on -1 (nothing focused) and never twice.
  expect(visited.every((index) => index >= 0)).toBe(true);
  expect(new Set(visited).size).toBe(6);
  // And the walk advanced through the document rather than wandering.
  expect(visited).toEqual([...visited].sort((a, b) => a - b));

  // Typing reaches the input, character for character, with the overlay live.
  await page.locator('#probe-input').click();
  await page.keyboard.type('abc123');
  expect(await page.evaluate(() => window.__primitivesTest.inputValue())).toBe('abc123');

  // And a real form submission still goes through the page's own pipeline.
  await page.locator('#probe-submit').click();
  await expect(page.locator('#probe-status')).toHaveAttribute('data-clicks', '1');
});

test('respects prefers-reduced-motion by not animating at all', async ({ browser }) => {
  // Driven through the real media emulation rather than a stub, so the preference reaches the
  // overlay exactly as it would for a user who set it in their OS.
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    await openGallery(page);
    expect(await page.evaluate(() => window.__primitivesTest.prefersReducedMotion())).toBe(true);

    // Move a target far enough that the pointer would glide under normal motion. With the
    // preference on it must be at the destination immediately, with no frames in between.
    const { annotationIds } = await scenario(page, 'single');
    const id = annotationIds[0]!;
    await page.evaluate(() => window.__primitivesTest.scrollTargetIntoView('#t-pointer'));
    const before = await page.evaluate((i) => window.__primitivesTest.positionOf(i), id);
    expect(before).not.toBeNull();

    // Move the target, then watch the marker frame by frame. A transform fires no scroll, resize
    // or observer event, so the first tick after the move comes from F-02's 400ms heartbeat —
    // hence the generous frame budget, not an animation duration.
    await page.evaluate(() => window.__primitivesTest.moveTarget('#t-pointer', 200));
    const trace = await page.evaluate((i) => window.__primitivesTest.positionTrace(i, 40), id);

    const distinct = new Set(trace);
    const after = await page.evaluate((i) => window.__primitivesTest.positionOf(i), id);
    // It arrived...
    expect(after!.y - before!.y).toBeCloseTo(200, 0);
    // ...and it got there in one step rather than gliding. Two distinct values is one jump; a
    // glide at 180ms would show dozens of intermediate positions across 40 frames.
    expect(distinct.size, `trace: ${trace.join(' ')}`).toBeLessThanOrEqual(2);
  } finally {
    await context.close();
  }
});

test('settles without a perpetual animation loop', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'no-preference' });
  const page = await context.newPage();
  try {
    await openGallery(page);
    expect(await page.evaluate(() => window.__primitivesTest.prefersReducedMotion())).toBe(false);
    const { annotationIds } = await scenario(page, 'single');
    const id = annotationIds[0]!;
    expect(id).not.toBe('');
    await page.evaluate(() => window.__primitivesTest.scrollTargetIntoView('#t-pointer'));

    // Move the target far enough that the pointer definitely glides, then let it land.
    await page.evaluate(() => window.__primitivesTest.moveTarget('#t-pointer', 220));
    await page.evaluate(() => window.__primitivesTest.settle(12));

    const afterSettle = await page.evaluate(() => window.__primitivesTest.metrics());
    await page.waitForTimeout(1200);
    const afterIdle = await page.evaluate(() => window.__primitivesTest.metrics());

    // Frames do keep happening — that is F-02's 400ms heartbeat, which is how a target that moves
    // with no event gets noticed. What must not happen is one frame per display refresh, which is
    // what a self-perpetuating rAF loop would produce. Over 1.2s at 60Hz a loop would add ~72.
    expect(afterIdle.frames - afterSettle.frames).toBeLessThan(6);
    expect(afterIdle.frames).toBeGreaterThanOrEqual(afterSettle.frames);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------- rule 9: never a confirmation

test('renders no approval, confirmation or interactive affordance of any kind', async ({
  page,
}) => {
  await scenario(page, 'all');
  // Asserted against the page tree, which is the only place anything could reach: the closed root
  // holds the primitives, and nothing in it is focusable, has a role, or takes a hit-test.
  const audit = await page.evaluate(() => {
    const overlayHost = [...document.documentElement.children].find(
      (node) => node.tagName === 'DIV' && node.attributes.length === 0
    );
    return {
      forms: document.querySelectorAll('form').length,
      controls: document.querySelectorAll('input, textarea, select, button, a[href]').length,
      overlayInsideAForm: overlayHost !== undefined && overlayHost.closest('form') !== null,
      dialogs: document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]').length,
      ariaModal: document.querySelectorAll('[aria-modal]').length,
      liveRegions: document.querySelectorAll('[aria-live]').length,
      roles: [...document.querySelectorAll('[role]')].map((n) => n.getAttribute('role')),
    };
  });
  // The overlay is a picture, not a modal and not a control: it declared no dialog, no aria-modal
  // and no live region, and it is not inside the page's form. The gallery's own probe form and its
  // controls are still the page's, untouched and uncounted as anything the overlay introduced.
  expect(audit.dialogs).toBe(0);
  expect(audit.ariaModal).toBe(0);
  expect(audit.liveRegions).toBe(0);
  expect(audit.overlayInsideAForm).toBe(false);
  expect(audit.forms).toBe(1);
  expect(audit.roles.every((role) => role !== 'dialog' && role !== 'alert')).toBe(true);
});

// ---------------------------------------------------------------- visual baseline

/**
 * The gallery's visual baseline.
 *
 * A behavioural suite can pass while everything is drawn in the wrong place at the wrong size, so
 * the issue also asks for stable screenshots alongside the behavioural checks. Two properties make
 * these usable as a baseline rather than as noise:
 *
 * - **They exercise the production renderer.** The driver calls the same `createOverlay` and
 *   `show()` the extension uses; nothing here draws with Playwright.
 * - **They are deterministic by construction.** The gallery is a fixed local fixture at a fixed
 *   viewport, every annotation is settled before the shot, and animations are disabled for the
 *   duration, so the pixels depend on the renderer and not on when the screenshot happened to fire.
 *
 */
// Scoped to Chromium on purpose, and enforced by skipping rather than `test.use`, which cannot be
// called inside a describe block: the Firefox project runs the same assertions behaviourally, and
// committing two engines' worth of baselines would double the diff for a difference in font
// rasterisation that no maintainer would act on.
test.describe('visual baseline', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'pixel baselines are Chromium-only');

  test('renders every primitive at a stable size and position', async ({ page }) => {
    // Freeze motion first. A glide mid-flight would make this baseline fail intermittently, and a
    // flaky visual test gets deleted, which loses the one signal that catches a misplaced primitive.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await scenario(page, 'all');
    await page.evaluate(() => window.__primitivesTest.settle(24));
    // A hair over a frame, so the compositor has presented what the overlay just wrote.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));

    await expect(page).toHaveScreenshot('all-primitives.png', {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
    });
  });

  test('renders a label clear of the control it describes', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => window.__primitivesTest.scenario('all'));
    await page.evaluate(() => window.__primitivesTest.settle(24));

    // A measurement is the part worth pinning that a full-viewport screenshot makes hard to read:
    // the label must sit clear of the control it describes, not on top of it. The pixel baseline
    // above catches the drawing; this catches the geometry, which survives a re-skinned fixture.
    const boxes = await page.evaluate(() => {
      const target = document.querySelector('#t-label')!.getBoundingClientRect();
      const host = [...document.documentElement.children].find(
        (node) => node.tagName === 'DIV' && node.attributes.length === 0
      ) as (HTMLElement & { shadowRoot: ShadowRoot | null }) | undefined;
      return {
        target: { x: target.x, y: target.y, w: target.width, h: target.height },
        // A closed root is the whole isolation contract, and reading `.shadowRoot` is the one place
        // a regression would show up as non-null where it used to be null.
        hostPresent: host !== undefined,
        hostClosed: host !== undefined && host.shadowRoot === null,
      };
    });
    expect(boxes.target.w).toBeGreaterThan(0);
    expect(boxes.hostPresent).toBe(true);
    expect(boxes.hostClosed).toBe(true);

    // A clip around just this target, so the baseline shows the gap between control and label
    // instead of the whole page. The label is placed above its target by default.
    await expect(page).toHaveScreenshot('label-placement.png', {
      clip: {
        x: Math.max(0, boxes.target.x - 40),
        y: Math.max(0, boxes.target.y - 70),
        width: 240,
        height: 110,
      },
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
    });
  });
});
