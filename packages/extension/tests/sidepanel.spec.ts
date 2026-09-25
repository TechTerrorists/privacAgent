import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testsDir, '../../..');
const extensionDir = resolve(testsDir, '../dist/chrome');
const sidePanelUrl = (extensionId: string): string =>
  `chrome-extension://${extensionId}/src/ui/sidepanel.html`;

interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
}

/**
 * The kit ships Tailwind *source*, so the extension's own build has to compile it. If the
 * Tailwind plugin is ever dropped from the Vite config, the panel still renders every element
 * and passes the behavioural tests below while shipping no styling at all, so these reads
 * assert computed styles rather than class names.
 */
const readComputed = (page: Page, selector: string, property: string): Promise<string> =>
  page.evaluate(
    ([sel, prop]) => {
      const el = document.querySelector(sel as string);
      if (!el) throw new Error(`no element matches ${sel as string}`);
      return getComputedStyle(el).getPropertyValue(prop as string);
    },
    [selector, property] as const
  );

const readStorage = async (key: string): Promise<unknown> => {
  const area = (globalThis as { chrome?: { storage?: { local?: StorageAreaLike } } }).chrome
    ?.storage?.local;
  if (!area) throw new Error('chrome.storage.local is unavailable in this context');
  return (await area.get(key))[key];
};

let context: BrowserContext;
let page: Page;
let extensionId: string;
let userDataDir: string;
const externalRequests: string[] = [];
const pageErrors: string[] = [];

// Only the Chromium host can load an unpacked extension, so the Firefox project skips this
// file. The Firefox sidebar is covered by web-ext lint and docs/development.md.
test.describe('A-10 side panel', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'requires the Chromium extension host'
  );

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    if (!existsSync(resolve(extensionDir, 'manifest.json'))) {
      execFileSync('pnpm', ['build:chrome'], { cwd: repoRoot, stdio: 'inherit' });
    }

    userDataDir = await mkdtemp(join(tmpdir(), 'privacagent-sidepanel-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });

    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(worker.url()).host;

    page = await context.newPage();
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(`chrome-extension://${extensionId}/`) && !url.startsWith('about:')) {
        externalRequests.push(url);
      }
    });
    page.on('pageerror', (error) => pageErrors.push(String(error)));
  });

  test.afterAll(async () => {
    await context?.close();
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  });

  test.beforeEach(async () => {
    externalRequests.length = 0;
    pageErrors.length = 0;
    await page.goto(sidePanelUrl(extensionId));
    await page.waitForSelector('[data-testid="task-input"]');
  });

  test('renders the shell, build target and demo notice', async () => {
    await expect(page.locator('.pa-build-target')).toHaveText('Build target: chrome');
    await expect(page.getByTestId('demo-banner')).toContainText('no network calls');
    await expect(page.getByTestId('start-task')).toBeEnabled();
    await expect(page.getByTestId('stop-task')).toBeDisabled();
  });

  test('compiles the kit stylesheet and repaints when the theme changes', async () => {
    // An uncompiled sheet leaves utilities inert: the input would be transparent with square
    // corners and the token variables would be empty strings.
    const inputBackground = await readComputed(
      page,
      '[data-testid="task-input"]',
      'background-color'
    );
    const inputRadius = await readComputed(page, '[data-testid="task-input"]', 'border-radius');
    expect(inputBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(Number.parseFloat(inputRadius)).toBeGreaterThan(0);
    expect(await readComputed(page, '#root', '--pa-accent')).toMatch(/^oklch|^#/);

    // The header is token-driven and present on both routes, so it proves a theme swap
    // repaints through the token variables without depending on which view is mounted.
    await page.getByTestId('open-settings').click();
    await page.locator('[data-testid="theme-select"] label', { hasText: 'Light' }).click();
    const light = await readComputed(page, 'header', 'background-color');

    await page.locator('[data-testid="theme-select"] label', { hasText: 'Dark' }).click();
    await expect(page.locator('#root')).toHaveAttribute('data-pa-theme', 'dark');
    const dark = await readComputed(page, 'header', 'background-color');

    expect(dark).not.toBe(light);
  });

  test('runs a task, shows the action trace and stops it', async () => {
    const input = page.getByTestId('task-input');
    await input.fill('Show the status of my latest order');
    await page.getByTestId('start-task').click();

    await expect(page.getByTestId('status')).toHaveText('Task running');
    await expect(page.getByTestId('current-task')).toHaveText(
      'Current task: Show the status of my latest order'
    );
    await expect(page.getByTestId('action-list').locator('li').first()).toBeVisible();
    await expect(input).toBeDisabled();
    await expect(page.getByTestId('stop-task')).toBeEnabled();

    await page.getByTestId('stop-task').click();

    await expect(page.getByTestId('status')).toHaveText('Task stopped');
    await expect(input).toBeEnabled();
    await expect(page.getByTestId('start-task')).toBeEnabled();
    await expect(
      page.getByTestId('action-list').locator('li[data-status="stopped"]')
    ).not.toHaveCount(0);
    await expect(page.getByTestId('action-list').locator('li[data-status="running"]')).toHaveCount(
      0
    );
  });

  test('keeps the typed draft across a state update', async () => {
    const input = page.getByTestId('task-input');
    await input.fill('draft that must survive');
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('theme-select')).toBeVisible();
    await page.getByTestId('back-home').click();
    await expect(input).toHaveValue('draft that must survive');
  });

  test('routes to settings, persists the theme and hydrates it on reopen', async () => {
    await page.getByTestId('open-settings').click();
    await expect(page).toHaveURL(/#settings$/);
    await page.locator('[data-testid="theme-select"] label', { hasText: 'Light' }).click();

    await expect(page.locator('#root')).toHaveAttribute('data-pa-theme', 'light');
    await expect(page.getByTestId('theme-status')).toHaveText(
      'Theme saved locally in this browser.'
    );
    expect(await page.evaluate(readStorage, 'theme')).toBe('light');

    await page.reload();
    await expect(page.locator('[data-testid="theme-select"] input[value="light"]')).toBeChecked();
    await expect(page).toHaveURL(/#settings$/);

    await page.getByTestId('back-home').click();
    await expect(page.locator('#root')).toHaveAttribute('data-pa-theme', 'light');
  });

  test('makes no external requests and raises no page errors', async () => {
    await page.getByTestId('task-input').fill('check egress');
    await page.getByTestId('start-task').click();
    await expect(page.getByTestId('action-list')).toBeVisible();
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('theme-select')).toBeVisible();

    expect(externalRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
