# Dekopon Studio engineering gates

Use Node 24.19.0, declared in `.nvmrc` and used by CI, and npm 11.9.0.
`package.json` restricts the Node engine to major 24. Commit `package-lock.json`
and install with `npm ci`. Pin direct dependency versions exactly. Every GitHub
Action must use a full commit SHA with its version in a comment. Workflow
permissions default to `contents: read`.

Run these exact commands, in order, before submitting changes:

```sh
npm ci
npm audit --audit-level=high
npx playwright install --with-deps chromium
npm run build:wasm
npm run lint
npm run typecheck
npm test
npm run build
npm run check:dist
npm run check:views
npm run check:seed
npm run check:cedar
```

TypeScript stays strict. The test suite includes the landing component and URL
runtime request-gate regressions. CI runs every gate and uploads `dist/` as an artifact.
Deployment, publishing, and release tags are outside this step. Rust and wasm
are limited to the pinned client-side policy bridge under `src/wasm/`.

## Must-hold client-side rule

Nothing a viewer opens may ever leave the browser. This is a must-hold invariant
for every later step: no uploads, remote evaluation, analytics, telemetry, or
code that sends viewer data anywhere. All runtime assets must be bundled and all
asset URLs must stay under `/studio/`; no runtime fonts, CDNs, or third-party
requests. Only synthetic fixtures may enter this repository.

`src/App.tsx` owns the landing shell. Reader modules belong under
`src/record/`. The policy bridge lives under `src/wasm/`, bundled for
client-side execution. Keep these integrations inside the browser boundary.

## Built runtime request gate

After `npm ci`, install the pinned browser with `npx playwright install --with-deps chromium`
(also done in CI before tests). The exact Playwright dependency pins its Chromium
revision; do not substitute a system browser.

`npm run check:dist` enforces **no request outside /studio/ when the built pages load**.
Playwright loads every HTML file under `dist/` at
`https://dekopon-agents.github.io/studio/`, serving bundled resources locally from
disk through browser routing. It records requests and rejects any whose origin
differs or whose path is outside `/studio/`. Out-of-bound requests are aborted;
nothing is sent to the live site or third parties. Missing assets, page errors,
and WebSocket attempts also fail. Service workers are blocked for observation.
No static URL scanner or inert-string allow-list remains.

Each page gets an isolated context. Observation ends at network idle (500 ms with
no pending requests, within a 10-second load limit). The gate cannot see code paths
not exercised on load: user interactions, later timers, conditional branches,
service-worker behavior, or markup/CSS constructed only on those paths. Review
those paths against the must-hold browser-only rule; passing this load test is not
a proof of all possible runtime behavior.

## Operator harness (`harness/`)

`harness/` is operator-side Python 3.12 that drives released Dekopon daemons with a loopback stub
model and synthetic fixtures, and writes trial bundles in the layout of `harness/BUNDLE.md`. The
must-hold browser-only rule above governs the app: everything a viewer opens. It does not describe
the harness, which runs on an operator's machine, talks to local processes and a local Collector, and
downloads checksum-pinned release artifacts into the ignored `harness/.cache/`. Nothing in `harness/`
may be imported by `src/` or bundled into `dist/`, and only synthetic fixtures may enter it.

The Node gates above are unchanged. The harness adds one daemon-free gate, run in CI as its own job:

```sh
python3.12 -m unittest discover -s harness/tests -v
```

## Opened-bundle interaction gate

`npm run check:views` uses the same pinned Playwright browser and built-page routing
as `check:dist`. After bundled page assets load, it opens a handwritten synthetic
bundle directory and drives forensic and context views. It asserts zero additional
requests, including same-origin requests, as well as the stepping, aborted-step,
summary-gap, source-omission and reduced-motion invariants. Run it after the build
and `check:dist`; CI runs it before uploading `dist/`. Do not replace the pinned
browser with a system browser.

## Seed interaction gate

`npm run check:seed` opens a synthetic bundle in the built app, marks only its
captured freeze, edits continuation messages, downloads a seed, and reopens it
through the record reader. It checks freeze/continuation round-trip, null-freeze
refusal and zero additional network requests, including same-origin requests.
The local Blob download is the only way viewer bytes leave the app. CI runs this
gate after `check:views` and before uploading `dist/`. The seed format is defined
in [harness/SEED.md](harness/SEED.md); bundle v1 is unchanged.

## Pinned policy wasm

The added Rust dependencies are justified by the requirement to use the published
`dekopon-policy` evaluator in the browser: exact `dekopon-policy`, `dekopon-core`
and `dekopon-capability` 0.70.0 supply the engine and its validated types; serde
1.0.229 and serde_json 1.0.151 carry explicit facts across the bridge; wasm-bindgen
0.2.126 provides the binding. No JavaScript runtime dependency is added.

Prepare Rust 1.98.1 with rustfmt and wasm32-unknown-unknown, and install the exact
CLI with `cargo +1.98.1 install wasm-bindgen-cli --version 0.2.126 --locked`.
`npm run build:wasm` checks the Rust/CLI pins, formatting, native bridge tests and a
locked release build, then generates bindings and inline bytes. Commit Cargo.lock;
never commit `src/wasm/generated/` or target output. CI builds them from scratch
before lint, typecheck and tests, with a 20-minute check-job limit for Rust builds.
CI also runs on `codex/record-studio-cedar-1` so proof can precede a ready PR.

Use only the synchronous initializer with embedded bytes. Never use bindgen's URL
initializer, fetch, remote imports or workers. `npm run check:cedar` shares the
existing built-page helper and requires zero requests after opening and driving
a synthetic multi-user bundle, including actual wasm initialization.

Bundle v1 has no complete provider inventory. Its world is always a typed gap;
the UI never supplies a fabricated world to wasm. Explicit-world native bridge
tests verify the published engine, not successful bundle what-ifs. The latter
remain deferred under the coordinator's 2026-10-28 ruling (B).
