import { array, Context, decode, field, integer, lines, object, parse, text, unknownFields } from './json';
import type { ObjectValue, Value } from './json';
import type { Fact, Arrival, AssetInventory, JournalChange, JournalItem, JournalRecord, JournalSpan,
  Location, ModelIdentity, Slot, Subject } from './types';

const shape = 'journal-shape';
const bytesOf = (s: string) => new TextEncoder().encode(s).length;
const u = (v: Value | undefined, c: Context, at: Location, min = 0n, max = 18446744073709551615n) =>
  integer(v, c, at, shape, min, max);
const t = (v: Value | undefined, c: Context, at: Location) => text(v, c, at, shape);
const o = (v: Value | undefined, c: Context, at: Location) => object(v, c, at, shape);
const a = (v: Value | undefined, c: Context, at: Location) => array(v, c, at, shape);
function model(v: Value | undefined, c: Context, at: Location): ModelIdentity {
  const m = o(v, c, at); unknownFields(m, ['backend', 'upstream', 'reported'], c, at);
  const backend = t(m.backend, c, at);
  if (!['codex', 'open-router', 'open-ai-compatible'].includes(backend)) c.note('unknown-variant', at, backend);
  return { backend, upstream: t(m.upstream, c, at), reported: m.reported === undefined || m.reported === null ? null : t(m.reported, c, at) };
}
function slot(v: Value, c: Context, at: Location): Slot {
  if (v === 'Queued' || v === 'Running') return { state: v === 'Queued' ? 'queued' : 'running' };
  if (v === 'Generated' || v === 'Error') c.fail(shape, at);
  if (typeof v === 'string') { c.note('unknown-variant', at, v); return { state: 'unknown', variant: v }; }
  const s = o(v, c, at), keys = Object.keys(s);
  if (keys.length !== 1) c.fail(shape, at);
  if (keys[0] === 'Generated') return { state: 'generated', text: t(s.Generated, c, at) };
  if (keys[0] === 'Error') {
    const error = o(s.Error, c, at); unknownFields(error, ['kind', 'detail'], c, at);
    let failure: string, ioKind: string | undefined;
    if (typeof error.kind === 'string') {
      if (error.kind === 'Io') c.fail(shape, at);
      failure = error.kind;
    } else {
      const kind = o(error.kind, c, at);
      if (Object.keys(kind).length !== 1) c.fail(shape, at);
      failure = Object.keys(kind)[0];
      if (failure === 'Io') {
        const io = o(kind.Io, c, at); unknownFields(io, ['kind'], c, at); ioKind = t(io.kind, c, at);
      } else c.note('unknown-variant', at, failure);
    }
    if (!['Timeout', 'Refused', 'ModelFailed', 'Empty', 'Overflow', 'Panicked', 'Io', 'Unconfigured'].includes(failure))
      c.note('unknown-variant', at, failure);
    return { state: 'error', failure, detail: t(error.detail, c, at), ...(ioKind === undefined ? {} : { ioKind }) };
  }
  c.note('unknown-variant', at, keys[0]); return { state: 'unknown', variant: keys[0] };
}
function slots(v: Value | undefined, c: Context, at: Location) { return a(v, c, at).map(v => slot(v, c, at)); }
function rung(v: Value | undefined, c: Context, at: Location): Fact<string | null> {
  if (v === undefined || v === null) return { state: 'known', value: null };
  if (v === 'native' || v === 'metadata') return { state: 'known', value: v };
  if (typeof v === 'string') { c.note('unknown-variant', at, v); return c.unknown('evidence-field', at, { attribute: 'rung' }); }
  const r = o(v, c, at);
  if (Object.keys(r).length !== 1) c.fail(shape, at);
  if (r.summary !== undefined) return { state: 'known', value: 'summary-' + u(r.summary, c, at, 1n, 255n) };
  c.note('unknown-variant', at, Object.keys(r)[0]); return c.unknown('evidence-field', at, { attribute: 'rung' });
}
function subject(v: Value | undefined, c: Context, at: Location): Subject {
  if (v === undefined || v === 'record') return { kind: 'record' };
  if (typeof v === 'string') { c.note('unknown-variant', at, v); return { kind: 'unknown' }; }
  const s = o(v, c, at);
  if (Object.keys(s).length !== 1) c.fail(shape, at);
  if (s.asset !== undefined) return { kind: 'asset', number: u(s.asset, c, at, 1n) };
  c.note('unknown-variant', at, Object.keys(s)[0]); return { kind: 'unknown' };
}
function kept(v: Value | undefined, c: Context, at: Location): { text: string; originalBytes: string } {
  const k = o(v, c, at); unknownFields(k, ['text', 'original_bytes'], c, at);
  const value = { text: t(k.text, c, at), originalBytes: u(k.original_bytes, c, at) };
  const bytes = BigInt(bytesOf(value.text));
  if (BigInt(value.originalBytes) < bytes) c.fail(shape, at);
  if (BigInt(value.originalBytes) > bytes) c.gap('truncated-attribute', at, { attribute: 'original_bytes' });
  return value;
}
const tools = ['Bash', 'ReadSkill', 'FetchChatAsset', 'ReadMemoryRecord', 'SetMemoryPin', 'ClearMemoryPin',
  'InspectAgentConfig', 'SuggestImprovement', 'Wake', 'Rejected'];
