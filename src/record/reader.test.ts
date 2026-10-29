// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { readTrialBundle } from './index';
import { steps } from '../studio/model';
import type { Fact, ReadResult } from './types';
import { attributes, definitions, event, Fixture, journalText, prompt, span, studioFixture, traceA, traceB, traceSummary } from './fixtures';

function record(result: ReadResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.record;
}
function value<T>(fact: Fact<T>): T {
  expect(fact.state).toBe('known');
  if (fact.state !== 'known') throw new Error(fact.gap.kind);
  return fact.value;
}
test('two messages use their earliest trace anchors and rebuild full then delta with exported tools', async () => {
  const r = record(await readTrialBundle(await new Fixture().files()));
  expect(r.readerVersion).toBe(3); expect(r.bundleVersion).toBe(1); expect(value(r.dekoponVersion)).toBe('0.66.0');
  expect(r.messages.map(m => m.traceId)).toEqual([traceA, traceB]);
  expect(r.messages.map(m => m.ordinal)).toEqual([1, 2]);
  expect(r.messages[1].anchor.spanId).toBe('2000000000000001');
  expect(r.messages[0].startedAt).toBe('1800000000000000000');
  const calls = r.messages[0].calls;
  expect(calls).toHaveLength(2);
  expect(value(calls[1].input)).toMatchObject({ provenance: 'reconstructed', messages: [
    { role: 'system', content: 'synthetic system' }, { role: 'user', content: 'first' },
    { role: 'assistant', content: null }, { role: 'tool', content: 'synthetic output' },
  ], prompts: expect.any(Array) });
  expect(value(calls[1].session)).toEqual({ traceId: traceA, spanId: '1000000000000002' });
  expect(value(calls[1].turn)).toBe('2');
  expect(value(calls[1].tools)).toEqual(value(calls[0].tools));
  expect(r.toolSets.find(t => t.key.spanId === value(calls[1].tools).spanId)?.definitions).toEqual(definitions);
  expect(value(r.messages[1].calls[0].input).messages).toEqual([{ role: 'user', content: 'second' }]);
  expect(r.messages[0].tools.map(t => [value(t.callId), value(t.script), value(t.output)]))
    .toEqual([['call-1', 'fixture command', 'synthetic output']]);
  expect(value(calls[0].settings['model.dialect'])).toBe('chat-completions');
  expect(calls[0].settings['generation.temperature']).toMatchObject({ state: 'unknown', gap: { kind: 'unknown-setting' } });
  expect(r.gaps.filter(g => ['missing-prompt', 'tool-definitions', 'tool-exchange', 'prompt-continuity'].includes(g.kind))).toEqual([]);
});
test('journal publication and summary join by record id while each summary input remains explicitly unavailable', async () => {
  const r = record(await readTrialBundle(await new Fixture().files())), j = r.journals[0], s = r.summaryCalls[0];
  expect(j.key).toEqual({ agent: 'agent', stem: 'stem', recordId: '1' });
  expect(j.publications.map(p => p.attributes['memory.record.id'])).toEqual(['1']);
  expect(s.recordCandidates).toEqual([j.key]); expect(value(s.part)).toBe('1'); expect(value(s.recordId)).toBe('1');
  expect(s.task).toEqual({ traceId: traceSummary, spanId: '3000000000000001' });
  expect(s.key).toEqual({ traceId: traceSummary, spanId: '3000000000000002' });
  expect(s.input).toEqual({ state: 'unknown', gap: {
    kind: 'summary-input-unavailable', at: s.at, traceId: traceSummary, spanId: s.key.spanId, missingAttribute: 'agent.model.prompt',
  } });
  expect(s.transitions.map(t => t.attributes['memory.summary.to'])).toEqual(['generated']);
  expect(j.summaryCalls).toEqual([s.key]);
  expect(r.gaps.filter(g => g.kind === 'summary-input-unavailable')).toEqual([s.input.gap]);
  expect(j.items[0]).toMatchObject({ kind: 'user', text: 'a\n🦀\\"z' });
  expect(j.initialSummaries).toEqual([{ state: 'queued' }]);
  expect(j.summaries).toEqual([{ state: 'generated', text: 'synthetic summary' }]);
  expect(j.changes[0].subject).toEqual({ kind: 'record' });
  expect(j.changes[1].subject).toEqual({ kind: 'asset', number: '7' });
  expect(j.arrivals[0].summaries).toEqual([]); expect(value(j.pin)).toBe('metadata'); expect(value(j.choice)).toBe('summary-1');
  expect(j.representations.map(r => r.id)).toEqual(['native', 'summary-1', 'metadata']);
});
test('a summary task with no exported model child stays visible with its own span and gap', async () => {
  const f = new Fixture(); f.spans = f.spans.filter(s => s.spanId !== '3000000000000002');
  const r = record(await readTrialBundle(await f.files()));
  expect(r.summaryCalls[0]).toMatchObject({ evidenceKind: 'summary-task', key: { spanId: '3000000000000001' },
    input: { gap: { spanId: '3000000000000001', missingAttribute: 'agent.model.prompt' } } });
});
test('missing journal is a typed gap while trace messages remain readable', async () => {
  const f = new Fixture(); f.journal = null;
  const r = record(await readTrialBundle(await f.files()));
  expect(r.gaps).toContainEqual({ kind: 'journal-missing', at: { path: 'manifest.json', field: 'journal' } });
  expect(r.messages).toHaveLength(2);
});
test('manifest-named v2 journals yield a version-carrying format gap without decoding or losing trace calls', async () => {
  const f = new Fixture(); f.version = '0.62.0'; f.journal = 'synthetic v2 evidence intentionally not v3\n';
  const r = record(await readTrialBundle(await f.files()));
  expect(r.gaps).toContainEqual({ kind: 'journal-format', at: { path: 'manifest.json', field: 'journal' }, version: '0.62.0' });
  expect(r.journals).toEqual([]); expect(r.messages[0].calls).toHaveLength(2);
});
test('bounded attributes whose recorded byte count exceeds captured text produce typed truncation gaps', async () => {
  const f = new Fixture(), command = f.spans.find(s => s.name === 'shell.command')!;
  command.attributes = attributes({ 'shell.command.name': 'fixture', 'shell.command.arguments': '[]',
    'shell.command.arguments.bytes': 4097, 'shell.command.output': '', 'shell.command.output.bytes': 0,
    'shell.command.exit_code': 0, outcome: 'succeeded' });
  const r = record(await readTrialBundle(await f.files()));
  expect(r.gaps).toContainEqual(expect.objectContaining({ kind: 'truncated-attribute', attribute: 'shell.command.arguments' }));
});
test('unknown events, spans, attributes and journal fields are skipped with notes without keeping their values', async () => {
  const f = new Fixture();
  f.spans[0].events.push(event('future.event', 1, { payload: 'UNKNOWN_PAYLOAD_CANARY' }));
  f.spans.push(span(traceA, '1000000000000099', '', 'future.span', 2));
  f.spans[0].attributes.push(...attributes({ future: 'UNKNOWN_PAYLOAD_CANARY' }));
  f.journal = f.journal!.replace('"h":{', '"futureEnvelope":"UNKNOWN_PAYLOAD_CANARY","h":{"future":"UNKNOWN_PAYLOAD_CANARY",') + '{"future":{"payload":"UNKNOWN_PAYLOAD_CANARY"}}\n';
  const r = record(await readTrialBundle(await f.files()));
  expect(r.notes).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'unknown-event', name: 'future.event' }),
    expect.objectContaining({ kind: 'unknown-span', name: 'future.span' }),
    expect.objectContaining({ kind: 'unknown-field', name: 'future' }),
    expect.objectContaining({ kind: 'unknown-variant', name: 'future' }),
  ]));
  expect(JSON.stringify(r)).not.toContain('UNKNOWN_PAYLOAD_CANARY');
});
test.each([
  ['non-trace envelope', '{"resourceLogs":[]}', 'otlp-shape'],
  ['explicit null', '{"resourceSpans":null}', 'otlp-shape'],
  ['invalid JSON', '{', 'json'],
  ['non-finite number', '{"resourceSpans":[{"resource":{"attributes":[{"key":"x","value":{"doubleValue":"NaN"}}]}}]}', 'otlp-scalar'],
  ['out-of-range int64', '{"resourceSpans":[{"resource":{"attributes":[{"key":"x","value":{"intValue":"9223372036854775808"}}]}}]}', 'otlp-scalar'],
  ['wrong boolean', '{"resourceSpans":[{"resource":{"attributes":[{"key":"x","value":{"boolValue":"true"}}]}}]}', 'otlp-scalar'],
])('malformed OTLP %s returns a typed error instead of rejecting the promise', async (_name, raw, kind) => {
  const f = new Fixture(); f.traceOverride = raw;
  await expect(readTrialBundle(await f.files())).resolves.toMatchObject({ ok: false, errors: [{ kind }] });
});
test('OTLP AnyValue nesting is bounded before recursive conversion', async () => {
  const f = new Fixture(); let value: import('./types').Json = { stringValue: 'x' };
  for (let i = 0; i < 34; i++) value = { arrayValue: { values: [value] } };
  f.spans[0].attributes = [{ key: 'future', value }];
  expect(await readTrialBundle(await f.files())).toMatchObject({ ok: false, errors: [{ kind: 'otlp-depth' }] });
});
test('arrival inventory sources never reach records, notes, errors or network requests', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    const r = record(await readTrialBundle(await new Fixture().files()));
    expect(r.journals[0].assets).toEqual([{ id: '7', atMs: '1', name: 'synthetic.txt', mime: 'text/plain', size: '3' }]);
    expect(r.journals[0].arrivals[0]).toEqual({ item: '1', number: '7', kind: 'text-document', bytes: '3', summaries: [] });
    expect(JSON.stringify(r)).not.toContain('SOURCE_CANARY'); expect(JSON.stringify(r)).not.toContain('NESTED_CANARY');
    expect(fetch).not.toHaveBeenCalled();
    const bad = new Fixture(); bad.journal = bad.journal!.replace('"bodyLen":', '"bodyLen":"SOURCE_CANARY","bad":');
    const result = await readTrialBundle(await bad.files());
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('SOURCE_CANARY');
  } finally { fetch.mockRestore(); }
});
test('segmented prompts assemble in segment order before full then delta reconstruction', async () => {
  const f = new Fixture(), turn = f.spans[2], first = turn.events[0];
  const messages = first.attributes.find(a => a.key === 'messages')!.value as { stringValue: string };
  const encoded = messages.stringValue, cut = Math.floor(encoded.length / 2);
  const segment = (index: number, chunk: string) => event('agent.model.prompt', 21, {
    'model.turn': 1, 'transcript.scope': 'full', 'message.count': 2, 'transcript.segment': index,
    'transcript.segments': 2, messages: chunk, ...(index === 1 ? { 'gen_ai.tool.definitions': JSON.stringify(definitions) } : {}),
  });
  turn.events = [segment(2, encoded.slice(cut)), segment(1, encoded.slice(0, cut)), turn.events[1]];
  const r = record(await readTrialBundle(await f.files()));
  expect(value(r.messages[0].calls[0].input).messages).toHaveLength(2);
  expect(value(r.messages[0].calls[1].input).messages).toHaveLength(4);
  expect(r.gaps.filter(g => g.kind === 'prompt-segments')).toEqual([]);
});
test('a broken delta invalidates the input until a later full prompt resets it', async () => {
  const f = new Fixture();
  f.spans[3].events[0] = prompt(2, 'delta', 5, [{ role: 'tool', content: 'delta' }], 61);
  f.spans.push(span(traceA, '1000000000000008', '1000000000000002', 'prompt.model_turn', 80, [
    prompt(3, 'full', 1, [{ role: 'user', content: 'reset' }], 81),
  ], { 'model.turn': 3 }));
  const r = record(await readTrialBundle(await f.files())), calls = r.messages[0].calls;
  expect(calls[1].input).toMatchObject({ state: 'unknown', gap: { kind: 'prompt-continuity' } });
  expect(value(calls[2].input).messages).toEqual([{ role: 'user', content: 'reset' }]);
});
test('missing prompt segments are a gap and cannot masquerade as a rebuilt input', async () => {
  const f = new Fixture();
  f.spans[2].events[0].attributes.push(...attributes({ 'transcript.segment': 1, 'transcript.segments': 2 }));
  const r = record(await readTrialBundle(await f.files()));
  expect(r.messages[0].calls[0].input).toMatchObject({ state: 'unknown', gap: { kind: 'prompt-segments' } });
  expect(r.messages[0].calls[1].input.state).toBe('unknown');
});
test('ambiguous record ids across journals retain candidates without assigning publication or summary to either', async () => {
  const f = new Fixture(); f.extraJournals.set('journal/other/stem.jsonl', journalText());
  const r = record(await readTrialBundle(await f.files()));
  expect(r.summaryCalls[0].recordCandidates).toEqual(r.journals.map(j => j.key));
  expect(r.journals.every(j => !j.publications.length && !j.summaryCalls.length)).toBe(true);
  expect(r.gaps).toContainEqual(expect.objectContaining({ kind: 'ambiguous-record-join', recordId: '1' }));
});
test('journal u64 identifiers survive JSON decoding and serialization without floating point loss', async () => {
  const f = new Fixture();
  f.journal = f.journal!.replace(/"record":1/g, '"record":9007199254740993').replace('"id":1', '"id":9007199254740993')
    .replace('"nextRecordId":2', '"nextRecordId":9007199254740994');
  const r = record(await readTrialBundle(await f.files()));
  expect(r.journals[0].key.recordId).toBe('9007199254740993');
  expect(JSON.parse(JSON.stringify(r)).journals[0].nextRecordId).toBe('9007199254740994');
});
test('a permitted torn newest line is a gap while a corrupt byte index is a typed error', async () => {
  const f = new Fixture(); f.journal += '{"s":{"torn"';
  const r = record(await readTrialBundle(await f.files()));
  expect(r.journals).toHaveLength(1);
  expect(r.gaps).toContainEqual(expect.objectContaining({ kind: 'journal-tail' }));
  const bad = new Fixture(); bad.journal = bad.journal!.replace('"relOffset":', '"relOffset":9999,"old":');
  expect(await readTrialBundle(await bad.files())).toMatchObject({ ok: false, errors: [{ kind: 'journal-index' }] });
});
test('missing evidence, manifest gaps and incomplete reasons remain explicit without synthesized facts', async () => {
  const f = new Fixture(); f.manifestGaps = ['image bytes', 'decider probabilities'];
  f.extraManifest = { completeness: { status: 'incomplete', reasons: [{ code: 'telemetry_console_dropped', detail: 'synthetic loss' }] },
    freeze: null };
  const files = await f.files(); files.delete('trace/logs.jsonl');
  const r = record(await readTrialBundle(files));
  expect(r.gaps).toEqual(expect.arrayContaining([
    { kind: 'bundle-evidence', at: { path: 'manifest.json', field: 'gaps' }, detail: 'image bytes' },
    { kind: 'bundle-evidence', at: { path: 'manifest.json', field: 'gaps' }, detail: 'decider probabilities' },
    { kind: 'incomplete-bundle', at: { path: 'manifest.json', field: 'completeness' }, attribute: 'telemetry_console_dropped', detail: 'synthetic loss' },
    { kind: 'missing-file', at: { path: 'trace/logs.jsonl' } },
  ]));
  expect(r.freeze).toMatchObject({ state: 'unknown', gap: { kind: 'freeze' } });
});
test('a log copy of a span event is deduplicated by structured identity with the span event preferred', async () => {
  const f = new Fixture(), e = f.spans[4].events[2];
  f.rawLog = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ traceId: traceA, spanId: f.spans[4].spanId,
    timeUnixNano: e.timeUnixNano, body: { stringValue: e.name },
    attributes: [...e.attributes, ...attributes({ level: 'INFO', 'code.filepath': 'synthetic' })] }] }] }] };
  const r = record(await readTrialBundle(await f.files()));
  expect(r.journals[0].publications).toHaveLength(1); expect(r.journals[0].publications[0].origin).toBe('span');
});
test('two repeated steer observations survive in the reader and timeline while their log copies are suppressed', async () => {
  const f = new Fixture(), session = f.spans[1];
  const steers = [40, 50].map(time => event('gateway.progress', time, { kind: 'steered', turn: 2 }));
  session.events.push(...steers);
  f.rawLog = { resourceLogs: [{ scopeLogs: [{ logRecords: steers.map(e => ({
    traceId: traceA, spanId: session.spanId, timeUnixNano: e.timeUnixNano,
    body: { stringValue: e.name }, attributes: [...e.attributes, ...attributes({ level: 'INFO' })],
  })) }] }] };
  const r = record(await readTrialBundle(await f.files()));
  const retained = r.evidence.filter(e => e.name === 'gateway.progress' && e.attributes.kind === 'steered');
  expect(retained.map(e => ({ time: e.time, origin: e.origin, turn: e.attributes.turn }))).toEqual([
    { time: steers[0].timeUnixNano, origin: 'span', turn: '2' },
    { time: steers[1].timeUnixNano, origin: 'span', turn: '2' },
  ]);
  const timeline = steps(r).filter(step => step.event?.name === 'gateway.progress' && step.event.attributes.kind === 'steered');
  expect(timeline.map(step => step.time)).toEqual(steers.map(e => e.timeUnixNano));
  expect(new Set(timeline.map(step => step.id)).size).toBe(2);
});
test.each([0, 1])('repeated log observations remain when only %s span copies can be matched', async spanCopies => {
  const f = new Fixture(), session = f.spans[1];
  const steers = [40, 50].map(time => event('gateway.progress', time, { kind: 'steered', turn: 2 }));
  session.events.push(...steers.slice(0, spanCopies));
  f.rawLog = { resourceLogs: [{ scopeLogs: [{ logRecords: steers.map(e => ({
    traceId: traceA, spanId: session.spanId, timeUnixNano: e.timeUnixNano,
    body: { stringValue: e.name }, attributes: e.attributes,
  })) }] }] };
  const r = record(await readTrialBundle(await f.files()));
  const retained = r.evidence.filter(e => e.name === 'gateway.progress' && e.attributes.kind === 'steered');
  expect(retained.map(e => ({ time: e.time, origin: e.origin }))).toEqual(steers.map((e, i) => ({
    time: e.timeUnixNano, origin: i < spanCopies ? 'span' : 'log',
  })));
});
test('malformed known event shapes are errors and incorrect reference digests are refused', async () => {
  const f = new Fixture(); f.spans[2].events[0].attributes = attributes({ messages: true });
  expect(await readTrialBundle(await f.files())).toMatchObject({ ok: false, errors: [{ kind: 'known-event-shape' }] });
  const files = await new Fixture().files(), bytes = files.get('trace/traces.jsonl')!;
  bytes[0] = 32;
  expect(await readTrialBundle(files)).toMatchObject({ ok: false, errors: [{ kind: 'file-integrity' }] });
});

