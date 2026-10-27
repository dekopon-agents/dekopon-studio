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

1. Downloads the dekopon v0.62.0 x86_64 Linux release archive and gh provider v0.10.0 into
   `harness/.cache/` (ignored by git), verifies their pinned SHA-256 digests on every use, and checks
   that both daemons print version 0.62.0. There is no source build.
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

Output needles must fall within the provider output the model receives: on 0.62.0 tool output is
cut at about 1 KiB with no marker before it reaches `agent.tool.output`. On a journal-backed route
earlier turns come back inside the user message (`[memory: ...]`), so the stub's `historyContains`
predicate searches every message in the request.

The acceptance scenario, `scenarios/two-message.json`, makes one authorized `gh repo view` read
through brokerd against the synthetic service, then asks the agent to recall that fact on a
journal-backed route. Its whole `repo view` output is 69 bytes, well inside the output cap.

## Tests

```sh
python3.12 -m unittest discover -s harness/tests -v
```

The tests use synthetic OTLP fixtures and in-process loopback fixtures only; they need no daemon,
Docker or network.

## Harbor

`harbor/` holds an optional Harbor 0.23.0 host agent and an offline verifier that call the same
driver and grader; see [harbor/README.md](harbor/README.md). The core runner and tests do not need it.
