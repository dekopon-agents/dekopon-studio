import { bundle } from './bundle';
import { Context, Failure } from './json';
import { journal } from './journal';
import { otlp } from './otlp';
import { reconstruct } from './reconstruct';
import type { ReadResult } from './types';

export type * from './types';

export async function readTrialBundle(files: ReadonlyMap<string, Uint8Array>): Promise<ReadResult> {
  const c = new Context();
  try {
    const snapshot = new Map([...files].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
    const b = await bundle(snapshot, c);
    const exported = { spans: [], events: [] } as ReturnType<typeof otlp>;
    for (const [path, logs] of [[b.trace, false], [b.logs, true]] as const) if (path) {
      const parsed = otlp(snapshot.get(path)!, path, logs, c);
      exported.spans.push(...parsed.spans); exported.events.push(...parsed.events);
    }
    const version = b.record.dekoponVersion.state === 'known' ? b.record.dekoponVersion.value : null;
    const match = version?.match(/^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:[-+].*)?$/);
    const v3 = match && (BigInt(match[1]) > 0n || BigInt(match[2]) >= 65n);
    if (b.journals.length && !v3) c.gaps.push({ kind: 'journal-format', at: { path: 'manifest.json', field: 'journal' }, version });
    else for (const path of b.journals) b.record.journals.push(...journal(snapshot.get(path)!, path, c));
    reconstruct(b.record, exported, c);
    return { ok: true, record: b.record };
  } catch (error) {
    return { ok: false, errors: [error instanceof Failure ? error.error : { kind: 'reader-failure', at: { path: 'manifest.json' } }], notes: c.notes };
  }
}
