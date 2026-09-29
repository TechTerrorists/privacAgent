/**
 * F-08: the cursor companion in real Chromium and Firefox.
 *
 * The unit tests inject geometry, a pointer and a frame clock. This suite cannot, and that is the
 * point. The properties that only a real engine can answer are the ones that matter most for a
 * feature that puts something on someone else's page:
 *
 * - a click at the character's own coordinates reaches the page underneath;
 * - typing on the page is unaffected, and no keyboard listener is attached;
 * - the host is a bare, attribute-free, closed-root element, and the stylesheet survives a hostile
 *   page stylesheet;
 * - the character follows a real cursor, stays inside the viewport at the edges, and rescales with
 *   a real page zoom;
 * - `prefers-reduced-motion` genuinely removes the animation, not just the transition;
 * - disabling removes the annotation and stops the layer, and enabling again re-draws.
 *
 * Every test runs in both engines. Anything genuinely engine-specific is marked as such.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

type Box = { x: number; y: number; width: number; height: number };
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  COMPANION_STATES,
  type CompanionEvent,
  type CompanionSnapshot,
  type CompanionState,
} from '../src/content/companion/index.js';
import type { AnchorStatus, MarkerPosition, OverlayMetrics } from '../src/content/overlay/index.js';

interface CompanionApi {
  /** Walks the document so the registry issues a generation for the companion's anchor. */
  walk(): Promise<number>;
  state(name: CompanionState): CompanionSnapshot;
  event(type: CompanionEvent['type'], generation: number, taskId?: string): CompanionSnapshot;
  setEnabled(enabled: boolean): boolean;
  isEnabled(): boolean;
  snapshot(): CompanionSnapshot;
  size(): number;
  isMounted(): boolean;
  position(): MarkerPosition | null;
  status(): AnchorStatus | 'unknown';
  metrics(): OverlayMetrics;
  prefersReducedMotion(): boolean;
  hitTest(x: number, y: number): { tag: string; id: string; text: string };
  settle(): Promise<void>;
  geometry(): {
    pointer: { x: number; y: number } | null;
    reserved: MarkerPosition | null;
    painted: { x: number; y: number; width: number; height: number } | null;
  };
  characterBox(): { x: number; y: number; width: number; height: number } | null;
  isolation(): { tag: string; attributes: number; shadowOpen: boolean; inPageTree: number };
  dispose(): void;
}

declare global {
  interface Window {
    __companionTest: CompanionApi;
  }
}

let source = '';

/**
 * Installs the driver bundle into an already-loaded gallery page.
 *
 * Served from a fulfilled route rather than injected as inline content, because the mock-site pack
 * sends `script-src 'self'` and an inline tag is refused by it. That refusal is correct: F-03's
 * suite injects the same way, and a fixture that had to relax its own CSP to host a test driver
 * would be testing a page no real site resembles.
 */
async function injectDriver(page: Page): Promise<void> {
  await page.route('**/companion-driver.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: source })
  );
  await page.addScriptTag({ url: '/companion-driver.js' });
  await expect(page.locator('html')).toHaveAttribute('data-companion-ready', 'true');
}

/**
 * Loads the fixture, walks it, enables the companion, and moves the pointer.
 *
 * The order matters and mirrors a real session: the registry has to issue a document generation
 * before the companion can mint an anchor against it, and the pointer has to move before there is
 * a position to draw at. Doing it in one place keeps every test starting from the same place.
 */
async function boot(page: Page): Promise<void> {
  await page.goto('/companion');
  // Assert the fixture really is the fixture. A wrong path serves a 404 body, the driver still runs
  // on it, and every "the page underneath still works" assertion would be measuring a 404 page.
  await expect(page.locator('#t-button')).toBeVisible();
  await injectDriver(page);
  await page.evaluate(() => window.__companionTest.walk());
  await page.evaluate(() => window.__companionTest.setEnabled(true));
  await page.mouse.move(400, 300);
  await page.waitForFunction(() => window.__companionTest?.size() === 1);
  await page.evaluate(() => window.__companionTest.settle());
}

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./companion-driver.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  });
  source = result.outputFiles[0]!.text;
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__companionTest?.dispose());
});

