// @vitest-environment node
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { exportSeed, readSeed, readTrialBundle } from './index';
import { studioFixture } from './fixtures';

const encoder = new TextEncoder();
async function envelope() {
  const files = await studioFixture().files();
  const result = await exportSeed(files, [{ text: 'synthetic continuation' }]);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return JSON.parse(new TextDecoder().decode(result.bytes));
}
test('seed export then re-read round-trips the same freeze, continuation messages and referenced bytes', async () => {
  const files = await studioFixture().files();
  files.set('unreferenced-private-sibling.txt', encoder.encode('not part of the bundle'));
  const continuationMessages = [{ text: 'First 🦀\nline two\r\n\u0000' }, { text: '' }, { text: 'Second <script>synthetic</script>' }];
  const original = await readTrialBundle(files);
  const exported = await exportSeed(files, continuationMessages);
  expect(exported.ok).toBe(true);
  if (!exported.ok || !original.ok) throw new Error('synthetic bundle failed');
  const restored = await readSeed(exported.bytes);
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw new Error(JSON.stringify(restored.errors));
  expect(restored.record.freeze).toEqual(original.record.freeze);
  expect(restored.continuationMessages).toEqual(continuationMessages);
  expect(restored.record.messages).toEqual(original.record.messages);
  const expected = new Set(['manifest.json', ...original.record.references.map(r => r.path)]);
  expect([...restored.files.keys()]).toEqual([...expected].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  for (const [path, bytes] of restored.files) expect(bytes).toEqual(files.get(path));
  expect(restored.seedDigest).toBe(createHash('sha256').update(exported.bytes).digest('hex'));
  expect(exported.seedDigest).toBe(restored.seedDigest);
  const repeated = await exportSeed(new Map([...files].reverse()), continuationMessages);
  expect(repeated.ok && repeated.bytes).toEqual(exported.bytes);
  const spaced = encoder.encode(' \n' + new TextDecoder().decode(exported.bytes));
  const imported = await readSeed(spaced);
  expect(imported.ok && imported.seedDigest).toBe(createHash('sha256').update(spaced).digest('hex'));
  expect(imported.ok && imported.seedDigest).not.toBe(exported.seedDigest);
});
test.each([null, { gateway: { signal: 'SIGTERM', drained: false, exitCode: 0 } }])(
  'an absent or invalid freeze cannot be exported or imported as a seed (%j)', async freeze => {
    const fixture = studioFixture(); fixture.extraManifest.freeze = freeze;
    expect(await exportSeed(await fixture.files(), [])).toMatchObject({ ok: false, errors: [{ kind: 'seed-freeze' }] });
    const seed = await envelope();
    const manifest = seed.files.find((f: { path: string }) => f.path === 'manifest.json');
    manifest.base64 = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(manifest.base64, 'base64').toString()), freeze })).toString('base64');
    expect(await readSeed(encoder.encode(JSON.stringify(seed)))).toMatchObject({ ok: false, errors: [{ kind: 'seed-freeze' }] });
  });
test('seed export preserves missing evidence as gaps without adding missing or sibling files', async () => {
  const files = await studioFixture().files(); files.delete('trace/traces.jsonl');
  const exported = await exportSeed(files, []);
  if (!exported.ok) throw new Error('export failed');
  const result = await readSeed(exported.bytes);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('read failed');
  expect(result.files.has('trace/traces.jsonl')).toBe(false);
  expect(result.record.gaps).toContainEqual({ kind: 'missing-file', at: { path: 'trace/traces.jsonl' } });
});
test.each([
  ['seed-version', (s: Awaited<ReturnType<typeof envelope>>) => { s.seedVersion = 2; }],
  ['bundle-path', (s: Awaited<ReturnType<typeof envelope>>) => { s.files.push(s.files[0]); }],
  ['bundle-path', (s: Awaited<ReturnType<typeof envelope>>) => { s.files[0].path = '../manifest.json'; }],
  ['seed-base64', (s: Awaited<ReturnType<typeof envelope>>) => { s.files[0].base64 = 'Zg='; }],
  ['seed-base64', (s: Awaited<ReturnType<typeof envelope>>) => { s.files[0].base64 = 'Zh=='; }],
  ['seed-shape', (s: Awaited<ReturnType<typeof envelope>>) => { s.continuationMessages = [{ text: 1 }]; }],
  ['seed-shape', (s: Awaited<ReturnType<typeof envelope>>) => { s.continuationMessages = [{ text: '\ud800' }]; }],
  ['seed-shape', (s: Awaited<ReturnType<typeof envelope>>) => { s.files.push({ path: 'sibling', base64: '' }); }],
  ['file-integrity', (s: Awaited<ReturnType<typeof envelope>>) => {
    s.files.find((f: { path: string }) => f.path === 'trace/traces.jsonl').base64 = 'e30=';
  }],
] as const)('seed reader refuses %s violations (%#)', async (kind, mutate) => {
  const seed = await envelope(); mutate(seed);
  expect(await readSeed(encoder.encode(JSON.stringify(seed)))).toMatchObject({ ok: false, errors: [{ kind }] });
});

test('seed round-trip preserves multi-megabyte binary files without a parser stack limit', async () => {
  const fixture = studioFixture();
  const binary = Uint8Array.from({ length: 4 * 1024 * 1024 }, (_, i) => i % 256);
  fixture.fileOverrides.set('stdout/gateway.stderr', binary);
  const exported = await exportSeed(await fixture.files(), []);
  if (!exported.ok) throw new Error(JSON.stringify(exported.errors));
  const restored = await readSeed(exported.bytes);
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw new Error(JSON.stringify(restored.errors));
  expect(Buffer.from(restored.files.get('stdout/gateway.stderr')!).equals(Buffer.from(binary))).toBe(true);
});
