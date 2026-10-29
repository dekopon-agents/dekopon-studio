# Approach note: eval gateway pin and branch arms

Epoch diaphanous-dilettantes; step `18-forensics/evalgw/branch-arms`; lane codex.
Base: `057d51341a80f1fe630de5978e2649edd875340f`.
Steering: xrl/agents `7a5ceaf641b3516be8cfe7b2ff0769ad6690f598`, first line:
`# Steering for GPT executors`.

**Status: Astra note r1 ACCEPT; coordinator ruling received 2026-10-29T04:45Z.**
The review accepts the stop, not the blocked mappings. The coordinator authorizes
pin implementation now and narrows the later arms part to three expressible
policies. Originals-only and prefixes-only are one follow-up for a later drop,
requiring a gatewayd projection selector/core export outside this step. No core
change, authority expansion or new memory key is authorized. Arms starts from
current main after pin merges.

## Conflicts and readings

These were identified before editing implementation files. Sources are the
stamped Studio base, SHARED.md (blob `aaa134619df2f7a4b7968a6d79fb4deba4d29168`),
PLAN.md (blob `cf0072f78d4e9e3457290ac816301e9dda2189cb`), and the exact releases below.

| Conflict | Reading followed |
| --- | --- |
| SHARED R1/R9 and the existing harness describe internal journal v2, `retain`, routines and old selection policies; the brief requires v3 and the 0.65+ configuration. | The explicit v0.70.0 pin and allowed `hotTurns`, `summaries`, `selection` keys govern; do not introduce compatibility aliases. |
| `artifacts.py:16` pins 0.62.0; v0.71.0 is now released. | Move only to the brief's v0.70.0, using published artifacts, never a source-built substitute. |
| v0.70.0 enables summary generation by default; the two-message fixture scripts only main-loop completions. | Explicitly disable new summaries for that existing scenario, retain its default hot window, and select `ladder`. The reference scenario enables summaries separately. |
| Originals-only must expose a whole-original `record-exceeds-budget` omission, but v0.70.0 native replay prefixes tool results before testing its budget, then omits with `WindowFit`. | Contract stop; neither call a prefix an original nor relabel `WindowFit` as the required reason. |
| Prefixes-only needs selection distinct from originals-only; disabling `summaries` does not suppress stored summary slots or change native projection. | Contract stop; no valid independent mapping found within the three knobs. |
| A literal summaries-only arm needs no native hot records, but `hotTurns` is nonzero, and older records honor stored pins/choices before deepest summaries. | Flag the mapping as blocked; do not silently interpret the name as a mixed hot/native policy or alter pins. |
| SHARED's reference assumes a post-reply summary is ready before the next turn; v0.70.0 summary generation is asynchronous and shutdown cancels running work. | Generate the synthetic reference using real daemons and verify terminal, generated summary slots before freezing. A reply alone does not prove a summary exists. |
| Bundle v1 fixes `seedDigest` null and the reader accepts only v1; seeded trials must carry digest and arm. | Add bundle v2 only for seeded trials; preserve v1 behavior and document both. |
| PLAN describes lifted Rust trace/journal readers; the merged base uses the TypeScript reader and a policy-only wasm bridge. | The brief explicitly requires existing src/record importer semantics; reuse that implementation and do not replace the reader. |
| The original brief predates reader v4. | Dispatch governs: retain v4 through pin; bump to v5 with the arms record-shape change. |
| A fresh runtime needs new socket/storage paths, whereas captured config contains the deleted source runtime's paths. | Relocate only runtime locations, record the relocation, and keep catalog, policy, grant inputs, providers, model identity, horizons and all non-arm memory settings unchanged. Refuse unsupported restoration rather than reconstructing authority. |
| Scenario validation rejects zero messages; SEED.md allows an empty continuation array. | The existing ordinary scenario rule remains; seed mode must admit zero continuations and report that no first projection exists. It must not invent a message. |
| AGENTS.md's current gates include wasm, views, seed and Cedar beyond the brief's shorthand. | Run the entire current list, in its order, plus Python tests for each implementation PR. |
| AGENTS.md says gates precede submission; the delivery brief says push an approach note, end the turn, and build after review. | This draft contains the note only; all build/test gates are deferred explicitly until review. |
| HELPER-RULES asks for reports within 100 words; the delivery brief permits 300 per part. | Keep the parent handoff within 100 words and link the evidence. |

SEED.md matches the specified envelope, digest and v1 fixed-null rule. The extra
required, integrity-verified frozen journals are exactly the dispatch correction,
not a further contract difference. The synthetic-only rule in PLAN remains in
force. No real seed or bundle has been opened or copied.

## Released-source evidence and arm mapping

Dekopon v0.70.0 resolves to `2e0a398620c6ceaf77b0b0cd3353d1d9fa66c0fc`.
All following paths are in that commit under `crates/dekopon-gatewayd/src/`:

- `config/memory.rs:74-84,145-169`: nonzero `hotTurns`; selection admits only
  `ladder` or a decider object. There is no originals/prefixes selector.
