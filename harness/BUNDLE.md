# Trial bundle, version 1

One attempt writes one directory. It is created exclusively and is never reused or deleted, including
for launch failures. `manifest.json` is written before any daemon starts, as an incomplete placeholder,
and atomically replaced once the attempt is finalized. `record/reader` reads this layout.

```text
manifest.json
trace/traces.jsonl                         OTLP JSON lines, one export request per line (Collector file exporter)
trace/logs.jsonl                           same, for logs
journal/<agent>/<conversation-stem>.jsonl  optional; verbatim copy taken after the gateway exits
config/{scenario,catalog,broker,gateway}.json
config/policies.cedar
config/collector.yaml
stdout/{gateway,broker}.jsonl              daemon console at RUST_LOG=warn, verbatim
stdout/{gateway,broker}.stderr
stdout/collector.log
driver.json                                sent messages, reply lines, process exits, fixture requests
grade.json
```

## Manifest

Every file reference is `{"path", "sha256", "bytes"}` with `path` relative to the bundle. The manifest
holds no absolute host path and no URL a reader must fetch. An absent file is `null`.

| Field | Meaning |
| --- | --- |
| `bundleVersion` | `1` |
| `kind` | `"trial"` |
| `attempt` | `id`, `startedAt`, `finishedAt` (UTC ISO 8601) |
| `scenario` | `id` and `config` (reference to `config/scenario.json`) |
| `dekopon` | `version`, `source` (`repository`, `commit`), `artifact` (archive `name`, `version`, `source`, `sha256`), `binaries` (per daemon: `sha256`, `version` as printed by `--version`) |
| `providers` | per provider: `id`, `name`, `version`, `source`, `sha256` |
| `collector` | `image` (digest-pinned), `exitCode`, `forcedKill` |
| `trace`, `logs` | `format: "otlp-jsonl"` plus the reference |
| `journal` | `null`, or `format` and `files` (references). The format is the gateway's internal journal, unversioned on disk (v2 at dekopon 0.62.0); readers must treat it as coupled to that release |
| `freeze` | `null`, or `lastRepliedMessage`, `conversation`, `journalStems`, `gateway` (`signal`, `drained`, `exitCode`), `copiedAt` |
| `config` | references for `scenario`, `catalog`, `broker`, `gateway`, `policies`, `collector` |
| `stdout` | `gateway` and `broker` (`stdout`, `stderr` references), `collector`, `lossSignals` (console reasons, below) |
| `driver` | reference to `driver.json` |
| `completeness` | `status` (`complete` or `incomplete`) and `reasons` (`code`, `detail`) |
| `grade` | reference to `grade.json` |
| `gaps` | strings naming evidence this bundle does not carry |
| `seedDigest` | always `null` in version 1 |

Config copies are what the daemons read, verbatim, so they name the attempt's private runtime paths
(sockets, journal directory). Those are evidence, not references.

## Freeze

A freeze exists only when the gateway, after the last reply, exited 0 from SIGTERM within its drain
deadline; the journal is copied after that exit. A forced kill, non-zero exit or missing reply leaves
`freeze: null` and the attempt is incomplete. A reply timestamp alone is never a freeze.

## Completeness

`incomplete` when any reason exists. Reason codes:

- Console (both daemons, stdout and stderr): `opentelemetry_diagnostic` (an `opentelemetry*` target at
  WARN or ERROR, or an exporter-disabled notice), `telemetry_console_dropped`,
  `gateway_telemetry_shutdown_failed`, `gateway_sessions_abandoned`, `console_missing`, `console_malformed`.
- Exports: `export_missing`, `export_malformed`.
- Evidence: `message_evidence_missing` (one trace with a `gateway.message` span, at least one
  `agent.model.prompt` and a final `agent.model.answer` per sent message), `message_count_discontinuity`.
- Run: `driver_failure`, `driver_record_missing`, `process_failure`, `reply_missing`, `fixture_violation`,
  `receiver_failure` (an error-level line in the Collector log, or no log), `finalization_error` (the
  check itself failed; the attempt is still finished, with an infrastructure-error grade).

`message.count` on `agent.model.prompt` is the transcript length, not a sequence number. Prompts are
grouped by model session (the `prompt.session` parent of each `prompt.model_turn` span). Within a
session a `full` prompt must carry exactly `message.count` messages, and a `delta` prompt must carry
`message.count` minus the previous prompt's count. Sessions are never compared with each other.

## Evidence and grade

Gatewayd exports `dekopon_agent::audit` records as span events, not log records. The reader takes
records from both and drops a log record that repeats a span event (same trace, span, record name and
attributes). Each message is one trace, anchored by its earliest `gateway.message` span (a queued
message opens a second one in the same trace); message ordinals follow anchor start times, and
everything in the trace belongs to that message. The socket reply line is transport evidence only and
is never graded.

Scripts are each bash call's `agent.tool.script` text and `agent.tool.output` result, paired by
`gen_ai.tool.call.id`; dekopon does not bound either. Script needles, output counts and read order are
graded from them, as S4 grades its runner's scripts. `shell.command.output` is not used: on 0.62.0 a
provider command can export it empty (`.bytes` 0) while its stdout reached the script. `shell.command`
spans still decide the `command`, `argumentsContain`, `outcome` and `exitCode` checks. Their
`.arguments` are bounded at 4096 bytes, with the original length recorded as `.arguments.bytes`; a
truncated value, or one without its length, is a gap. Any evidence field of the wrong type (a
non-text command name, argument or outcome, a non-integer exit code) or text that is not valid UTF-8
is a gap, never coerced. Rules are validated against a fixed schema (unknown keys, missing predicates
and wrong types are refused) before a scenario runs and again in offline regrading; an invalid rule
never grades.

Malformed OTLP shapes are `export_malformed`. Every scalar the reader takes from an export (strings,
fixed64 timestamps, int64 and finite double values, booleans) goes through one validating conversion,
AnyValue nesting is bounded at 32 levels, an explicit `null` in a parsed field is refused (the Collector
never writes one; an absent field keeps its default), and JSON that cannot be decoded (including
CPython's integer digit limit and deep nesting) is malformed, never a crash. JSON carried inside text
attributes and console lines is decoded without raising.

`grade.json`: `gradeVersion: 1`, `status` (`passed`, `failed` or `infrastructure_error`), `score`
(`1.0`, `0.0` or `null`), `reasons`, and per-rule `rules` results (`pass`, `fail`, `gap`). An incomplete
bundle, or any rule whose evidence field is absent, is `infrastructure_error` with `score: null`.
