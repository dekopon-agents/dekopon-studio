import { readdir, stat } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const deployedOrigin = 'https://dekopon-agents.github.io';
const base = '/studio/';

export async function checkDist(directory, drive) {
  directory = resolve(directory);
  const pages = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name.toLowerCase().endsWith('.html')) pages.push(file);
    }
  }
  await visit(directory);
  if (!pages.length) throw new Error('No built HTML pages found');

  const requests = new Set();
  const failures = new Set();
  const browser = await chromium.launch();
  try {
    for (const file of pages) {
      const context = await browser.newContext({ serviceWorkers: 'block', offline: true });
      try {
        context.on('request', request => requests.add(request.url()));
        context.on('page', page => {
          // Native events also cover worker sockets, which routing cannot intercept.
          page.on('websocket', socket => {
            requests.add(socket.url());
            failures.add(`WebSocket request in static app: ${socket.url()}`);
          });
          page.on('pageerror', error => failures.add(`Page error: ${error.message}`));
        });
        // Serve built files from disk at the real deployed HTTPS origin. No request
        // reaches the public site or any other network destination.
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== deployedOrigin || !url.pathname.startsWith(base)) {
            failures.add(`Request outside /studio/: ${url.href}`);
            await route.abort();
            return;
          }
          let local = resolve(directory, decodeURIComponent(url.pathname.slice(base.length)) || '.');
          if (local !== directory && !local.startsWith(directory + sep)) {
            failures.add(`Invalid built path: ${url.href}`);
            await route.abort();
            return;
          }
          try {
            if ((await stat(local)).isDirectory()) local = resolve(local, 'index.html');
            await route.fulfill({ path: local });
          } catch {
            failures.add(`Missing built resource: ${url.href}`);
            await route.fulfill({ status: 404, body: 'Not found' });
          }
        });
        await context.routeWebSocket('**/*', socket => {
          // There is no websocket server in this static app; record and reject it.
          requests.add(socket.url());
          failures.add(`WebSocket request in static app: ${socket.url()}`);
          socket.close();
        });
        const page = await context.newPage();
        const path = relative(directory, file).split(sep).map(encodeURIComponent).join('/');
        try {
          await page.goto(`${deployedOrigin}${base}${path}`, { waitUntil: 'load', timeout: 10000 });
          // Observe load-triggered fetches, preloads, and immediate refreshes until
          // Chromium has had no pending network requests for 500 ms.
          await page.waitForLoadState('networkidle', { timeout: 10000 });
          if (drive) await drive({ page, context, file });
        } catch (error) {
          failures.add(`Loading ${path}: ${error.message}`);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (failures.size) throw new Error([...failures].join('\n'));
  return [...requests];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const requests = await checkDist('dist');
  console.log(`Chromium loaded all built HTML pages; ${requests.length} requests stayed under ${deployedOrigin}${base}`);
}
