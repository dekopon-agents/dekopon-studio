import { useState } from 'react';
import { exportSeed } from '../record';
import type { ChatRecord, ContinuationMessage } from '../record';
import { FactView, location } from './Facts';

export default function SeedExport({ record, files, initialMessages, importedDigest }: {
  record: ChatRecord; files: ReadonlyMap<string, Uint8Array>;
  initialMessages: ContinuationMessage[]; importedDigest?: string;
}) {
  const [marked, setMarked] = useState(false);
  const [messages, setMessages] = useState<ContinuationMessage[]>(initialMessages);
  const [busy, setBusy] = useState(false);
  const [digest, setDigest] = useState(importedDigest);
  const [error, setError] = useState('');
  async function download() {
    if (!marked || busy || record.freeze.state !== 'known') return;
    setBusy(true); setError(''); setDigest(undefined);
    try {
      const result = await exportSeed(files, messages);
      if (!result.ok) {
        setError(result.errors.map(e => e.kind + ' · ' + location(e.at)).join('; '));
        return;
      }
      const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'dekopon-seed-v1.json';
      document.body.append(link);
      try { link.click(); }
      finally {
        link.remove();
        // Give the browser time to start its download before releasing the local URL.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setDigest(result.seedDigest);
    } catch { setError('Seed download could not be created.'); }
    finally { setBusy(false); }
  }
  return <section className="panel seed-export" aria-label="Seed export"><h2>Seed from the captured freeze</h2>
    {importedDigest && <p role="status">Seed opened and verified.</p>}
    <p>Mark this captured freeze and add the messages a fresh gateway should continue with. Stepping through observations does not change the freeze.</p>
    <FactView fact={record.freeze} />
    {record.freeze.state === 'unknown' && <p>A validated freeze is required to export a seed.</p>}
    <label><input type="checkbox" checked={marked} disabled={busy || record.freeze.state !== 'known'}
      onChange={event => setMarked(event.target.checked)} /> Use captured freeze for seed</label>
    <p>The seed preserves the referenced bundle bytes, identity, catalog and policy, including any evidence gaps shown below. Continuation text grants no authority.</p>
    <fieldset disabled={busy}><legend>Continuation messages (in send order)</legend>
      <ol>{messages.map((message, i) => <li key={i}>
        <label htmlFor={'continuation-message-' + i}>Continuation message {i + 1}</label>
        <textarea id={'continuation-message-' + i} value={message.text} onChange={event => {
          setMessages(current => current.map((entry, index) => index === i ? { text: event.target.value } : entry));
          setDigest(undefined);
        }} />
        <button onClick={() => { setMessages(current => current.filter((_, index) => index !== i)); setDigest(undefined); }}>Remove message {i + 1}</button>
      </li>)}</ol>
      <button onClick={() => { setMessages(current => [...current, { text: '' }]); setDigest(undefined); }}>Add continuation message</button>
    </fieldset>
    <button disabled={!marked || busy || record.freeze.state !== 'known'} onClick={() => void download()}>{busy ? 'Preparing seed…' : 'Export seed'}</button>
    {digest && <p>SHA-256 seedDigest: <output aria-label="Seed digest">{digest}</output></p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
