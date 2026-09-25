import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { canaries, products, profile, scenarios } from '../src/fixtures.js';
import type * as Walker from '../../../packages/extension/src/content/dom-extract/index.js';

declare global {
  interface Window {
    b08Walker: typeof Walker;
  }
}

let walkerSource: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL('../../../packages/extension/src/content/dom-extract/index.ts', import.meta.url)
      ),
    ],
    bundle: true,
    format: 'iife',
    globalName: 'b08Walker',
    platform: 'browser',
    write: false,
  });
  walkerSource = result.outputFiles[0]!.text;
});

test.beforeEach(async ({ page, baseURL }) => {
  // Fail any external request: fixtures remain usable without outside services.
  await page.route('**/*', async (route) => {
    expect(new URL(route.request().url()).origin).toBe(baseURL);
    expect(route.request().method()).toBe('GET');
    await route.continue();
  });
  page.on('pageerror', (error) => {
    throw error;
  });
});

async function expectInitialProfile(page: Page): Promise<void> {
  for (const canary of canaries) {
    await expect(page.locator(canary.input)).toHaveValue(canary.value);
    await expect(page.locator(canary.saved)).toHaveText(canary.value);
  }
  await expect(page.getByRole('status')).toHaveText(scenarios.profile.initialStatus);
  await expect(page.locator('#profile-error')).toBeEmpty();
}

async function resultIds(page: Page): Promise<string[]> {
  return page
    .locator('#results li')
    .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.productId!));
}

test('index links to all three functional fixtures', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('A shared place to test.');
  for (const scenario of Object.values(scenarios)) {
    await page.locator(`.scenario-card[href="${scenario.path}"]`).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(scenario.heading);
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
  }
});

test('profile saves a valid edit, keeps drafts separate, and resets repeatedly', async ({
  page,
}) => {
  await page.goto('/profile');
  await expectInitialProfile(page);
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.getByLabel('Full name', { exact: true }).fill('Morgan Example');
    await page.getByLabel('Email', { exact: true }).fill('morgan.canary@example.test');
    await page.getByLabel('Phone', { exact: true }).fill('+12025550199');
    await expect(page.getByRole('status')).toHaveText('Unsaved changes.');
    await expect(page.locator('#saved-email')).toHaveText(profile.email);
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('status')).toHaveText('Profile saved.');
    await expect(page.locator('#saved-name')).toHaveText('Morgan Example');
    await expect(page.locator('#saved-email')).toHaveText('morgan.canary@example.test');
    await expect(page.locator('#saved-phone')).toHaveText('+12025550199');
    await page.getByRole('button', { name: 'Reset profile' }).click();
    await expectInitialProfile(page);
  }
});

test('invalid profile inputs never change the saved snapshot', async ({ page }) => {
  await page.goto('/profile');
  for (const [label, badValue] of [
    ['Full name', '   '],
    ['Email', 'invalid-email'],
    ['Phone', '123'],
  ]) {
    await page.getByLabel(label!, { exact: true }).fill(badValue!);
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('alert')).toContainText('Nothing was saved.');
    for (const canary of canaries)
      await expect(page.locator(canary.saved)).toHaveText(canary.value);
    await page.getByRole('button', { name: 'Reset profile' }).click();
    await expectInitialProfile(page);
  }
});

test('profile supports keyboard submission and renders entered text literally', async ({
  page,
}) => {
  await page.goto('/profile');
  const literal = '<img src=x onerror="throw 1">';
  await page.getByLabel('Full name', { exact: true }).fill(literal);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Profile saved.');
  await expect(page.locator('#saved-name')).toHaveText(literal);
  await expect(page.locator('#saved-name img')).toHaveCount(0);
});

