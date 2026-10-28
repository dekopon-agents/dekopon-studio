import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkDist } from './check-dist.mjs';
import { studioFixture } from '../src/record/fixtures.ts';

const directory = await mkdtemp(join(tmpdir(), 'studio-views-'));
try {
  for (const [path, bytes] of await studioFixture().files()) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await checkDist('dist', async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const requests = [];
    context.on('request', request => requests.push(request.url()));
    await page.getByLabel('Open bundle directory', { exact: true }).setInputFiles(directory);
    await page.getByLabel('Call input', { exact: true }).waitFor();
    const input = await page.getByLabel('Call input', { exact: true }).textContent();
    await page.getByRole('button', { name: 'Context view', exact: true }).click();
    await page.getByRole('button', { name: 'Next step', exact: true }).click();
    assert.equal(await page.getByLabel('Call input', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Previous step', exact: true }).click();
    assert.equal(await page.getByLabel('Call input', { exact: true }).textContent(), input,
      'stepping back after forward restores the same call input');
    await page.getByRole('button', { name: 'Message 1 · attempt 2 · model turn 2', exact: true }).click();
    assert.equal(await page.getByText('Aborted (steered) · does not consume a completed step', { exact: true }).count(), 1);
    assert.equal(await page.getByLabel('Step budget', { exact: true }).textContent(), '1 recorded completed steps / 4 cap',
      'a steered call is shown aborted and not counted toward the step cap');
    await page.getByRole('button', { name: 'Message 1 · attempt 3 · model turn 2', exact: true }).click();
    assert.equal(await page.getByLabel('Step budget', { exact: true }).textContent(), '2 recorded completed steps / 4 cap');
    await page.getByRole('button', { name: 'gateway.admission · queued', exact: true }).click();
    for (const heading of ['Steer queue inventory: unknown', 'Follow-up queue inventory: unknown', 'RUNNING interval: unknown', 'COMPLETING interval: unknown'])
      assert.equal(await page.getByRole('heading', { name: heading, exact: true }).count(), 1);
    assert.equal(await page.getByRole('table').getByText('"2"', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'History replay into turn', exact: true }).last().click();
    assert.equal(await page.getByRole('heading', { name: 'History replay into this turn', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Message 2 · attempt 1 · model turn 1', exact: true }).click();
    assert.match(await page.getByLabel('Call input', { exact: true }).textContent(), /steered answer/);
    await page.getByRole('button', { name: 'Summary observation', exact: true }).click();
    assert.ok(await page.getByText('Gap: summary-input-unavailable', { exact: true }).count() > 0,
      'summary-input-unavailable renders as a gap');
    const html = await page.locator('html').evaluate(element => element.outerHTML);
    for (const canary of ['SOURCE_CANARY', 'NESTED_CANARY']) assert.ok(!html.includes(canary), 'an asset source appears nowhere in the DOM');
    assert.equal(await page.locator('.observation').evaluate(element => element.ownerDocument.defaultView.getComputedStyle(element).animationName), 'none', 'reduced motion removes animation');
    await page.getByRole('button', { name: 'Forensic view', exact: true }).click();
    await page.waitForTimeout(600);
    assert.deepEqual(requests, [], 'opening a synthetic bundle and driving views makes zero network requests');
  });
  console.log('Views invariants passed in pinned Chromium with zero interaction network requests');
} finally {
  await rm(directory, { recursive: true, force: true });
}
