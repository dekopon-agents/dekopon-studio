import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkDist } from './check-dist.mjs';
import { permissionFixture } from '../src/record/fixtures.ts';

await test('cedar opens a synthetic shared-channel bundle without network requests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-cedar-'));
  try {
    for (const [path, bytes] of await permissionFixture().files()) {
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    await checkDist('dist', async ({ page, context }) => {
      const requests = [];
      context.on('request', request => requests.push(request.url()));
      await page.getByLabel('Open bundle directory', { exact: true }).setInputFiles(directory);
      await page.getByRole('button', { name: 'Permissions', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Multi-user permissions', exact: true });
      await t.test('a recorded decision denied by the space shows space as the denier', async () => {
        const denied = panel.getByRole('region', { name: 'Broker decision decision-space-denial', exact: true });
        assert.equal(await denied.getByLabel('Denied by', { exact: true }).textContent(), '"space"');
        assert.equal(await denied.getByLabel('Recorded allowed', { exact: true }).textContent(), 'false');
        assert.ok(await panel.getByText('alice · p1', { exact: true }).count() > 0);
      });
      await t.test('the missing provider inventory yields a visible world gap through the real wasm module', async () => {
        await panel.getByLabel('What-if principal', { exact: true }).fill('bob');
        await panel.getByLabel('What-if capability', { exact: true }).fill('fixture.write');
        await panel.getByRole('button', { name: 'Check what-if availability', exact: true }).click();
        await panel.getByText('dekopon-policy 0.70.0 · evaluation unavailable: missing-world', { exact: true }).waitFor();
        assert.ok(await panel.getByText('Gap: policy-world-unavailable', { exact: true }).count() > 0);
        assert.equal(await panel.getByRole('region', { name: 'Broker decision decision-space-denial', exact: true }).getByLabel('Recorded allowed', { exact: true }).textContent(), 'false');
      });
      await t.test('authenticated principal attribution switches on the next message without reviving replayed handles', async () => {
        await panel.getByLabel('Permission message', { exact: true }).selectOption('1');
        assert.ok(await panel.getByText('bob · p1', { exact: true }).count() > 0);
        assert.ok(await panel.getByText('Prompt labels can include replayed history; this handle is not corroborated by a current-turn broker decision.', { exact: true }).count() > 0);
      });
      await t.test('opening and driving the permission and what-if views makes zero network requests', async () => {
        await page.waitForTimeout(600);
        assert.deepEqual(requests, []);
        const html = await page.locator('html').evaluate(element => element.outerHTML);
        assert.ok(!html.includes('SOURCE_CANARY'));
        assert.ok(!html.includes('NESTED_CANARY'));
      });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
