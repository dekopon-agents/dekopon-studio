import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exportSeed, readSeed, readTrialBundle } from '../src/record/index';
import { journal } from '../src/record/journal';
import { Context } from '../src/record/json';
import type { ContinuationMessage } from '../src/record/types';

interface Request { operation: 'seed' | 'bundle' | 'export' | 'journals'; path: string; output?: string; continuationMessages?: ContinuationMessage[] }
const allowed = /^(manifest\.json|driver\.json|grade\.json|trace\/(traces|logs)\.jsonl|journal\/[^/]+\/[^/]+\.jsonl|config\/(scenario|catalog|broker|gateway)\.json|config\/(policies\.cedar|collector\.yaml)|stdout\/(gateway|broker)\.(jsonl|stderr)|stdout\/collector\.log)$/;
async function filesFromDirectory(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  async function visit(prefix: string) {
    for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Bundle directory contains a symbolic link');
      if (entry.isDirectory()) {
        if ((!prefix && ['trace', 'journal', 'config', 'stdout'].includes(entry.name)) || prefix === 'journal/')
          await visit(path + '/');
      } else if (entry.isFile() && allowed.test(path)) files.set(path, new Uint8Array(await readFile(resolve(root, path))));
    }
  }
  await visit('');
  return files;
}
export default async function run(request: Request): Promise<unknown> {
  if (request.operation === 'seed') {
    const result = await readSeed(new Uint8Array(await readFile(request.path)));
    if (!result.ok) return result;
    return { ...result, files: [...result.files].map(([path, bytes]) => ({ path, base64: Buffer.from(bytes).toString('base64') })) };
  }
  const files = await filesFromDirectory(request.path);
  if (request.operation === 'bundle') return readTrialBundle(files);
  if (request.operation === 'journals') {
    const c = new Context();
    return { ok: true, records: [...files].filter(([path]) => path.startsWith('journal/'))
      .flatMap(([path, bytes]) => journal(bytes, path, c)), gaps: c.gaps };
  }
  if (request.operation !== 'export' || !request.output) throw new Error('Unknown record adapter operation');
  const result = await exportSeed(files, request.continuationMessages ?? []);
  if (!result.ok) return result;
  await writeFile(request.output, result.bytes, { flag: 'wx', mode: 0o600 });
  return { ok: true, seedDigest: result.seedDigest };
}
