import { useState } from 'react';
import type { ChatRecord, ModelCall, ReplayObservation, SummaryCall } from '../record';
import { FactView, GapView, JsonView, location } from './Facts';
import Permissions from './Permissions';
import { budget, difference, eventTitles, key, steps } from './model';

function CallView({ call, record }: { call: ModelCall; record: ChatRecord }) {
  const all = [...record.messages.flatMap(m => m.calls), ...record.unanchoredCalls];
  const previous = all.filter(c => c !== call && c.session.state === 'known' && call.session.state === 'known' &&
    key(c.session.value) === key(call.session.value) && BigInt(c.startedAt) < BigInt(call.startedAt)).at(-1);
  const change = difference(previous, call);
  const count = budget(record, call);
  const toolKey = call.tools.state === 'known' ? key(call.tools.value) : undefined;
  const tools = record.toolSets.find(t => key(t.key) === toolKey);
  const aborted = call.outcome.state === 'known' && ['steered', 'interrupted'].includes(call.outcome.value);
  return <>
    <div className="call-facts">
      <section><h3>Attempt outcome</h3>
        {aborted && <p className="badge">Aborted ({call.outcome.state === 'known' ? call.outcome.value : ''}) · does not consume a completed step</p>}
        <FactView fact={call.outcome} />
      </section>
      <section><h3>Step cap</h3>
        <output aria-label="Step budget">{call.session.state === 'known' ? count.completed : 'unknown'} recorded completed steps / {call.stepCap.state === 'known' ? call.stepCap.value : 'unknown'} cap</output>
        {count.unknown > 0 && <p>{count.unknown} attempt outcomes unknown; the count is a lower bound.</p>}
        {call.stepCap.state === 'unknown' && <GapView gap={call.stepCap.gap} />}
      </section>
    </div>
    <h3>Reconstructed call input</h3>
    <p>The recorded <code>messages</code> list, reconstructed by the reader. Opaque content and image bytes remain unavailable.</p>
    {call.input.state === 'known' ? <pre aria-label="Call input">{call.input.value.messagesJson}</pre> : <GapView gap={call.input.gap} />}
    {call.input.state === 'known' && (!previous || previous.input.state === 'known') && <details><summary>Input changes from previous call in this session</summary>
      <p>{change.shared} leading messages unchanged. Comparison uses the decoded view; exact JSON is above.</p>
      <h4>Removed suffix</h4><JsonView value={change.removed} />
      <h4>Added suffix</h4><JsonView value={change.added} />
    </details>}
    {previous?.input.state === 'unknown' && <p>Previous input is unavailable; no input difference can be established.</p>}
    <h3>Tool definitions</h3>
    {tools ? <pre aria-label="Tool definitions">{tools.definitionsJson}</pre> : <FactView fact={call.tools} />}
    <h3>Recorded memory selection and publication</h3>
    <p>Evidence for this message; each event retains its own timestamp. The frozen journal remains beside it.</p>
    <JsonView value={record.evidence.filter(event => event.key.traceId === call.key.traceId &&
      ['gateway_memory_selection', 'gateway_memory_projection', 'gateway_memory_choice', 'gateway_memory_published', 'gateway_memory_notice'].includes(event.name))} />
    <details><summary>Tool exchanges for this message</summary><JsonView value={record.messages.find(message => message.traceId === call.key.traceId)?.tools ?? []} /></details>
    <details><summary>Answer and effective settings</summary><FactView fact={call.answer} /><JsonView value={call.settings} /></details>
    <details><summary>Call provenance and model session</summary>
      <p>Trace: {call.key.traceId} · span: {call.key.spanId}</p>
      <p>Started: {call.startedAt} · ended: {call.endedAt} (Unix nanoseconds)</p>
      <FactView fact={call.session} />
      {call.input.state === 'known' && <ul>{call.input.value.prompts.map((at, i) => <li key={i}>{location(at)}</li>)}</ul>}
    </details>
  </>;
}
function SummaryView({ summary }: { summary: SummaryCall }) {
  return <section><h3>Summary observation · {summary.evidenceKind}</h3>
    <p>Task {summary.task.spanId} · observation {summary.key.spanId}</p>
    <h4>Record and part</h4><FactView fact={summary.recordId} /><FactView fact={summary.part} />
    <h4>Summary input</h4><GapView gap={summary.input.gap} />
    <h4>Observed transitions</h4><JsonView value={summary.transitions} />
    <details><summary>Candidate records, task attributes and effective settings</summary>
      <JsonView value={summary.recordCandidates} /><JsonView value={summary.taskAttributes} /><JsonView value={summary.settings} />
    </details>
  </section>;
}
function ReplayView({ replay }: { replay: ReplayObservation }) {
  return <section><h3>History replay into this turn</h3>
    <p>These are recorded session totals, not a simulated replay.</p>
    <dl><dt>Prior exchanges</dt><dd><FactView fact={replay.priorTurns} /></dd>
      <dt>Prior bytes</dt><dd><FactView fact={replay.priorBytes} /></dd>
      <dt>Configuration generation digest</dt><dd><FactView fact={replay.generation} /></dd></dl>
    <p>Select this turn’s call to inspect the replayed messages actually sent. Memory generation and record selection appear on projection/publication steps.</p>
  </section>;
}
function Mailbox({ record, time }: { record: ChatRecord; time: string }) {
  const observations = record.admissions.filter(e => BigInt(e.evidence.time) <= BigInt(time));
  return <section aria-label="Mailbox evidence"><h3>Mailbox evidence</h3>
    <p>Admissions report combined depth (steers, follow-ups and authorizing participants). Each value belongs to its recorded admission; it is not the current queue length.</p>
    <table><thead><tr><th>Admission time (ns)</th><th>Conversation</th><th>Outcome</th><th>Combined depth</th></tr></thead>
      <tbody>{observations.map((event, i) => <tr key={i}><td>{event.evidence.time}</td><td><FactView fact={event.conversation} /></td>
        <td><FactView fact={event.outcome} /></td><td><FactView fact={event.combinedDepth} /></td></tr>)}</tbody></table>
    {!observations.length && <p>No admissions recorded before this observation.</p>}
    <h4>Steer queue inventory: unknown</h4><FactView fact={record.mailbox.steers} />
    <h4>Follow-up queue inventory: unknown</h4><FactView fact={record.mailbox.followUps} />
    <h4>RUNNING interval: unknown</h4><FactView fact={record.mailbox.runningInterval} />
    <h4>COMPLETING interval: unknown</h4><FactView fact={record.mailbox.completingInterval} />
    <p>Exact queue drains and RUNNING → COMPLETING transitions are not exported by Dekopon v0.70.0. Exact mailbox animation awaits a core export.</p>
  </section>;
}
function FrozenJournal({ record }: { record: ChatRecord }) {
  return <aside className="panel" aria-label="Frozen journal"><h2>Journal at the captured freeze</h2>
    <FactView fact={record.freeze} />
    <p>This is the captured journal, beside the selected evidence. Moving the cursor does not create a historical freeze.</p>
    {!record.journals.length && <p>Journal state unavailable. See the journal gaps below.</p>}
    {record.journals.map(j => <section key={JSON.stringify(j.key)} className="journal-record"><h3>{j.key.agent}/{j.key.stem} · record {j.key.recordId}</h3>
      <h4>Retained original items</h4><JsonView value={j.items} />
      <h4>Representations and lineage</h4><JsonView value={{ representations: j.representations, model: j.model, plan: j.plan, turn: j.turn }} />
      <h4>Summary slots at freeze</h4><JsonView value={{ initial: j.initialSummaries, frozen: j.summaries }} />
      <h4>Pin</h4><FactView fact={j.pin} /><h4>Choice</h4><FactView fact={j.choice} />
      <details><summary>Slot changes, reads, publication, grants and assets</summary>
        <JsonView value={{ changes: j.changes, publications: j.publications, grant: j.grant,
          arrivals: j.arrivals, assets: j.assets, spans: j.spans, summaryCalls: j.summaryCalls }} />
      </details>
    </section>)}
  </aside>;
}
export default function Studio({ record }: { record: ChatRecord }) {
  const observations = steps(record);
  const [cursor, setCursor] = useState(() => Math.max(0, observations.findIndex(step => step.call)));
  const [mode, setMode] = useState<'forensic' | 'context' | 'permissions'>('forensic');
  const selected = observations[cursor];
  return <>
    <section className="record-heading"><h2>Opened bundle</h2>
      <p>Reader v{record.readerVersion} · bundle v{record.bundleVersion} · {record.messages.length} messages · {record.gaps.length} gaps · {record.notes.length} notes</p>
      <details><summary>Build identity, catalog/policy references and completeness</summary>
        <FactView fact={record.dekoponVersion} /><JsonView value={record.identity} />
        <JsonView value={record.references} /><FactView fact={record.completeness} />
      </details>
    </section>
    <nav className="mode-switch" aria-label="Studio views">
      <button aria-pressed={mode === 'forensic'} onClick={() => setMode('forensic')}>Forensic view</button>
      <button aria-pressed={mode === 'context'} onClick={() => setMode('context')}>Context view</button>
      <button aria-pressed={mode === 'permissions'} onClick={() => setMode('permissions')}>Permissions</button>
    </nav>
    {mode === 'permissions' ? <Permissions record={record} /> : <>
    <div className="studio-layout">
      <nav className="panel observations" aria-label="Recorded observations"><h2>{mode === 'forensic' ? 'Messages and model calls' : 'Turn timeline'}</h2>
        {mode === 'forensic' ? <>
          {record.messages.map(message => <section key={message.traceId}><h3>Message {message.ordinal}</h3>
            <p className="identifier">{message.traceId}</p>
            {!message.calls.length && <p>No model calls recorded.</p>}
            {observations.filter(step => step.call && step.traceId === message.traceId).map(step =>
              <button key={step.id} aria-current={selected?.id === step.id ? 'step' : undefined}
                onClick={() => setCursor(observations.indexOf(step))}>{step.label}</button>)}
          </section>)}
          {observations.filter(step => step.summary || step.call && !record.messages.some(m => m.traceId === step.traceId)).map(step =>
            <button key={step.id} onClick={() => setCursor(observations.indexOf(step))}>{step.label}</button>)}
        </> : <ol>{observations.map((step, i) => <li key={step.id}><button aria-current={cursor === i ? 'step' : undefined}
          onClick={() => setCursor(i)}>{step.label}</button></li>)}</ol>}
      </nav>
      <section className="panel selected" aria-label="Selected observation"><h2>{selected?.label ?? 'No recorded observations'}</h2>
        <div className="step-controls"><button disabled={cursor === 0 || !selected} onClick={() => setCursor(c => c - 1)}>Previous step</button>
          <output aria-live="polite">{selected ? cursor + 1 : 0} / {observations.length}</output>
          <button disabled={!selected || cursor === observations.length - 1} onClick={() => setCursor(c => c + 1)}>Next step</button></div>
        {selected && <div key={selected.id} className="observation"><p className="identifier">{selected.traceId} · {selected.time} ns</p>
          {selected.call && <CallView call={selected.call} record={record} />}
          {selected.event && <><h3>Recorded event</h3><p>{eventTitles[selected.event.name]?.explanation}</p><JsonView value={selected.event} /></>}
          {selected.summary && <SummaryView summary={selected.summary} />}
          {selected.replay && <ReplayView replay={selected.replay} />}
        </div>}
        {mode === 'context' && <><p>Steps select recorded observations and complete call snapshots. They do not simulate unexported mailbox state.</p>
          <Mailbox record={record} time={selected?.time ?? '0'} /></>}
      </section>
      <FrozenJournal record={record} />
    </div>
    <section className="panel"><h2>Summary observations</h2>
      {!record.summaryCalls.length && <p>No summary tasks exported.</p>}
      {record.summaryCalls.map(summary => <details key={key(summary.key)}><summary>Summary observation · {summary.key.spanId}</summary><SummaryView summary={summary} /></details>)}
    </section>
    </>}
    <section className="panel"><h2>Gaps and unknown evidence</h2>
      {record.gaps.map((gap, i) => <GapView key={i} gap={gap} />)}
      <details><summary>Notes for unknown fields and events ({record.notes.length})</summary><JsonView value={record.notes} /></details>
    </section>
  </>;
}
