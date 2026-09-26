import { test, expect, chromium, firefox } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { build } from 'esbuild';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection, createServer } from 'node:net';

// Firefox's temporary-addon RDP endpoint lets us exercise the actual isolated
// extension world in Playwright's Firefox, not a page-world imitation.
async function installFirefoxAddon(port: number, path: string): Promise<() => void> {
  const socket = createConnection(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let buffer = Buffer.alloc(0);
  let receive: ((value: Record<string, unknown>) => void) | undefined;
  const pending: Record<string, unknown>[] = [];
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    for (;;) {
      const colon = buffer.indexOf(':');
      if (colon < 0) break;
      const size = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + size) break;
      const value = JSON.parse(buffer.subarray(colon + 1, colon + 1 + size).toString()) as Record<
        string,
        unknown
      >;
      buffer = buffer.subarray(colon + 1 + size);
      if (receive) {
        const callback = receive;
        receive = undefined;
        callback(value);
      } else pending.push(value);
    }
  });
  const next = () =>
    pending.length
      ? Promise.resolve(pending.shift()!)
      : new Promise<Record<string, unknown>>((resolve, reject) => {
          const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error('Firefox RDP response timeout'));
          }, 5_000);
          receive = (value) => {
            clearTimeout(timeout);
            resolve(value);
          };
        });
  const request = async (payload: Record<string, unknown>) => {
    const body = JSON.stringify(payload);
    socket.write(`${Buffer.byteLength(body)}:${body}`);
    const reply = await next();
    if (reply.error) throw new Error(`Firefox test add-on installation: ${String(reply.error)}`);
    return reply;
  };
  await next(); // Server greeting.
  const root = await request({ to: 'root', type: 'getRoot' });
  await request({ to: root.addonsActor, type: 'installTemporaryAddon', addonPath: path });
  return () => socket.destroy();
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

interface Snapshot {
  item: { status: string; doc_id: string; id: string };
  previousStatus: string | null;
  changes: number;
  disposed: boolean;
  persisted: boolean;
  targetCount?: number;
}
async function snapshot(page: Page, command = 'sample'): Promise<Snapshot> {
  await expect(page.locator('html')).toHaveAttribute('data-b05-ready', 'true');
  await page.evaluate((command) => {
    document.documentElement.removeAttribute('data-b05-result');
    document.documentElement.setAttribute('data-b05-command', command);
    document.dispatchEvent(new Event('b05:test:request'));
  }, command);
  await expect(page.locator('html')).toHaveAttribute('data-b05-result', /./);
  const result = JSON.parse(
    (await page.locator('html').getAttribute('data-b05-result'))!
  ) as Snapshot;
  expect(result.item?.status).toBe('ok');
  return result;
}

