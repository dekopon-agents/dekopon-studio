import type { Json } from './types';

export interface WireEvent { name: string; timeUnixNano: string; attributes: { key: string; value: Json }[] }
export interface WireSpan {
  traceId: string; spanId: string; parentSpanId: string; name: string;
  startTimeUnixNano: string; endTimeUnixNano: string; attributes: WireEvent['attributes']; events: WireEvent[];
}
const encoder = new TextEncoder();
export const traceA = 'a1'.repeat(16), traceB = 'b2'.repeat(16), traceSummary = 'c3'.repeat(16);
const base = 1800000000000000000n;
export const definitions = [{ type: 'function', function: { name: 'bash', description: 'Synthetic tool', parameters: { type: 'object' } } }];
export function attributes(values: Record<string, Json>): WireEvent['attributes'] {
  function value(v: Json): Json {
    if (typeof v === 'boolean') return { boolValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
    return { stringValue: typeof v === 'number' ? String(v) : v };
  }
  return Object.entries(values).map(([key, v]) => ({ key, value: value(v) }));
}
export function event(name: string, offset: number, values: Record<string, Json>): WireEvent {
  return { name, timeUnixNano: String(base + BigInt(offset)), attributes: attributes({ 'audit.event': name, ...values }) };
}
export function prompt(turn: number, scope: string, count: number, messages: Json[], offset: number): WireEvent {
  return event('agent.model.prompt', offset, { 'model.turn': turn, 'transcript.scope': scope, 'message.count': count,
    messages: JSON.stringify(messages), ...(scope === 'full' ? { 'gen_ai.tool.definitions': JSON.stringify(definitions) } : {}) });
}
export function span(traceId: string, spanId: string, parentSpanId: string, name: string, offset: number,
  events: WireEvent[] = [], attrs: Record<string, Json> = {}): WireSpan {
  return { traceId, spanId, parentSpanId, name, startTimeUnixNano: String(base + BigInt(offset)),
    endTimeUnixNano: String(base + BigInt(offset + 100)), attributes: attributes(attrs), events };
}
export function journalText(id = 1): string {
  const text = 'a\n🦀\\"z';
  const body = JSON.stringify({ b: [{ user: { text, original_bytes: encoder.encode(text).length } }, { asset: 7 }] }) + '\n';
  const token = JSON.stringify(text), start = body.indexOf(token) + 1;
  const header = { h: { id, nextRecordId: id + 1, turn: 1, atMs: 1, grant: Array(8).fill(0),
    model: { backend: 'codex', upstream: 'fixture', reported: null },
    summaries: ['Queued'], plan: { model: 'summary', parts: [200], maxInputBytes: 131072 },
    assets: [{ id: 7, atMs: 1, name: 'synthetic.txt', mime: 'text/plain', size: 3,
      source: { kind: 'generated', capability: 'fixture', invocation: 'SOURCE_CANARY', nested: { source: 'NESTED_CANARY' } } }],
    nextAssetId: 8, bodyLen: encoder.encode(body).length,
    spans: [{ item: 0, field: { User: { original_bytes: encoder.encode(text).length } }, kind: 'escaped',
      relOffset: encoder.encode(body.slice(0, start)).length, len: encoder.encode(token.slice(1, -1)).length }],
    arrived: [{ item: 1, number: 7, kind: 'text-document', bytes: 3, summaries: [] }] } };
  return body + JSON.stringify(header) + '\n' +
    JSON.stringify({ s: { atMs: 2, record: id, part: 1, slot: { Generated: 'synthetic summary' } } }) + '\n' +
    JSON.stringify({ s: { atMs: 3, record: id, part: 1, slot: 'Running', subject: { asset: 7 } } }) + '\n' +
    JSON.stringify({ p: { atMs: 4, record: id, pin: 'metadata' } }) + '\n' +
    JSON.stringify({ c: { atMs: 5, record: id, choice: { summary: 1 } } }) + '\n';
}
export class Fixture {
  version = '0.66.0';
  journal: string | null = journalText();
  extraJournals = new Map<string, string>();
  manifestGaps: string[] = [];
  traceOverride?: string;
  rawLog?: Json;
  extraManifest: Record<string, Json> = {};
  spans: WireSpan[] = [
    span(traceA, '1000000000000001', '', 'gateway.message', 0),
    span(traceA, '1000000000000002', '1000000000000001', 'prompt.session', 10),
    span(traceA, '1000000000000003', '1000000000000002', 'prompt.model_turn', 20, [
      prompt(1, 'full', 2, [{ role: 'system', content: 'synthetic system' }, { role: 'user', content: 'first' }], 21),
      event('agent.model.answer', 22, { 'model.turn': 1, answer: '', tool_calls: '[{"id":"call-1"}]' }),
    ], { 'model.turn': 1 }),
    span(traceA, '1000000000000004', '1000000000000002', 'prompt.model_turn', 60, [
      prompt(2, 'delta', 4, [{ role: 'assistant', content: null }, { role: 'tool', content: 'synthetic output' }], 61),
      event('agent.model.answer', 62, { 'model.turn': 2, answer: 'first answer', tool_calls: '[]' }),
    ], { 'model.turn': 2 }),
    span(traceA, '1000000000000005', '1000000000000002', 'prompt.script', 30, [
      event('agent.tool.script', 31, { 'gen_ai.tool.call.id': 'call-1', script: 'fixture command' }),
      event('agent.tool.output', 32, { 'gen_ai.tool.call.id': 'call-1', output: 'synthetic output' }),
      event('gateway_memory_published', 33, { 'memory.record.id': 1, 'memory.generation': 1 }),
    ]),
    span(traceA, '1000000000000006', '1000000000000003', 'model.complete', 24, [], {
      'model.name': 'fixture', 'model': 'synthetic', 'model.backend': 'openai-compatible', 'model.dialect': 'chat-completions',
      'model.stream': true,
    }),
    span(traceA, '1000000000000007', '1000000000000005', 'shell.command', 40, [], {
      'shell.command.name': 'fixture', 'shell.command.arguments': '[]', 'shell.command.arguments.bytes': 2,
      'shell.command.output': '', 'shell.command.output.bytes': 0, 'shell.command.exit_code': 0, outcome: 'succeeded',
    }),
    span(traceB, '2000000000000001', '', 'gateway.message', 1000),
    span(traceB, '2000000000000004', '', 'gateway.message', 1500),
    span(traceB, '2000000000000002', '2000000000000001', 'prompt.session', 1010),
    span(traceB, '2000000000000003', '2000000000000002', 'prompt.model_turn', 1020, [
      prompt(1, 'full', 1, [{ role: 'user', content: 'second' }], 1021),
      event('agent.model.answer', 1022, { 'model.turn': 1, answer: 'second answer', tool_calls: '[]' }),
    ], { 'model.turn': 1 }),
    span(traceSummary, '3000000000000001', '', 'memory.summarize', 500, [
      event('gateway_memory_summary_transition', 501, { 'memory.record.id': 1, 'memory.summary.part': 1,
        'memory.summary.from': 'running', 'memory.summary.to': 'generated',
        'memory.summary.text': 'synthetic summary', 'memory.summary.bytes': 17 }),
    ], { 'memory.record.id': 1, 'memory.summary.part': 1 }),
    span(traceSummary, '3000000000000002', '3000000000000001', 'model.complete', 502),
  ];
  async files(): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    const put = (path: string, raw: string) => files.set(path, encoder.encode(raw));
    put('trace/traces.jsonl', this.traceOverride ?? JSON.stringify({ resourceSpans: [{
      resource: { attributes: attributes({ 'service.name': 'dekopon-gatewayd' }) },
      scopeSpans: [{ scope: { name: 'fixture' }, spans: this.spans }],
    }] }) + '\n');
    put('trace/logs.jsonl', JSON.stringify(this.rawLog ?? { resourceLogs: [] }) + '\n');
    if (this.journal !== null) put('journal/agent/stem.jsonl', this.journal);
    for (const [path, raw] of this.extraJournals) put(path, raw);
    async function ref(path: string) {
      const data = files.get(path);
      if (!data) return null;
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(data)));
      return { path, sha256: Array.from(digest, b => b.toString(16).padStart(2, '0')).join(''), bytes: data.length };
    }
    const config: Record<string, Json> = {};
    for (const name of ['scenario', 'catalog', 'broker', 'gateway', 'policies', 'collector']) {
      const path = 'config/' + name + (name === 'policies' ? '.cedar' : name === 'collector' ? '.yaml' : '.json');
      put(path, '{}'); config[name] = await ref(path);
    }
    const stdout: Record<string, Json> = { lossSignals: [] };
    for (const name of ['gateway', 'broker']) {
      put('stdout/' + name + '.jsonl', ''); put('stdout/' + name + '.stderr', '');
      stdout[name] = { stdout: await ref('stdout/' + name + '.jsonl'), stderr: await ref('stdout/' + name + '.stderr') };
    }
    put('stdout/collector.log', 'synthetic collector'); stdout.collector = await ref('stdout/collector.log');
    put('driver.json', '{"messages":[]}'); put('grade.json', '{"gradeVersion":1}');
    const manifest = { bundleVersion: 1, kind: 'trial', dekopon: { version: this.version },
      attempt: { id: 'synthetic', startedAt: '2026-10-28T00:00:00Z', finishedAt: '2026-10-28T00:00:01Z' },
      scenario: { id: 'synthetic', config: config.scenario }, config, stdout,
      freeze: { lastRepliedMessage: 2, conversation: { kind: 'directMessage', id: 'synthetic' }, journalStems: ['agent/stem'],
        gateway: { signal: 'SIGTERM', drained: true, exitCode: 0 }, copiedAt: '2026-10-28T00:00:01Z' },
      trace: { format: 'otlp-jsonl', ...await ref('trace/traces.jsonl') },
      logs: { format: 'otlp-jsonl', ...await ref('trace/logs.jsonl') },
      journal: this.journal === null && !this.extraJournals.size ? null : {
        format: 'dekopon-gatewayd-journal (internal, unversioned on disk; v2 at dekopon 0.62.0)',
        files: await Promise.all([...files.keys()].filter(p => p.startsWith('journal/')).map(ref)),
      }, driver: await ref('driver.json'), grade: await ref('grade.json'),
      completeness: { status: 'complete', reasons: [] }, gaps: this.manifestGaps, seedDigest: null, ...this.extraManifest };
    put('manifest.json', JSON.stringify(manifest));
    return files;
  }
}


