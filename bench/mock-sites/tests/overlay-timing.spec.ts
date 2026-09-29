/**
 * F-03: frame cost of the overlay primitives, measured rather than asserted.
 *
 * The unit suite proves the overlay is *logically* cheap — one registry, one root, one coalescer,
 * a glide that subscribes on arrival and unsubscribes before its final write. None of that is a
 * number a user experiences. This file produces the numbers: how long a full frame of every
 * primitive takes to write, what the frame cadence looks like while the overlay is live and after
 * it has settled, and whether the layer ever causes a long task.
 *
 * Three deliberate choices about what is measured, because each one is a way to fool yourself:
 *
 * - **Intervals, not counts.** "300 frames in 5 s" sounds like a number until you notice the
 *   browser was idling. The cadence of *intervals between* animation frames is the thing a user
 *   perceives, and it is what a dropped frame actually shows up in.
 * - **A worst case that is reachable.** The core caps a layer at 64 annotations, and a caller can
 *   legitimately fill it. The interesting number is the full layer, not a lone circle.
 * - **Settled and unsettled reported separately.** A layer that animates and then goes quiet and a
 *   layer that animates forever look identical in a total frame count. Only the post-settle cadence
 *   tells them apart, and that is the difference between "~0% idle CPU" and a busy loop.
 *
 * Honest limitation, stated rather than hidden: both projects run headless, and a headless browser
 * has no display and therefore no vsync. The cadence figures below are the *headless* cadence and
 * are not a claim about a real 60 Hz display. What they do establish, and what the report says
 * plainly, is the cost of the overlay's own work: the long-task check is a real main-thread bound
 * that holds regardless of vsync, and the idle check is a comparison against the page's own
 * baseline in the same headless engine, which cancels the engine out.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath as toPath } from 'node:url';
import os from 'node:os';

/**
 * The slice of the F-03 test driver this benchmark uses. Declared locally rather than imported:
 * the driver is bundled into the page by `beforeAll`, and the bench project does not depend on
 * the extension's test project.
 */
declare global {
  interface Window {
    __primitivesTest: {
      scenario(name: string): Promise<{ annotationIds: string[]; status: string }>;
      settle(count?: number): Promise<void>;
      saturate(): Promise<string[]>;
      churnAll(frames: number): Promise<void>;
      metrics(): { frames: number; longestFrameMs: number };
    };
  }
}

/**
 * The host machine, recorded at run time rather than copied into the report by hand, so a stale
 * report cannot claim hardware it was not measured on.
 */
const hostInfo = `${os.cpus()[0]?.model.trim() ?? 'unknown CPU'}, ${os.totalmem() / 1024 ** 3 >= 1 ? `${Math.round(os.totalmem() / 1024 ** 3)} GB` : 'unknown memory'}, ${os.platform()} ${os.release()}, node ${process.version}`;

interface Cadence {
  frames: number;
  /** Intervals between consecutive animation frames, in ms. */
  intervals: number[];
  elapsedMs: number;
  longTasks: { name: string; duration: number }[];
  /** How many times the overlay itself did work during the window. */
  overlayTicks: number;
  /**
   * The core's own high-water mark for one tick, in ms. Cumulative across the page's life, so this
   * is a maximum ever seen rather than a maximum for this window — which makes it the stricter of
   * the two readings, and the reason it is worth quoting.
   */
  longestTickMs: number;
}

let source: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL('../../../packages/extension/tests/primitives-driver.ts', import.meta.url)
      ),
    ],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  });
  source = result.outputFiles[0]!.text;
});

async function openGallery(page: Page): Promise<void> {
  await page.goto('/overlay');
  await page.route('**/primitives-driver.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: source })
  );
  await page.addScriptTag({ url: '/primitives-driver.js' });
  await expect(page.locator('html')).toHaveAttribute('data-primitives-ready', 'true');
}

/**
 * Samples three things over `ms`: the overlay's own work, any long task the main thread reports,
 * and animation-frame cadence.
 *
 * The three are not equally trustworthy and the benchmark does not pretend otherwise. Long tasks
 * are the PRD's hard bound ("> 50 ms") and the one display-independent measurement here. The
 * overlay's tick count and per-tick cost come from the core's own instrumentation, so they measure
 * the overlay rather than this probe. The rAF cadence is a *control* and a caveat: a benchmark
 * that spins its own requestAnimationFrame loop pins the page at the display cadence, so those
 * frame counts would read the same whether or not an overlay existed. They are kept because a p95
 * or max that drifts would show the overlay introducing jank, and because a control that is never
 * compared to anything is not a control.
 *
 * The observer is installed first and disconnected last, so a long task caused by the overlay's
 * own teardown would still be caught.
 */
