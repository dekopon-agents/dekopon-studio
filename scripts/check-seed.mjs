import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkDist } from './check-dist.mjs';
import { studioFixture } from '../src/record/fixtures.ts';

await test('seed download and reopening round-trip the freeze and continuations with zero network requests', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'studio-seed-'));
  try {
    const frozen = join(scratch, 'frozen'), unfrozen = join(scratch, 'unfrozen');
    const captured = studioFixture();
    captured.fileOverrides.set('stdout/gateway.stderr', new Uint8Array(4 * 1024 * 1024).fill(128));
    const missing = studioFixture(); missing.extraManifest.freeze = null;
    for (const [directory, fixture] of [[frozen, captured], [unfrozen, missing]]) {
      for (const [path, bytes] of await fixture.files()) {
        const target = join(directory, path);
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
      }
      await writeFile(join(directory, 'unreferenced.txt'), 'SIBLING_CANARY');
    }
    await checkDist('dist', async ({ page, context }) => {
      const requests = [];
      context.on('request', request => requests.push(request.url()));
      await page.getByLabel('Open bundle directory', { exact: true }).setInputFiles(frozen);
      const seedPanel = page.getByRole('region', { name: 'Seed export', exact: true });
      await seedPanel.waitFor();
      const freeze = await page.getByLabel('Frozen journal', { exact: true }).locator('pre').first().textContent();
      const button = page.getByRole('button', { name: 'Export seed', exact: true });
      assert.equal(await button.isEnabled(), false);
      await page.getByLabel('Use captured freeze for seed', { exact: true }).check();
      const continuations = ['Continue the synthetic chat 🦀\nwith detail.', 'Second synthetic continuation <tag>.'];
      for (const [i, text] of continuations.entries()) {
        await page.getByRole('button', { name: 'Add continuation message', exact: true }).click();
        await page.getByLabel(`Continuation message ${i + 1}`, { exact: true }).fill(text);
      }
      await page.getByRole('button', { name: 'Context view', exact: true }).click();
      await page.getByRole('button', { name: 'Next step', exact: true }).click();
      const downloaded = page.waitForEvent('download');
      await button.click();
      const download = await downloaded;
      assert.equal(download.suggestedFilename(), 'dekopon-seed-v1.json');
      const path = join(scratch, 'dekopon-seed-v1.json');
      await download.saveAs(path);
      const bytes = await readFile(path);
      const digest = createHash('sha256').update(bytes).digest('hex');
      await page.getByLabel('Seed digest', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Seed digest', { exact: true }).textContent(), digest);
      assert.ok(!JSON.parse(bytes.toString('utf8')).files.some(file => file.path === 'unreferenced.txt'));
      await t.test('export then re-read through the reader preserves the same freeze and continuation messages', async () => {
        await page.getByLabel('Open seed', { exact: true }).setInputFiles(path);
        await page.getByText('Seed opened and verified.', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('Frozen journal', { exact: true }).locator('pre').first().textContent(), freeze);
        for (const [i, text] of continuations.entries())
          assert.equal(await page.getByLabel(`Continuation message ${i + 1}`, { exact: true }).inputValue(), text);
        assert.equal(await page.getByLabel('Seed digest', { exact: true }).textContent(), digest);
        const html = await page.locator('html').evaluate(element => element.outerHTML);
        for (const canary of ['SOURCE_CANARY', 'NESTED_CANARY']) assert.ok(!html.includes(canary));
      });
      await t.test('a null freeze cannot be marked or exported', async () => {
        await page.getByLabel('Open bundle directory', { exact: true }).setInputFiles(unfrozen);
        await page.getByText('A validated freeze is required to export a seed.', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('Use captured freeze for seed', { exact: true }).isEnabled(), false);
        assert.equal(await button.isEnabled(), false);
      });
      await page.waitForTimeout(1200);
      assert.deepEqual(requests, []);
    });
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
