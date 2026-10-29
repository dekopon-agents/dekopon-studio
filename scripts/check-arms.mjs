import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkDist } from './check-dist.mjs';

const root = resolve(process.argv[2] ?? '/tmp/evalgw-reference');
const seedBytes = await readFile(resolve(root, 'dekopon-seed-v1.json'));
const seed = JSON.parse(seedBytes);
const digest = createHash('sha256').update(seedBytes).digest('hex');
const arms = ['live-policy', 'decider', 'summaries-preferred'];
const directories = [resolve(root, 'original'), ...arms.map(arm => resolve(root, 'arms', arm))];
for (const [index, directory] of directories.entries()) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  const driver = JSON.parse(await readFile(resolve(directory, 'driver.json'), 'utf8'));
  const grade = JSON.parse(await readFile(resolve(directory, 'grade.json'), 'utf8'));
  assert.equal(manifest.dekopon.version, '0.70.0');
  assert.deepEqual(manifest.completeness, { status: 'complete', reasons: [] });
  assert.equal(grade.status, 'passed');
  assert.equal(manifest.bundleVersion, index ? 2 : 1);
  assert.equal(manifest.seedDigest, index ? digest : null);
  if (!index) continue;
  const arm = arms[index - 1];
  assert.equal(manifest.armId, arm);
  assert.equal(driver.firstProjection.status, 'matched');
  assert.equal(driver.firstProjection.currentMessageMatches, true);
  assert.equal(driver.firstProjection.records.length, 4);
  assert.deepEqual(driver.firstProjection.records.map(record => record.expectedRung),
    arm === 'summaries-preferred' ? ['summary-2', 'summary-2', 'summary-2', 'native']
      : ['summary-2', 'summary-2', 'native', 'native']);
  assert.ok(driver.firstProjection.records.every(record => record.matches &&
    record.attribution === 'reconstructed-from-exact-replay'));
  const decisions = driver.fixtures.service.requests.filter(request => request.kind === 'decider');
  assert.equal(decisions.length, arm === 'decider' ? 2 : 0);
  for (const file of seed.files.filter(file => file.path.startsWith('journal/'))) {
    const frozen = Buffer.from(file.base64, 'base64');
    const restored = await readFile(resolve(directory, file.path));
    assert.deepEqual(restored.subarray(0, frozen.length), frozen);
  }
}

await checkDist('dist', async ({ page, context }) => {
  const requests = [];
  let observing = false;
  context.on('request', request => { if (observing) requests.push(request.url()); });
  for (const [index, directory] of directories.entries()) {
    const tab = index ? await context.newPage() : page;
    if (index) {
      observing = false;
      await tab.goto(page.url(), { waitUntil: 'networkidle' });
    }
    observing = true;
    await tab.getByLabel('Open bundle directory', { exact: true }).setInputFiles(directory);
    await tab.getByLabel('Call input', { exact: true }).waitFor();
    assert.equal(await tab.getByRole('alert').count(), 0);
    const journal = tab.getByLabel('Frozen journal', { exact: true });
    assert.equal(await journal.locator('.journal-record').count(), index ? 6 : 4);
    assert.ok((await journal.textContent()).includes('ledger-of-tides'));
    if (index) assert.ok((await tab.getByLabel('Call input', { exact: true }).textContent()).includes('ledger-of-tides'));
    await tab.getByRole('button', { name: 'Context view', exact: true }).click();
    assert.equal(await journal.locator('.journal-record').count(), index ? 6 : 4);
    await tab.waitForTimeout(600);
    assert.deepEqual(requests, []);
  }
  assert.equal(context.pages().length, 4);
});
console.log('Reference original and three seeded v2 arms opened beside each other: exact journal prefixes, matched first projections, loopback decider, zero interaction requests');
