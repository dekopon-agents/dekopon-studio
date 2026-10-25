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
npm run lint
npm run typecheck
npm test
npm run build
npm run check:dist
```

TypeScript stays strict. The test suite includes the landing component and URL
checker rejection cases. CI runs every gate and uploads `dist/` as an artifact.
No deployment, publishing, release tags, Rust toolchain, or wasm package belongs
in this bootstrap.

## Must-hold client-side rule

Nothing a viewer opens may ever leave the browser. This is a must-hold invariant
for every later step: no uploads, remote evaluation, analytics, telemetry, or
code that sends viewer data anywhere. All runtime assets must be bundled and all
asset URLs must stay under `/studio/`; no runtime fonts, CDNs, or third-party
requests. Only synthetic fixtures may enter this repository.

`src/App.tsx` owns the landing shell. Future forensic reader modules belong under
`src/record/`. Future wasm packages will plug in through `src/wasm/`, bundled for
client-side execution; bootstrap adds neither that implementation nor a Rust
build. Keep these integrations inside the browser boundary.

## Built URL gate

`scripts/check-dist.mjs` parses JavaScript literals and HTML attributes and scans
CSS URLs. It fails on URLs outside `/studio/` except exact inert strings recorded
with reasons in `scripts/url-allowlist.json`. Inert strings are allowed as code
constants, never as HTML asset or CSS resource URLs. Unknown dist file types fail
closed; extend the checker deliberately when new asset types are introduced.
The check does not prove arbitrary computed code makes no network calls: review
all future data and networking code against the client-side rule above.