- `memory/project.rs:63-95`: ladder is native, generated summaries, metadata;
  older records start at a valid pin, then stored choice, then deepest generated
  summary, else native. Current summary-generation config is not an input here.
- `memory/project.rs:210-229,304-326,376-390`: native replay reserves text first,
  prefixes results to remaining share, and uses `maxBytes / max(hotTurns, 1)`.
  Making every retained record hot therefore still does not mean whole originals.
- `memory/project.rs:417-441`: repacking drops oldest records beyond the turn
  window, steps older records down the ladder, and omits hot records whole last.
- `session.rs:2857-2866,2899-2903`: projection receives no summaries knob;
  projected omissions become `OmissionReason::WindowFit`.
- `memory/journal.rs:560-574` and `docs/gatewayd.md:1376`: SummaryPlan and slots
  belong to each appended record; changing `summaries` affects new records only.
- `session.rs:2841-2855` and `docs/gatewayd.md:1374`: a new decider choice is
  obtained before projection but persisted after the reply; it is not injected
  into the frozen header used by that first projection.

| Ruled arm | Exact v0.70.0 knob mapping |
| --- | --- |
| live-policy | The seed's hotTurns, summaries and selection unchanged. |
| decider | The seed's hotTurns and summaries unchanged; selection becomes `{decider: {capability: "decide.choose", backend: "openrouter-jev", model: "typesafe/jev-1.13", requireProbabilities: true}}` against a loopback stub. The decider provider is in the common seed's provider set and grant for every arm. A fresh first projection uses frozen stored rungs; a new choice affects a later projection/repack. |
| summaries-preferred | Set hotTurns to 1; preserve the seed's summaries and selection. Older unpinned, unchosen records prefer their deepest generated summary and the newest stays native. Never call this summaries-only. |
| originals-only and prefixes-only (deferred together) | No mapping in this step. A gatewayd projection selector is a config-key and contract change for a later drop/core export. |

First-projection checks compare each of the three active arms against its actual
knob-selected v0.70.0 projection. Name WindowFit omissions as WindowFit; do not
require or fabricate a record-exceeds-budget result. This implements the
coordinator's narrowing of the arm list, not a reinterpretation of the two
deferred policies.

The decider provider must already be in the common seed's provider set and grant,
including arms that never invoke it; adding it to one arm would change authority.
Provider v0.1.1 resolves to `8830dcb5cde8b59f9727bcb9ebb22daf88fc0716`;
its README lines 3-5 specify the owner-controlled `providerSettings.decide.baseUrl`
and `/api/alpha/decisions`. Reuse the harness HTTP Service seam for a loopback POST
stub returning a valid declared-label distribution. Never use its default vendor
endpoint, configure a credential, or make a paid call.

The findings above explain the original stop. The coordinator ruling resolves
it by authorizing the three active arms and deferring the other two together.
The required daemon pin remains v0.70.0.

## Pin part after review

Use release `dekopon-0.70.0-x86_64-unknown-linux-gnu.tar.gz`, SHA-256
`09e052b3fe0ba5d831dfbbb011152a3f2e8a4984b97fe54e03902fd6a324861a`
(as published in release asset metadata). Retain the current gh and Collector
pins. Keep checksum verification and both daemon `--version` checks. Update
journal-format descriptions to internal v3 at 0.70.0 without a bundle bump.

The existing two-message route becomes explicit about `hotTurns: 10`,
`summaries: "off"`, `selection: "ladder"`, beside persistent journal recall.
No legacy retain/routine keys exist in that checked-in scenario to translate.
Keep existing scenario behavior and grading; update release-specific evidence
fixtures only where real v0.70.0 output demonstrates a necessary change. Check
that its real journal opens in the built Studio using the existing browser
routing helper. Delete this note in the pin PR's final implementation commit.

## Arms structure and single seed definition, conditional on resolution

Extend `driver.run` and its existing launch/drain/finalization path with an
explicit restored-seed input. Add an operator CLI `harness/branch.py` and a small
`evalgw/arms.py` orchestrator; do not create a second daemon runner. Keep all
operator code outside `src/` and `dist/`.

An operator-only Node adapter calls the existing `readSeed`, `readTrialBundle`
and `exportSeed` from `src/record/`. Bundle that adapter with the already pinned
Vite toolchain into ignored operator cache/scratch, outside the app output. Python
receives validated files, normalized records, notes and the exact-byte digest;
it does not implement another seed decoder. Unknown-field notes survive into
driver evidence. No credential contents are read by the adapter.

SEED acceptance stays independent of whether the seed is executable here: only
harness-generated synthetic seeds are run, and runtime validation separately
refuses non-loopback endpoints, missing required executable config, unsupported
providers, mismatched conversation/transport/grant or unsupported journal format.
Do not normalize text, timestamps, grants, summary plans, pins or journal content.
An unsafe path, duplicate path, noncanonical base64 or null/unavailable freeze is
refused through the existing importer. Hash the original file bytes once; never
hash reserialized JSON. A changed seed has a new digest and is another experiment;
restore must also verify staged journal hashes against imported references before
any daemon starts, so an edit during staging is refused.