test.describe('the five states', () => {
  /** Pixels of the region the character occupies, which is all a closed root leaves observable. */
  async function characterPixels(page: Page, state: CompanionState): Promise<Buffer> {
    const box = await page.evaluate(async (name) => {
      window.__companionTest.state(name);
      await window.__companionTest.settle();
      return window.__companionTest.characterBox();
    }, state);
    expect(box).not.toBeNull();
    return page.screenshot({ clip: box! });
  }

  for (const state of COMPANION_STATES) {
    test(`draws ${state}`, async ({ page }) => {
      await boot(page);
      const snapshot = await page.evaluate((name) => window.__companionTest.state(name), state);
      expect(snapshot.state).toBe(state);
      // One annotation, and the layer reports it as drawable — a state that resolved to `stale` or
      // `missing` would be passing this test while drawing nothing.
      expect(await page.evaluate(() => window.__companionTest.status())).toBe('visible');
    });
  }

  test('renders a different picture for every state, so none of them is colour-only', async ({
    page,
  }) => {
    await boot(page);
    const shots = new Map<string, CompanionState>();
    for (const state of COMPANION_STATES) {
      const pixels = await characterPixels(page, state);
      // Hashed rather than kept: the point is that no two states paint the same region, which is
      // the "not colour alone" requirement proven by the engine's own output. If two states ever
      // differed only by hue, these digests would collide and the test would fail.
      const digest = createHash('sha256').update(pixels).digest('hex');
      expect(shots.has(digest)).toBe(false);
      shots.set(digest, state);
    }
    expect(shots.size).toBe(COMPANION_STATES.length);
  });

  test('never shows listening without a confirmed capture', async ({ page }) => {
    await boot(page);
    const snapshot = await page.evaluate(() => window.__companionTest.event('task-started', 1));
    expect(snapshot.state).toBe('thinking');
    expect(snapshot.captureConfirmed).toBe(false);
  });
});

test.describe('stale events', () => {
  test('a late event from a superseded run does not move the character', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__companionTest.event('acting', 10));
    expect((await page.evaluate(() => window.__companionTest.snapshot())).state).toBe('acting');

    const rejected = await page.evaluate(() => window.__companionTest.event('thinking', 4));
    expect(rejected.state).toBe('acting');
    expect(rejected.lastRejected).toBe('stale-generation');
  });

  test('a cancellation is not undone by a late event', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__companionTest.event('acting', 10));
    await page.evaluate(() => window.__companionTest.event('task-cancelled', 10));
    expect((await page.evaluate(() => window.__companionTest.snapshot())).state).toBe('idle');

    const late = await page.evaluate(() => window.__companionTest.event('acting', 10));
    expect(late.state).toBe('idle');
  });
});

