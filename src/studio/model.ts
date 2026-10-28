import type { ChatRecord, EvidenceRecord, ModelCall, ReplayObservation, SummaryCall } from '../record';

export interface Step {
  id: string; time: string; label: string; traceId: string;
  call?: ModelCall; event?: EvidenceRecord; summary?: SummaryCall; replay?: ReplayObservation;
}
export const key = (value: { traceId: string; spanId: string }) => value.traceId + '/' + value.spanId;
export function steps(record: ChatRecord): Step[] {
  const result: Step[] = [];
  for (const message of record.messages) for (const [i, call] of message.calls.entries())
    result.push({ id: key(call.key), time: call.startedAt, traceId: message.traceId, call,
      label: `Message ${message.ordinal} · attempt ${i + 1} · model turn ${call.turn.state === 'known' ? call.turn.value : '?'}` });
  for (const call of record.unanchoredCalls)
    result.push({ id: key(call.key), time: call.startedAt, traceId: call.key.traceId, call, label: 'Unanchored model attempt' });
  for (const [i, event] of record.evidence.entries()) {
    if (['agent.model.prompt', 'agent.model.answer', 'accounting.model.turn'].includes(event.name)) continue;
    result.push({ id: `event-${i}`, time: event.time, traceId: event.key.traceId, event,
      label: event.name + (event.name === 'gateway.admission' ? ` · ${event.attributes.outcome}` : '') });
  }
  for (const summary of record.summaryCalls) {
    const task = record.spans.find(span => key(span.key) === key(summary.task));
    result.push({ id: 'summary-' + key(summary.key), time: task?.start ?? '0', traceId: summary.key.traceId,
      label: 'Summary observation', summary });
  }
  for (const replay of record.replays)
    result.push({ id: 'session-' + key(replay.key), time: replay.time, traceId: replay.key.traceId,
      label: 'History replay into turn', replay });
  return result.sort((a, b) => BigInt(a.time) < BigInt(b.time) ? -1 : BigInt(a.time) > BigInt(b.time) ? 1 : a.id.localeCompare(b.id));
}
export function budget(record: ChatRecord, call: ModelCall) {
  const prior = [...record.messages.flatMap(m => m.calls), ...record.unanchoredCalls].filter(c =>
    c.session.state === 'known' && call.session.state === 'known' && key(c.session.value) === key(call.session.value) &&
    BigInt(c.startedAt) <= BigInt(call.startedAt));
  return { completed: prior.filter(c => c.outcome.state === 'known' && c.outcome.value === 'succeeded').length,
    unknown: prior.filter(c => c.outcome.state === 'unknown').length };
}
export function difference(previous: ModelCall | undefined, current: ModelCall) {
  const before = previous?.input.state === 'known' ? previous.input.value.messages : [];
  const after = current.input.state === 'known' ? current.input.value.messages : [];
  let shared = 0;
  while (shared < before.length && shared < after.length && JSON.stringify(before[shared]) === JSON.stringify(after[shared])) shared++;
  return { shared, removed: before.slice(shared), added: after.slice(shared) };
}