test('settings apply controls, disable dependent digest, and reset all state', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByLabel('Enable notifications')).toBeChecked();
  await expect(page.getByLabel('Digest frequency')).toHaveValue('daily');
  await page.getByLabel('Digest frequency').selectOption('weekly');
  await page.getByLabel('Compact', { exact: true }).check();
  await page.getByLabel('Time zone', { exact: true }).selectOption('UTC');
  await expect(page.locator('#saved-density')).toHaveText('comfortable');
  await page.getByRole('button', { name: 'Apply settings' }).click();
  await expect(page.locator('#saved-digest')).toHaveText('weekly');
  await expect(page.locator('#saved-density')).toHaveText('compact');
  await expect(page.locator('#saved-timezone')).toHaveText('UTC');
  await page.getByLabel('Enable notifications').uncheck();
  await expect(page.getByLabel('Digest frequency')).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('Unapplied changes.');
  await expect(page.locator('#saved-notifications')).toHaveText('On');
  await page.getByRole('button', { name: 'Apply settings' }).click();
  await expect(page.locator('#saved-notifications')).toHaveText('Off');
  await expect(page.locator('#saved-digest')).toHaveText('Off');
  await page.getByLabel('Enable notifications').check();
  await expect(page.getByLabel('Digest frequency')).toBeEnabled();
  await expect(page.getByLabel('Digest frequency')).toHaveValue('weekly');
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.getByRole('button', { name: 'Reset settings' }).click();
    await expect(page.getByLabel('Enable notifications')).toBeChecked();
    await expect(page.getByLabel('Comfortable', { exact: true })).toBeChecked();
    await expect(page.getByLabel('Digest frequency')).toHaveValue('daily');
    await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('Asia/Kolkata');
    await expect(page.locator('#saved-digest')).toHaveText('daily');
    await expect(page.locator('#saved-density')).toHaveText('comfortable');
    await expect(page.locator('#saved-timezone')).toHaveText('Asia/Kolkata');
    await expect(page.getByRole('status')).toHaveText(scenarios.settings.initialStatus);
  }
});

test('catalog combines case-insensitive search, filters, empty state, and reset', async ({
  page,
}) => {
  await page.goto('/search');
  expect(await resultIds(page)).toEqual(scenarios.search.initialResultIds);
  await expect(page.getByRole('status')).toHaveText('6 results');
  await page.getByLabel('Search products').fill('  cEdAr  ');
  expect(await resultIds(page)).toEqual(['p01', 'p03', 'p06']);
  await page.getByLabel('Category', { exact: true }).selectOption('travel');
  expect(await resultIds(page)).toEqual(['p06']);
  await expect(page.getByRole('status')).toHaveText('1 result');
  await page.getByLabel('Available only').check();
  await expect(page.getByRole('status')).toHaveText('0 results');
  await expect(page.locator('#empty-results')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Available only').check();
  expect(await resultIds(page)).toEqual(['p01', 'p03', 'p05']);
  await page.getByLabel('Search products').fill('<script>throw 1</script>');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('0 results');
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByLabel('Search products')).toBeEmpty();
    await expect(page.getByLabel('Category', { exact: true })).toHaveValue('all');
    await expect(page.getByLabel('Available only')).not.toBeChecked();
    expect(await resultIds(page)).toEqual(products.map((product) => product.id));
    await expect(page.locator('#empty-results')).toBeHidden();
  }
});

test('reload and fresh contexts restore defaults without browser storage', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto('/profile');
  await page.getByLabel('Email', { exact: true }).fill('changed@example.test');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.reload();
  await expectInitialProfile(page);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  const context = await browser.newContext(baseURL ? { baseURL } : {});
  try {
    const other = await context.newPage();
    await other.goto('/profile');
    await expectInitialProfile(other);
  } finally {
    await context.close();
  }
});

for (const [id, scenario] of Object.entries(scenarios)) {
  test(`B-02 walks real ${id} controls and context`, async ({ page }) => {
    await page.goto(scenario.path);
    // addScriptTag inline is rejected by the site's CSP. Serve the test bundle
    // as a same-origin script via Playwright's test-only route instead.
    await page.route('**/walker-test.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: walkerSource })
    );
    await page.addScriptTag({ url: '/walker-test.js' });
    const result = await page.evaluate(async () => {
      const result = await window.b08Walker.walkDocument(document);
      if (result.status !== 'complete') throw new Error(result.status);
      return {
        controls: result.candidates.map((candidate) => candidate.node.id),
        text: result.evidence.textNodes.map(({ node }) => node.data).join(' '),
        attributes: result.evidence.attributeElements.map(({ node }) => node.id),
      };
    });
    expect(result.controls).toEqual(expect.arrayContaining([...scenario.controls]));
    expect(result.text).toContain(scenario.heading);
    if (id === 'profile') {
      for (const canary of canaries) {
        expect(result.text).toContain(canary.value);
        expect(result.attributes).toContain(canary.input.slice(1));
      }
    }
  });

  test(`${id} remains usable at narrow widths`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(scenario.path);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    for (const control of scenario.controls)
      await expect(page.locator(`#${control}`)).toBeVisible();
  });
}

test('server exposes only fixture routes and rejects writes', async ({ request }) => {
  expect((await request.get('/health')).status()).toBe(200);
  expect((await request.get('/package.json')).status()).toBe(404);
  expect((await request.get('/src/fixtures.ts')).status()).toBe(404);
  expect((await request.post('/profile', { data: 'synthetic' })).status()).toBe(405);
});
