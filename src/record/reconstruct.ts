import { array, canonical, Context, decimal, field, json, known, object, parse, text, wellFormed } from './json';
import type { ObjectValue, Value } from './json';
import type { Event, Export, Span } from './otlp';
import type { CallOutcome, ChatMessage, ChatRecord, EvidenceRecord, Fact, Json, Location, ModelCall, SpanKey, ToolExchange } from './types';

const settings = ['model.name', 'model', 'model.backend', 'model.dialect', 'model.stream', 'cache.style',
  'generation.max_output_tokens', 'generation.temperature', 'generation.top_p', 'reasoning.effort',
  'routing.allow_fallbacks', 'routing.require_parameters', 'routing.only', 'cache.ttl', 'tool_choice', 'parallel_tool_calls'];
const spans = new Set(['transport.receive', 'gateway.message', 'gateway.session', 'memory.persist', 'prompt.session',
  'prompt.model_turn', 'prompt.script', 'model.complete', 'memory.summarize', 'shell.command']);
const names = new Set(['agent.model.prompt', 'agent.model.answer', 'agent.tool.script', 'agent.tool.output',
  'gateway_memory_selection', 'gateway_memory_projection', 'gateway_memory_choice', 'gateway_memory_published',
  'gateway_memory_summary_transition', 'gateway_memory_summary_dropped', 'gateway_memory_pin_dropped',
  'gateway_memory_policy', 'gateway_memory_notice', 'gateway_journal_expired', 'gateway_journal_append_failed',
  'gateway_memory_record_failed', 'gateway_memory_retention_failed', 'accounting.model.turn',
  'gateway.message.received', 'reply.delivered', 'broker.execution', 'gateway.admission',
  'gateway.progress', 'gateway_recalled', 'gateway_recall_failed']);
const attributes = new Set([...settings, 'audit.event', 'event', 'model.turn', 'message.count', 'transcript.scope',
  'transcript.segment', 'transcript.segments', 'messages', 'gen_ai.tool.definitions', 'answer', 'tool_calls',
  'stream.interrupted', 'gen_ai.tool.call.id', 'script', 'output', 'memory.record.id', 'memory.generation',
  'memory.record.bytes', 'memory.record.items', 'memory.slots.queued', 'memory.summary.part', 'memory.summary.from',
  'memory.summary.to', 'memory.summary.failure', 'memory.summary.text', 'memory.summary.bytes',
  'memory.summary.queue_wait_ms', 'gen_ai.request.model', 'gen_ai.response.model', 'memory.record.ids',
  'memory.rung.native', 'memory.rung.summary', 'memory.rung.metadata', 'memory.omitted', 'memory.opaque.dropped',
  'memory.repacked', 'memory.bytes', 'memory.body.chunks', 'memory.body.file_bytes', 'memory.notice.kinds',
  'memory.record.first_shown', 'memory.records.omitted', 'memory.notice.bytes', 'memory.expiry.reason',
  'memory.records.evicted', 'choice', 'reason', 'io.kind', 'memory.pin.reason', 'memory.selection',
  'memory.hot_turns', 'memory.summaries.parts', 'memory.summaries.model', 'memory.summaries.max_input_bytes',
  'memory.capture.max_item_bytes', 'capability.id', 'outcome', 'error.type', 'text', 'message.text',
  'transport', 'agent', 'busy.cause', 'generation.digest', 'conversation.turns', 'conversation.bytes',
  'prompt.max_steps', 'prompt.max_capability_calls', 'shell.command.name', 'shell.command.arguments',
  'shell.command.arguments.bytes', 'shell.command.exit_code', 'shell.command.kind', 'shell.command.output',
  'shell.command.output.bytes', 'shell.command.stdout.bytes', 'usage.input_tokens', 'usage.output_tokens',
  'usage.total_tokens', 'queue.depth', 'conversation.id', 'kind', 'turn', 'turns', 'of',
  'max_steps', 'source', 'delta', 'class', 'by', 'duration_ms', 'note', 'note.eta_s',
  'word', 'argument_count', 'calls_used', 'calls_max', 'index', 'media_type', 'bytes', 'count',
  'elapsed_ms', 'first_delta_ms', 'stream.deltas', 'progress.dropped', 'progress.notes_dropped', 'tool_calls.bytes', 'messages.bytes', 'answer.bytes', 'output.bytes', 'script.bytes']);
