import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkDist } from './check-dist.mjs';

const directory = resolve(process.argv[2] ?? '/tmp/evalgw-two-message');
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
const grade = JSON.parse(await readFile(resolve(directory, 'grade.json'), 'utf8'));
assert.equal(manifest.scenario.id, 'two-message-gh-recall');
assert.equal(manifest.dekopon.version, '0.70.0');
assert.equal(manifest.bundleVersion, 1);
assert.equal(manifest.seedDigest, null);
assert.deepEqual(manifest.completeness, { status: 'complete', reasons: [] });
assert.equal(manifest.freeze.lastRepliedMessage, 2);
assert.equal(grade.status, 'passed');

await checkDist('dist', async ({ page, context }) => {
  const requests = [];
  context.on('request', request => requests.push(request.url()));
  await page.getByLabel('Open bundle directory', { exact: true }).setInputFiles(directory);
  await page.getByLabel('Call input', { exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  const journal = page.getByLabel('Frozen journal', { exact: true });
  assert.equal(await journal.locator('.journal-record').count(), 2);
  assert.ok((await journal.textContent()).includes('ledger-of-tides'));
  await page.getByRole('button', { name: 'Message 2 · attempt 1 · model turn 1', exact: true }).click();
  assert.ok((await page.getByLabel('Call input', { exact: true }).textContent()).includes('ledger-of-tides'));
  await page.getByRole('button', { name: 'Context view', exact: true }).click();
  assert.equal(await journal.locator('.journal-record').count(), 2);
  await page.waitForTimeout(600);
  assert.deepEqual(requests, []);
});
console.log('Real v0.70.0 bundle opened: two journal records, recalled fact, both views, zero interaction requests');
