export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Location { path: string; line?: number; field?: string }
export interface SpanKey { traceId: string; spanId: string }
type GapKind =
  | 'bundle-evidence' | 'incomplete-bundle' | 'missing-file' | 'freeze'
  | 'journal-missing' | 'journal-tail' | 'truncated-attribute' | 'evidence-field'
  | 'prompt-segments' | 'prompt-continuity' | 'missing-prompt' | 'missing-answer'
  | 'session-identity' | 'model-turn' | 'tool-definitions' | 'tool-exchange'
  | 'summary-missing' | 'summary-truncated' | 'publication-missing' | 'record-missing'
  | 'ambiguous-record-join' | 'selection-reason' | 'unknown-setting'
  | 'opaque-content' | 'image-bytes' | 'evicted-record' | 'append-failure'
  | 'decider-probability' | 'call-outcome' | 'step-cap' | 'mailbox-inventory-unavailable'
  | 'mailbox-state-unavailable' | 'permission-evidence' | 'permission-attribution'
  | 'policy-world-unavailable';
export type Gap =
  | { kind: GapKind; at: Location; attribute?: string; traceId?: string; spanId?: string;
      recordId?: string; part?: string; detail?: string }
  | { kind: 'journal-format'; at: Location; version: string | null }
  | { kind: 'summary-input-unavailable'; at: Location; traceId: string; spanId: string;
      missingAttribute: 'agent.model.prompt' };
export interface Note { kind: 'unknown-field' | 'unknown-span' | 'unknown-event' | 'unknown-variant';
  at: Location; name: string }
export type Fact<T> = { state: 'known'; value: T } | { state: 'unknown'; gap: Gap };
export interface ReadError {
  kind: 'utf8' | 'json' | 'manifest-shape' | 'bundle-version' | 'bundle-path'
    | 'file-integrity' | 'otlp-shape' | 'otlp-scalar' | 'otlp-depth'
    | 'known-event-shape' | 'journal-shape' | 'journal-index' | 'journal-reference'
    | 'reader-failure' | 'seed-shape' | 'seed-version' | 'seed-base64' | 'seed-freeze';
  at: Location;
}
export interface FileReference { at: Location; path: string; sha256: string; bytes: string }
export interface EvidenceRecord {
  key: SpanKey; at: Location; name: string; time: string; origin: 'span' | 'log';
  attributes: { [key: string]: Json };
}
export interface RecordSpan {
  key: SpanKey; at: Location; parent: string; name: string; start: string; end: string;
  attributes: Record<string, Json>;
}
export interface Admission {
  evidence: EvidenceRecord; outcome: Fact<string>; conversation: Fact<string>; combinedDepth: Fact<string>;
}
export interface ReplayObservation {
  key: SpanKey; time: string; priorTurns: Fact<string>; priorBytes: Fact<string>; generation: Fact<string>;
}
export type CallOutcome = 'succeeded' | 'steered' | 'interrupted' | 'refused' | 'failed';
export interface MailboxGaps {
  steers: Fact<Json[]>; followUps: Fact<Json[]>;
  runningInterval: Fact<{ start: string; end: string }>;
  completingInterval: Fact<{ start: string; end: string }>;
}
export interface ToolSet { key: SpanKey; definitions: Json[]; definitionsJson: string }
export interface ModelCall {
  key: SpanKey; session: Fact<SpanKey>; turn: Fact<string>;
  startedAt: string; endedAt: string; outcome: Fact<CallOutcome>; stepCap: Fact<string>;
  input: Fact<{ provenance: 'reconstructed'; messages: Json[]; messagesJson: string; prompts: Location[] }>;
  tools: Fact<SpanKey>; answer: Fact<EvidenceRecord>; settings: Record<string, Fact<Json>>;
  completionSpans: SpanKey[];
}
export interface ToolExchange {
  callId: Fact<string>; script: Fact<string>; output: Fact<string>;
}
export interface ChatMessage {
  traceId: string; ordinal: number; anchor: SpanKey; startedAt: string;
  finalAnswer: Fact<EvidenceRecord>; calls: ModelCall[]; tools: ToolExchange[]; evidence: EvidenceRecord[];
}
export type Subject = { kind: 'record' } | { kind: 'asset'; number: string } | { kind: 'unknown' };
export type Slot =
  | { state: 'queued' | 'running' }
  | { state: 'generated'; text: string }
  | { state: 'error'; failure: string; detail: string; ioKind?: string }
  | { state: 'unknown'; variant: string };