Create a fresh private runtime for every arm. Copy every freeze journal verbatim
to `<runtime>/journal/<agent>/<stem>.jsonl`, mode 0600, under directories 0700,
before gateway startup. Keep the original frozen bytes separately for comparison.
Gateway `sessions.journal.path` names that new root. The local transport preserves
name, subject and full conversation coordinate: `transport/local.rs:223-239` and
`conversation.rs:128-136` show that a new connection's message nonce is not a new
journal stem. `memory/journal.rs:160-172,772-773` supports startup loading of the
same layout. Real-daemon restore remains a required gate, not yet a verified claim.

Copy catalog and Cedar bytes unchanged. Relocate only private file/socket/cache
locations (and required local process UID bindings without changing the mapped
service principal). Bind fixtures to the captured loopback endpoint ports so
HTTP grants and owner settings remain identical, one arm at a time; refuse an
occupied port rather than broadening a grant. Preserve maxTurns, maxBytes,
retention, forgetAfterMs, capture, routes and all provider pins. Compare effective
arm configuration with the seed after an explicit runtime-location allowlist;
reject any remaining difference outside the three approved knobs.

## Bundle v2 and record v5, conditional on resolution

Ordinary trials continue to write v1 with `seedDigest: null`. Seeded trials write
v2 with `seedDigest` as a required lowercase 64-hex digest and `armId` as a required
nonempty string naming the selected arm. These are the only v2 manifest contract
changes. Other references, completeness and gaps keep their existing meanings.
Record v5 accepts v1 and v2, retains the actual bundleVersion and typed gaps, and
exposes validated digest/arm identity. A digest is provenance, not authenticity.
Document v2 beside v1 in BUNDLE.md; do not expand the complete-provider-world
contract deferred by Cedar. SEED.md's v1 envelope and embedded v1 contract remain
unchanged; the original and all arm bundles must open beside each other locally.

Put first-projection evidence under the already-referenced `driver.json`, avoiding
a new manifest reference: `firstProjection` contains status, model-call key,
seedDigest, armId and one entry per frozen `(agent, stem, recordId)` with expected
rung or named omission, observed rung or omission, and comparison detail. Emit a
compact JSON summary per arm for the PR; retain full evidence in each bundle.

Compare the actual first continuation main-loop `model.complete` input rebuilt
from OTLP with the frozen records and permitted policy. Account for v0.70.0's
native prefix sizes, envelopes, cumulative summary parts, budgets, grant and age
eligibility; do not infer success merely from aggregate rung counts or a stub
answer. Missing/ambiguous evidence or a mismatch is an incomplete reason before
grading, with score null. No continuations means an explicit no-first-projection
observation. WindowFit omissions are named as such. The originals-only/prefixes-only
comparison is deferred with their shared projection-selector follow-up.

## Reference seed and validation, conditional on resolution

Extend the existing StubModel seam to handle summary requests separately from
ordered main-loop completions, since the release runs summaries asynchronously.
Use a synthetic shell-generated roughly 200 KiB tool result with an early fact
and distractors, preserving the reference's message order. The existing gh
fixture's small provider output is not evidence for this large-output scenario.
Verify the produced journal captured the intended result size and generated
summary parts before allowing freeze/export; never hand-write or patch its
journal. Use `exportSeed` to produce the same bytes/layout as Studio, then run the
three ruled arms from that one file after pin merges.

Planned meaningful tests: importer acceptance/refusal for unsafe path, bad base64,
null/missing frozen journal, unknown-field note and exact-byte digest; staging
edit refusal; forbidden arm-config difference refusal; matching versus mismatched
projection controlling completeness/score; v1/v2 reader compatibility. Use the
existing neighboring synthetic helpers and fixtures. Real-daemon validation must
show every arm's manifest and comparison, and built-Studio opening beside the
original, without additional network requests.

No build or test gate has run at this note stage. Deferred, in exact AGENTS order:
`npm ci`; `npm audit --audit-level=high`;
`npx playwright install --with-deps chromium`; `npm run build:wasm`;
`npm run lint`; `npm run typecheck`; `npm test`; `npm run build`;
`npm run check:dist`; `npm run check:views`; `npm run check:seed`;
`npm run check:cedar`; then
`python3.12 -m unittest discover -s harness/tests -v`.
Also deferred: real v0.70.0 two-message run, real restored reference arms,
built-Studio opening, CI and coordinator-launched external reviews. Node 24.19.0,
npm 11.9.0, Python 3.12 and the Docker CLI are present; daemon/Docker execution
and complete Rust/wasm prerequisites have not been exercised. No Pi/deploy check
belongs to this work. No implementation, tag, merge, release or deployment was made.

## Inherited follow-up

Astra note r1 found that the existing harness launches brokerd and gatewayd under
the same operator UID and therefore does not exercise core's separate-UID
isolation boundary. The coordinator explicitly excludes changing launch UIDs
from this step. List this inherited issue under Follow-ups in the pin PR body.
