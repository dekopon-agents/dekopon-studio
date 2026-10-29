# evalgw harness

Operator-side Python that drives stock Dekopon daemons through one scenario and writes a trial
bundle ([BUNDLE.md](BUNDLE.md)) that the Studio reader opens. It is not part of the browser app:
nothing under `harness/` is imported by `src/` or bundled into `dist/`.

## Run one scenario

Requirements: Linux x86_64, Python 3.12 (CI pins 3.12.12; the runner uses only the standard
library), Docker, and outbound HTTPS to GitHub releases and Docker Hub for the first run.

```sh
python3.12 harness/run.py harness/scenarios/two-message.json --output /tmp/evalgw-attempt-001
```

The command:

1. Downloads the dekopon v0.70.0 x86_64 Linux release archive and gh provider v0.10.0 into
   `harness/.cache/` (ignored by git), verifies their pinned SHA-256 digests on every use, and checks
   that both daemons print version 0.70.0. There is no source build.
2. Creates the attempt directory (it must not exist) with a placeholder manifest.
3. Starts the digest-pinned OpenTelemetry Collector (contrib 0.137.0) with OTLP/HTTP on loopback and
   one `file` exporter each for traces and logs, then the loopback stub model and synthetic service.
4. Starts `dekopon-brokerd`, then `dekopon-gatewayd`, each with an owner-only config, a private `HOME`,
   `RUST_LOG=warn` and no other environment: no credential, proxy or OTLP header reaches them.
5. Sends message N on the local socket, waits for its whole reply line, then sends N+1.
6. Sends SIGTERM to the gateway and waits for its drain, then stops the broker, copies the journal,
   stops the fixtures, then stops the Collector so its file exporters flush.
7. Checks completeness, grades, writes `grade.json` and the final manifest, and prints both.

Exit status is 0 for passed, 1 for failed and 2 for an infrastructure error (no model score). The
attempt directory is kept in every case.

`python3.12 harness/verify.py <attempt>` regrades a bundle offline from its own evidence; it refuses
a bundle whose files no longer match the manifest hashes.

## Scenarios

A scenario is JSON data, never code: catalog agent fields, broker `capabilities` and
`providerSettings`, Cedar policy lines, gateway route settings, ordered messages, scripted stub
completions (each with request predicates and one `answer` or `bash` response), exact service routes,
and grading rules. External URLs are refused; the only substitutions are the attempt's loopback values
(`{{service.authority}}`, `{{service.origin}}`) and `{{principal}}`, `{{agent}}`. Every provider must
take its origin from the fixture service (`providerSettings.gh.baseUrl: "{{service.origin}}"`), every
`allowedHosts` must be exactly `["{{service.authority}}"]`, and no credential or secret binding is
accepted. The assembled configuration is checked again, with real loopback values, before any daemon
starts.

On the v0.70.0 journal-backed route, the newest `hotTurns` records replay native user, assistant
and tool messages, with tool results bounded by each record's share of `maxBytes`. Older records
use the ladder (stored pin, stored choice, deepest generated summary, then native). The stub's
`historyContains` predicate searches user, tool and assistant messages before the final prompt;
the final prompt and system prompts never satisfy it.

The two-message scenario explicitly sets `hotTurns: 10`, `summaries: "off"` and
`selection: "ladder"`. Disabling new summary generation keeps its scripted completions limited to
the two main-loop turns. Journals use the internal v3 format the Studio reader already reads;
ordinary trials still use bundle v1 and its fixed-null `seedDigest`. Capture copies only conversation
`.jsonl` files; private cache-key state and side markers never enter a bundle.

The acceptance scenario, `scenarios/two-message.json`, makes one authorized `gh repo view` read
through brokerd against the synthetic service, then asks the agent to recall that fact on a
journal-backed route. Its whole `repo view` output is 69 bytes, well inside the output cap.

After building the Studio and installing its pinned Playwright browser, open that generated bundle:

```sh
node scripts/check-harness.mjs /tmp/evalgw-attempt-001
```

This smoke check uses the existing built-page routing helper. It verifies a complete v0.70.0 trial,
both frozen journal records and the recalled fact in the second call, drives both Studio views,
and requires zero network requests after opening the bundle. CI runs the documented scenario and
this check after the ordinary browser gates. No bundle contents are sent to a live site.

## Restore a Studio seed and run the ruled arms

Seed operations also require the repository's Node 24.19.0, npm 11.9.0 and `npm ci`.
`harness/record.mjs` builds an operator adapter into the ignored cache and calls the existing
`src/record/` importer, journal reconstruction and seed exporter. There is no second seed decoder
or browser-to-harness import. The adapter is never bundled into the app.

