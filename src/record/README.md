# Trial record reader

`readTrialBundle` accepts a `ReadonlyMap<string, Uint8Array>` keyed by the relative
paths in [bundle v1](../../harness/BUNDLE.md). It snapshots those bytes and returns
`Promise<ReadResult>`. It does not open files, extract archives or render content.

```ts
import { readTrialBundle } from './record';

const result = await readTrialBundle(files);
if (result.ok) {
  const record = result.record;
  // Pass the derived record to a local view.
} else {
  // Match result.errors[i].kind; locations identify the input, without raw payloads.
}
```

The reader has no runtime dependency and performs no network requests, uploads,
remote imports or worker creation. File sizes and SHA-256 digests are verified with
local Web Crypto. A missing referenced file becomes a gap; a mismatched file is
a typed error. Attachment inventory is constructed from allowed metadata fields.
An asset's `source` is discarded, including its nested fields; it never appears
in a returned record, note or error. Opaque reasoning bytes are omitted.

## Record version 3

The result carries `readerVersion`, the manifest's `bundleVersion`, the observed
dekopon version, build/catalog/policy file references, freeze evidence,
completeness, messages, tool sets, journal records, summary observations, gaps
and notes. It reports evidence and does not grade a trial or infer completeness
from a reply.

Messages use trace ids and the earliest `gateway.message` in each trace. Queued
gateway spans do not create extra messages. Main-loop calls retain their model
session, model turn and completion span identifiers. Full prompts replace prior
input; deltas append within the same session. Segments are assembled before
count checking. A broken chain stays unavailable until a valid full prompt.
Calls without an anchor remain in `unanchoredCalls`.

Inputs are labeled `provenance: 'reconstructed'`. `messagesJson` is the complete
JSON message list, assembled without changing numeric literals. `ToolSet` keeps
the exported `definitionsJson` and a decoded `definitions` view. Decoded payload
views use numbers for safe integers and decimal strings for larger integers;
the JSON text is authoritative when those distinctions matter. IDs, int64
attributes and timestamps use decimal strings and can be serialized without
rounding. Tool definitions are referenced by the span containing the full prompt.

Journal records use agent, conversation stem and record id. Indexed body slices
use UTF-8 byte offsets, not JavaScript string positions. Record and asset side
lines stay distinct; an omitted subject addresses the record. Initial slots,
ordered changes, current slots, pins, choices, arrivals and representations remain
available. Unknown rungs are explicit unknown facts.

Publication and summary joins use exported record identifiers. Record ids are
local to a journal; an ambiguous match retains `recordCandidates` and an
`ambiguous-record-join` gap, without assigning the observation to either record.

## Summary-engine inputs

Coordinator ruling, 2026-10-28T20:30Z:

> dekopon v0.66.0+ exports no agent.model.prompt for summary-engine calls
> (engine.rs:456), so the reader rebuilds main-loop model calls only.
> Each summary-engine call it finds is listed as present but not rebuildable,
> with its span id and the missing attribute, so the gap is visible and not silent.

Each summary `model.complete` child gets an observation, with its task span,
record id, part, transitions and a `summary-input-unavailable` gap containing
its own trace/span id and `missingAttribute: 'agent.model.prompt'`. When only
`memory.summarize` is exported, the observation is labeled `summary-task`;
it does not assert that a provider exchange occurred. No summary prompt is
invented. Exporting summary requests in core is a separate follow-up.

## Refusals, gaps and notes

`ReadError.kind` distinguishes decoding/JSON, manifest/version/path/integrity,
OTLP shape/scalar/depth, known-event shape, journal shape/index/reference, and
runtime reader failures. Malformed input resolves to the error union and never
rejects the promise with an input-derived exception.

`Fact<T>` distinguishes known data from an unknown fact carrying a typed gap.
The gap union includes manifest and completeness reasons, missing evidence and
freeze points, absent journals, version-carrying journal-format gaps, torn tails,
capture truncation, prompt continuity/segments, settings and tool evidence,
missing or ambiguous record joins, summary inputs and slot evidence. A v2
journal yields a format gap and trace reconstruction, without a v2 decoder.

Unknown spans, events, attributes, journal envelopes, fields and variants become
notes with names and locations. Unknown payload values are discarded. Known
malformed shapes are errors; BUNDLE.md's bounded command evidence exceptions are
gaps. A torn newest journal append is a gap; malformed completed lines and
invalid byte indexes are errors.

The tests use one handwritten synthetic builder. No production exports or
Python harness code are imported by this module.

## Context evidence (record v2)

Call attempts carry start/end times, a typed accounting outcome, and the exported
session step cap. A steered/interrupted attempt is retained and does not consume
a completed step. Missing outcomes and caps are gaps. Recognized spans retain
parentage and filtered, validated attributes. Admission observations expose their
recorded outcome, conversation and combined depth as facts; replay observations
expose session exchange/byte totals and the configuration generation digest.
These are distinct from `memory.generation` on projection/publication evidence.

Coordinator ruling, 2026-10-28T22:00Z: v0.70.0 does not export mailbox drains or
exact RUNNING/COMPLETING boundaries. The Studio shows admissions and combined
depth, but queue inventories and those intervals stay explicitly unknown. Exact
mailbox animation waits for a core export. Recorded permissions and a missing
policy-world path belong to the later cedar part; successful same-request
what-if evaluation also waits for a core export of the provider inventory.

A freeze is known only with the required conversation kind and id as well as the
existing drain evidence. Bundle v1 refuses a non-null `seedDigest` with a typed
manifest error; a later external seed format does not change that contract.

## Seed envelope (record v3)

`exportSeed(files, continuationMessages)` verifies a snapshot through the bundle
reader, requires a known freeze, and returns local download bytes and their
SHA-256 `seedDigest`. It includes only the original manifest and present files
named by validated references. `readSeed(bytes)` validates the versioned envelope,
recovers the file map, delegates reconstruction to `readTrialBundle`, and returns
the same record, ordered continuation messages and digest of the original bytes.
Both resolve to typed errors for invalid input. The recovered file map is private
export material, never a raw-file view. Unknown envelope fields become notes.
See [SEED.md](../../harness/SEED.md) for the complete transport and digest contract;
bundle v1 and its fixed-null `seedDigest` remain unchanged. Version 3 adds seed
validation APIs and errors; existing record fields retain their meaning.
