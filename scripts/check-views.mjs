import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkDist } from './check-dist.mjs';
import { studioFixture } from '../src/record/fixtures.ts';

await test('views open a synthetic bundle and keep all interactions in the browser', async t => {
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
      await page.getByRole('button', { name: 'Context view', exact: true }).click();
      await t.test('stepping back after forward restores the same call input', async () => {
        const input = await page.getByLabel('Call input', { exact: true }).textContent();
        let advanced = 0;
        do {
          await page.getByRole('button', { name: 'Next step', exact: true }).click();
          advanced++;
        } while (!await page.getByLabel('Call input', { exact: true }).count() && advanced < 20);
        assert.notEqual(await page.getByLabel('Call input', { exact: true }).textContent(), input);
        for (let i = 0; i < advanced; i++) await page.getByRole('button', { name: 'Previous step', exact: true }).click();
        assert.equal(await page.getByLabel('Call input', { exact: true }).textContent(), input);
      });
      await t.test('a steered call is shown aborted and not counted toward the step cap', async () => {
        await page.getByRole('button', { name: 'Message 1 · attempt 2 · model turn 2', exact: true }).click();
        assert.equal(await page.getByText('Aborted (steered) · does not consume a completed step', { exact: true }).count(), 1);
        assert.equal(await page.getByLabel('Step budget', { exact: true }).textContent(), '1 recorded completed steps / 4 cap');
        await page.getByRole('button', { name: 'Message 1 · attempt 3 · model turn 2', exact: true }).click();
        assert.equal(await page.getByLabel('Step budget', { exact: true }).textContent(), '2 recorded completed steps / 4 cap');
      });
      await t.test('recorded admissions do not invent queue inventories or RUNNING/COMPLETING intervals', async () => {
        await page.getByRole('button', { name: 'Recorded admission · queued', exact: true }).click();
        for (const heading of ['Steer queue inventory: unknown', 'Follow-up queue inventory: unknown', 'RUNNING interval: unknown', 'COMPLETING interval: unknown'])
          assert.equal(await page.getByRole('heading', { name: heading, exact: true }).count(), 1);
        assert.equal(await page.getByRole('table').getByText('"2"', { exact: true }).count(), 1);
      });
      await t.test('history replay shows the next turn messages', async () => {
        await page.getByRole('button', { name: 'History replay into turn', exact: true }).last().click();
        assert.equal(await page.getByRole('heading', { name: 'History replay into this turn', exact: true }).count(), 1);
        await page.getByRole('button', { name: 'Message 2 · attempt 1 · model turn 1', exact: true }).click();
        assert.match(await page.getByLabel('Call input', { exact: true }).textContent(), /steered answer/);
      });
      await t.test('summary-input-unavailable renders as a gap', async () => {
        await page.getByRole('button', { name: 'Summary observation', exact: true }).click();
        assert.ok(await page.getByText('Gap: summary-input-unavailable', { exact: true }).count() > 0);
      });
      await t.test('an asset source in the bundle appears nowhere in the DOM', async () => {
        const html = await page.locator('html').evaluate(element => element.outerHTML);
        for (const canary of ['SOURCE_CANARY', 'NESTED_CANARY']) assert.ok(!html.includes(canary));
      });
      await t.test('reduced motion removes the context-step animation', async () => {
        assert.equal(await page.locator('.observation').evaluate(element => element.ownerDocument.defaultView.getComputedStyle(element).animationName), 'none');
      });
      await t.test('opening the bundle and driving both views makes zero network requests', async () => {
        await page.getByRole('button', { name: 'Forensic view', exact: true }).click();
        await page.waitForTimeout(600);
        assert.deepEqual(requests, []);
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