const incidental = (key: string) => ['level', 'target', 'name', 'message'].includes(key) ||
  ['code.', 'thread.', 'log.', 'busy_ns', 'idle_ns'].some(prefix => key.startsWith(prefix));
const id = (key: SpanKey) => key.traceId + '/' + key.spanId;
const compare = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
function publicEvent(e: Event): EvidenceRecord {
  return { ...e, attributes: Object.fromEntries(Object.entries(e.attributes)
    .filter(([key]) => attributes.has(key)).map(([key, value]) => [key, json(value)])) };
}
function eventIdentity(e: Event) {
  return canonical([e.key.traceId, e.key.spanId, e.name, Object.fromEntries(Object.entries(e.attributes).filter(([key]) => !incidental(key)))]);
}
function unique(events: Event[]): Event[] {
  const seen = new Set<string>();
  return [...events].sort((a, b) => Number(a.origin !== 'span') - Number(b.origin !== 'span') || compare(a.time, b.time))
    .filter(e => { const key = eventIdentity(e); if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => compare(a.time, b.time));
}
function embedded(v: Value | undefined, c: Context, at: Location): Value {
  return parse(text(v, c, at, 'known-event-shape'), c, at);
}
function decFact(v: Value | undefined, c: Context, at: Location, kind: 'model-turn' | 'record-missing' | 'summary-missing'): Fact<string> {
  if (v === undefined) return c.unknown(kind, at);
  const n = decimal(v);
  if (n === undefined || n === '0') c.fail('known-event-shape', at);
  return known(n);
}
function bounded(o: ObjectValue, key: string, c: Context, at: Location, requiredLength: boolean): boolean {
  const v = o[key], length = decimal(o[key + '.bytes']);
  if (v === undefined) { c.gap('evidence-field', at, { attribute: key }); return false; }
  if (typeof v !== 'string' || !wellFormed(v) || requiredLength && length === undefined ||
    o[key + '.bytes'] !== undefined && length === undefined) {
    c.gap('evidence-field', at, { attribute: key }); return false;
  }
  if (length !== undefined && BigInt(length) !== BigInt(new TextEncoder().encode(v).length)) {
    c.gap('truncated-attribute', at, { attribute: key }); return false;
  }
  return true;
}
function validate(e: Event, c: Context): boolean {
  let final = false;
  if (e.name === 'agent.model.answer') {
    const answer = bounded(e.attributes, 'answer', c, e.at, false);
    if (bounded(e.attributes, 'tool_calls', c, e.at, false)) {
      const calls = array(embedded(e.attributes.tool_calls, c, e.at), c, e.at, 'known-event-shape');
      final = answer && !calls.length && e.attributes['stream.interrupted'] !== true;
    }
  }
  for (const [key, v] of Object.entries(e.attributes)) {
    if (!attributes.has(key) && !incidental(key)) c.note('unknown-field', e.at, key);
    if (['model.turn', 'message.count', 'transcript.segment', 'transcript.segments', 'memory.record.id',
      'memory.generation', 'memory.summary.part', 'memory.summary.bytes', 'queue.depth',
      'turn', 'turns', 'of', 'max_steps', 'conversation.turns', 'conversation.bytes',
      'prompt.max_steps', 'prompt.max_capability_calls', 'delta', 'note.eta_s', 'argument_count',
      'calls_used', 'calls_max', 'index', 'bytes', 'count', 'elapsed_ms', 'first_delta_ms',
      'stream.deltas', 'progress.dropped', 'progress.notes_dropped'].includes(key) && decimal(v) === undefined)
      c.fail('known-event-shape', field(e.at, key));
    if (['gen_ai.tool.definitions', 'answer', 'script', 'output',
      'gen_ai.tool.call.id', 'transcript.scope', 'memory.summary.text', 'memory.summary.from',
      'memory.summary.to', 'memory.summary.failure', 'choice', 'reason', 'outcome',
      'kind', 'conversation.id', 'source', 'class', 'by', 'generation.digest', 'note', 'word', 'media_type'].includes(key) && typeof v !== 'string')
      c.fail('known-event-shape', field(e.at, key));
    if (key === 'messages' || key === 'tool_calls') {
      const numeric = key === 'messages' && e.name === 'gateway_recalled' || key === 'tool_calls' && e.name === 'gateway.progress';
      if (numeric ? decimal(v) === undefined : typeof v !== 'string') c.fail('known-event-shape', field(e.at, key));
    }
    if (key === 'stream.interrupted' && typeof v !== 'boolean') c.fail('known-event-shape', field(e.at, key));
  }
  return final;
}
function evidenceFact(o: ObjectValue, attribute: string, at: Location, c: Context): Fact<string> {
  const v = o[attribute];
  if (v === undefined) return c.unknown('evidence-field', at, { attribute });
  return known(typeof v === 'string' ? v : decimal(v)!);
}
function outcome(events: Event[], at: Location, c: Context): Fact<CallOutcome> {
  const accounting = events.find(e => e.name === 'accounting.model.turn');
  const value = accounting?.attributes.outcome;
  if (value === 'succeeded' || value === 'steered' || value === 'interrupted' || value === 'refused' || value === 'failed')
    return known(value);
  if (value !== undefined && typeof value === 'string') c.note('unknown-variant', accounting!.at, value);
  if (value === undefined && events.some(e => e.name === 'agent.model.answer' && e.attributes['stream.interrupted'] === true))
    return known('interrupted');
  return c.unknown('call-outcome', at);
}
function callSettings(completes: Span[], at: Location, c: Context): Record<string, Fact<Json>> {
  const o = completes[0]?.attributes ?? {};
  return Object.fromEntries(settings.map(name => {
    const v = o[name], loc = field(completes[0]?.at ?? at, name);
    if (v === undefined) return [name, c.unknown<Json>('unknown-setting', loc, { attribute: name })];
    const booleans = ['model.stream', 'routing.allow_fallbacks', 'routing.require_parameters', 'parallel_tool_calls'];
    const numeric = ['generation.max_output_tokens', 'generation.temperature', 'generation.top_p'];
    if (booleans.includes(name) ? typeof v !== 'boolean'
      : numeric.includes(name) ? !['string', 'bigint', 'number'].includes(typeof v) || !Number.isFinite(Number(v))
        : typeof v !== 'string') c.fail('known-event-shape', loc);
    return [name, known(json(v))];
  }));
}
export function reconstruct(record: ChatRecord, exported: Export, c: Context) {
  const index = new Map(exported.spans.map(s => [id(s.key), s]));
  function descends(span: Span, ancestor: Span): boolean {
    const seen = new Set<string>(); let current: Span | undefined = span;
    while (current) {
      if (id(current.key) === id(ancestor.key)) return true;
      if (seen.has(id(current.key))) break;
      seen.add(id(current.key)); current = index.get(id({ traceId: current.key.traceId, spanId: current.parent }));
    }
    return false;
  }
  const events = unique(exported.events), recognized: Event[] = [];
  const finals = new Map<string, Event>();
  for (const e of events) {
    if (!names.has(e.name)) { c.note('unknown-event', e.at, e.name); continue; }
    if (validate(e, c)) finals.set(e.key.traceId, e);
    recognized.push(e); record.evidence.push(publicEvent(e));
    if (e.name === 'gateway.admission') record.admissions.push({ evidence: publicEvent(e),
      outcome: evidenceFact(e.attributes, 'outcome', e.at, c),
      conversation: evidenceFact(e.attributes, 'conversation.id', e.at, c),
      combinedDepth: evidenceFact(e.attributes, 'queue.depth', e.at, c) });
  }
  for (const s of exported.spans) {
    if (!spans.has(s.name)) c.note('unknown-span', s.at, s.name);
    else {
      const contextAttributes = Object.fromEntries(Object.entries(s.attributes).filter(([name]) =>
        ['conversation.turns', 'conversation.bytes', 'generation.digest', 'prompt.max_steps', 'prompt.max_capability_calls'].includes(name)));
      validate({ key: s.key, at: s.at, name: s.name, time: s.start, origin: 'span', attributes: contextAttributes }, c);
      record.spans.push({ ...s, attributes: publicEvent({ ...s, time: s.start, origin: 'span' }).attributes });
      if (s.name === 'gateway.session') record.replays.push({ key: s.key, time: s.start,
        priorTurns: evidenceFact(s.attributes, 'conversation.turns', s.at, c),
        priorBytes: evidenceFact(s.attributes, 'conversation.bytes', s.at, c),
        generation: evidenceFact(s.attributes, 'generation.digest', s.at, c) });
    }
    for (const key of Object.keys(s.attributes)) if (!attributes.has(key) && !incidental(key)) c.note('unknown-field', s.at, key);
    if (s.name === 'shell.command') {
      for (const key of ['shell.command.arguments', 'shell.command.output']) bounded(s.attributes, key, c, s.at, true);
      for (const key of ['shell.command.name', 'outcome']) if (typeof s.attributes[key] !== 'string' || !wellFormed(s.attributes[key] as string))
        c.gap('evidence-field', s.at, { attribute: key });
      if (decimal(s.attributes['shell.command.exit_code']) === undefined) c.gap('evidence-field', s.at, { attribute: 'shell.command.exit_code' });
    }
  }
  const anchors = new Map<string, Span>();
  for (const s of exported.spans) if (s.name === 'gateway.message') {
    const prior = anchors.get(s.key.traceId);
    if (!prior || compare(s.start, prior.start) < 0) anchors.set(s.key.traceId, s);
  }
  const byTrace = new Map<string, ChatMessage>();
  for (const [ordinal, s] of [...anchors.values()].sort((a, b) => compare(a.start, b.start)).entries()) {
    const final = finals.get(s.key.traceId);
    const message: ChatMessage = { traceId: s.key.traceId, ordinal: ordinal + 1, anchor: s.key,
      startedAt: s.start, finalAnswer: final ? known(publicEvent(final)) : c.unknown('missing-answer', s.at, s.key), calls: [], tools: [], evidence: record.evidence.filter(e => e.key.traceId === s.key.traceId) };
    record.messages.push(message); byTrace.set(message.traceId, message);
  }
  const state = new Map<string, { messages?: Json[]; messagesJson?: string; prompts: Location[]; tools?: SpanKey }>();
  const turns = exported.spans.filter(s => s.name === 'prompt.model_turn');
  const missingOwners = new Set<string>();
  for (const e of recognized) if (['agent.model.prompt', 'agent.model.answer'].includes(e.name) &&
    !index.has(id(e.key)) && !missingOwners.has(id(e.key))) {
    missingOwners.add(id(e.key));
    turns.push({ key: e.key, at: e.at, parent: '', name: 'prompt.model_turn', start: e.time, end: e.time, attributes: {} });
  }
  turns.sort((a, b) => compare(a.start, b.start));
  for (const span of turns) {
    const sessionSpan = index.get(id({ traceId: span.key.traceId, spanId: span.parent }));
    const session = sessionSpan?.name === 'prompt.session' ? known(sessionSpan.key)
      : c.unknown<SpanKey>('session-identity', span.at, span.key);
    const prior = session.state === 'known' ? state.get(id(session.value)) : undefined;
    const accumulated = prior ?? { prompts: [] };
    const own = recognized.filter(e => id(e.key) === id(span.key));
    const prompts = own.filter(e => e.name === 'agent.model.prompt');
    const answers = own.filter(e => e.name === 'agent.model.answer');
    const completes = exported.spans.filter(s => s.name === 'model.complete' && descends(s, span));
    const turn = decFact(prompts[0]?.attributes['model.turn'] ?? span.attributes['model.turn'], c, span.at, 'model-turn');
    const cap = sessionSpan?.name === 'prompt.session' ? sessionSpan.attributes['prompt.max_steps'] : undefined;
    const stepCap = cap === undefined ? c.unknown<string>('step-cap', sessionSpan?.at ?? span.at)
      : known(decimal(cap)!);
    const call: ModelCall = { key: span.key, session, turn, startedAt: span.start, endedAt: span.end,
      outcome: outcome(own, span.at, c), stepCap, input: c.unknown('missing-prompt', span.at, span.key),
      tools: c.unknown('tool-definitions', span.at, span.key),
      answer: answers.length ? known(publicEvent(answers[answers.length - 1])) : c.unknown('missing-answer', span.at, span.key),
      settings: callSettings(completes, span.at, c), completionSpans: completes.map(s => s.key) };
    const inputGap = call.input.state === 'unknown' ? call.input.gap : undefined;
    const toolsGap = call.tools.state === 'unknown' ? call.tools.gap : undefined;
    if (prompts.length) {
      if (inputGap) c.gaps.splice(c.gaps.indexOf(inputGap), 1);
      const first = prompts[0], f = first.attributes;
      const scope = f['transcript.scope'], count = decimal(f['message.count']);
      const segmented = f['transcript.segment'] !== undefined || f['transcript.segments'] !== undefined;
      const total = segmented ? decimal(f['transcript.segments']) : '1';
      const pieces = [...prompts].sort((a, b) => compare(decimal(a.attributes['transcript.segment']) ?? '0', decimal(b.attributes['transcript.segment']) ?? '0'));
      const validSegments = total !== undefined && BigInt(total) === BigInt(pieces.length) &&
        pieces.every((e, i) => (!segmented || decimal(e.attributes['transcript.segment']) === String(i + 1) &&
          decimal(e.attributes['transcript.segments']) === total) &&
          e.attributes['transcript.scope'] === scope && decimal(e.attributes['message.count']) === count &&
          decimal(e.attributes['model.turn']) === (turn.state === 'known' ? turn.value : undefined));
      if (!validSegments) {
        call.input = c.unknown('prompt-segments', first.at, span.key); accumulated.messages = undefined;
      } else if (!pieces.every(e => bounded(e.attributes, 'messages', c, e.at, false))) {
        call.input = c.unknown('prompt-continuity', first.at, span.key); accumulated.messages = undefined;
      } else {
        const encoded = pieces.map(e => e.attributes.messages as string).join('');
        const decoded = array(parse(encoded, c, first.at), c, first.at, 'known-event-shape');
        for (const message of decoded) {
          const m = object(message, c, first.at, 'known-event-shape');
          text(m.role, c, first.at, 'known-event-shape');
        }
        const messages = decoded.map(v => json(v, true));
        const next = scope === 'full' ? messages : scope === 'delta' && accumulated.messages
          ? [...accumulated.messages, ...messages] : undefined;
        if (scope !== 'full' && scope !== 'delta' && typeof scope === 'string') c.note('unknown-variant', first.at, scope);
        if (!next || count === undefined || BigInt(count) !== BigInt(next.length)) {
          call.input = c.unknown('prompt-continuity', first.at, span.key); accumulated.messages = undefined;
        } else {
          const old = accumulated.messagesJson?.trim().slice(1, -1) ?? '';
          const added = encoded.trim().slice(1, -1);
          accumulated.messagesJson = scope === 'full' ? encoded : '[' + [old, added].filter(s => s.trim()).join(',') + ']';
          accumulated.messages = next;
          accumulated.prompts = scope === 'full' ? pieces.map(e => e.at) : [...accumulated.prompts, ...pieces.map(e => e.at)];
          call.input = known({ provenance: 'reconstructed', messages: next, messagesJson: accumulated.messagesJson, prompts: [...accumulated.prompts] });
        }
      }
      if (scope === 'full') {
        accumulated.tools = undefined;
        const segmentOne = pieces.find(e => !segmented || decimal(e.attributes['transcript.segment']) === '1');
        if (segmentOne?.attributes['gen_ai.tool.definitions'] !== undefined) {
          const definitions = array(embedded(segmentOne.attributes['gen_ai.tool.definitions'], c, segmentOne.at), c, segmentOne.at, 'known-event-shape');
          for (const definition of definitions) object(definition, c, segmentOne.at, 'known-event-shape');
          record.toolSets.push({ key: span.key, definitions: definitions.map(v => json(v, true)), definitionsJson: segmentOne.attributes['gen_ai.tool.definitions'] as string }); accumulated.tools = span.key;
        }
      }
    } else accumulated.messages = undefined;
    if (accumulated.tools) {
      if (toolsGap) c.gaps.splice(c.gaps.indexOf(toolsGap), 1);
      call.tools = known(accumulated.tools);
    }
    if (session.state === 'known') state.set(id(session.value), accumulated);
    const message = byTrace.get(span.key.traceId);
    if (message) message.calls.push(call);
    else { record.unanchoredCalls.push(call); c.gap('bundle-evidence', span.at, { ...span.key, attribute: 'gateway.message' }); }
  }
  for (const message of record.messages) {
    if (!message.calls.length) c.gap('missing-prompt', { path: 'trace/traces.jsonl' }, { traceId: message.traceId });
    const tools: { exchange: ToolExchange; hasOutput: boolean }[] = [];
    for (const e of recognized.filter(e => e.key.traceId === message.traceId)) {
      if (e.name !== 'agent.tool.script' && e.name !== 'agent.tool.output') continue;
      const callId = e.attributes['gen_ai.tool.call.id'];
      const key = typeof callId === 'string' ? known(callId) : c.unknown<string>('tool-exchange', e.at, { attribute: 'gen_ai.tool.call.id' });
      let item = e.name === 'agent.tool.output' ? tools.find(t => !t.hasOutput && key.state === 'known' &&
        t.exchange.callId.state === 'known' && t.exchange.callId.value === key.value) : undefined;
      if (!item) {
        item = { exchange: { callId: key, script: c.unknown('tool-exchange', e.at, { attribute: 'script' }),
          output: c.unknown('tool-exchange', e.at, { attribute: 'output' }) }, hasOutput: false };
        tools.push(item);
      }
      const property = e.name === 'agent.tool.script' ? 'script' : 'output';
      if (bounded(e.attributes, property, c, e.at, false)) {
        const old = item.exchange[property];
        if (old.state === 'unknown') c.gaps.splice(c.gaps.indexOf(old.gap), 1);
        item.exchange[property] = known(e.attributes[property] as string);
      }
      if (property === 'output') item.hasOutput = true;
    }
    message.tools = tools.map(t => t.exchange);
  }
  function matching(recordId: Fact<string>, at: Location, turn?: Value) {
    if (recordId.state !== 'known') return [];
    const generation = decimal(turn);
    const candidates = record.journals.filter(r => r.key.recordId === recordId.value &&
      (generation === undefined || r.turn === generation));
    if (!candidates.length) c.gap('record-missing', at, { recordId: recordId.value });
    if (candidates.length > 1) c.gap('ambiguous-record-join', at, { recordId: recordId.value });
    return candidates;
  }
  for (const e of recognized) {
    if (e.name === 'gateway_memory_published') {
      const candidates = matching(decFact(e.attributes['memory.record.id'], c, e.at, 'record-missing'), e.at, e.attributes['memory.generation']);
      if (candidates.length === 1) candidates[0].publications.push(publicEvent(e));
    }
    if (['gateway_memory_selection', 'gateway_memory_projection', 'gateway_memory_choice'].includes(e.name) && e.attributes.reason === undefined)
      c.gap('selection-reason', e.at, e.key);
    if (e.name === 'gateway_journal_expired') c.gap('evicted-record', e.at, e.key);
    if (['gateway_journal_append_failed', 'gateway_memory_record_failed', 'gateway_memory_retention_failed'].includes(e.name))
      c.gap('append-failure', e.at, e.key);
    if (e.name === 'gateway_memory_choice') c.gap('decider-probability', e.at, e.key);
    if (e.name === 'gateway_memory_summary_transition' && e.attributes['memory.summary.to'] === 'generated') {
      const size = decimal(e.attributes['memory.summary.bytes']), text = e.attributes['memory.summary.text'];
      if (typeof text !== 'string') c.gap('summary-missing', e.at, e.key);
      else if (size === undefined || BigInt(size) !== BigInt(new TextEncoder().encode(text).length))
        c.gap('summary-truncated', e.at, { ...e.key, attribute: 'memory.summary.text' });
    }
  }
  for (const task of exported.spans.filter(s => s.name === 'memory.summarize')) {
    const recordId = decFact(task.attributes['memory.record.id'], c, task.at, 'record-missing');
    const part = decFact(task.attributes['memory.summary.part'], c, task.at, 'summary-missing');
    const completes = exported.spans.filter(s => s.name === 'model.complete' && descends(s, task));
    const candidates = matching(recordId, task.at);
    for (const span of completes.length ? completes : [task]) {
      const gap = { kind: 'summary-input-unavailable' as const, at: span.at, ...span.key,
        missingAttribute: 'agent.model.prompt' as const };
      c.gaps.push(gap);
      record.summaryCalls.push({ key: span.key, taskAttributes: Object.fromEntries(Object.entries(task.attributes)
        .filter(([key]) => attributes.has(key)).map(([key, v]) => [key, json(v)])), task: task.key, evidenceKind: span === task ? 'summary-task' : 'model-complete',
        at: span.at, recordId, part, input: { state: 'unknown', gap },
        recordCandidates: candidates.map(r => r.key), transitions: recognized.filter(e => e.name === 'gateway_memory_summary_transition' &&
          id(e.key) === id(task.key)).map(publicEvent),
        settings: callSettings(span === task ? [] : [span], span.at, c), completionSpans: completes.map(s => s.key) });
      if (candidates.length === 1) candidates[0].summaryCalls.push(span.key);
    }
  }
  for (const r of record.journals) {
    if (!r.publications.length) c.gap('publication-missing', r.at, { recordId: r.key.recordId });
    for (const [i, slot] of r.summaries.entries()) if (slot.state !== 'generated')
      c.gap('summary-missing', r.at, { recordId: r.key.recordId, part: String(i + 1) });
  }
}
