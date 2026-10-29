import { validBundlePath } from './bundle';
import { readTrialBundle } from './index';
import { array, Context, decode, Failure, field, object, parse, text, unknownFields } from './json';
import type { ContinuationMessage, ExportSeedResult, ReadResult, ReadSeedResult } from './types';

const root = { path: 'dekopon-seed-v1.json' };
const encoder = new TextEncoder();
function failure(error: unknown, c: Context): Extract<ReadResult, { ok: false }> {
  return { ok: false, errors: [error instanceof Failure ? error.error : { kind: 'reader-failure', at: root }], notes: c.notes };
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(chunks.join(''));
}
function messages(value: unknown, c: Context): ContinuationMessage[] {
  const at = field(root, 'continuationMessages');
  return array(value as Parameters<typeof array>[0], c, at, 'seed-shape').map((entry, i) => {
    const loc = field(at, String(i)), o = object(entry, c, loc, 'seed-shape');
    unknownFields(o, ['text'], c, loc);
    return { text: text(o.text, c, field(loc, 'text'), 'seed-shape') };
  });
}
function reachable(record: import('./types').ChatRecord): Set<string> {
  return new Set(['manifest.json', ...record.references.map(ref => ref.path)]);
}
// Lexicographic UTF-8 byte order, independent of locale and UTF-16 surrogate ordering.
function comparePaths(a: string, b: string): number {
  const x = encoder.encode(a), y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
export async function exportSeed(files: ReadonlyMap<string, Uint8Array>,
  continuationMessages: readonly ContinuationMessage[]): Promise<ExportSeedResult> {
  const c = new Context();
  try {
    const snapshot = new Map([...files].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
    const continuation = messages(continuationMessages, c);
    const result = await readTrialBundle(snapshot);
    if (!result.ok) return result;
    if (result.record.freeze.state !== 'known') c.fail('seed-freeze', { path: 'manifest.json', field: 'freeze' });
    const entries = [...reachable(result.record)].filter(path => snapshot.has(path)).sort(comparePaths)
      .map(path => ({ path, base64: base64(snapshot.get(path)!) }));
    const bytes = encoder.encode(JSON.stringify({ seedVersion: 1, files: entries, continuationMessages: continuation }));
    return { ok: true, bytes, seedDigest: await digest(bytes) };
  } catch (error) { return failure(error, c); }
}
export async function readSeed(input: Uint8Array): Promise<ReadSeedResult> {
  const c = new Context();
  try {
    const bytes = Uint8Array.from(input);
    const seed = object(parse(decode(bytes, c, root), c, root), c, root, 'seed-shape');
    if (seed.seedVersion !== 1n) c.fail('seed-version', field(root, 'seedVersion'));
    unknownFields(seed, ['seedVersion', 'files', 'continuationMessages'], c, root);
    const continuationMessages = messages(seed.continuationMessages, c);
    const files = new Map<string, Uint8Array>();
    for (const [i, entry] of array(seed.files, c, field(root, 'files'), 'seed-shape').entries()) {
      const at = field(root, 'files.' + i), o = object(entry, c, at, 'seed-shape');
      unknownFields(o, ['path', 'base64'], c, at);
      const path = text(o.path, c, field(at, 'path'), 'seed-shape');
      if (!validBundlePath(path) || files.has(path)) c.fail('bundle-path', field(at, 'path'));
      const encoded = text(o.base64, c, field(at, 'base64'), 'seed-shape');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        c.fail('seed-base64', field(at, 'base64'));
      const decoded = Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0));
      if (base64(decoded) !== encoded) c.fail('seed-base64', field(at, 'base64'));
      files.set(path, decoded);
    }
    const result = await readTrialBundle(files);
    if (!result.ok) return { ...result, notes: [...c.notes, ...result.notes] };
    if (result.record.freeze.state !== 'known') c.fail('seed-freeze', { path: 'manifest.json', field: 'freeze' });
    const allowed = reachable(result.record);
    if ([...files.keys()].some(path => !allowed.has(path))) c.fail('seed-shape', field(root, 'files'));
    result.record.notes.unshift(...c.notes);
    return { ok: true, record: result.record, files, continuationMessages, seedDigest: await digest(bytes) };
  } catch (error) { return failure(error, c); }
}