test('installed extension: page-world routing, isolated IDs, full navigation and reinjection', async ({
  baseURL,
}, testInfo) => {
  test.setTimeout(60_000);
  const target = testInfo.project.name === 'chromium' ? 'chrome' : 'firefox';
  const directory = await mkdtemp(join(tmpdir(), 'b05-extension-'));
  const extension = join(directory, 'extension');
  let context: BrowserContext | undefined;
  let disconnect: (() => void) | undefined;
  try {
    await cp(resolve(`packages/extension/dist/${target}`), extension, { recursive: true });
    const manifestPath = join(extension, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      host_permissions: string[];
      content_scripts: unknown[];
      background: { service_worker?: string; scripts?: string[] };
    };
    // Test fixture only: explicit localhost grant/static driver, no production permission broadening.
    manifest.host_permissions = ['http://127.0.0.1/*'];
    manifest.content_scripts = [{ matches: ['http://127.0.0.1/*'], js: ['test-driver.js'] }];
    if (manifest.background.service_worker) {
      await writeFile(
        join(extension, 'test-background-wrapper.js'),
        `import './${manifest.background.service_worker}';\nimport './test-background.js';\n`
      );
      manifest.background.service_worker = 'test-background-wrapper.js';
    } else manifest.background.scripts!.push('test-background.js');
    await writeFile(manifestPath, JSON.stringify(manifest));
    for (const [input, output] of [
      ['registry-driver.ts', 'test-driver.js'],
      ['registry-background-driver.ts', 'test-background.js'],
    ]) {
      await build({
        entryPoints: [resolve(`packages/extension/tests/${input}`)],
        outfile: join(extension, output!),
        bundle: true,
        format: 'iife',
        platform: 'browser',
      });
    }
    if (target === 'chrome') {
      context = await chromium.launchPersistentContext(join(directory, 'profile'), {
        channel: 'chromium',
        headless: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
        ignoreDefaultArgs: ['--disable-back-forward-cache'],
      });
    } else {
      const port = await unusedPort();
      context = await firefox.launchPersistentContext(join(directory, 'profile'), {
        headless: true,
        args: ['--start-debugger-server', String(port)],
        firefoxUserPrefs: {
          'devtools.debugger.remote-enabled': true,
          'devtools.debugger.prompt-connection': false,
          'devtools.chrome.enabled': true,
        },
      });
      disconnect = await installFirefoxAddon(port, extension);
    }
    const page = await context.newPage();
    await page.goto(`${baseURL}/profile`);
    const initial = await snapshot(page, 'walk');
    expect(initial.targetCount).toBeGreaterThan(0);
    expect((await snapshot(page)).item).toEqual(initial.item);
    // The page cannot see the isolated-world owner (and no element IDs are stamped on nodes).
    expect(await page.evaluate(() => '__privacAgentSession' in globalThis)).toBe(false);
    await page.evaluate(() => history.pushState({}, '', '/profile?route=1'));
    await expect.poll(async () => (await snapshot(page)).item.doc_id).not.toBe(initial.item.doc_id);
    const pushed = await snapshot(page);
    await page.evaluate(() => history.replaceState({}, '', '/profile?route=2'));
    await expect.poll(async () => (await snapshot(page)).item.doc_id).not.toBe(pushed.item.doc_id);
    const replaced = await snapshot(page);
    await page.evaluate(() => history.replaceState({ sameUrl: true }, '', location.href));
    await expect
      .poll(async () => (await snapshot(page)).item.doc_id)
      .not.toBe(replaced.item.doc_id);
    const sameUrl = await snapshot(page);
    await page.evaluate(() => {
      location.hash = 'anchor';
    });
    await expect.poll(async () => (await snapshot(page)).item.doc_id).not.toBe(sameUrl.item.doc_id);
    const hashed = await snapshot(page);
    await page.goBack();
    await expect.poll(async () => (await snapshot(page)).item.doc_id).not.toBe(hashed.item.doc_id);
    const backed = await snapshot(page);
    await page.goForward();
    await expect.poll(async () => (await snapshot(page)).item.doc_id).not.toBe(backed.item.doc_id);
    const beforeReinject = await snapshot(page);
    const reinjected = await snapshot(page, 'reinject');
    expect(reinjected.disposed).toBe(true);
    expect(reinjected.item.doc_id).not.toBe(beforeReinject.item.doc_id);
    await page.goto(`${baseURL}/settings`);
    const navigated = await snapshot(page);
    expect(navigated.item.doc_id).not.toBe(reinjected.item.doc_id);
    await page.goBack();
    const restored = await snapshot(page);
    expect(restored.item.doc_id).not.toBe(reinjected.item.doc_id);
    const cacheReport = testInfo.outputPath('bfcache.json');
    await writeFile(cacheReport, JSON.stringify({ persisted: restored.persisted }));
    await testInfo.attach('bfcache-coverage', {
      path: cacheReport,
      contentType: 'application/json',
    });
    // Hide only the isolated world's Navigation API to exercise the browser
    // notification fallback while the real page router continues in MAIN.
    const fallback = await snapshot(page, 'fallback');
    await page.evaluate(() => history.replaceState({ fallback: true }, '', location.href));
    await expect
      .poll(async () => (await snapshot(page)).item.doc_id)
      .not.toBe(fallback.item.doc_id);
    const fallbackState = await snapshot(page);
    await page.evaluate(() => history.pushState({}, '', '/profile?fallback=1'));
    await expect
      .poll(async () => (await snapshot(page)).item.doc_id)
      .not.toBe(fallbackState.item.doc_id);
  } finally {
    disconnect?.();
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
