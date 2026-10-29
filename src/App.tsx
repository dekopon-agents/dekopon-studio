import { useRef, useState } from 'react';
import type { OpenResult } from './studio/open';
import { location } from './studio/Facts';
import { openDirectory, openSeed } from './studio/open';
import Studio from './studio/Studio';
import SeedExport from './studio/SeedExport';

export default function App() {
  const [result, setResult] = useState<OpenResult>();
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  async function open(files: File[], seed = false) {
    const id = ++request.current;
    setResult(undefined); setLoading(true);
    const next = await (seed ? openSeed(files[0]) : openDirectory(files));
    if (id === request.current) { setResult(next); setLoading(false); }
  }
  return <main>
    <header><p className="eyebrow">Context Studio</p><h1>Dekopon Studio</h1>
      <p>Inspect forensic chat records and explore agent context in your browser.</p>
      <p>Open a trial bundle directory. Its contents stay in this browser.</p>
      <label className="file-picker">Open bundle directory
        <input type="file" multiple {...{ webkitdirectory: '' }} aria-label="Open bundle directory"
          onChange={event => { const files = Array.from(event.target.files ?? []); if (files.length) void open(files); }} />
      </label>
      <label className="file-picker">Open seed
        <input type="file" accept=".json,application/json" aria-label="Open seed"
          onChange={event => { const files = Array.from(event.target.files ?? []); if (files.length) void open(files, true); }} />
      </label>
      {loading && <p role="status">Reading and verifying…</p>}
      {result && !result.ok && <div role="alert"><h2>Bundle or seed could not be opened</h2>
        <ul>{result.errors.map((error, i) => <li key={i}>{error.kind} · {location(error.at)}</li>)}</ul>
      </div>}
    </header>
    {result?.ok && <div key={request.current}>
      <SeedExport record={result.record} files={result.files} initialMessages={result.continuationMessages} importedDigest={result.seedDigest} />
      <Studio record={result.record} />
    </div>}
  </main>;
}
