import { useState } from 'react';
import type { BrokerDecision, ChatRecord } from '../record';
import { whatIf } from '../wasm';
import { FactView, GapView, JsonView } from './Facts';

function DecisionView({ decision }: { decision: BrokerDecision }) {
  return <section className="journal-record" aria-label={`Broker decision ${decision.id.state === 'known' ? decision.id.value : 'unknown'}`}><h4>Recorded broker decision</h4>
    <dl><dt>Decision</dt><dd><FactView fact={decision.id} /></dd>
      <dt>Principal authorizing this request</dt><dd><FactView fact={decision.principal} /></dd>
      <dt>Capability</dt><dd><FactView fact={decision.capability} /></dd>
      <dt>Recorded allowed</dt><dd aria-label="Recorded allowed"><FactView fact={decision.allowed} /></dd>
      <dt>Space</dt><dd><FactView fact={decision.space} /></dd>
      <dt>Asker allowed</dt><dd><FactView fact={decision.askerAllowed} /></dd>
      <dt>Space allowed</dt><dd><FactView fact={decision.spaceAllowed} /></dd>
      <dt>Denied by</dt><dd aria-label="Denied by"><FactView fact={decision.deniedBy} /></dd></dl>
    <details><summary>Authenticated context, policy IDs and provenance</summary><JsonView value={decision.evidence} /></details>
  </section>;
}
export default function Permissions({ record }: { record: ChatRecord }) {
  const [turnIndex, setTurnIndex] = useState(0);
  const [principal, setPrincipal] = useState('');
  const [capability, setCapability] = useState('');
  const [result, setResult] = useState<ReturnType<typeof whatIf>>();
  const [failed, setFailed] = useState(false);
  const turn = record.permissions.turns[turnIndex];
  function evaluate() {
    try { setResult(whatIf(record.permissions, principal, capability)); setFailed(false); }
    catch { setFailed(true); setResult(undefined); }
  }
  return <section className="panel" aria-label="Multi-user permissions"><h2>Multi-user permissions</h2>
    <p>Recorded broker decisions are authoritative. Prompt join lines describe what the model saw; they do not supply a complete policy world.</p>
    <label>Recorded message <select aria-label="Permission message" value={turnIndex}
      onChange={event => { setTurnIndex(Number(event.target.value)); setResult(undefined); }}>
      {record.permissions.turns.map((t, i) => <option key={t.traceId} value={i}>Message {t.ordinal}</option>)}
    </select></label>
    {turn && <><h3>Authenticated senders</h3>
      {!turn.receipts.length && <p>No authenticated receipt exported for this message.</p>}
      {turn.receipts.map((receipt, i) => <section key={i}><FactView fact={receipt.subject} />
        <details><summary>Receipt provenance</summary><JsonView value={receipt.evidence} /></details></section>)}
      <h3>Active principal</h3><FactView fact={turn.principal} />
      <p>The principal is joined from the receipt subject to broker attribution in this trace, not inferred from message prose.</p>
      <h3>Participant observations in recorded inputs</h3>
      {!turn.participants.length && <p>No gateway participant prefix was exported.</p>}
      {turn.participants.map((participant, i) => <section key={i} aria-label={`Participant ${participant.principal} · call ${participant.call.spanId} · message ${participant.messageIndex}`}><h4>{participant.principal} · {participant.handle ?? 'no current handle'}</h4>
        {participant.observedJoinLine !== null && <><p>Unverified join-line text</p><JsonView label="Unverified join-line text" value={participant.observedJoinLine} /></>}
        <FactView fact={participant.surface} />
        <p>Recorded prompt prefix · call {participant.call.spanId} · message index {participant.messageIndex}</p>
        {participant.identityAttestation.state === 'known' ? <p>Identity-only match in current-turn broker span (does not verify capabilities): {participant.identityAttestation.value.spanId}</p>
          : <GapView gap={participant.identityAttestation.gap} />}
      </section>)}
      <h3>Requests and recorded decisions</h3>
      {!turn.decisions.length && <p>No broker decisions exported for this message.</p>}
      {turn.decisions.map((d, i) => <DecisionView key={i} decision={d} />)}
      <h3>Effects beside their decisions</h3>
      {!turn.effects.length && <p>No provider effects exported for this message. A denied request does not imply execution.</p>}
      {turn.effects.map((effect, i) => <section key={i}><h4>Recorded effect</h4><JsonView value={effect.evidence} />
        {effect.decisions.state === 'known' ? effect.decisions.value.map((d, i) => <DecisionView key={i} decision={d} />) : <GapView gap={effect.decisions.gap} />}
      </section>)}
    </>}
    <h3>What-if evaluation</h3>
    <p>Evaluation unavailable: successful bundle what-ifs are deferred until a core export supplies the complete provider inventory. This panel never replaces a recorded verdict.</p>
    <GapView gap={record.permissions.world.gap} />
    <details><summary>Bundle policy text</summary><FactView fact={record.permissions.policy} /></details>
    <label>Participant principal <input aria-label="What-if principal" value={principal} onChange={event => setPrincipal(event.target.value)} /></label>
    <label>Capability <input aria-label="What-if capability" value={capability} onChange={event => setCapability(event.target.value)} /></label>
    <button onClick={evaluate} disabled={record.permissions.policy.state === 'unknown'}>Check what-if availability</button>
    {result && <div role="status"><p>{result.engine} · evaluation unavailable: {result.reason}</p><GapView gap={record.permissions.world.gap} /></div>}
    {failed && <p role="alert">The local policy module could not initialize. Recorded decisions remain available.</p>}
    <details><summary>All broker evidence, including records without a message anchor</summary>
      <JsonView value={record.permissions.decisions} /><JsonView value={record.permissions.effects} />
    </details>
  </section>;
}