// v0.70.0 exports only admission depth, not mailbox inventories or state transitions.
export function studioFixture(): Fixture {
  const f = new Fixture(); f.version = '0.70.0';
  f.spans[1].attributes = attributes({ 'prompt.max_steps': 4, 'prompt.max_capability_calls': 2 });
  f.spans[1].events.push(event('gateway.progress', 11, { kind: 'started', max_steps: 4 }));
  f.spans[2].events.push(event('gateway.progress', 23, { kind: 'answered', turn: 1, tool_calls: 1 }));
  f.spans[2].events.push(event('accounting.model.turn', 23, { 'model.turn': 1, outcome: 'succeeded' }));
  f.spans[3].events = [f.spans[3].events[0],
    event('accounting.model.turn', 62, { 'model.turn': 2, outcome: 'steered' }),
    event('agent.model.answer', 63, { 'model.turn': 2, answer: 'interrupted draft', tool_calls: '[]', 'stream.interrupted': true })];
  f.spans[2].endTimeUnixNano = String(base + 29n);
  f.spans[3].endTimeUnixNano = String(base + 69n);
  f.spans.push(span(traceA, '1000000000000008', '1000000000000002', 'prompt.model_turn', 90, [
    prompt(2, 'full', 5, [{ role: 'system', content: 'synthetic system' }, { role: 'user', content: 'first' },
      { role: 'assistant', content: null }, { role: 'tool', content: 'synthetic output' },
      { role: 'user', content: 'steer: include the synthetic detail' }], 91),
    event('accounting.model.turn', 92, { 'model.turn': 2, outcome: 'succeeded' }),
    event('agent.model.answer', 93, { 'model.turn': 2, answer: 'steered answer', tool_calls: '[]' }),
  ], { 'model.turn': 2 }));
  f.spans[0].events.push(event('gateway.message.received', 1, { text: 'first' }),
    event('gateway.admission', 52, { outcome: 'steered', transport: 'synthetic', 'conversation.id': 'synthetic', 'queue.depth': 1 }),
    event('gateway.admission', 95, { outcome: 'queued', transport: 'synthetic', 'conversation.id': 'synthetic', 'queue.depth': 2 }));
  f.spans.push(span(traceA, '1000000000000009', '1000000000000001', 'gateway.session', 5, [], {
    'conversation.turns': 0, 'conversation.bytes': 0, 'generation.digest': 'synthetic-generation',
  }));
  f.spans.push(span(traceB, '2000000000000009', '2000000000000001', 'gateway.session', 1005, [
    event('gateway_recalled', 1006, { source: 'journal', messages: 1, delta: 0 }),
    event('gateway_memory_projection', 1007, { 'memory.generation': 1, 'memory.record.ids': ['1'],
      'memory.rung.summary': 1, 'memory.bytes': 17 }),
  ], { 'conversation.turns': 1, 'conversation.bytes': 90, 'generation.digest': 'synthetic-generation' }));
  f.spans.find(s => s.spanId === '2000000000000002')!.attributes = attributes({ 'prompt.max_steps': 4 });
  f.spans.find(s => s.spanId === '2000000000000003')!.events = [
    prompt(1, 'full', 3, [{ role: 'user', content: 'first with steer' },
      { role: 'assistant', content: 'steered answer' }, { role: 'user', content: 'second' }], 1021),
    event('accounting.model.turn', 1022, { 'model.turn': 1, outcome: 'succeeded' }),
    event('agent.model.answer', 1023, { 'model.turn': 1, answer: 'second answer', tool_calls: '[]' }),
  ];
  return f;
}
