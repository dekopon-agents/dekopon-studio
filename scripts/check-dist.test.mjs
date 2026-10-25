// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { checkDist } from './check-dist.mjs';

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(files) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-runtime-'));
  fixtures.push(directory);
  for (const [name, contents] of Object.entries(files)) {
    const file = join(directory, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, contents);
  }
  return directory;
}

test('loads every built HTML page and serves bundled assets at the deployed origin', async () => {
  const directory = await fixture({
    'index.html': '<!doctype html><link rel="stylesheet" href="/studio/style.css"><script src="/studio/app.js"></script>',
    'nested/page.html': '<!doctype html><img src="/studio/image.svg">',
    'style.css': 'body { color: green }',
    'app.js': 'fetch("/studio/data.json")',
    'data.json': '{}',
    'image.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  expect(await checkDist(directory)).toEqual(expect.arrayContaining([
    'https://dekopon-agents.github.io/studio/index.html',
    'https://dekopon-agents.github.io/studio/nested/page.html',
    'https://dekopon-agents.github.io/studio/style.css',
    'https://dekopon-agents.github.io/studio/app.js',
    'https://dekopon-agents.github.io/studio/data.json',
    'https://dekopon-agents.github.io/studio/image.svg',
  ]));
}, 30000);

test.each([
  ['backslash fetch', '<script>fetch("\\\\private")</script>', '/private'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=/refresh">', '/refresh'],
  ['imagesrcset', '<link rel="preload" as="image" imagesrcset="\\image.png 1x">', '/image.png'],
])('rejects a load-triggered %s request outside the base', async (_name, html, path) => {
  const directory = await fixture({ 'index.html': `<!doctype html>${html}` });
  await expect(checkDist(directory)).rejects.toThrow(`Request outside /studio/: https://dekopon-agents.github.io${path}`);
}, 30000);