function outcome(v: Value | undefined, c: Context, at: Location): string | { Exit: string } {
  if (v === 'Refused' || v === 'Failed') return v;
  if (typeof v === 'string') { c.note('unknown-variant', at, v); return 'unknown'; }
  const result = o(v, c, at);
  if (Object.keys(result).length !== 1) c.fail(shape, at);
  if (result.Exit !== undefined) return { Exit: u(result.Exit, c, at, 0n, 255n) };
  c.note('unknown-variant', at, Object.keys(result)[0]); return 'unknown';
}
function item(v: Value, c: Context, at: Location): JournalItem | undefined {
  const b = o(v, c, at);
  if (Object.keys(b).length !== 1) c.fail(shape, at);
  const kind = Object.keys(b)[0];
  switch (kind) {
    case 'user': case 'steer': case 'assistant': return { kind, ...kept(b[kind], c, at) };
    case 'asset': return { kind, number: u(b.asset, c, at, 1n) };
    case 'reasoning': {
      const r = o(b.reasoning, c, at);
      if (Object.keys(r).length !== 1) c.fail(shape, at);
      if (r.Plain !== undefined) return { kind: 'reasoning', ...kept(r.Plain, c, at) };
      if (r.Opaque !== undefined) {
        const opaque = o(r.Opaque, c, at); unknownFields(opaque, ['model', 'bytes'], c, at);
        if (opaque.bytes === undefined) c.fail(shape, at);
        c.gap('opaque-content', at);
        return { kind: 'opaque', model: model(opaque.model, c, at) };
      }
      c.note('unknown-variant', at, Object.keys(r)[0]); return;
    }
    case 'exchange': {
      const e = o(b.exchange, c, at); unknownFields(e, ['call', 'result'], c, at);
      const call = o(e.call, c, at), result = o(e.result, c, at);
      unknownFields(call, ['id', 'tool', 'arguments'], c, at); unknownFields(result, ['outcome', 'text'], c, at);
      let tool: string;
      if (typeof call.tool === 'string') {
        tool = call.tool; if (!tools.includes(tool)) c.note('unknown-variant', at, tool);
      } else {
        const rejected = o(call.tool, c, at);
        if (Object.keys(rejected).length !== 1) c.fail(shape, at);
        if (rejected.Rejected === undefined) { c.note('unknown-variant', at, Object.keys(rejected)[0]); tool = 'unknown'; }
        else tool = kept(rejected.Rejected, c, at).text;
      }
      return { kind, callId: t(call.id, c, at), tool, arguments: kept(call.arguments, c, at).text,
        result: kept(result.text, c, at).text, outcome: outcome(result.outcome, c, at) };
    }
    default: c.note('unknown-variant', at, kind); return;
  }
}
function inventory(v: Value, c: Context, at: Location): AssetInventory {
  const asset = o(v, c, at);
  unknownFields(asset, ['id', 'atMs', 'name', 'mime', 'size', 'source'], c, at);
  return { id: u(asset.id, c, at, 1n), atMs: u(asset.atMs, c, at),
    name: t(asset.name, c, at), mime: t(asset.mime, c, at),
    ...(asset.size === undefined || asset.size === null ? {} : { size: u(asset.size, c, at) }) };
}
function arrival(v: Value, c: Context, at: Location): Arrival {
  const asset = o(v, c, at); unknownFields(asset, ['item', 'number', 'kind', 'bytes', 'summaries'], c, at);
  const kind = t(asset.kind, c, at);
  if (!['image', 'text-document', 'binary-document', 'other'].includes(kind)) c.note('unknown-variant', at, kind);
  if (kind === 'image') c.gap('image-bytes', at);
  return { item: u(asset.item, c, at, 0n, 4294967295n), number: u(asset.number, c, at, 1n), kind,
    bytes: asset.bytes === null || asset.bytes === undefined ? null : u(asset.bytes, c, at),
    summaries: slots(asset.summaries, c, at) };
}
interface Body { bytes: Uint8Array; rawItems: Value[]; items: (JournalItem | undefined)[] }
function header(v: Value, body: Body, path: string, at: Location, c: Context): JournalRecord {
  const h = o(v, c, at);
  unknownFields(h, ['id', 'nextRecordId', 'turn', 'atMs', 'grant', 'model', 'summaries', 'plan', 'assets',
    'nextAssetId', 'bodyLen', 'spans', 'arrived', 'pin', 'choice'], c, at);
  const recordId = u(h.id, c, at, 1n), nextRecordId = u(h.nextRecordId, c, at, 1n);
  if (BigInt(nextRecordId) !== BigInt(recordId) + 1n) c.fail(shape, at);
  if (BigInt(u(h.bodyLen, c, at)) !== BigInt(body.bytes.length)) c.fail('journal-index', at);
  const spans: JournalSpan[] = [];
  for (const v of a(h.spans, c, at)) {
    const s = o(v, c, at); unknownFields(s, ['item', 'field', 'kind', 'relOffset', 'len'], c, at);
    const index = u(s.item, c, at, 0n, 4294967295n);
    const relOffset = u(s.relOffset, c, at), len = u(s.len, c, at);
    if (BigInt(index) >= BigInt(body.rawItems.length) || BigInt(relOffset) + BigInt(len) > BigInt(body.bytes.length))
      c.fail('journal-index', at);
    if (s.kind !== 'escaped' && s.kind !== 'raw') {
      t(s.kind, c, at); c.note('unknown-variant', at, s.kind as string); continue;
    }
    let fieldName: string, meta: ObjectValue = {};
    if (typeof s.field === 'string') fieldName = s.field;
    else {
      const f = o(s.field, c, at);
      if (Object.keys(f).length !== 1) c.fail(shape, at);
      fieldName = Object.keys(f)[0];
    }
    if (!['User', 'Steer', 'Assistant', 'Plain', 'Opaque', 'CallId', 'RejectedTool', 'Arguments', 'Result'].includes(fieldName)) {
      c.note('unknown-variant', at, fieldName); continue;
    }
    if (typeof s.field !== 'string') meta = o((s.field as ObjectValue)[fieldName], c, at);
    const expectedKind = fieldName === 'Opaque' ? 'raw' : 'escaped';
    if (s.kind !== expectedKind) c.fail('journal-index', at);
    unknownFields(meta, ['original_bytes', 'model', 'tool', 'outcome'], c, at);
    if (['User', 'Steer', 'Assistant', 'Plain', 'Arguments', 'Result'].includes(fieldName)) u(meta.original_bytes, c, at);
    if (fieldName === 'Opaque') model(meta.model, c, at);
    if (fieldName === 'Arguments') {
      const tool = t(meta.tool, c, at); if (!tools.includes(tool)) c.note('unknown-variant', at, tool);
    }
    if (fieldName === 'Result') outcome(meta.outcome, c, at);
    const source = body.items[Number(index)];
    const expectedItemKind = ({ User: 'user', Steer: 'steer', Assistant: 'assistant', Plain: 'reasoning', Opaque: 'opaque',
      CallId: 'exchange', RejectedTool: 'exchange', Arguments: 'exchange', Result: 'exchange' } as Record<string, string>)[fieldName];
    if (source && source.kind !== expectedItemKind) c.fail('journal-index', at);
    if (['User', 'Steer', 'Assistant', 'Plain'].includes(fieldName) && source && meta.original_bytes !== undefined &&
      u(meta.original_bytes, c, at) !== source.originalBytes) c.fail('journal-index', at);
    const expected = fieldName === 'CallId' ? source?.callId : fieldName === 'Arguments' ? source?.arguments
      : fieldName === 'Result' ? source?.result : fieldName === 'RejectedTool' ? source?.tool : source?.text;
    const slice = body.bytes.subarray(Number(relOffset), Number(BigInt(relOffset) + BigInt(len)));
    if (fieldName !== 'Opaque') {
      const decoded = parse('"' + decode(slice, c, at) + '"', c, at);
      if (typeof decoded !== 'string' || decoded !== expected) c.fail('journal-index', at);
    } else if (source?.kind !== 'opaque') c.fail('journal-index', at);
    spans.push({ item: index, field: fieldName, kind: s.kind, relOffset, len });
  }
  const initialSummaries = slots(h.summaries, c, at);
  let plan: JournalRecord['plan'] = null;
  if (h.plan !== null && h.plan !== undefined) {
    const p = o(h.plan, c, at); unknownFields(p, ['model', 'parts', 'maxInputBytes'], c, at);
    const parts = a(p.parts, c, at).map(v => u(v, c, at, 1n, 4294967295n));
    if (!parts.length || parts.length > 255 || parts.length !== initialSummaries.length) c.fail(shape, at);
    plan = { model: t(p.model, c, at), parts, maxInputBytes: u(p.maxInputBytes, c, at, 1n, 4294967295n) };
  } else if (initialSummaries.length) c.fail(shape, at);
  const grant = a(h.grant, c, at).map(v => Number(u(v, c, at, 0n, 255n)));
  if (grant.length !== 8) c.fail(shape, at);
  const parts = path.split('/');
  return { key: { agent: parts[1], stem: parts[2].slice(0, -6), recordId }, at, nextRecordId,
    turn: u(h.turn, c, at), atMs: u(h.atMs, c, at), model: model(h.model, c, at), grant,
    nextAssetId: u(h.nextAssetId, c, at, 1n), items: body.items.filter((v): v is JournalItem => v !== undefined),
    spans, plan, initialSummaries, summaries: [...initialSummaries],
    pin: rung(h.pin, c, at), choice: rung(h.choice, c, at),
    arrivals: a(h.arrived === undefined ? [] : h.arrived, c, at).map(v => arrival(v, c, at)),
    assets: a(h.assets, c, at).map(v => inventory(v, c, at)), changes: [],
    representations: [{ id: 'native' }, ...initialSummaries.map((_, i) => ({ id: 'summary-' + (i + 1), part: String(i + 1) })), { id: 'metadata' }],
    publications: [], summaryCalls: [] };
}
export function journal(bytes: Uint8Array, path: string, c: Context): JournalRecord[] {
  const records: JournalRecord[] = [], byId = new Map<string, JournalRecord>();
  let body: Body | undefined;
  let expectedRecordId: string | undefined;
  for (const line of lines(bytes)) {
    const at = { path, line: line.line };
    if (!line.terminated) { c.gap('journal-tail', at); break; }
    const envelope = o(parse(decode(line.bytes, c, at), c, at), c, at);
    const tags = Object.keys(envelope).filter(key => ['b', 'h', 's', 'p', 'c'].includes(key));
    if (tags.length > 1) c.fail(shape, at);
    for (const key of Object.keys(envelope)) if (!tags.includes(key))
      c.note(tags.length ? 'unknown-field' : 'unknown-variant', at, key);
    if (!tags.length) continue;
    const tag = tags[0];
    if (tag === 'b') {
      if (body) c.fail('journal-reference', at);
      const rawItems = a(envelope.b, c, at);
      body = { bytes: line.bytes, rawItems, items: rawItems.map((v, i) => {
        const decoded = item(v, c, field(at, 'b[' + i + ']'));
        return decoded ? { ...decoded, item: String(i) } : undefined;
      }) };
    } else if (tag === 'h') {
      if (!body) c.fail('journal-reference', at);
      const record = header(envelope.h, body, path, at, c);
      if (expectedRecordId !== undefined && record.key.recordId !== expectedRecordId) c.fail('journal-reference', at);
      expectedRecordId = record.nextRecordId;
      byId.set(record.key.recordId, record); records.push(record); body = undefined;
    } else if (['s', 'p', 'c'].includes(tag)) {
      if (body) c.fail('journal-reference', at);
      const side = o(envelope[tag], c, at);
      unknownFields(side, tag === 's' ? ['atMs', 'record', 'part', 'slot', 'subject']
        : tag === 'p' ? ['atMs', 'record', 'pin', 'subject'] : ['atMs', 'record', 'choice'], c, at);
      const record = byId.get(u(side.record, c, at, 1n));
      if (!record) c.fail('journal-reference', at);
      if (tag === 'c' && (side.choice === undefined || side.choice === null)) c.fail(shape, at);
      const subj = tag === 'c' ? { kind: 'record' as const } : subject(side.subject, c, at);
      const change: JournalChange = { at, atMs: u(side.atMs, c, at), subject: subj,
        change: tag === 's' ? { kind: 'slot', part: u(side.part, c, at, 1n, 255n), slot: slot(side.slot as Value, c, at) }
          : tag === 'p' ? { kind: 'pin', rung: rung(side.pin, c, at) }
            : { kind: 'choice', rung: rung(side.choice, c, at) } };
      if (subj.kind === 'record') {
        switch (change.change.kind) {
          case 'slot': {
            const index = Number(change.change.part) - 1;
            if (index >= record.summaries.length) c.fail('journal-reference', at);
            record.summaries[index] = change.change.slot; break;
          }
          case 'pin': record.pin = change.change.rung; break;
          case 'choice': record.choice = change.change.rung; break;
        }
      }
      record.changes.push(change);
    } else c.note('unknown-variant', at, tag);
  }
  if (body) c.gap('journal-tail', { path });
  return records;
}
