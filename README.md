# Dekopon Studio

Dekopon Studio will host the forensic chat record reader and Context Studio:
inspect chat records and explore agent context inside your browser. This bootstrap
provides an empty landing view and reads no data.

The owner's purpose is a standalone React app, with wasm pieces later lifted out
of Dekopon, that can eventually live at `dekopon-agents.github.io/studio`.
This repository currently builds static files and uploads a CI artifact; it does
not publish or deploy them.

## Local development

Use Node 24.19.0 (`nvm use`, if you use nvm) and npm 11.9.0.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite at `/studio/`. Run the gates in [AGENTS.md](AGENTS.md)
before proposing changes. `npm run build` writes the static app to `dist/` with
asset paths under `/studio/`; `npm run check:dist` checks its URL allow-list.

The app uses bundled code and system fonts. Viewer data must stay in the browser.
Only synthetic fixtures may enter this repository.

Licensed under MIT OR Apache-2.0; see LICENSE-MIT and LICENSE-APACHE.