export interface ModelIdentity { backend: string; upstream: string; reported: string | null }
export interface JournalItem {
  item?: string;
  kind: 'user' | 'steer' | 'assistant' | 'reasoning' | 'opaque' | 'exchange' | 'asset';
  text?: string; originalBytes?: string; model?: ModelIdentity; number?: string;
  callId?: string; tool?: string; arguments?: string; result?: string; outcome?: Json;
}
export interface JournalSpan {
  item: string; field: string; kind: 'escaped' | 'raw'; relOffset: string; len: string;
}
export interface Arrival {
  item: string; number: string; kind: string; bytes: string | null; summaries: Slot[];
}
export interface AssetInventory {
  id: string; atMs: string; name: string; mime: string; size?: string;
}
export interface JournalChange {
  at: Location; atMs: string; subject: Subject;
  change: { kind: 'slot'; part: string; slot: Slot } | { kind: 'pin'; rung: Fact<string | null> }
    | { kind: 'choice'; rung: Fact<string | null> };
}
export interface JournalKey { agent: string; stem: string; recordId: string }
export interface JournalRecord {
  key: JournalKey; at: Location; turn: string; atMs: string; model: ModelIdentity;
  grant: number[]; nextRecordId: string; nextAssetId: string; items: JournalItem[];
  spans: JournalSpan[]; plan: { model: string; parts: string[]; maxInputBytes: string } | null;
  initialSummaries: Slot[]; summaries: Slot[]; pin: Fact<string | null>; choice: Fact<string | null>;
  arrivals: Arrival[]; assets: AssetInventory[]; changes: JournalChange[];
  representations: { id: string; part?: string }[];
  publications: EvidenceRecord[]; summaryCalls: SpanKey[];
}
export interface SummaryCall {
  taskAttributes: Record<string, Json>; task: SpanKey; evidenceKind: 'summary-task' | 'model-complete';
  key: SpanKey; at: Location; recordId: Fact<string>; part: Fact<string>;
  input: { state: 'unknown'; gap: Extract<Gap, { kind: 'summary-input-unavailable' }> };
  recordCandidates: JournalKey[]; transitions: EvidenceRecord[];
  settings: Record<string, Fact<Json>>; completionSpans: SpanKey[];
}
export interface BrokerDecision {
  evidence: EvidenceRecord; id: Fact<string>; invocation: Fact<string>; capability: Fact<string>;
  principal: Fact<string>; subject: Fact<string>; participant: Fact<string>;
  allowed: Fact<boolean>; space: Fact<string>; askerAllowed: Fact<boolean>; spaceAllowed: Fact<boolean>;
  deniedBy: Fact<'asker' | 'space' | 'both' | null>;
}
export interface BrokerEffect {
  evidence: EvidenceRecord; id: Fact<string>; invocation: Fact<string>;
  decisions: Fact<BrokerDecision[]>;
}
export interface ParticipantObservation {
  principal: string; handle: string | null; surface: Fact<string>; call: SpanKey; messageIndex: number;
  observedJoinLine: string | null; identityAttestation: Fact<SpanKey>;
}
export interface PermissionTurn {
  traceId: string; ordinal: number; receipts: { evidence: EvidenceRecord; subject: Fact<string> }[];
  principal: Fact<string>; participants: ParticipantObservation[];
  decisions: BrokerDecision[]; effects: BrokerEffect[];
}
export interface PermissionRecord {
  policy: Fact<string>; world: { state: 'unknown'; gap: Gap };
  decisions: BrokerDecision[]; effects: BrokerEffect[]; turns: PermissionTurn[];
}
export interface ChatRecord {
  readerVersion: 5; bundleVersion: 1 | 2; dekoponVersion: Fact<string>;
  references: FileReference[]; identity: { [key: string]: Json };
  freeze: Fact<Json>; completeness: Fact<Json>;
  messages: ChatMessage[]; unanchoredCalls: ModelCall[]; toolSets: ToolSet[]; journals: JournalRecord[];
  summaryCalls: SummaryCall[]; evidence: EvidenceRecord[]; spans: RecordSpan[]; admissions: Admission[]; replays: ReplayObservation[]; mailbox: MailboxGaps;
  permissions: PermissionRecord;
  gaps: Gap[]; notes: Note[];
}
export type ReadResult = { ok: true; record: ChatRecord }
  | { ok: false; errors: ReadError[]; notes: Note[] };

export interface ContinuationMessage { text: string }
export type ReadSeedResult = {
  ok: true; record: ChatRecord; files: ReadonlyMap<string, Uint8Array>;
  continuationMessages: ContinuationMessage[]; seedDigest: string;
} | Extract<ReadResult, { ok: false }>;
export type ExportSeedResult = { ok: true; bytes: Uint8Array<ArrayBuffer>; seedDigest: string }
  | Extract<ReadResult, { ok: false }>;
