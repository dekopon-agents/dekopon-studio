import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = ['harness/record.ts', 'package-lock.json', ...(await readdir(resolve(root, 'src/record')))
  .filter(name => name.endsWith('.ts')).sort().map(name => 'src/record/' + name)];
const digest = createHash('sha256');
for (const path of sources) digest.update(path).update(await readFile(resolve(root, path)));
const output = resolve(root, 'harness/.cache/record-' + digest.digest('hex'), 'record.mjs');
try { await readFile(output); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(resolve(dirname(output), 'build-'));
  try {
    await build({ root, configFile: false, envDir: false, publicDir: false, logLevel: 'silent',
    build: { ssr: resolve(root, 'harness/record.ts'), outDir: staging, emptyOutDir: false,
      rollupOptions: { output: { entryFileNames: 'record.mjs' } } } });
    await rename(resolve(staging, 'record.mjs'), output);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { default: run } = await import(pathToFileURL(output).href);
process.stdout.write(JSON.stringify(await run(JSON.parse(input))) + '\n');
