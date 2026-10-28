import { array, Context, decode, field, integer, json, known, object, parse, text, unknownFields } from './json';
import type { ObjectValue, Value } from './json';
import type { ChatRecord, FileReference, Location } from './types';

export interface Bundle {
  record: ChatRecord; trace?: string; logs?: string; journals: string[];
}
const root = { path: 'manifest.json' };
export async function bundle(files: ReadonlyMap<string, Uint8Array>, c: Context): Promise<Bundle> {
  const bytes = files.get(root.path);
  if (!bytes) c.fail('manifest-shape', root);
  const m = object(parse(decode(bytes, c, root), c, root), c, root, 'manifest-shape');
  if (m.bundleVersion !== 1n && m.bundleVersion !== 1) c.fail('bundle-version', field(root, 'bundleVersion'));
  if (m.kind !== 'trial') c.fail('manifest-shape', field(root, 'kind'));
  unknownFields(m, ['bundleVersion', 'kind', 'attempt', 'scenario', 'dekopon', 'providers', 'collector',
    'trace', 'logs', 'journal', 'freeze', 'config', 'stdout', 'driver', 'completeness', 'grade', 'gaps', 'seedDigest'], c, root);
  const references: FileReference[] = [];
  async function ref(value: Value | undefined, at: Location, format = false): Promise<string | undefined> {
    if (value === undefined || value === null) { c.gap('missing-file', at); return; }
    const o = object(value, c, at, 'manifest-shape');
    unknownFields(o, format ? ['path', 'sha256', 'bytes', 'format'] : ['path', 'sha256', 'bytes'], c, at);
    if (format && o.format !== 'otlp-jsonl') c.fail('manifest-shape', field(at, 'format'));
    if (o.path === null) { c.gap('missing-file', at); return; }
    const path = text(o.path, c, field(at, 'path'), 'manifest-shape');
    if (!path || path.includes('\\') || path.includes(':') || path.includes('\0') ||
      path.split('/').some(p => !p || p === '.' || p === '..')) c.fail('bundle-path', at);
    const sha256 = text(o.sha256, c, field(at, 'sha256'), 'manifest-shape');
    if (!/^[a-f0-9]{64}$/.test(sha256)) c.fail('manifest-shape', field(at, 'sha256'));
    const size = integer(o.bytes, c, field(at, 'bytes'), 'manifest-shape');
    references.push({ path, sha256, bytes: size });
    const content = files.get(path);
    if (!content) { c.gap('missing-file', { path }); return; }
    if (BigInt(content.length) !== BigInt(size)) c.fail('file-integrity', { path });
    const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(content));
    const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (actual !== sha256) c.fail('file-integrity', { path });
    return path;
  }
  const identity: ChatRecord['identity'] = {};
  if (m.dekopon !== undefined) {
    const d = object(m.dekopon, c, field(root, 'dekopon'), 'manifest-shape');
    unknownFields(d, ['version', 'source', 'artifact', 'binaries'], c, field(root, 'dekopon'));
    if (d.version !== undefined) text(d.version, c, field(root, 'dekopon.version'), 'manifest-shape');
    for (const k of ['source', 'artifact', 'binaries']) if (d[k] !== undefined) identity[k] = json(d[k]);
  }
  const d = m.dekopon as ObjectValue | undefined;
  const dekoponVersion = d?.version === undefined
    ? c.unknown<string>('bundle-evidence', field(root, 'dekopon.version')) : known(d.version as string);
  for (const k of ['attempt', 'providers', 'collector', 'seedDigest']) if (m[k] !== undefined) identity[k] = json(m[k]);
  const freeze = m.freeze === null || m.freeze === undefined
    ? c.unknown<import('./types').Json>('freeze', field(root, 'freeze'))
    : known(json(object(m.freeze, c, field(root, 'freeze'), 'manifest-shape')));
  let completeness: ChatRecord['completeness'];
  if (m.completeness === undefined) completeness = c.unknown('incomplete-bundle', field(root, 'completeness'));
  else {
    const o = object(m.completeness, c, field(root, 'completeness'), 'manifest-shape');
    unknownFields(o, ['status', 'reasons'], c, field(root, 'completeness'));
    if (o.status !== 'complete' && o.status !== 'incomplete') c.fail('manifest-shape', field(root, 'completeness.status'));
    const reasons = array(o.reasons, c, field(root, 'completeness.reasons'), 'manifest-shape').map(v => {
      const r = object(v, c, root, 'manifest-shape');
      return { code: text(r.code, c, root, 'manifest-shape'), detail: text(r.detail, c, root, 'manifest-shape') };
    });
    if (o.status === 'incomplete' && !reasons.length) c.gap('incomplete-bundle', field(root, 'completeness'));
    for (const r of reasons) c.gap('incomplete-bundle', field(root, 'completeness'), { attribute: r.code, detail: r.detail });
    completeness = known({ status: o.status, reasons });
  }
  if (m.gaps !== undefined) for (const gap of array(m.gaps, c, field(root, 'gaps'), 'manifest-shape'))
    c.gap('bundle-evidence', field(root, 'gaps'), { detail: text(gap, c, root, 'manifest-shape') });
  const trace = await ref(m.trace, field(root, 'trace'), true);
  const logs = await ref(m.logs, field(root, 'logs'), true);
  const journals: string[] = [];
  if (m.journal === undefined || m.journal === null) c.gap('journal-missing', field(root, 'journal'));
  else {
    const j = object(m.journal, c, field(root, 'journal'), 'manifest-shape');
    unknownFields(j, ['format', 'files'], c, field(root, 'journal'));
    text(j.format, c, field(root, 'journal.format'), 'manifest-shape');
    for (const entry of array(j.files, c, field(root, 'journal.files'), 'manifest-shape')) {
      const path = await ref(entry, field(root, 'journal.files'));
      if (path) {
        if (!/^journal\/[^/]+\/[^/]+\.jsonl$/.test(path)) c.fail('bundle-path', { path });
        journals.push(path);
      }
    }
    if (!journals.length) c.gap('journal-missing', field(root, 'journal'));
  }
  for (const key of ['driver', 'grade']) await ref(m[key], field(root, key));
  for (const key of ['config', 'scenario', 'stdout']) {
    if (m[key] === undefined || m[key] === null) { c.gap('missing-file', field(root, key)); continue; }
    const o = object(m[key], c, field(root, key), 'manifest-shape');
    const keys = key === 'config' ? ['scenario', 'catalog', 'broker', 'gateway', 'policies', 'collector']
      : key === 'scenario' ? ['id', 'config'] : ['gateway', 'broker', 'collector', 'lossSignals'];
    unknownFields(o, keys, c, field(root, key));
    for (const name of keys) {
      const at = field(root, key + '.' + name);
      if (key === 'scenario' && name === 'id') { text(o[name], c, at, 'manifest-shape'); continue; }
      if (key === 'stdout' && name === 'lossSignals') {
        if (o[name] !== undefined) for (const v of array(o[name], c, at, 'manifest-shape')) {
          const signal = object(v, c, at, 'manifest-shape');
          c.gap('incomplete-bundle', at, { attribute: text(signal.code, c, at, 'manifest-shape'),
            detail: text(signal.detail, c, at, 'manifest-shape') });
        }
      } else if (key === 'stdout' && (name === 'gateway' || name === 'broker')) {
        if (o[name] === null || o[name] === undefined) c.gap('missing-file', at);
        else {
          const streams = object(o[name], c, at, 'manifest-shape');
          unknownFields(streams, ['stdout', 'stderr'], c, at);
          await ref(streams.stdout, field(at, 'stdout')); await ref(streams.stderr, field(at, 'stderr'));
        }
      } else await ref(o[name], at);
    }
  }
  return { trace, logs, journals, record: { readerVersion: 1, bundleVersion: 1, dekoponVersion,
    references, identity, freeze, completeness, messages: [], unanchoredCalls: [], toolSets: [], journals: [],
    summaryCalls: [], evidence: [], gaps: c.gaps, notes: c.notes } };
}
