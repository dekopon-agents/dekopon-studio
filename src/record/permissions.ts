import { Context, field, known, wellFormed } from './json';
import type { ObjectValue } from './json';
import type { BrokerDecision, ChatRecord, EvidenceRecord, Fact, Json, Location, ParticipantObservation, SpanKey } from './types';

export const permissionAttributes = ['capability.id', 'outcome', 'agent', 'conversation.id', 'principal', 'subject', 'participant.handle', 'principal.kind', 'turn.started_by',
  'space.id', 'asker.allowed', 'space.allowed', 'decision.denied_by', 'decision.allowed', 'decision.reason',
  'invocation.id', 'decision.id', 'provider', 'authorized.by', 'actor.kind', 'actor.id', 'via',
  'policy.ids', 'space.policy.ids', 'policy.digest', 'decision.point', 'policy.error_ids', 'policy.errors_present',
  'transport.id', 'transport.kind', 'conversation.kind', 'conversation.container', 'conversation.thread',
  'delivery.kind', 'delivery.id', 'effect', 'risk', 'credential', 'channel'];
const booleanAttributes = new Set(['asker.allowed', 'space.allowed', 'decision.allowed', 'policy.errors_present']);
const signature = (...parts: string[]) => JSON.stringify(parts);
function fact<T extends string | boolean>(e: EvidenceRecord, attribute: string, c: Context): Fact<T> {
  const value = e.attributes[attribute];
  return value === undefined ? c.unknown('permission-evidence', field(e.at, attribute), { attribute }) : known(value as T);
}
function joinedKey(decision: { id: Fact<string>; invocation: Fact<string>; evidence: EvidenceRecord }): string | undefined {
  return decision.id.state === 'known' && decision.invocation.state === 'known'
    ? signature(decision.evidence.key.traceId, decision.invocation.value, decision.id.value) : undefined;
}
function unknownActor(c: Context, at: Location): Fact<string> {
  return c.unknown('permission-attribution', at, { attribute: 'principal', detail: 'No unique broker principal matches the authenticated receipt subject.' });
}