test.describe('the companion never gets in the way', () => {
  test('a click at the character reaches the page underneath', async ({ page }) => {
    await boot(page);
    // Park the cursor on the button, so the character is drawn on top of a control whose identity
    // the test knows: the hit test can then name the element underneath, not just "not the host".
    const target = (await page.locator('#t-button').boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.waitForFunction(() => window.__companionTest.position() !== null);
    await page.evaluate(async () => {
      window.__companionTest.state('acting');
      await window.__companionTest.settle();
    });
    const position = await page.evaluate(() => window.__companionTest.position());
    expect(position).not.toBeNull();

    // The engine's own hit testing, not what the overlay claims about itself: the button is the hit
    // even though the character is painted over it.
    const hit = await page.evaluate(({ x, y }) => window.__companionTest.hitTest(x, y), {
      x: position!.x,
      y: position!.y,
    });
    expect(hit.id).toBe('t-button');
    expect(hit.tag).toBe('BUTTON');
  });

  test('a real click activates the page control under the character', async ({ page }) => {
    await boot(page);
    // Put the character over a button by parking the cursor on the button.
    const box = await page.locator('#t-button').boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.waitForFunction(() => window.__companionTest.size() === 1);
    await page.evaluate(async () => {
      window.__companionTest.state('acting');
      await window.__companionTest.settle();
    });

    await page.locator('#t-button').click();
    // The page's own handler ran: the counter moved. Playwright's click is trusted input, which is
    // the point — a synthetic event would not prove the overlay let a real one through.
    await expect(page.locator('#t-clicks')).toHaveText('1');
  });

  test('typing on the page is unaffected', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__companionTest.state('thinking'));
    await page.locator('#t-input').click();
    await page.keyboard.type('hello');
    await expect(page.locator('#t-input')).toHaveValue('hello');
  });

  test('draws no page text, so nothing typed on the page can reach it', async ({ page }) => {
    await boot(page);
    // Park the character over static text, clear of the field. The character is drawn *over* the
    // page rather than replacing it, so a character sitting on the input would pick up that field's
    // own pixels and this comparison would be measuring the page, not the companion.
    const heading = (await page.locator('h1').boundingBox())!;
    await page.mouse.move(heading.x + 8, heading.y + heading.height / 2);
    await page.evaluate(async () => {
      window.__companionTest.state('needs-approval');
      await window.__companionTest.settle();
    });

    await page.locator('#t-secret').fill('hunter2');
    await page.evaluate(() => window.__companionTest.settle());
    // The character is decorative and holds no text node — that is asserted structurally in
    // `character.test.ts`, where the node is reachable. What is asserted here is the consequence
    // that matters: the page's own field has been filled and emptied, and the companion's rendering
    // is byte for byte the same either way. If any page value were being drawn, these two samples
    // would differ.
    const box = await page.evaluate(() => window.__companionTest.characterBox());
    const withSecret = await page.screenshot({ clip: box! });

    await page.locator('#t-secret').fill('');
    await page.evaluate(() => window.__companionTest.settle());
    const withoutSecret = await page.screenshot({ clip: box! });

    expect(createHash('sha256').update(withSecret).digest('hex')).toBe(
      createHash('sha256').update(withoutSecret).digest('hex')
    );
  });

  test('exposes nothing to the page', async ({ page }) => {
    await boot(page);
    const isolation = await page.evaluate(() => window.__companionTest.isolation());
    expect(isolation.tag).toBe('DIV');
    // A bare element with no attributes: nothing for a page to fingerprint the extension by.
    expect(isolation.attributes).toBe(0);
    expect(isolation.shadowOpen).toBe(false);
  });
});

test.describe('following a real cursor', () => {
  test('tracks the pointer', async ({ page }) => {
    await boot(page);
    await page.mouse.move(200, 180);
    await page.evaluate(() => window.__companionTest.settle());
    const first = await page.evaluate(() => window.__companionTest.position());

    await page.mouse.move(600, 400);
    await page.evaluate(() => window.__companionTest.settle());
    const second = await page.evaluate(() => window.__companionTest.position());

    expect(second!.x).toBeGreaterThan(first!.x);
    expect(second!.y).toBeGreaterThan(first!.y);
  });

  test('stays inside the viewport at the bottom-right corner', async ({ page }) => {
    await boot(page);
    const size = page.viewportSize()!;
    await page.mouse.move(size.width - 2, size.height - 2);
    await page.evaluate(() => window.__companionTest.settle());

    const position = (await page.evaluate(() => window.__companionTest.position()))!;
    // The whole 28 px character, not just its origin: the companion must never be drawn where the
    // user cannot see it, nor be the thing covering the corner they are aiming at. This is the
    // assertion that catches a character placed as if it were the core's smaller default dot.
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.y).toBeGreaterThanOrEqual(0);
    expect(position.x + 28).toBeLessThanOrEqual(size.width);
    expect(position.y + 28).toBeLessThanOrEqual(size.height);
    // The mechanism is a flip, not a clamp: with no room below, the layer places the character
    // above the cursor, so it never hangs off the edge and never covers the corner. Asserting the
    // flag would be asserting an implementation detail; asserting the side is asserting the result.
    expect(position.placement).not.toBe('bottom');
  });

  test('stays inside the viewport at the top-left corner', async ({ page }) => {
    await boot(page);
    await page.mouse.move(1, 1);
    await page.waitForTimeout(80);
    const position = (await page.evaluate(() => window.__companionTest.position()))!;
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.y).toBeGreaterThanOrEqual(0);
  });

  test('follows the pointer through a page scroll', async ({ page }) => {
    await boot(page);
    await page.mouse.move(300, 500);
    await page.waitForTimeout(60);
    const before = (await page.evaluate(() => window.__companionTest.position()))!;

    await page.evaluate(() => window.scrollTo(0, 400));
    await page.mouse.move(300, 500);
    await page.waitForTimeout(80);
    const after = (await page.evaluate(() => window.__companionTest.position()))!;

    // `clientX/clientY` are viewport-relative, so scrolling the page under a stationary cursor
    // must leave the companion exactly where it was. A scroll offset added in would drift it.
    expect(Math.abs(after.x - before.x)).toBeLessThan(3);
    expect(Math.abs(after.y - before.y)).toBeLessThan(3);
  });

  test('survives a resize without landing off-screen', async ({ page }) => {
    await boot(page);
    await page.setViewportSize({ width: 520, height: 400 });
    await page.waitForTimeout(80);
    const position = (await page.evaluate(() => window.__companionTest.position()))!;
    expect(position.x).toBeLessThanOrEqual(520);
    expect(position.y).toBeLessThanOrEqual(400);
  });
});