test('exact request JSON preserves large numeric literals while the decoded tool schema keeps safe numbers', async () => {
  const f = new Fixture();
  const raw = '[{"role":"user","content":"synthetic","n":9007199254740993}]';
  const tools = '[{"type":"function","function":{"name":"fixture","parameters":{"maximum":3}}}]';
  f.spans[2].events[0] = event('agent.model.prompt', 21, { 'model.turn': 1, 'transcript.scope': 'full',
    'message.count': 1, messages: raw, 'gen_ai.tool.definitions': tools });
  f.spans[3].events[0] = prompt(2, 'delta', 2, [{ role: 'tool', content: 'delta' }], 61);
  const r = record(await readTrialBundle(await f.files())), calls = r.messages[0].calls;
  expect(value(calls[0].input).messagesJson).toBe(raw);
  expect(value(calls[1].input).messagesJson).toBe('[{"role":"user","content":"synthetic","n":9007199254740993},{"role":"tool","content":"delta"}]');
  expect(r.toolSets[0].definitionsJson).toBe(tools);
  expect(r.toolSets[0].definitions).toEqual([{ type: 'function', function: { name: 'fixture', parameters: { maximum: 3 } } }]);
});
test('interrupted answers and tool proposals are not reported as the delivered final answer', async () => {
  const f = new Fixture();
  f.spans[3].events.push(event('agent.model.answer', 90, { 'model.turn': 2, answer: 'partial', tool_calls: '[]', 'stream.interrupted': true }));
  const r = record(await readTrialBundle(await f.files()));
  expect(value(r.messages[0].finalAnswer).attributes.answer).toBe('first answer');
});
test('unknown rungs remain explicitly unknown rather than becoming an absent pin', async () => {
  const f = new Fixture(); f.journal = f.journal!.replace('"pin":"metadata"', '"pin":"future-rung"');
  const r = record(await readTrialBundle(await f.files()));
  expect(r.journals[0].pin).toMatchObject({ state: 'unknown', gap: { kind: 'evidence-field', attribute: 'rung' } });
});
test('a span index cannot label user bytes as another known journal field', async () => {
  const f = new Fixture(); f.journal = f.journal!.replace('"User":', '"Assistant":');
  expect(await readTrialBundle(await f.files())).toMatchObject({ ok: false, errors: [{ kind: 'journal-index' }] });
});
test('nested manifest unknown fields are noted and skipped while invalid known metadata is an error', async () => {
  const f = new Fixture();
  f.extraManifest = { dekopon: { version: '0.66.0', source: { repository: 'synthetic', commit: 'synthetic', future: 'METADATA_CANARY' } } };
  const r = record(await readTrialBundle(await f.files()));
  expect(r.notes).toContainEqual(expect.objectContaining({ kind: 'unknown-field', name: 'future' }));
  expect(JSON.stringify(r)).not.toContain('METADATA_CANARY');
  f.extraManifest = { dekopon: { version: '0.66.0', source: [] } };
  expect(await readTrialBundle(await f.files())).toMatchObject({ ok: false, errors: [{ kind: 'manifest-shape' }] });
});
test('model events whose owning span was lost remain calls with explicit session gaps', async () => {
  const f = new Fixture(), owner = f.spans[2];
  f.spans = f.spans.filter(s => s !== owner);
  const prompts = owner.events;
  f.rawLog = { resourceLogs: [{ scopeLogs: [{ logRecords: prompts.map(e => ({
    traceId: traceA, spanId: owner.spanId, timeUnixNano: e.timeUnixNano, body: { stringValue: e.name }, attributes: e.attributes,
  })) }] }] };
  const r = record(await readTrialBundle(await f.files()));
  expect(r.messages[0].calls[0]).toMatchObject({ key: { spanId: owner.spanId }, session: { state: 'unknown', gap: { kind: 'session-identity' } } });
});
test('finite OTLP doubles stay valid while fractional or floating point timestamps are refused', async () => {
  const f = new Fixture();
  f.traceOverride = '{"resourceSpans":[{"resource":{"attributes":[{"key":"future","value":{"doubleValue":1e100}}]}}]}';
  expect((await readTrialBundle(await f.files())).ok).toBe(true);
  f.traceOverride = '{"resourceSpans":[{"scopeSpans":[{"spans":[{"startTimeUnixNano":1.0}]}]}]}';
  expect(await readTrialBundle(await f.files())).toMatchObject({ ok: false, errors: [{ kind: 'otlp-scalar' }] });
});

