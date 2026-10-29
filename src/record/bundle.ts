import { array, Context, decode, field, integer, known, object, parse, text, unknownFields } from './json';
import type { Value } from './json';
import type { ChatRecord, FileReference, Location } from './types';

export interface Bundle {
  record: ChatRecord; trace?: string; logs?: string; journals: string[];
}
const root = { path: 'manifest.json' };
export async function bundle(files: ReadonlyMap<string, Uint8Array>, c: Context): Promise<Bundle> {
  const bytes = files.get(root.path);
  if (!bytes) c.fail('manifest-shape', root);
  const m = object(parse(decode(bytes, c, root), c, root), c, root, 'manifest-shape');
  if (m.bundleVersion !== 1n) c.fail('bundle-version', field(root, 'bundleVersion'));
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
    references.push({ at, path, sha256, bytes: size });
    const content = files.get(path);
    if (!content) { c.gap('missing-file', { path }); return; }
    if (BigInt(content.length) !== BigInt(size)) c.fail('file-integrity', { path });
    const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(content));
    const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (actual !== sha256) c.fail('file-integrity', { path });
    return path;
  }
  const identity: ChatRecord['identity'] = {};
  type Decoder = (v: Value, at: Location) => import('./types').Json;
  const string: Decoder = (v, at) => text(v, c, at, 'manifest-shape');
  const unsigned: Decoder = (v, at) => integer(v, c, at, 'manifest-shape');
  const signed: Decoder = (v, at) => integer(v, c, at, 'manifest-shape', -2147483648n, 2147483647n);
  const boolean: Decoder = (v, at) => { if (typeof v !== 'boolean') c.fail('manifest-shape', at); return v; };
  function metadata(v: Value, at: Location, schema: Record<string, Decoder>): import('./types').Json {
    const o = object(v, c, at, 'manifest-shape');
    unknownFields(o, Object.keys(schema), c, at);
    const result: Record<string, import('./types').Json> = {};
    for (const [key, decoder] of Object.entries(schema)) {
      const loc = field(at, key);
      if (o[key] === undefined) c.gap('bundle-evidence', loc, { attribute: key });
      else result[key] = decoder(o[key], loc);
    }
    return result;
  }
  const source: Decoder = (v, at) => metadata(v, at, { repository: string, commit: string });
  const artifact: Decoder = (v, at) => metadata(v, at, { name: string, version: string, source, sha256: string });
  const nullable = (decoder: Decoder): Decoder => (v, at) => v === null ? null : decoder(v, at);
  const list = (decoder: Decoder): Decoder => (v, at) =>
    array(v, c, at, 'manifest-shape').map((entry, i) => decoder(entry, field(at, String(i))));
  const binaries: Decoder = (v, at) => {
    const b = object(v, c, at, 'manifest-shape');
    return Object.fromEntries(Object.entries(b).map(([name, value]) =>
      [name, metadata(value, field(at, name), { version: string, sha256: string })]));
  };
  const d = m.dekopon === undefined ? undefined : object(m.dekopon, c, field(root, 'dekopon'), 'manifest-shape');
  if (d) {
    unknownFields(d, ['version', 'source', 'artifact', 'binaries'], c, field(root, 'dekopon'));
    if (d.version !== undefined) text(d.version, c, field(root, 'dekopon.version'), 'manifest-shape');
  }
  const dekoponVersion = d?.version === undefined
    ? c.unknown<string>('bundle-evidence', field(root, 'dekopon.version')) : known(d.version as string);
  for (const [key, decoder] of Object.entries({ source, artifact, binaries })) {
    const at = field(root, 'dekopon.' + key);
    if (d?.[key] === undefined) c.gap('bundle-evidence', at, { attribute: key });
    else identity[key] = decoder(d[key], at);
  }
  const identityDecoders: Record<string, Decoder> = {
    attempt: (v, at) => metadata(v, at, { id: string, startedAt: string, finishedAt: nullable(string) }),
    providers: list((v, at) => metadata(v, at, { id: string, name: string, version: string, source, sha256: string })),
    collector: (v, at) => metadata(v, at, { image: string, exitCode: nullable(signed), forcedKill: boolean }),
    seedDigest: (v, at) => { if (v !== null) c.fail('manifest-shape', at); return null; },
  };
  for (const [key, decoder] of Object.entries(identityDecoders)) {
    const at = field(root, key);
    if (m[key] === undefined) c.gap('bundle-evidence', at, { attribute: key });
    else identity[key] = decoder(m[key], at);
  }
  let freeze: ChatRecord['freeze'];
  if (m.freeze === null || m.freeze === undefined) freeze = c.unknown('freeze', field(root, 'freeze'));
  else {
    const normalized = metadata(m.freeze, field(root, 'freeze'), {
      lastRepliedMessage: unsigned,
      conversation: (v, at) => metadata(v, at, { kind: string, id: string,
        ...(typeof v === 'object' && v !== null && !Array.isArray(v) && v.container !== undefined ? { container: string } : {}),
        ...(typeof v === 'object' && v !== null && !Array.isArray(v) && v.thread !== undefined ? { thread: string } : {}) }),
      journalStems: list(string),
      gateway: (v, at) => metadata(v, at, { signal: string, drained: boolean, exitCode: signed }),
      copiedAt: string,
    }) as Record<string, import('./types').Json>;
    const conversation = normalized.conversation as Record<string, import('./types').Json> | undefined;
    const gateway = normalized.gateway as Record<string, import('./types').Json> | undefined;
    freeze = gateway?.signal === 'SIGTERM' && gateway.drained === true && gateway.exitCode === '0' &&
      normalized.lastRepliedMessage !== undefined && normalized.copiedAt !== undefined &&
      conversation?.kind !== undefined && conversation.id !== undefined && normalized.journalStems !== undefined
      ? known(normalized) : c.unknown('freeze', field(root, 'freeze'));
  }
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
  const policyRef = references.find(ref => ref.at.field === 'config.policies');
  const policyBytes = policyRef && files.get(policyRef.path);
  const policy = policyBytes ? known(decode(policyBytes, c, { path: policyRef!.path }))
    : c.unknown<string>('permission-evidence', { path: 'manifest.json', field: 'config.policies' });
  return { trace, logs, journals, record: { readerVersion: 3, bundleVersion: 1, dekoponVersion,
    references, identity, freeze, completeness, messages: [], unanchoredCalls: [], toolSets: [], journals: [],
    summaryCalls: [], evidence: [], spans: [], admissions: [], replays: [], mailbox: {
      steers: c.unknown('mailbox-inventory-unavailable', { path: 'trace/traces.jsonl', field: 'steers' }),
      followUps: c.unknown('mailbox-inventory-unavailable', { path: 'trace/traces.jsonl', field: 'follow-ups' }),
      runningInterval: c.unknown('mailbox-state-unavailable', { path: 'trace/traces.jsonl', field: 'RUNNING interval' }),
      completingInterval: c.unknown('mailbox-state-unavailable', { path: 'trace/traces.jsonl', field: 'COMPLETING interval' }),
    }, permissions: { policy, world: { state: 'unknown', gap: c.gap('policy-world-unavailable',
      { path: 'manifest.json', field: 'providers' }, { attribute: 'provider-inventory',
        detail: 'Bundle v1 has provider pins and runtime paths, not the complete loaded capability inventory. Successful what-if evaluation waits for a core export.' }) },
      decisions: [], effects: [], turns: [] }, gaps: c.gaps, notes: c.notes } };
}
