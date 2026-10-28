import type { Fact, Gap, Location } from '../record';

export const location = (at: Location) => at.path + (at.line ? ':' + at.line : '') + (at.field ? ' · ' + at.field : '');
export function JsonView({ value, label }: { value: unknown; label?: string }) {
  return <pre aria-label={label}>{JSON.stringify(value, null, 2)}</pre>;
}
export function GapView({ gap }: { gap: Gap }) {
  return <div className="gap" role="note"><strong>Gap: {gap.kind}</strong>
    <div>{location(gap.at)}</div>
    {'missingAttribute' in gap && <div>Missing attribute: {gap.missingAttribute}</div>}
    {'attribute' in gap && gap.attribute && <div>Missing evidence: {gap.attribute}</div>}
    {'detail' in gap && gap.detail && <div>{gap.detail}</div>}
    {'version' in gap && <div>Dekopon version: {gap.version ?? 'unknown'}</div>}
    {'spanId' in gap && gap.spanId && <div>Span: {gap.spanId}</div>}
  </div>;
}
export function FactView({ fact }: { fact: Fact<unknown> }) {
  return fact.state === 'known' ? <JsonView value={fact.value} /> : <GapView gap={fact.gap} />;
}