test('large valid exports assemble every span and event without a function-argument limit', async () => {
  const f = new Fixture(), extraCount = 130_000;
  f.spans = f.spans.concat(Array.from({ length: extraCount }, (_, i) =>
    span(traceA, (i + 1000).toString(16).padStart(16, '0'), '', 'future.span', i + 2000,
      [event('future.event', i + 2000, {})])));
  const r = record(await readTrialBundle(await f.files()));
  expect(r.notes.filter(n => n.kind === 'unknown-span' && n.name === 'future.span')).toHaveLength(extraCount);
  expect(r.notes.filter(n => n.kind === 'unknown-event' && n.name === 'future.event')).toHaveLength(extraCount);
}, 60_000);
test.each([1, null, 'future payload', [], { nested: true }].map(payload => [payload]))(
  'unknown journal index variants skip their payload and keep a note: %j', async payload => {
    const f = new Fixture();
    f.journal = f.journal!.replace(/"field":\{"User":\{"original_bytes":\d+\}\}/,
      '"field":' + JSON.stringify({ Future: payload }));
    const r = record(await readTrialBundle(await f.files()));
    expect(r.notes).toContainEqual(expect.objectContaining({ kind: 'unknown-variant', name: 'Future' }));
    expect(r.journals[0].spans).toEqual([]);
  });
