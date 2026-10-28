# Approach: Context Studio views, Cedar, and seed export

Epoch `diaphanous-dilettantes`, step `18-forensics/record/studio`, lane `codex`.
Steering read first at `7a5ceaf641b3516be8cfe7b2ff0769ad6690f598`; first line:

> # Steering for GPT executors

This is the approach-note checkpoint only. No implementation or build has begun.
The views branch is `codex/record-studio-views-1`, rooted at verified Studio main
`e77e10e6768db854c4606d78b5ab9dfc39be4f65` (reader #3). The initial checkout was
`ffe4c12`; `git fetch origin --tags` supplied the specified base before branching.
Dekopon v0.70.0 resolves to `e7575230f18784e922a40915cc253faa3c4d1848`.
Read inputs also include Studio `AGENTS.md`, `src/record/README.md`, `types.ts`,
`harness/BUNDLE.md`, and the requested v0.70.0 docs and policy/broker sources.
Campaign-trail input blob SHAs at this reading: PLAN.md
`cf0072f78d4e9e3457290ac816301e9dda2189cb`; IDEA-0072
`4f6028276be98d94d6911651133d034569a10400`; SHARED.md
`aaa134619df2f7a4b7968a6d79fb4deba4d29168`; HELPER-RULES.md
`ee29e6a19a4d9fb073a098a28c33c9e18f17f40e`.
The coordinator launches the Astra note review. Implementation waits for its answer
and resolution of the contract stops below. Delete this note in the views PR's final commit.
Cedar and seed each branch from current main after views merges; neither stacks on
an unmerged sibling. One ready PR per implemented part, with green CI and a fresh
coordinator-launched Astra review. No merges, tags, releases, deployments, Pages
changes, repository secrets, or release-App work are authorized here.

## Conflicts found before implementation and the reading to follow

| Brief, plan, or base conflict | Reading to follow |
| --- | --- |
| Cached checkout predates the stated reader base. | Fetch and branch from the full verified `e77e10e6` SHA above; do not build on the cached harness head. |
| PLAN.md:305 calls for lifted wasm trace/journal readers; the merged reader is TypeScript. | This brief explicitly makes `src/record/` the only parser. Extend that reader; use the published policy crate for Cedar. Do not create a parallel Rust reader. |
| AGENTS.md's bootstrap paragraph excludes Rust and wasm. | The brief authorizes them for cedar and explicitly requires correcting that paragraph and its gates in that part. Preserve the browser boundary. |
| IDEA-0072 A1/A3 and R2 describe summary input reconstruction; the reader's coordinator ruling says those inputs are absent. | Preserve every `summary-input-unavailable` gap, span id, and missing attribute. Show observed tasks, transitions and text; invent no summary input. |
| The older idea says summaries run serially and hold the next message; v0.70.0 gatewayd.md:1376 describes bounded background work. | Display recorded publication and slot transitions, without imposing the old serial ordering. |
| Harness pins 0.62.0/v2 journals; the reader supports v3 for 0.65.0 onward. | Keep the harness pin. Its journals remain an explicit format gap. Add handwritten v0.70.0/v3 fixtures through the existing reader fixture builder. |
| The plan authorizes release-tag Pages publishing; this dispatch forbids shipping. | This dispatch controls. CI and its `dist/` artifact are the proof; post-deploy check: none. |
| The requested mailbox queues and RUNNING/COMPLETING state have no complete exported state history at v0.70.0. | Contract stop A below. Do not infer queue contents or state boundaries from admission outcomes or final answers. |
| A faithful policy world needs the loaded provider registry; bundle v1 has pins and paths, not its complete capability inventory. | Contract stop B below. Missing-world gaps are required, but cannot replace the successful same-request what-if acceptance. No invented registry or new bundle fields. |
| BUNDLE.md:45 fixes a trial v1 `seedDigest` to null. | Specify a separate versioned seed envelope; preserve its embedded trial manifest byte-for-byte. A later trial can refer to the seed's digest only under its own approved contract. Do not edit BUNDLE.md v1. |
| R5/Interoperation discuss marking a point in history; the available bundle contains only its captured freeze snapshot. | Mark the existing, validated non-null freeze. Never synthesize an earlier journal snapshot from a cursor position. |
| AGENTS.md requires build gates before submitting changes; the brief requires a pushed note and review before building. | Treat this as the explicit note-only checkpoint. List all implementation gates as not run; run them in order after the review permits building. |
| Steering ordinarily requires a full PR report and a draft on an unmet brief; this brief first requires a note-only push and end of turn. | Deliver the note checkpoint now, with the blockers named and no implementation PR. Do not imply implementation acceptance or launch a reviewer ourselves. |

## Contract stops for the coordinator

**A: missing mailbox evidence.** At the pinned Dekopon source,
`crates/dekopon-gatewayd/src/session.rs:106-108` defines the three session states;
`:1048-1057` changes RUNNING to COMPLETING without a trace/log event.
`record_admission` at `:551-580` exports outcome and total `queue.depth`, not the
state or separate queue inventories. The total at `:621` also includes authorizing
participants. `take_steers` at `:733-740` and `seal_or_take` at `:742-756` drain
steers without exporting a drain record. `seal_locked` at `:813-829` observes
leftovers internally. Admissions alone cannot reconstruct the required queues or
exact seal boundary, even in a complete trace. This is a missing v0.70.0 export,
not merely an incomplete fixture. The brief says to stop and report this case.
No new event, upstream change, dependency-version move, inferred animation, or
reduced acceptance is chosen here.

**B: complete policy-world input.** At v0.70.0,
`crates/dekopon-brokerd/src/lib.rs:1160-1198` constructs the world from service
identities, principal subjects/groups, every loaded registry capability, its
provider and read-only effect, and secret names. `:1338-1367` also distinguishes
strict/lenient policy construction and unchecked-secret handling.
`crates/dekopon-brokerd/src/capabilities.rs:11-31` describes the configured
capability allowlist; it is not the complete registry and carries no manifest
effect/risk fields. In Studio, `harness/BUNDLE.md:34,47-48` supplies provider pins
and runtime config paths only; `harness/evalgw/scenario.py:197-212` writes those
paths into broker config. An observed request or join line is not proof of all
capabilities a provider declares. Public `PolicyWorld` constructors can accept
complete facts, but the bundle does not establish those facts or an inventory
completeness marker. Brokerd's world assembly is not a reusable published
assembly entry point in `dekopon-policy`.

The missing-provider acceptance can be met by a typed world gap. The successful
bundle-derived what-if fixture still needs an approved evidence source for a
complete registry and its meaning. Do not silently add a manifest/config field,
run a provider, fetch a provider, assume an allowlist equals the registry, or
copy brokerd's assembly into a second implementation. If resolving this needs a
Dekopon change or a BUNDLE.md v1 change, that is the brief's explicit stop. The
coordinator must resolve the input contract before cedar implementation.

## Views: components, state, opening, and reader additions

Keep `App.tsx` as the shell. Put bundle selection and forensic/context components
under `src/studio/`. Use one local folder input (`webkitdirectory`, multiple
files); normalize a single picked root to relative paths and read `File` bytes.
No archive opener, File System Access API fallback, upload, persisted private
state, or new JavaScript runtime dependency is needed. Reject ambiguous roots
and duplicate paths; do not resolve any URL or absolute path found in a file.
Pass the resulting map to `readTrialBundle`; components never parse bundle JSON,
OTLP, journal text, Cedar config, or embedded transcript strings.

The component state is the validated record plus a message/step cursor and view
selection. Retain original file bytes privately for later seed export; never put
them into a raw-file viewer, DOM attribute, error dump, console, or HTML. Render
payloads as escaped text, with no HTML interpretation or active resource/link URLs
constructed from bundle content. The
view model is a pure projection of the record. Forward/back changes the cursor
into stable call/event snapshots, not mutable transcript reconstruction. A
selected call always uses that call's existing `input.messagesJson` and tool-set
reference. Show the reconstructed provenance, effective settings, unknown facts,
trace/span links within the UI, and input additions/removals between calls.
Keep unanchored calls and summaries visible rather than assigning false owners.

Forensics places the call input/definitions beside journal records at the
captured freeze: original retained items, slots, pins, choices, arrivals,
representations, publication and selection evidence. A journal's frozen state
is labeled with the bundle freeze; it is not presented as a historical snapshot
at every call. Missing or ambiguous joins remain gaps. Summary observations show
queued/running/generated/error transitions and available text; their input gap
is prominent. Opaque/image bytes stay omitted and asset `source` stays discarded.

Context steps cover received inputs, admission evidence, model attempts,
interrupted calls, tools, terminal delivery, publication, summary tasks, and the
next turn's recorded replay. Add typed facts for session replay counts and memory
generation. A steer-aborted attempt remains in the timeline and does not consume
a completed step; determine this from accounting/interruption evidence, not from
a missing answer or the number of spans. Show the exported step cap and report a
gap if it is absent. The exact mailbox animation remains blocked by stop A.
Use short CSS transitions keyed to the cursor, accessible Previous/Next controls,
readable text at every step, and `prefers-reduced-motion` to remove movement.
No autoplay is needed.

Proposed reader version is 2 for views. Each later part uses the next version at
its current-main base (3 for cedar and 4 for seed if they land in that order),
preserving `bundleVersion: 1`. Extend the existing OTLP decoding, allowlists, validation and
reconstruction inside `src/record/`, rather than adding a second parser. Views
adds typed lifecycle/admission/progress/session facts, span start/end/parent
references needed for joins, and explicit gaps for absent evidence. Cedar adds
typed sender/principal/space/decision/execution facts and validated policy inputs.
Seed adds typed envelope/continuation validation. Known malformed shapes remain
errors; unknown fields/variants remain notes with payloads discarded. Do not
relax integrity checks, integer precision, unknown handling, or source stripping.
New record fields are the explicitly requested reader contract extension.

## Cedar: wasm build, authority display, and conditional world assembly

The wasm home is `src/wasm/`: a small `policy/` Rust cdylib, build script, ignored
generated bindgen output, and a TypeScript adapter. Proposed exact pins are
`dekopon-policy = "=0.70.0"`, Rust `1.98.1` (upstream rust-version), and matching
`wasm-bindgen` library/CLI `0.2.126` (upstream Cargo.lock). Pin any directly needed
Dekopon/serde dependencies exactly and commit the crate's Cargo.lock. These are
design pins, not a claim that a wasm build has passed. No Cedar interpreter,
vendored engine, or handwritten policy semantics are introduced.

Build wasm in CI and locally, not committed generated binaries. Add
`npm run build:wasm` using `cargo build --locked --release --target
wasm32-unknown-unknown` and the pinned bindgen CLI. Embed generated wasm bytes
inside bundled JavaScript and initialize synchronously from those bytes. Do not
use bindgen's URL-loading initializer, a worker, fetch, or a separate runtime
wasm download. Build before typecheck so generated declarations exist. Amend
AGENTS.md's bootstrap-only Rust sentence, dependency justification, and gate list;
keep Node 24.19.0/npm 11.9.0 and SHA-pinned Actions with read-only permissions.
The justification is that the exact published crate supplies the same evaluator
as Dekopon and is required by the brief; no added JavaScript runtime package is
planned. Locking/build verification must prove wasm compatibility after review.

Multi-user display reads only typed reader facts. For each receipt show the
canonical authenticated subject; separately show the turn's active principal,
participant handle and recorded channel-downscoped join surface. Do not turn
message prose into trusted identity or a complete capability inventory. Join
surfaces can be shown as the gateway-authored lines preserved in the transcript,
with source provenance; any extraction belongs in the reader. Pair effects and
decisions by exported invocation/decision identifiers, not timeline proximity.
Show `asker.allowed`, `space.allowed`, and `decision.denied_by` verbatim, including
`space`, `asker`, and `both`; a pre-Cedar denial with only `space.id` remains so.

Recorded `broker.decision` is authoritative. A separate panel labels every result
as a what-if evaluation against the bundle's own policy text. Subject to stop B,
use the published `PolicyWorld` APIs and `PolicyEngine::authorize`, passing the
complete recorded request context and effect/risk facts. Shared-channel evaluation
must account for both participant and space, with the same request context, as
`crates/dekopon-broker/src/lib.rs:2162-2228` does. HTTP-specific or pre-Cedar
checks are not falsely represented as ordinary capability authorization. Missing
world, request, space mapping, or request facts produce typed gaps before calling
wasm. Preserve strict/lenient behavior only where evidence establishes it; never
infer secret names or unchecked mode from Cedar text. No UI claim of equivalent
whole-broker authorization is justified by a single Cedar verdict.

## Seed: proposed one-page contract and download

Add `harness/SEED.md` as the one-page format definition in the seed part; leave
BUNDLE.md v1 unchanged. Proposed download name is `dekopon-seed-v1.json`, a single
UTF-8 JSON envelope with these fields:

- `seedVersion`: integer `1`.
- `files`: path-sorted objects `{ "path": <relative bundle path>, "base64": <bytes> }`.
  Include the original `manifest.json` and present files reachable through its
  validated file references, preserving all bytes. Include each path once; never
  sweep in unreferenced sibling files from the selected folder.
- `continuationMessages`: ordered `{ "text": <string> }` objects, the same message
  shape used by the harness scenario. Identity, conversation, catalog and policy
  remain those in the embedded bundle. No authority is supplied by message text.

This is the seed's explicit single-download transport, not a new general archive
format or a replacement bundle manifest. Base64 preserves exact UTF-8/non-text
file bytes and existing file digests. `seedDigest` is lowercase SHA-256 over the
exact downloaded file bytes, computed with Web Crypto. It is not embedded in the
file it hashes; the producer displays it for a future trial to carry. Importers
hash the original bytes, never a reserialized object, avoiding canonical-JSON
ambiguity. Path sorting makes repeated exports stable; define ordering by UTF-8
bytes and compact JSON field order in the one-page contract.

The seed importer/validator lives in `src/record/` and delegates its recovered file
map to the existing bundle reader. It rejects duplicate/unsafe paths, invalid
base64, unsupported versions, malformed continuations and an absent/invalid
freeze. Only the bundle's validated non-null freeze can enable export; completeness
gaps remain visible and are not repaired. The round-trip keeps the same freeze
and continuation message bytes. An editor lets the viewer supply continuation
texts; it does not claim an arbitrary later transcript was captured after an
earlier freeze. A deliberate Export button creates a Blob URL and an `<a download>`;
revoke the URL after use. No network, server, directory write, or automatic export.
`evalgw/branch-arms` should consume this definition without conversion. Carrying
its digest in a trial must respect that trial manifest's approved version; changing
v1's fixed-null rule remains a stop, not an implicit part of this proposal.

## Fixtures, acceptance, and gates

Extend the existing `src/record/fixtures.ts` builder; do not add a parallel fake
reader, parser, or policy evaluator. Synthetic fixtures cover full/delta prompts,
a steer-aborted attempt followed by a replacement with the same model turn,
summary input gaps and slot changes, v3 frozen journal state, and asset source
canaries including nested fields. A handwritten v0.70.0 shared-channel fixture
adds participant subjects/handles, asker/space decisions, join lines and paired
effects. Its successful what-if inventory is unresolved under stop B. A missing
provider list must exercise the world gap; it must not invoke a guessed world.
Keep the harness at its released pin and use no captured private data.

Name Vitest and Playwright cases for the required invariants: stepping back after
forward restores the identical call input; steered attempts are aborted and not
counted toward the step cap; summary-input-unavailable renders as a gap; no asset
source canary appears anywhere in the DOM. Cedar cases assert a space denial's
denier, same-request participant what-if parity through the real compiled crate,
and the missing-provider world gap. Seed cases download, re-read through the
record reader, and compare freeze plus all continuation messages. Also assert
that null-freeze export cannot start. Each assertion must fail if its corresponding
behavior is removed; do not duplicate the reader's existing decoder tests.

Each part adds an interaction Playwright test using the existing built-page local
routing approach from `scripts/check-dist.mjs`. After initial bundled assets have
loaded, arm request/WebSocket observation, open a synthetic directory, drive that
part's interactions, and assert zero additional requests, including same-origin
requests. Block service workers, fail on page errors, and exercise reduced motion
for views and the actual wasm initialization/evaluation for cedar. A Blob download
in seed is observed as a download, not an allowed HTTP request. Reuse the existing
browser/routing helper by extending it rather than adding a second stand-in.

After the note review and stop resolution, run the eight brief gates in their
specified relative order: `npm ci`; `npm audit --audit-level=high`;
`npx playwright install --with-deps chromium`; `npm run lint`;
`npm run typecheck`; `npm test`; `npm run build`; `npm run check:dist`.
In cedar insert the new `npm run build:wasm` after browser installation and before
lint/typecheck, and run its interaction tests against the generated build. Every
part also runs the repository's existing daemon-free gate
`python3.12 -m unittest discover -s harness/tests -v`. Any separate interaction
command must be named in AGENTS.md/CI and the PR validation table. CI on each
merged head and its `dist/` artifact are the delivery proof; no deployment follows.

At this checkpoint all eight application gates, the harness gate, wasm build and
new interaction tests are **not run**: the brief requires note review before any
build. The note-only check is `git diff --check` after staging this file. Each final
PR body will record its exact head, toolchain, gates/results, omissions with reasons,
and end with `Choices I made`, one line per meaningful choice. No pushed commit
will be amended or rebased; merge main on conflicts.
