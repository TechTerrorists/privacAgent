/** B-08: fixed-route, loopback-only fixture server. No user data is persisted or logged. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { build } from 'esbuild';

const port = Number(process.env.MOCK_SITES_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MOCK_SITES_PORT must be an integer from 1 to 65535');
}
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./src/app.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
});
/** @type {Map<string, {type: string, body: string}>} */
const routes = new Map();
for (const page of ['index', 'profile', 'settings', 'search']) {
  routes.set(page === 'index' ? '/' : `/${page}`, {
    type: 'text/html; charset=utf-8',
    body: await readFile(new URL(`./${page}.html`, import.meta.url), 'utf8'),
  });
}
routes.set('/assets/app.js', {
  type: 'text/javascript; charset=utf-8',
  body: bundle.outputFiles[0]?.text ?? '',
});
routes.set('/assets/style.css', {
  type: 'text/css; charset=utf-8',
  body: await readFile(new URL('./style.css', import.meta.url), 'utf8'),
});
routes.set('/health', { type: 'text/plain; charset=utf-8', body: 'B-08 mock sites ready' });
routes.set('/favicon.svg', {
  type: 'image/svg+xml',
  body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#21654e"/><path d="M10 8v16h14v-4H14V8z" fill="white"/></svg>',
});
const server = createServer((request, response) => {
  // Exact allowlist: no filesystem paths derived from a request URL.
  const route = routes.get((request.url ?? '').split('?')[0] ?? '');
  const allowed = request.method === 'GET' || request.method === 'HEAD';
  response.writeHead(!allowed ? 405 : route ? 200 : 404, {
    'Content-Type': route?.type ?? 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...(!allowed ? { Allow: 'GET, HEAD' } : {}),
  });
  response.end(
    request.method === 'HEAD'
      ? undefined
      : !allowed
        ? 'Method not allowed'
        : (route?.body ?? 'Not found')
  );
});
server.on('error', () => {
  console.error('Mock sites could not start. Check that the configured port is available.');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.info(`B-08 mock sites: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
