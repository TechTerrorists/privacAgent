import { test, expect, chromium, firefox, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));

// Test-only extension, including bootstrap/tab identity discovery. Production host
// lifecycle belongs to A-04. No API mocks: both browsers use their real runtime.
test('extension runtime, frames and host/worker relay round trips', async ({ browserName }) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'pa-message-extension-'));
  let context: BrowserContext | undefined;
  let process: ChildProcess | undefined;
  let output = '';
  let complete!: (result: string) => void;
  const completion = new Promise<string>((r) => {
    complete = r;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    output += `\nrequest: ${url.pathname}${url.search}`;
    if (url.pathname === '/result') complete(url.searchParams.get('result') ?? 'missing');
    res.setHeader('Content-Type', 'text/html');
    res.end(
      url.pathname === '/page'
        ? '<!doctype html><iframe src="/page-child"></iframe>'
        : '<!doctype html><p>fixture</p>'
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  const base = `http://127.0.0.1:${address.port}`;
  const common = `
    import browser from 'webextension-polyfill';
    import { MessageBus, ExtensionTransport, WorkerTransport, HostRelay } from './packages/extension/src/messaging/index.ts';
    const peers = { extensionPeers: {
      [browser.runtime.getURL('ui.html')]: {context:'ui'},
      [browser.runtime.getURL('bg.js')]: {context:'background'},
      [browser.runtime.getURL('_generated_background_page.html')]: {context:'background'},
      [browser.runtime.getURL('host.html')]: {context:'offscreen'}
    }, workerRelayUrls: [browser.runtime.getURL('host.html'), browser.runtime.getURL('_generated_background_page.html')] };
  `;
  const host = `
    const hostTransport = new ExtensionTransport({context: ${JSON.stringify(browserName === 'chromium' ? 'offscreen' : 'background')}}, peers);
    new HostRelay(hostTransport, new WorkerTransport(new Worker(browser.runtime.getURL('worker.js'))));
  `;
  const scripts: Record<string, string> = {
    'bg.js':
      common +
      `
      globalThis.addEventListener('error', e => { void browser.tabs.create({url:${JSON.stringify(base + '/result?result=')}+encodeURIComponent(e.message)}); });
      const bus = new MessageBus({context:'background'}, new ExtensionTransport({context:'background'}, peers));
      bus.registerHandler('ping', req => ({timestamp:req.timestamp, echo:'background', context:'background'}), {allowedSources:['ui']});
      browser.runtime.onMessage.addListener((message, sender) => {
        if (message.fixtureIdentity) return Promise.resolve({tabId:sender.tab.id, frameId:sender.frameId});
        if (message.fixtureHostReady) { void browser.tabs.create({url:browser.runtime.getURL('ui.html')}); }
      });
      ${
        browserName === 'chromium'
          ? "void chrome.offscreen.createDocument({url:'host.html', reasons:['WORKERS'], justification:'A-03 integration test worker host'});"
          : host + "void browser.tabs.create({url:browser.runtime.getURL('ui.html')});"
      }
    `,
    'host.js': common + host + `void browser.runtime.sendMessage({fixtureHostReady:true});`,
    'worker.js': `
      import { MessageBus, WorkerTransport } from './packages/extension/src/messaging/worker.ts';
      const bus = new MessageBus({context:'worker'}, new WorkerTransport(self));
      bus.registerHandler('ping', req => ({timestamp:req.timestamp, echo:'worker', context:'worker'}), {allowedSources:['ui']});
    `,
    'content.js':
      common +
      `
      void (async () => {
        const identity = await browser.runtime.sendMessage({fixtureIdentity:true});
        const source = {context:'content', ...identity};
        const bus = new MessageBus(source, new ExtensionTransport(source, peers));
        bus.registerHandler('dom:walk', () => ({docId:'frame-'+identity.frameId, elementCount:42, timestamp:1}));
        await browser.runtime.sendMessage({fixtureContentReady:identity});
      })();
    `,
    'ui.js':
      common +
      `
      void (async () => {
        try {
          const bus = new MessageBus({context:'ui'}, new ExtensionTransport({context:'ui'}, peers));
          const bg = await bus.send('ping', {timestamp:1}, {context:'background'});
          if (bg.echo !== 'background') throw new Error('background reply');
          const frames = [];
          const ready = new Promise(resolve => browser.runtime.onMessage.addListener(msg => {
            if (msg.fixtureContentReady) { frames.push(msg.fixtureContentReady); if(frames.length === 2) resolve(); }
          }));
          await browser.tabs.create({url:${JSON.stringify(base + '/page')}});
          await ready;
          if (!frames.some(f => f.frameId === 0) || !frames.some(f => f.frameId > 0)) throw new Error('missing top or child frame');
          for (const frame of frames) {
            const result = await bus.send('dom:walk', {}, {context:'content', ...frame});
            if(result.docId !== 'frame-'+frame.frameId) throw new Error('wrong frame');
          }
          const worker = await bus.send('ping', {timestamp:1}, {context:'worker'});
          if(worker.echo !== 'worker') throw new Error('worker reply');
          await browser.tabs.create({url:${JSON.stringify(base + '/result?result=')}+'ok'});
        } catch (error) {
          await browser.tabs.create({url:${JSON.stringify(base + '/result?result=')}+encodeURIComponent(String(error))});
        }
      })();
    `,
  };
  try {
    for (const [name, contents] of Object.entries(scripts)) {
      await build({
        stdin: { contents, resolveDir: root },
        bundle: true,
        nodePaths: [resolve(root, 'packages/extension/node_modules')],
        format: 'iife',
        platform: 'browser',
        outfile: join(directory, name),
      });
    }
    for (const name of ['ui', 'host'])
      await writeFile(
        join(directory, `${name}.html`),
        `<!doctype html><script src="${name}.js"></script>`
      );
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'A-03 smoke fixture',
        version: '1.0.0',
        permissions: ['tabs', ...(browserName === 'chromium' ? ['offscreen'] : [])],
        host_permissions: ['http://127.0.0.1/*'],
        background:
          browserName === 'chromium' ? { service_worker: 'bg.js' } : { scripts: ['bg.js'] },
        content_scripts: [
          { matches: ['http://127.0.0.1/page*'], js: ['content.js'], all_frames: true },
        ],
        ...(browserName === 'firefox'
          ? { browser_specific_settings: { gecko: { id: 'a03-test@privacagent.local' } } }
          : {}),
      })
    );
    if (browserName === 'chromium') {
      context = await chromium.launchPersistentContext(join(directory, 'profile'), {
        channel: 'chromium',
        args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`],
      });
    } else {
      process = spawn(
        'pnpm',
        [
          'exec',
          'web-ext',
          'run',
          '--source-dir',
          directory,
          '--firefox',
          firefox.executablePath(),
          '--no-reload',
          '--no-input',
          '--args=-headless',
        ],
        {
          cwd: resolve(root, 'packages/extension'),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      process.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      process.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      process.on('error', (error) => complete(String(error)));
      process.on('exit', (code) => complete(`Firefox runner exited ${code}: ${output}`));
    }
    const result = await Promise.race([
      completion,
      new Promise<string>((r) => {
        const timer = setTimeout(() => r('timeout: ' + output), 60_000);
        timer.unref();
      }),
    ]);
    expect(result).toBe('ok');
  } finally {
    await context?.close();
    if (process?.pid) {
      try {
        globalThis.process.kill(-process.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
    }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
});