async function measure(page: Page, ms: number): Promise<Cadence> {
  return page.evaluate(async (duration) => {
    const longTasks: { name: string; duration: number }[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ name: entry.name, duration: entry.duration });
      }
    });
    try {
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      // A longtask observer is unavailable: the report says so rather than reporting zero tasks.
      longTasks.push({ name: 'longtask-unsupported', duration: Number.NaN });
    }

    const intervals: number[] = [];
    let last: number | null = null;
    let running = true;
    const tick = (timestamp: number) => {
      if (last !== null) intervals.push(timestamp - last);
      last = timestamp;
      if (running) requestAnimationFrame(tick);
    };
    // The overlay's own accounting is the real subject here; the rAF loop above is only a control.
    const before = window.__primitivesTest.metrics();
    const started = performance.now();
    requestAnimationFrame(tick);
    await new Promise((done) => setTimeout(done, duration));
    running = false;
    observer.disconnect();
    const after = window.__primitivesTest.metrics();
    return {
      frames: intervals.length + 1,
      intervals,
      elapsedMs: performance.now() - started,
      longTasks,
      overlayTicks: after.frames - before.frames,
      longestTickMs: after.longestFrameMs,
    };
  }, ms);
}

function summarise(label: string, cadence: Cadence): Record<string, number | string> {
  const sorted = [...cadence.intervals].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1);
  // The modal interval is the cadence the page actually ran at; a p50 that is nowhere near it
  // means the page spent most of its time somewhere else.
  const counts = new Map<number, number>();
  for (const value of sorted) {
    const bucket = Math.round(value * 10) / 10;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  return {
    label,
    frames: cadence.frames,
    /** Times the overlay itself did work in this window. The idle-cost number. */
    overlayTicks: cadence.overlayTicks,
    /** Core's high-water mark for a single tick. The per-frame cost number. */
    longestTickMs: Math.round(cadence.longestTickMs * 100) / 100,
    elapsedMs: Math.round(cadence.elapsedMs),
    intervalP50: Math.round(at(0.5) * 100) / 100,
    intervalP95: Math.round(at(0.95) * 100) / 100,
    intervalMax: Math.round((sorted[sorted.length - 1] ?? 0) * 100) / 100,
    intervalMean: Math.round(mean * 100) / 100,
    /** The cadence the page actually ran at, which is what "60 fps" or "janky" would refer to. */
    modalInterval: modal,
    fpsFromModal: modal > 0 ? Math.round((1000 / modal) * 10) / 10 : 0,
    longTasks: cadence.longTasks.filter((t) => !Number.isNaN(t.duration)).length,
    longestTaskMs:
      Math.round(
        Math.max(
          0,
          ...cadence.longTasks.filter((t) => !Number.isNaN(t.duration)).map((t) => t.duration)
        ) * 100
      ) / 100,
  };
}