// Validate decoded OTLP values before bigint-to-JSON normalization can erase types.
export function validatePermissionAttributes(attributes: ObjectValue, at: Location, c: Context) {
  for (const name of permissionAttributes) {
    const value = attributes[name];
    if (value === undefined) continue;
    if (booleanAttributes.has(name) ? typeof value !== 'boolean' : typeof value !== 'string' || !wellFormed(value))
      c.fail('known-event-shape', field(at, name));
  }
}
function participantText(content: Json | undefined, c: Context, at: Location): string | undefined {
  if (typeof content === 'string') return content;
  // v0.70.0 serializes every ContentPart as a string; the prefix is in part zero.
  if (Array.isArray(content) && content.length && content.every(part => typeof part === 'string')) return content[0] as string;
  c.gap('permission-evidence', field(at, 'content'), { attribute: 'participant prefix',
    detail: 'Unsupported user message content; participant evidence is unavailable.' });
}
export function permissions(record: ChatRecord, c: Context) {
  const decisionsByTrace = new Map<string, BrokerDecision[]>();
  const decisionsById = new Map<string, BrokerDecision[]>();
  const identityAttestations = new Map<string, SpanKey>();
  const principalsBySubject = new Map<string, Set<string>>();
  for (const e of record.evidence) if (e.name === 'broker.decision') {
    const denier = e.attributes['decision.denied_by'];
    let deniedBy: BrokerDecision['deniedBy'];
    if (denier === 'asker' || denier === 'space' || denier === 'both') deniedBy = known(denier);
    else if (denier === undefined && e.attributes['decision.allowed'] === true) deniedBy = known(null);
    else {
      if (typeof denier === 'string') c.note('unknown-variant', field(e.at, 'decision.denied_by'), denier);
      deniedBy = c.unknown('permission-evidence', field(e.at, 'decision.denied_by'), { attribute: 'decision.denied_by' });
    }
    const decision: BrokerDecision = { evidence: e,
      id: fact(e, 'decision.id', c), invocation: fact(e, 'invocation.id', c), capability: fact(e, 'capability.id', c),
      principal: fact(e, 'principal', c), subject: fact(e, 'subject', c), participant: fact(e, 'participant.handle', c),
      allowed: fact(e, 'decision.allowed', c), space: fact(e, 'space.id', c),
      askerAllowed: fact(e, 'asker.allowed', c), spaceAllowed: fact(e, 'space.allowed', c), deniedBy };
    record.permissions.decisions.push(decision);
    const trace = decisionsByTrace.get(e.key.traceId) ?? [];
    trace.push(decision); decisionsByTrace.set(e.key.traceId, trace);
    const join = joinedKey(decision);
    if (join) { const ids = decisionsById.get(join) ?? []; ids.push(decision); decisionsById.set(join, ids); }
    if (decision.principal.state === 'known') {
      if (decision.participant.state === 'known') identityAttestations.set(signature(e.key.traceId, decision.principal.value, decision.participant.value), e.key);
      if (decision.subject.state === 'known') {
        const subject = signature(e.key.traceId, decision.subject.value);
        const values = principalsBySubject.get(subject) ?? new Set<string>();
        values.add(decision.principal.value); principalsBySubject.set(subject, values);
      }
    }
  }
  const effectsByTrace = new Map<string, typeof record.permissions.effects>();
  const receiptsByTrace = new Map<string, { evidence: EvidenceRecord; subject: Fact<string> }[]>();
  for (const e of record.evidence) {
    if (e.name === 'gateway.message.received') {
      const receipts = receiptsByTrace.get(e.key.traceId) ?? [];
      receipts.push({ evidence: e, subject: fact(e, 'subject', c) }); receiptsByTrace.set(e.key.traceId, receipts);
    }
    if (e.name !== 'broker.execution') continue;
    const id = fact<string>(e, 'decision.id', c), invocation = fact<string>(e, 'invocation.id', c);
    const join = joinedKey({ id, invocation, evidence: e });
    const candidates = join ? decisionsById.get(join) : undefined;
    const effect = { evidence: e, id, invocation, decisions: candidates ? known(candidates)
      : c.unknown<BrokerDecision[]>('permission-evidence', e.at, { attribute: 'broker.decision' }) };
    record.permissions.effects.push(effect);
    const effects = effectsByTrace.get(e.key.traceId) ?? [];
    effects.push(effect); effectsByTrace.set(e.key.traceId, effects);
  }
  for (const message of record.messages) {
    const receipts = receiptsByTrace.get(message.traceId) ?? [];
    if (!receipts.length) c.gap('permission-evidence', { path: 'trace/logs.jsonl', field: message.traceId }, { attribute: 'gateway.message.received' });
    const subject = receipts[0]?.subject;
    const principals = subject?.state === 'known' ? principalsBySubject.get(signature(message.traceId, subject.value)) : undefined;
    const principal = principals?.size === 1 ? known([...principals][0]) : unknownActor(c, { path: 'trace/logs.jsonl', field: message.traceId });
    const participants: ParticipantObservation[] = [];
    for (const call of message.calls) if (call.input.state === 'known') for (const [messageIndex, raw] of call.input.value.messages.entries()) {
      const payload = raw as Record<string, Json>;
      if (payload.role !== 'user') continue;
      const at = { path: 'trace/traces.jsonl', field: `messages[${messageIndex}]` };
      const content = participantText(payload.content, c, at);
      if (content === undefined) continue;
      const [header, joined] = content.split('\n', 3);
      const match = header.match(/^\[gateway: authenticated participant: ([^\],\n]+)(?:, handle (p[1-8]))?\]$/);
      if (!match) continue;
      const handle = match[2] ?? null;
      const observedJoinLine = joined?.match(/^\[gateway: participant joined; channel-downscoped capabilities: [^\]\n]*\]$/)?.[0] ?? null;
      const attestation = handle ? identityAttestations.get(signature(message.traceId, match[1], handle)) : undefined;
      participants.push({ principal: match[1], handle, call: call.key, messageIndex,
        observedJoinLine,
        surface: c.unknown('permission-evidence', at, { attribute: 'participant capability surface',
          detail: 'Transcript join-line text is unverified; broker principal/handle matches establish identity only, not capability grants.' }),
        identityAttestation: attestation ? known(attestation) : c.unknown('permission-attribution', at,
          { attribute: 'broker.decision', detail: 'Prompt labels can include replayed history; this handle is not corroborated by a current-turn broker decision.' }) });
    }
    record.permissions.turns.push({ traceId: message.traceId, ordinal: message.ordinal, receipts, principal, participants,
      decisions: decisionsByTrace.get(message.traceId) ?? [], effects: effectsByTrace.get(message.traceId) ?? [] });
  }
}