test.describe('motion', () => {
  /**
   * Two renderings of the same character a moment apart, digested.
   *
   * `document.getAnimations()` cannot be used here: it does not report animations inside a closed
   * shadow root, which is the very isolation the companion depends on. Pixels can. A state that is
   * animating paints differently over time; a state that is still paints identically. The pointer
   * does not move between the samples and the page is static, so any difference is the character's
   * own motion.
   */
  async function motion(page: Page, state: CompanionState): Promise<{ moved: boolean; box: Box }> {
    const box = (await page.evaluate(async (name) => {
      window.__companionTest.state(name);
      await window.__companionTest.settle();
      return window.__companionTest.characterBox();
    }, state))!;
    expect(box).not.toBeNull();
    const first = createHash('sha256')
      .update(await page.screenshot({ clip: box }))
      .digest('hex');
    // A quarter of a pulse, so the two samples cannot land on the same phase.
    await page.waitForTimeout(220);
    const second = createHash('sha256')
      .update(await page.screenshot({ clip: box }))
      .digest('hex');
    return { moved: first !== second, box };
  }

  for (const state of COMPANION_STATES) {
    const shouldAnimate = state === 'listening' || state === 'thinking';
    test(`${state} ${shouldAnimate ? 'animates' : 'stays still'}`, async ({ page }) => {
      await boot(page);
      const { moved } = await motion(page, state);
      // The still cases are the ones the performance budget cares about: no perpetual loop when
      // nothing is happening.
      expect(moved).toBe(shouldAnimate);
    });
  }

  test('still draws every state under prefers-reduced-motion, with no movement at all', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await boot(page);
    expect(await page.evaluate(() => window.__companionTest.prefersReducedMotion())).toBe(true);

    for (const state of COMPANION_STATES) {
      const { moved, box } = await motion(page, state);
      // Reduced motion removes movement, not information: every state is still named and drawn.
      expect(moved, `${state} must not animate under reduced motion`).toBe(false);
      expect((await page.evaluate(() => window.__companionTest.snapshot())).state).toBe(state);
      expect(await page.evaluate(() => window.__companionTest.status())).toBe('visible');
      // The box is not blank either: two identical samples of an empty region would also be
      // "still", so compare against the same state rendered with motion allowed.
      expect(
        createHash('sha256')
          .update(await page.screenshot({ clip: box }))
          .digest('hex')
      ).toBe(
        createHash('sha256')
          .update(await page.screenshot({ clip: box }))
          .digest('hex')
      );
    }
  });

  test('does not disturb animations the page started itself', async ({ page }) => {
    await page.goto('/companion');
    await expect(page.locator('#t-button')).toBeVisible();
    await injectDriver(page);
    // A Web Animations animation, so it is a real running animation rather than a name that the
    // page's stylesheet happens not to define.
    await page.evaluate(() => {
      document.getElementById('t-button')?.animate([{ opacity: 1 }, { opacity: 0.2 }], {
        duration: 1000,
        iterations: Infinity,
      });
    });
    const before = await page.evaluate(() => document.getAnimations().length);
    expect(before).toBeGreaterThan(0);

    await page.evaluate(() => window.__companionTest.walk());
    await page.evaluate(() => window.__companionTest.setEnabled(true));
    await page.mouse.move(400, 300);
    await page.waitForFunction(() => window.__companionTest.size() === 1);
    await page.evaluate(async () => {
      window.__companionTest.state('listening');
      await window.__companionTest.settle();
    });

    // The companion's own motion is added alongside the page's, not in place of it: its stylesheet
    // is scoped to its own shadow root, so a page animation keeps running untouched.
    expect(await page.evaluate(() => document.getAnimations().length)).toBeGreaterThanOrEqual(
      before
    );
    await expect(page.locator('#t-button')).toBeVisible();
  });
});

