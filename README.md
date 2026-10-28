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
npm run dev
```

Open the local URL printed by Vite at `/studio/`. Run the gates in [AGENTS.md](AGENTS.md)
before proposing changes. `npm run build` writes the static app to `dist/` with
asset paths under `/studio/`; `npm run check:dist` checks requests while Chromium loads every built HTML page.
`npm run check:views` opens a synthetic bundle in that build and checks views with
zero additional network requests.

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
text are shown. Policy evaluation and seed export are later parts.

The app uses bundled code and system fonts. Viewer data must stay in the browser.
Only synthetic fixtures may enter this repository.

Licensed under MIT OR Apache-2.0; see LICENSE-MIT and LICENSE-APACHE.
