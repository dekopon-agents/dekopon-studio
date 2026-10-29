# Dekopon Studio

Dekopon Studio opens trial bundle directories entirely in your browser. Inspect
each model call's reconstructed input and tools beside the frozen journal, or
step through the context timeline, admissions, replay and summary observations.
Missing evidence is shown as gaps; attachment sources are never rendered.

The owner's purpose is a standalone React app, with wasm pieces later lifted out
of Dekopon, that can eventually live at `dekopon-agents.github.io/studio`.
This repository currently builds static files and uploads a CI artifact; it does
not publish or deploy them.

## Local development

Use Node 24.19.0 (`nvm use`, if you use nvm) and npm 11.9.0.

```sh
npm ci
npx playwright install --with-deps chromium
rustup toolchain install 1.98.1 --profile minimal --component rustfmt --target wasm32-unknown-unknown
cargo +1.98.1 install wasm-bindgen-cli --version 0.2.126 --locked
npm run build:wasm
npm run dev
```

Open the local URL printed by Vite at `/studio/`. Run the gates in [AGENTS.md](AGENTS.md)
before proposing changes. `npm run build` writes the static app to `dist/` with
asset paths under `/studio/`; `npm run check:dist` checks requests while Chromium loads every built HTML page.
`npm run check:views` opens a synthetic bundle in that build and checks views with
zero additional network requests. `npm run check:cedar` drives the permissions
view and initializes the policy wasm with the same zero-request requirement.

## Opening a bundle

Choose **Open bundle directory** and select the folder containing `manifest.json`.
The reader checks its referenced file sizes and SHA-256 digests. A mismatched file
is refused; missing evidence remains visible as a gap. Nothing is uploaded.

Choose a message's model attempt in **Forensic view**, or use **Context view** and
**Previous step / Next step** to move through recorded observations. The journal
panel always describes the bundle's captured freeze, not a snapshot inferred from
the cursor. Reduced-motion preferences disable step animation.

At Dekopon v0.70.0, admissions export combined mailbox depth but not queue
inventories or exact RUNNING/COMPLETING intervals. Those remain explicitly unknown.
Summary-engine inputs also remain unavailable; summary transitions and observed
text are shown. The Permissions view shows recorded principals, participant surfaces and broker
decisions. Its what-if panel reports the missing provider inventory; successful
bundle evaluation awaits a core export.

## Exporting a seed

With a validated captured freeze, check **Use captured freeze for seed**, add
continuation messages in send order, and choose **Export seed**. The browser
downloads `dekopon-seed-v1.json` and displays the SHA-256 digest of its exact bytes.
The seed preserves the manifest and present referenced files byte-for-byte;
missing evidence stays a gap. A bundle without a validated freeze cannot be seeded.
Moving the timeline cursor does not change the captured freeze.

Choose **Open seed** to verify that file locally, inspect its frozen record and
edit its continuation messages. Nothing is uploaded. The format and digest
contract for eval-gateway consumers is [harness/SEED.md](harness/SEED.md).
`npm run check:seed` checks download and reopen with zero additional requests.

The app uses bundled code and system fonts. Viewer data must stay in the browser.
Only synthetic fixtures may enter this repository.

Licensed under MIT OR Apache-2.0; see LICENSE-MIT and LICENSE-APACHE.