```sh
python3.12 harness/branch.py --reference --output /tmp/evalgw-reference
node scripts/check-arms.mjs /tmp/evalgw-reference
python3.12 harness/branch.py /tmp/evalgw-reference/dekopon-seed-v1.json --output /tmp/evalgw-replay
```

Each output directory must be new. `--reference` writes `original/`, a Studio-format
`dekopon-seed-v1.json`, `arms/<arm-id>/`, and `results.json` with every manifest, grade and first
projection comparison. A supplied seed writes `<arm-id>/` and `results.json` directly under the
output. Repeat `--arm <id>` to run a subset. Exit statuses match the ordinary runner.

Only synthetic, harness-made v0.70.0 bundles can execute. The importer accepts the Studio seed
without rewriting its bytes: the digest is SHA-256 of the exact downloaded file, unknown fields
are noted, and unavailable or unverified frozen journals fail with the importer's typed errors.
Execution additionally checks the recorded scenario and fixture evidence, pinned daemon/provider
identities, catalog, Cedar policy, grant, horizon and configuration. It refuses remote endpoints or
credentials. The common seed must already contain the `decide` provider v0.1.1 and its grant when
running the decider arm; the owner `providerSettings.decide.baseUrl` points at the loopback fixture.
This proves compatibility with synthetic exports, not provenance or safety of arbitrary inputs.

Restoration stages every captured journal file verbatim at the fresh gateway's private journal
root, verifies its hash again immediately before launch, and uses the original conversation.
Changing timestamps, pins, grants or journal bytes is refused. Only private runtime paths,
Collector endpoints and authenticated operator UID bindings relocate. Model/provider loopback
ports are rebound to their recorded values so network grants and endpoints stay unchanged; a busy
port makes the attempt incomplete. Both daemons retain the inherited launcher UID arrangement.

| Arm | Memory settings relative to the seed |
| --- | --- |
| `live-policy` | `hotTurns`, `summaries`, `selection` unchanged |
| `decider` | Same `hotTurns` and `summaries`; `selection: {decider: {capability: "decide.choose", backend: "openrouter-jev", model: "typesafe/jev-1.13", requireProbabilities: true}}` |
| `summaries-preferred` | `hotTurns: 1`; same `summaries` and `selection` |

The reference seed has four records, `hotTurns: 2`, two generated summary parts per record and a
roughly 200 KiB Bash result containing an early synthetic fact. The result uses 1,024 lines inside
the shell's existing byte and line ceilings. Two later distractor records age the fact out of the
hot tail. The runner waits for summary publication before freezing, using the Studio journal
reader. Each arm then receives the seed's two continuation messages in order. The stub decider
selects metadata with a normalized probability distribution; its first decision is persisted after
the first reply, so its first projection matches live policy. Later requests may diverge.

`summaries-preferred` keeps the newest record native; older unpinned, unchosen records prefer
their deepest generated summary. Summary plans were fixed at append: changing `summaries` could
only affect new records. Native replay still prefixes tool results and WindowFit may omit records.
Originals-only and prefixes-only are deferred together to a later core projection-selector/export
contract. No core change or journal edit implements them here.

Each arm writes bundle v2 with `seedDigest` and `armId`; ordinary trials remain v1. The reader's
record version is v5. Seed v1 still embeds only a bundle v1: seeded trials open in Studio but cannot
be re-exported as seed v1. Open `original/` and each arm directory in separate Studio tabs, or use
the built-app check above, which keeps all four tabs open and asserts zero interaction requests.

Before scoring, `driver.json.firstProjection` compares the first actual `model.complete` input
with a cold projection reconstructed from frozen records under that arm's v0.70.0 knobs. It checks
the exact replay history, authenticated continuation, projection rung counts and byte count, and
names every omission (including WindowFit). Each frozen record gets a row. The exported selected-ID
array may be absent; that observed field stays null, and record attribution is explicitly
`reconstructed-from-exact-replay`, supported by the whole matching history and aggregate evidence.
Missing completion/input evidence, an unsupported native item, or a mismatch makes the trial
incomplete with a null score. Empty continuation lists cannot produce a checked result. Source
notes, gaps and completeness remain in `driver.seed`; effective model defaults stay unknown.

## Tests

```sh
python3.12 -m unittest discover -s harness/tests -v
```

After `npm ci`, the tests use the same record adapter, synthetic seed/OTLP fixtures and in-process loopback fixtures only; they need no daemon,
Docker or network.

## Harbor

`harbor/` holds an optional Harbor 0.23.0 host agent and an offline verifier that call the same
driver and grader; see [harbor/README.md](harbor/README.md). The core runner and tests do not need it.
