# Approach: trial bundle to chat record

Epoch: diaphanous-dilettantes. Step: 18-forensics/record/reader (codex, IDEA-0072 A2).
Studio base: `ffe4c12c6372fd5189ff17d916d468de950d4926`.
Branch: `codex/record-reader-1`.

Pinned steering first line: **# Steering for GPT executors**
([GPT.md at the dispatched SHA](https://github.com/xrl/agents/blob/7a5ceaf641b3516be8cfe7b2ff0769ad6690f598/steering/GPT.md)).

This commit contains only this approach note. Implementation waits for the
coordinator-launched Astra note review. Delete this file in the final implementation
commit. Do not merge, tag, release, deploy, or push main.

## Contract stop requiring the coordinator's ruling

The brief requires **each model call's input** to be rebuilt from full-then-delta
`agent.model.prompt` events. Dekopon v0.66.0 does not export those events for
the summary engine:

- [engine.rs:456–496](https://github.com/dekopon-agents/dekopon/blob/v0.66.0/crates/dekopon-gatewayd/src/memory/engine.rs#L456)
  constructs the summary messages and calls `ChatModel::complete` directly,
  with no transcript audit emission.
- [engine.rs:244–252](https://github.com/dekopon-agents/dekopon/blob/v0.66.0/crates/dekopon-gatewayd/src/memory/engine.rs#L244)
  exports the `memory.summarize` span's record, part, timing and model identifiers.
  [engine.rs:604–619](https://github.com/dekopon-agents/dekopon/blob/v0.66.0/crates/dekopon-gatewayd/src/memory/engine.rs#L604)
  exports the persisted summary transition and its bounded result text.
- In contrast, [prompt.rs:818–854](https://github.com/dekopon-agents/dekopon/blob/v0.66.0/crates/dekopon-agent/src/prompt.rs#L818)
  emits the main-loop transcript after its model call. That path is not used by
  the summary engine.
- [observability.md:799](https://github.com/dekopon-agents/dekopon/blob/v0.66.0/docs/observability.md#L799)
  documents the exported summary slot facts; it does not supply the missing request.

Joining publication and summary spans to a journal record is possible when the
record identity is unambiguous; reconstructing the summary request from the
required trace event is not. Re-creating the engine's request from its current
source or frozen journal would invent an unexported fact and is not a substitute.

**No implementation begins until the coordinator resolves this contract stop and
the note review answers.** The coordinator must rule on the required evidence or
the scope; this note does not silently restrict "each model call" to the main loop.
The proposed design below preserves the requested scope pending that ruling.

## Conflicts and readings, before implementation

1. PLAN §18-forensics calls for trace/journal readers lifted from Rust into Wasm.
   This dispatched brief explicitly requests pure TypeScript. Follow the brief:
   no Rust build, Wasm package, or new runtime dependency.
2. SHARED R1/R4 describes journal v2 and representation/routine identifiers.
   The brief and v0.66.0 `TurnRecord` describe v3 indexed bodies and summary slots.
   Follow the pinned current source: record id, subject, summary part, frozen
   plan and dekopon's rung labels. Do not fabricate routine/version identifiers.
3. The harness pins 0.62.0 and its journal format description names v2.
   Follow BUNDLE.md without edits; select journal decoding from the manifest's
   dekopon version, not from that descriptive format string. Pre-0.65.0 journals
   yield a version-carrying `journal-format` gap and trace-derived messages only.
4. The harness's evidence reader assumes one prompt event per JSON message list.
   v0.66.0 emits `transcript.segment`/`transcript.segments` (observability:1242–1250).
   Assemble those segments first, then mirror the harness's full/delta and
   per-session count rules. Older events lacking both segment fields are single
   segments, as the 0.62.0 fixtures demonstrate.
5. The gateway's own serde readers deny unknown journal fields and reject unknown
   tags (records/tests.rs:177, 1022). The external reader's explicit wire contract
   requires notes and skipping. Follow the brief for unknown fields/variants;
   validate all known shapes. Do not copy serde's forward-incompatibility.
6. BUNDLE.md explicitly calls absent, truncated, invalid-UTF-8 and wrong-type
   command evidence a gap, while the brief calls malformed known shapes errors.
   Follow the specific evidence rule for those bounded evidence fields; malformed
   OTLP envelopes/scalars and malformed known event/journal structures are typed
   errors. Invalid embedded JSON caused by evidenced truncation is a gap.
7. The acceptance wording puts `source` on an arrival. In the pinned Rust types,
   `ArrivedAsset` has item/number/kind/bytes/summaries; `AssetRow` inventory owns
   `source` (record.rs:61–73, 142–158). Test the real inventory-plus-arrival
   encoding and omit the inventory source entirely, including unknown nested data.
8. v0.66.0 uses projection counters, memory notices and `gateway_memory_choice`
   reasons rather than the older routine-selection schema in SHARED. Retain
   `gateway_memory_selection` when actually present in older trace evidence and
   the exported current projection/choice/notice facts; never derive a per-record
   reason from an aggregate counter. Missing reasons remain explicit gaps.
9. The "each model call" requirement exceeds v0.66.0's summary transcript export,
   as proved above. Follow the brief's **stop and report**, not a unilateral
   main-loop-only implementation.
10. The base Vitest include admits `.test.tsx` but not `.test.ts`. Extend that
    existing include for pure reader tests; do not add another runner.
11. SHARED R8 contemplates an approved data-sharing boundary; Studio AGENTS.md and
    this brief prohibit viewer data leaving the browser altogether. Follow the
    stricter browser-only invariant. No remote requests, worker URLs or imports.
12. The delivery requires an approach-note stop before building, followed by a ready
    PR. GPT.md additionally requires a draft on a contract blocker. Open the one
    eventual PR as a draft containing this note and the blocker; readiness remains
    gated on the ruling, note review, implementation, ordered gates and CI.
13. GPT.md asks for a full PR/diff report; this brief caps the parent report at 300
    words and HELPER-RULES.md at 100. Keep the parent handoff within 100 words and
    link the complete evidence here. No implementation gate is claimed at this stop.

No existing `src/record/` implementation or PR template exists at the base.
Origin was fetched with tags before branching; both the checkout and origin/main
resolved to the stated base, and the checkout was clean.

## Proposed record shape and serialization

Public entry: `readTrialBundle(files: ReadonlyMap<string, Uint8Array>)`, returning
a Promise of the typed result. Verify supplied reference sizes and SHA-256 digests
with browser-native Web Crypto; a mismatch is a typed file-integrity error.
Only the caller supplies files; no file picker, filesystem access, zip loader or UI.

`ReadResult` is a discriminated union:
`{ ok: true, record: ChatRecord }` or
`{ ok: false, errors: ReadError[], notes: Note[] }`.
Decoder/JSON/range exceptions become location-bearing typed errors; no exception
from malformed input escapes. Diagnostic locations carry path, line and field,
never raw input, raw exception text, or attachment-source values.

The record is a JSON-serializable derived view with `readerVersion: 1`,
`bundleVersion: 1`, the manifest's dekopon version, provenance, messages in anchor
order, journal records, session tool definitions, typed gaps and notes.
Keep evidence order explicitly in arrays, and use dekopon's keys in references:

- Message identity: trace id; anchor: earliest `gateway.message` in that trace.
  Ordinals sort by anchor start, with stable evidence order for ties.
- Model session: trace id plus `prompt.session` span id; model call: its turn
  span id and exported model turn. Missing parents/turn numbers produce gaps,
  never substitute identifiers masquerading as dekopon's session/turn.
- Model input: full message list with `provenance: 'reconstructed'`, source
  prompt references, observed dialect/settings, interruption/outcome facts and
  the session's tool-definition reference.
- Tool exchange identity: exported `gen_ai.tool.call.id`; retain unmatched
  scripts/outputs with missing-counterpart gaps.
- Journal identity: agent and conversation stem from
  `journal/<agent>/<stem>.jsonl`, then record id and turn from its header.
  Representations are declared once as native, summary part or metadata, using
  dekopon's labels and ordered per-inference references only when exported.
- Summary identity: record id, subject and summary part; keep frozen plan,
  initial slot, ordered transitions, pin and choice history and final slot.
  A side line without `subject` addresses the record, never an asset.
- All u64/i64 identifiers and nanosecond timestamps serialize as decimal strings.
  Decode integer tokens losslessly before any JavaScript-number conversion.
  Do not round journal ids or OTLP timestamp values through floating point.

Keep journal records separate from messages until evidence proves a join.
Record ids are scoped to a journal: journal.rs:527–565 allocates the next id from
that file. Publication (journal.rs:642–649) exports record id and generation, not
a journal stem. A unique match may join by those exported facts; an ambiguous
multi-journal match gets `ambiguous-record-join` and retained candidates, never
a positional/timestamp guess. Summary spans outside an anchored message trace
remain available at record level, not discarded or assigned an invented message.

## Module layout and the three parsers

`src/record/types.ts`: result, record, gap, note and error unions.
`src/record/index.ts`: one public orchestration entry and exported consumer types.
`src/record/json.ts`: shared strict UTF-8, safe JSON, scalar and location helpers.
`src/record/bundle.ts`, `otlp.ts`, `journal.ts`: the three format parsers.
`src/record/reconstruct.ts`: joins, segments, prompts and gap propagation.
Tests and a single handwritten fixture builder stay under `src/record/`.

| Parser | Rules | Matchable errors |
| --- | --- | --- |
| Bundle v1 | Validate manifest version/kind and known references, bytes/digests, relative POSIX paths, completeness, freeze and identity. Resolve only supplied map entries. Preserve manifest gaps and incomplete reasons; an incomplete placeholder remains readable with missing-evidence gaps. Skip unknown fields with location/key notes. | `utf8`, `json`, `manifest-shape`, `bundle-version`, `bundle-path`, `file-integrity` |
| OTLP JSONL | Both trace requests and log requests; blank lines allowed; absent repeated fields use OTLP defaults while explicit null is malformed. Validate scalar kinds/ranges, finite doubles, surrogate validity, attributes and AnyValue depth <=32. Canonicalize record name using audit.event, then event, then name/body. Prefer span events over duplicate log copies using the harness identity, excluding only its export-path attributes/prefixes. Keep unknown spans/events/attributes as notes. | `utf8`, `json`, `otlp-shape`, `otlp-scalar`, `otlp-depth`, `known-event-shape` |
| Journal v3 | Parse raw byte lines as body `b` then header `h`; verify bodyLen and byte-relative span ranges, lowercase escaped/raw kinds and decoded field shapes. Read summary `s`, pin `p` and choice `c` lines in file order. Apply record-subject changes to their record; retain asset-subject changes separately. Validate known ids, parts and plan/slot consistency; skip unknown fields/variants with notes. | `utf8`, `json`, `journal-shape`, `journal-index`, `journal-reference` |

A torn newest line or one trailing body without a completed header is a typed
`journal-tail` gap, mirroring the unlocked Rust reader's round-trip tests.
A malformed completed known line, an interior unmatched body, or multiple
unmatched bodies is an error. Unknown complete envelopes are notes, not bodies.

Segment reconstruction groups by trace, turn span and model turn; it validates
consistent counts/scope/segment totals, detects missing or repeated segments and
concatenates in segment order before parsing the message array. A full prompt
replaces accumulated input; a delta appends only after a valid earlier input in
that session. Count mismatch or a missing base yields `prompt-continuity`,
invalidates the accumulated input, and leaves the call's input unavailable until
the next valid full prompt. No partial list is labeled a complete reconstruction.
Session tools originate only from full-event segment 1; no synthesized tool set.

## Typed gaps

Each gap includes an evidence location and relevant dekopon keys; absence is not
encoded as an invented default. Use an explicit known/unknown field union where a
consumer needs a fact, with unknown referencing its gap.

- `bundle-evidence`: every string in manifest.gaps, preserved individually.
- `incomplete-bundle`: every manifest completeness reason; preserve stdout loss
  signals. Do not claim completeness from a socket reply or silently regrade.
- `missing-file`: absent referenced trace/log/config/driver evidence.
- `freeze`: absent freeze or absent freeze fact, never inferred from reply time.
- `journal-missing`; `journal-format` carrying the older or unknown dekopon version;
  `journal-tail` for a permitted incomplete newest append.
- `truncated-attribute` / `evidence-field`: bounded capture length mismatch,
  missing length, invalid text/type under BUNDLE.md's explicit evidence rule.
- `prompt-segments`, `prompt-continuity`, `missing-prompt`, `missing-answer`,
  `session-identity`, `model-turn`, `tool-definitions`, `tool-exchange`.
- `summary-missing`, `summary-truncated`, `publication-missing`,
  `record-missing`, `ambiguous-record-join`, `selection-reason`.
- `unknown-setting`: per model.complete field, absent means unknown; never read
  a latest config or insert the model client's defaults.
- `opaque-content`, `image-bytes`, retained-original truncation, evicted record,
  append-failure and decider-probability gaps when indicated by bundle/evidence.

The missing summary request described in the contract stop has **no agreed
fallback**. A new gap cannot be used to waive that requirement without a ruling.

Notes preserve the kind/name/key/location of unknown data. Never retain raw
unknown payloads, headers, source objects or raw journal lines. Attachment
inventory is constructed from an allowlist (id, atMs, name, mime, optional size);
arrivals retain only their actual typed fields. `source` is deliberately discarded
before records, errors, notes or any intermediate object can escape the parser.
Opaque continuation bytes are identified, never copied as visible payload.

## Synthetic fixtures and invariant tests

Use one TypeScript fixture builder for manifest references, OTLP resources,
spans/events/logs and encoded byte-indexed journal records. Mirror the existing
Python synthetic helpers' shapes without importing Python or harness files.
Handwritten journal examples mirror the pinned Rust serde tests, including an
escaped newline, multibyte text, asset markers without spans, a missing subject,
and an arrival with empty summaries. No production bundle or release-run export
enters the checkout.

Vitest tests will assert:

- two anchored traces produce exactly two trace-keyed messages despite a second
  queued gateway.message span; full, delta and a later full reset reconstruct
  exact ordered inputs, and each call references the exported tool definitions;
- multi-segment prompts assemble before count checking; a missing segment or
  mismatched delta gives its typed gap and a later full recovers;
- publication and memory.summarize join to the real record id/summary part, while
  duplicate record ids across journals never cross-join;
- missing journal, manifest-named 0.62.0/v2 journal and truncated bounded
  attributes each produce their named gap with context;
- unknown events/fields become typed notes; malformed OTLP produces a matching
  typed error, including explicit null, invalid scalar and excessive nesting;
- byte-relative journal spans survive escaped/multibyte text; record and asset
  side lines remain separate, and missing subject means record;
- a source canary on an inventory entry associated with an arrival is absent
  from every returned record/note/error, including nested unknown source data;
- missing settings, unknown versions, manifest gaps, incomplete evidence and
  ambiguous joins remain explicit, and no request or remote-code path is added.

Summary-request acceptance must follow the coordinator's ruling, not a synthetic
prompt event that the pinned exporter never writes.

## Validation and delivery after review

Use Node 24.19.0 and npm 11.9.0. No new runtime dependency is proposed.
The repository has no PR template at this base. The eventual PR uses the exact
requested title, a validation table and a final `Choices I made` section.
The coordinator launches the fresh-thread Astra implementation review.

Required gates, in order, after the approach review and contract resolution:

1. `npm ci`
2. `npm audit --audit-level=high`
3. `npx playwright install --with-deps chromium`
4. `npm run lint`
5. `npm run typecheck`
6. `npm test`
7. `npm run build`
8. `npm run check:dist`

Also run `git diff --check`. The harness is unchanged; its existing daemon-free
CI job remains required. Report its observed CI result without claiming a local
Python gate was run unless it was. CI must be green on the final pushed head.
No deployment and no post-deploy check belong to this step.

## Choices I made

- Root the work at the supplied ffe4c12c full SHA, verified against fetched origin/main.
- Follow the explicit TypeScript brief over the broader plan's Wasm reader direction.
- Treat pre-0.65.0 journals as version-carrying gaps only; add no v2 decoder.
- Preserve byte/identifier precision using decimal-string serialization.
- Use one public result-returning entry, three parsers and one reconstruction module.
- Reassemble v0.66.0 transcript segments before applying harness continuity semantics.
- Invalidate a broken delta chain until the next valid full prompt.
- Scope journal identity by agent/stem/id and report ambiguous joins without guessing.
- Discard attachment sources and unknown payload values from every outward result.
- Add .test.ts to the existing Vitest include and reuse one synthetic fixture builder.
- Verify reference sizes and hashes locally with Web Crypto; add no runtime dependency.
- Add no UI, bundle-layout change, Wasm build or deployment.
- Stop for the missing v0.66.0 summary transcript export; do not waive it with a gap.
- Open one draft PR for the documented contract stop and coordinator note review.