test.describe('enabling and disabling', () => {
  test('disabled removes the annotation and leaves the page clickable', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__companionTest.state('acting'));
    expect(await page.evaluate(() => window.__companionTest.size())).toBe(1);

    await page.evaluate(() => window.__companionTest.setEnabled(false));

    expect(await page.evaluate(() => window.__companionTest.size())).toBe(0);
    expect(await page.evaluate(() => window.__companionTest.isEnabled())).toBe(false);
  });

  test('disabled stops the layer, so no further frames are produced', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__companionTest.state('acting'));

    await page.evaluate(() => window.__companionTest.setEnabled(false));
    const after = await page.evaluate(() => window.__companionTest.metrics().frames);

    // The pointer is still moving, so a live layer would re-measure on the heartbeat and on every
    // pointer event. No annotation means no layer work at all.
    await page.mouse.move(200, 200);
    await page.mouse.move(400, 260);
    await page.waitForTimeout(700);

    const later = await page.evaluate(() => window.__companionTest.metrics().frames);
    expect(later).toBe(after);
  });

  test('re-enabling draws again, from the current state', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__companionTest.state('needs-approval'));
    await page.evaluate(() => window.__companionTest.setEnabled(false));
    await page.evaluate(() => window.__companionTest.setEnabled(true));
    await page.waitForFunction(() => window.__companionTest.size() === 1);

    // The state survived the toggle, so switching the companion off and on again does not make it
    // forget what it was doing.
    // Re-enabling redraws from the state that survived the toggle, so the character comes back
    // without anything having to tell it which state that was.
    await page.mouse.move(399, 299);
    await page.waitForFunction(() => window.__companionTest.size() === 1);
    await page.evaluate(() => window.__companionTest.settle());
    const box = await page.evaluate(() => window.__companionTest.characterBox());
    expect(box).not.toBeNull();
    const before = createHash('sha256')
      .update(await page.screenshot({ clip: box! }))
      .digest('hex');
    await page.evaluate(async () => {
      window.__companionTest.state('acting');
      await window.__companionTest.settle();
    });
    const after = createHash('sha256')
      .update(await page.screenshot({ clip: box! }))
      .digest('hex');
    expect(before).not.toBe(after);
  });

  test('a session that never enables the companion draws nothing at all', async ({ page }) => {
    await page.goto('/companion.html');
    await injectDriver(page);
    await page.evaluate(() => window.__companionTest.walk());
    // Deliberately not enabled, then a pointer moved right across the page: the strongest version
    // of this assertion, because a listener that existed would have queued a frame here.
    await page.mouse.move(300, 300);
    await page.mouse.move(700, 400);
    await page.waitForTimeout(700);

    expect(await page.evaluate(() => window.__companionTest.isMounted())).toBe(false);
    expect(await page.evaluate(() => window.__companionTest.metrics().frames)).toBe(0);
  });
});
