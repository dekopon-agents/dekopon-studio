import { useRef, useState } from 'react';
import type { ReadResult } from './record';
import { location } from './studio/Facts';
import { openDirectory } from './studio/open';
import Studio from './studio/Studio';

export default function App() {
  const [result, setResult] = useState<ReadResult>();
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  async function open(files: File[]) {
    const id = ++request.current;
    setResult(undefined); setLoading(true);
    const next = await openDirectory(files);
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
      {loading && <p role="status">Reading and verifying bundle…</p>}
      {result && !result.ok && <div role="alert"><h2>Bundle could not be opened</h2>
        <ul>{result.errors.map((error, i) => <li key={i}>{error.kind} · {location(error.at)}</li>)}</ul>
      </div>}
    </header>
    {result?.ok && <Studio key={request.current} record={result.record} />}
  </main>;
}