test('measures frame cost across a full layer, and writes the report', async ({
  page,
  browserName,
}, testInfo) => {
  await openGallery(page);
  const rows: Record<string, number | string | boolean>[] = [];

  // ---- the true baseline, before any layer exists.
  //
  // A page with no overlay at all: the core has nothing to tick, so the tick count must be exactly
  // zero and the modal interval is the engine's own cadence. This row is the control every later
  // number is read against, and the tick assertion is the strongest form of "~0% idle CPU" the
  // benchmark can make — the common case for a user is not a busy overlay but none.
  const baseline = summarise('baseline (no overlay mounted)', await measure(page, 3000));
  rows.push(baseline);
  expect(baseline.overlayTicks, 'with no overlay the core must not tick at all').toBe(0);

  // ---- cold mount, measured on a fresh layer and separately from every steady-state window.
  //
  // The first tick of a layer is a genuinely different cost from every tick after it: it builds
  // 64 elements, measures 64 targets and forces a layout nobody has cached yet. Left inside a
  // steady-state window, that cost does not simply fail the run — it leaks into whichever window
  // happens to be open when it lands, which is a flaky benchmark rather than a real budget. So it
  // is measured here, where it is honest and repeatable, and the long-task bound is asserted
  // against it too: a cold mount that blew 50 ms would block the page's main thread, which the PRD
  // forbids however briefly it lasted.
  // `saturate()` rather than `scenario('saturated')`: the scenario helper also waits out four
  // settle frames, and timing that would be timing `requestAnimationFrame` — about 67 ms of
  // waiting at 60 Hz — and filing it as mount cost. `saturate()` is the synchronous work alone.
  const coldMount = await page.evaluate(async () => {
    const started = performance.now();
    await window.__primitivesTest.saturate();
    const created = performance.now();
    // The core's own high-water mark, sampled after the first tick has run, is the honest reading
    // of what the first frame cost: waiting a rAF here would measure the wait, not the work.
    const ticksBefore = window.__primitivesTest.metrics().frames;
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done(null)))
    );
    return {
      createMs: created - started,
      firstTickMs: window.__primitivesTest.metrics().longestFrameMs,
      ticked: window.__primitivesTest.metrics().frames > ticksBefore,
    };
  });
  expect(coldMount.ticked, 'a freshly mounted layer must have ticked by the second frame').toBe(
    true
  );
  expect(coldMount.createMs, 'synchronous cost of creating 64 annotations').toBeLessThan(50);
  expect(
    coldMount.firstTickMs,
    "the core's cost for its first tick of a 64-annotation layer"
  ).toBeLessThan(50);
  rows.push({
    label: '64 annotations, cold mount (create + first tick)',
    overlayTicks: 1,
    longestTickMs: Math.round(coldMount.firstTickMs * 100) / 100,
    observed: false,
    frames: 0,
    modalInterval: 0,
    intervalP95: 0,
    longTasks: 0,
  });

  // Warm the full layer. By now the page has JIT-compiled the render path, so every row from here
  // on measures a running layer rather than the cost of starting one.
  await page.evaluate(() => window.__primitivesTest.settle(24));
  const saturated = summarise('64 annotations, settled', await measure(page, 3000));
  rows.push(saturated);

  // One annotation of each kind, live and settled.
  await page.evaluate(() => window.__primitivesTest.scenario('all'));
  await page.evaluate(() => window.__primitivesTest.settle(24));
  const settledSeven = summarise('7 annotations, settled', await measure(page, 3000));
  rows.push(settledSeven);

  // ---- motion, timed with the motion actually running.
  //
  // Back to the full layer first: `scenario` clears the previous one, so the 7-annotation row
  // above left a 7-annotation layer, and "64 annotations, page scrolling" would otherwise have
  // measured a 7-annotation layer under a 64-annotation label.
  const full = await page.evaluate(() => window.__primitivesTest.scenario('saturated'));
  expect(full.annotationIds, 'the motion rows must run against a full layer').toHaveLength(64);
  await page.evaluate(() => window.__primitivesTest.settle(24));

  // A page scroll re-measures and rewrites every annotation on every frame, which is the real
  // worst case for an overlay rather than a static one.
  //
  // Note the missing `await` on the loop, and the one on `measure` below it. Motion has to be
  // happening *while* the window is open: awaiting the scroll first would time a page that had
  // already stopped moving and file the result under "scrolling", which is how a benchmark ends up
  // asserting something it never measured.
  const scroll = page.evaluate(async () => {
    for (let step = 0; step < 180; step++) {
      window.scrollTo(0, (step * 40) % 1600);
      await new Promise((frame) => requestAnimationFrame(() => frame(null)));
    }
  });
  rows.push(summarise('64 annotations, page scrolling', await measure(page, 3000)));
  await scroll;

  // Oscillating every one of the 64 targets is the only configuration where a glide can be in
  // flight on every frame — and the one that a perpetual rAF loop would look like if the glide's
  // unsubscribe were missing.
  const churn = page.evaluate(() => window.__primitivesTest.churnAll(180));
  rows.push(summarise('64 annotations, targets moving', await measure(page, 3000)));
  await churn;

  // The same layer again, once the motion is over. This row is the one that would catch a glide
  // that never unsubscribed: it must fall back to the settled cadence.
  await page.evaluate(() => window.__primitivesTest.settle(24));
  rows.push(summarise('64 annotations, re-settled after motion', await measure(page, 3000)));

  // ---- the assertions. These are the budget; the numbers above are the evidence for them.
  const byLabel = new Map(rows.map((row) => [String(row.label), row]));
  const saturatedRow = byLabel.get('64 annotations, settled')!;
  const movingRow = byLabel.get('64 annotations, targets moving')!;
  const resettledRow = byLabel.get('64 annotations, re-settled after motion')!;

  // The PRD's hard bound, and the only display-independent one here. Only the rows that actually
  // ran with a PerformanceObserver installed are checked: the cold-mount row is timed directly
  // rather than sampled over a window, and asserting on a field it never observed would be
  // asserting that a number nobody measured is small.
  for (const row of rows) {
    if (row.observed !== true) continue;
    expect(Number(row.longestTaskMs), `long task in "${row.label}"`).toBeLessThan(50);
    expect(Number(row.longTasks), `long tasks in "${row.label}"`).toBe(0);
  }

  // The core's own per-tick cost, for a full layer. Well under a frame: a tick that ran to
  // anywhere near 16 ms would be spending the display's entire budget on decorations.
  expect(Number(saturatedRow.longestTickMs)).toBeLessThan(8);
  expect(Number(movingRow.longestTickMs)).toBeLessThan(8);

  // "~0% idle CPU" as a measurable claim. A settled layer must fall back to the core's 400 ms
  // heartbeat and nothing more, so 3 s buys at most ~8 ticks. A layer that re-measured on every
  // frame would post ~180 here, and that ratio is the whole point of the benchmark.
  const settledTicks = Number(saturatedRow.overlayTicks);
  const movingTicks = Number(movingRow.overlayTicks);
  expect(settledTicks, `settled ticks: ${JSON.stringify(saturatedRow)}`).toBeLessThan(15);
  expect(resettledRow.overlayTicks, 'layer must go quiet again after motion').toBeLessThan(15);

  // Guard the guards: if the motion phases did not actually move anything, the idle assertion above
  // would be passing for the wrong reason. A moving layer must tick far more often than a settled
  // one, or the comparison is not testing what it claims to test.
  expect(movingTicks, `moving ${movingTicks} vs settled ${settledTicks}`).toBeGreaterThan(
    settledTicks * 3
  );
  expect(Number(settledSeven.overlayTicks)).toBeLessThan(15);

  // The modal interval is the control: if the overlay had perturbed the page's frame budget, the
  // settled rows would no longer match the baseline.
  expect(
    Math.abs(Number(saturatedRow.modalInterval) - Number(baseline.modalInterval))
  ).toBeLessThan(4);
  expect(Math.abs(Number(movingRow.modalInterval) - Number(baseline.modalInterval))).toBeLessThan(
    4
  );

  // ---- the report
  const report = [
    `# F-03 overlay primitives — frame timing (${browserName}, headless)`,
    '',
    `Generated ${new Date().toISOString()} by \`bench/mock-sites/tests/overlay-timing.spec.ts\`.`,
    '',
    '## Numbers',
    '',
    '| configuration | overlay ticks / 3 s | longest tick | frames | modal interval | p95 | long tasks |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${row.label} | ${row.overlayTicks} | ${row.longestTickMs} ms | ${row.frames} | ${row.modalInterval} ms | ${row.intervalP95} ms | ${row.longTasks} |`
    ),
    '',
    '## How to read this',
    '',
    "- **overlay ticks / 3 s** is the number that matters, and it comes from the core's own",
    '  instrumentation rather than from this harness. A layer in motion ticks on nearly every',
    '  frame; a settled layer falls back to the 400 ms heartbeat, so 3 s buys roughly 8. The gap',
    '  between those two rows is what "~0% idle CPU" means here — and the re-settled row is the',
    '  one that would catch a glide which never unsubscribed.',
    "- **longest tick** is the core's high-water mark for a single tick of work, and is cumulative",
    "  over the page's life, so it is the strictest reading available. The budget asserted is",
    '  < 8 ms: a tick approaching one frame at 60 Hz would be spending the whole display budget on',
    '  decorations.',
    "- **long tasks** is the PRD's hard bound (> 50 ms is a failure).",
    '- **frames / modal interval / p95** are a *control*, not a result. This harness runs its own',
    '  requestAnimationFrame loop to sample cadence, and that loop pins the page to the display',
    '  cadence whether or not an overlay exists — so the frame counts would read the same either',
    '  way. They are reported because a p95 that drifts from the modal value would show the',
    '  overlay introducing jank, and because a control that is never compared to the baseline row',
    '  is not a control.',
    '',
    '## Hardware and fixture',
    '',
    'The issue asks for the measurement to name its hardware and fixture complexity, because a',
    'timing number without them is not reproducible.',
    '',
    '| | |',
    '| --- | --- |',
    '| Machine | recorded below, at run time |',
    '| Engines | Playwright Chromium and Firefox, both headless |',
    '| Viewport | 1280x720, device scale factor 1 |',
    '| Page | B-08 `bench/mock-sites/overlay.html`, local and deterministic, no network |',
    '| Page under test | the gallery plus a synthetic 64-cell viewport-fixed grid |',
    "| Layer size | 64 annotations, the core's cap, cycling all seven primitive kinds |",
    '| Motion cases | page scroll, and all 64 targets oscillating every frame |',
    '',
    `Recorded on this run: ${hostInfo}.`,
    '',
    '## Limitation',
    '',
    'Both Playwright projects run headless, and a headless browser has no display and therefore no',
    'vsync, so the absolute cadence figures are the headless cadence and are not a claim about a',
    'real 60 Hz display. No claim is made here about on-device frame rate.',
    '',
    'The figures that do not depend on a display are the tick count, the per-tick cost and the',
    'long-task bound, and those are asserted rather than merely reported. Timing is also taken on a',
    "developer machine rather than the PRD's reference device, so the per-tick cost should be read",
    'as an upper bound.',
    '',
  ].join('\n');

  const dir = toPath(new URL('./reports/', import.meta.url));
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}overlay-frame-timing-${browserName}.md`, report, 'utf8');
  await testInfo.attach(`overlay-frame-timing-${browserName}.md`, {
    body: report,
    contentType: 'text/markdown',
  });

  // Printed as well as written, so the numbers are visible in CI output rather than only in a file.
  console.log(`\n${report}`);
});