test.each([
  'Generated',
  'Error',
  { Error: { kind: 'Io', detail: 'failure' } },
])('known summary variants require their declared payloads: %j', async malformed => {
  const f = new Fixture();
  f.journal = f.journal!.replace('"summaries":["Queued"]', '"summaries":' + JSON.stringify([malformed]));
  expect(await readTrialBundle(await f.files())).toMatchObject({
    ok: false, errors: [{ kind: 'journal-shape', at: { path: 'journal/agent/stem.jsonl' } }],
  });
});
test('journal headers must declare the immediate successor id', async () => {
  const f = new Fixture(); f.journal = journalText().replace('"nextRecordId":2', '"nextRecordId":3');
  expect(await readTrialBundle(await f.files())).toMatchObject({ ok: false, errors: [{ kind: 'journal-shape' }] });
});
test('journal records must follow the preceding header successor id', async () => {
  const f = new Fixture(); f.journal = journalText(1) + journalText(3);
  expect(await readTrialBundle(await f.files())).toMatchObject({ ok: false, errors: [{ kind: 'journal-reference' }] });
});
test.each(['s', 'p', 'c'])('a known %s side line cannot interrupt a journal body and its header', async tag => {
  const f = new Fixture(), next = journalText(2).split('\n');
  const side = journalText().split('\n').find(line => line.startsWith('{"' + tag + '":'))!;
  f.journal = journalText() + [next[0], side, ...next.slice(1)].join('\n');
  expect(await readTrialBundle(await f.files())).toMatchObject({ ok: false, errors: [{ kind: 'journal-reference' }] });
});
test('a retained journal may start at any id and end with one unfinished body', async () => {
  const f = new Fixture(); f.journal = journalText(7) + journalText(8) + '{"b":[]}\n';
  const r = record(await readTrialBundle(await f.files()));
  expect(r.journals.map(j => j.key.recordId)).toEqual(['7', '8']);
  expect(r.gaps).toContainEqual({ kind: 'journal-tail', at: { path: 'journal/agent/stem.jsonl' } });
});


