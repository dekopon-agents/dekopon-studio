import { readTrialBundle } from '../record';
import type { ReadResult } from '../record';

export async function openDirectory(files: readonly File[]): Promise<ReadResult> {
  const paths = files.map(file => file.webkitRelativePath.split('/'));
  const root = paths[0]?.[0];
  if (!root || paths.some(parts => parts.length < 2 || parts[0] !== root ||
    parts.some(p => !p || p === '.' || p === '..' || /[\\:\0]/.test(p))))
    return { ok: false, errors: [{ kind: 'bundle-path', at: { path: 'manifest.json' } }], notes: [] };
  const names = paths.map(parts => parts.slice(1).join('/'));
  if (new Set(names).size !== names.length)
    return { ok: false, errors: [{ kind: 'bundle-path', at: { path: 'manifest.json' } }], notes: [] };
  try {
    const bytes = await Promise.all(files.map(async (file, i) =>
      [names[i], new Uint8Array(await file.arrayBuffer())] as const));
    return await readTrialBundle(new Map(bytes));
  } catch {
    return { ok: false, errors: [{ kind: 'reader-failure', at: { path: 'manifest.json' } }], notes: [] };
  }
}
