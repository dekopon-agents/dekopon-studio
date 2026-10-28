import type { ChatRecord, EvidenceRecord, ModelCall, ReplayObservation, SummaryCall } from '../record';

export interface Step {
  id: string; time: string; label: string; traceId: string;
  call?: ModelCall; event?: EvidenceRecord; summary?: SummaryCall; replay?: ReplayObservation;
}
export const eventTitles: Record<string, { title: string; explanation: string }> = {
  'gateway.message.received': { title: 'Message received', explanation: 'The gateway recorded this inbound text.' },
  'gateway.admission': { title: 'Recorded admission', explanation: 'This admission outcome and combined depth were recorded. Separate queue inventories are unavailable.' },
  'agent.tool.script': { title: 'Tool script', explanation: 'The model requested this script. Its output is a separate observation.' },
  'agent.tool.output': { title: 'Tool output', explanation: 'This output was recorded for the tool call; a later model input shows what was sent next.' },
  'gateway_memory_projection': { title: 'Memory selected for replay', explanation: 'The gateway recorded the selected record IDs, representation counts and memory generation. Inspect the next call for its actual messages.' },
  'gateway_memory_selection': { title: 'Memory selection', explanation: 'Recorded representations and selection reasons are shown beside the frozen journal.' },
  'gateway_memory_published': { title: 'Journal record published', explanation: 'This record was appended. Its summaries may complete later; publication is not summary completion.' },
  'gateway_memory_summary_transition': { title: 'Summary slot changed', explanation: 'This is one recorded summary transition, not a reconstructed summary request.' },
  'gateway_memory_choice': { title: 'Representation choice', explanation: 'This is a recorded choice, not a recomputation of memory policy.' },
  'gateway_recalled': { title: 'History recalled', explanation: 'The gateway reported the source and size of the recalled history.' },
  'gateway_recall_failed': { title: 'History recall failed', explanation: 'The turn ran without the history this recall would have supplied.' },
  'gateway.progress': { title: 'Turn progress', explanation: 'This is a recorded progress observation; it does not establish a mailbox state interval.' },
  'reply.delivered': { title: 'Reply delivered', explanation: 'Delivery was recorded. Post-reply persistence and background summary work have separate observations.' },
};
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
      label: (eventTitles[event.name]?.title ?? event.name) + (event.name === 'gateway.admission' ? ` · ${event.attributes.outcome ?? 'unknown'}` : '') });
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