test.each(['kind', 'id'])('freeze is unknown when its conversation lacks %s', async missing => {
  const f = new Fixture();
  f.extraManifest.freeze = { lastRepliedMessage: 2, conversation: { [missing === 'kind' ? 'id' : 'kind']: 'synthetic' },
    journalStems: ['agent/stem'], gateway: { signal: 'SIGTERM', drained: true, exitCode: 0 }, copiedAt: '2026-10-28T00:00:01Z' };
  const r = record(await readTrialBundle(await f.files()));
  expect(r.freeze).toMatchObject({ state: 'unknown', gap: { kind: 'freeze' } });
  expect(r.gaps).toContainEqual(expect.objectContaining({ kind: 'bundle-evidence', attribute: missing }));
});
test('bundle v1 refuses a non-null seedDigest as a typed manifest error', async () => {
  const f = new Fixture(); f.extraManifest.seedDigest = 'a'.repeat(64);
  expect(await readTrialBundle(await f.files())).toMatchObject({ ok: false,
    errors: [{ kind: 'manifest-shape', at: { path: 'manifest.json', field: 'seedDigest' } }] });
});


test('record v2 retains admissions, interrupted attempts and replay with typed mailbox gaps', async () => {
  const r = record(await readTrialBundle(await studioFixture().files()));
  expect(r.messages[0].calls.map(call => value(call.outcome))).toEqual(['succeeded', 'steered', 'succeeded']);
  expect(r.messages[0].calls.map(call => value(call.stepCap))).toEqual(['4', '4', '4']);
  expect(r.admissions.map(a => [value(a.outcome), value(a.combinedDepth)])).toEqual([['steered', '1'], ['queued', '2']]);
  expect(value(r.replays[1].priorTurns)).toBe('1');
  expect(value(r.replays[1].priorBytes)).toBe('90');
  expect(r.mailbox).toMatchObject({ steers: { state: 'unknown' }, followUps: { state: 'unknown' },
    runningInterval: { gap: { kind: 'mailbox-state-unavailable' } }, completingInterval: { state: 'unknown' } });
});
test('missing admission depth is a typed gap while malformed depth is a typed error', async () => {
  const f = studioFixture();
  const admission = f.spans[0].events.find(e => e.name === 'gateway.admission')!;
  admission.attributes = admission.attributes.filter(a => a.key !== 'queue.depth');
  const r = record(await readTrialBundle(await f.files()));
  expect(r.admissions[0].combinedDepth).toMatchObject({ state: 'unknown', gap: { kind: 'evidence-field', attribute: 'queue.depth' } });
  admission.attributes.push(...attributes({ 'queue.depth': false }));
  expect(await readTrialBundle(await f.files())).toMatchObject({ ok: false, errors: [{ kind: 'known-event-shape' }] });
});
