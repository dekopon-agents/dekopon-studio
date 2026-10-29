import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input || '{}');
const server = await createServer({ root, configFile: false, envDir: false,
  server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
try {
  const { studioFixture, journalText } = await server.ssrLoadModule('/src/record/fixtures.ts');
  const { exportSeed } = await server.ssrLoadModule('/src/record/index.ts');
  const fixture = studioFixture();
  fixture.journal = [1, 2, 3, 4].map(id => {
    const [b, h, s] = journalText(id).trim().split('\n').map(JSON.parse);
    b.b = b.b.filter(item => item.user);
    h.h.assets = []; h.h.arrived = []; h.h.nextAssetId = 1; h.h.turn = id;
    const body = JSON.stringify(b) + '\n'; h.h.bodyLen = Buffer.byteLength(body);
    return body + JSON.stringify(h) + '\n' + JSON.stringify(s) + '\n';
  }).join('');
  if (request.scenario) {
    fixture.extraManifest.dekopon = request.dekopon;
    fixture.extraManifest.providers = request.providers;
    for (const [name, value] of Object.entries(request.config))
      fixture.configContents.set(name, typeof value === 'string' ? value : JSON.stringify(value));
    fixture.configContents.set('scenario', JSON.stringify(request.scenario));
    fixture.fileOverrides.set('driver.json', new TextEncoder().encode(JSON.stringify({ attempt: 'synthetic',
      messages: request.scenario.messages, fixtures: { model: {}, service: {} } })));
  }
  const files = await fixture.files();
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
  manifest.freeze.lastRepliedMessage = 4;
  if (request.scenario) {
    const old = 'journal/agent/stem.jsonl', path = 'journal/' + request.scenario.agent.name + '/stem.jsonl';
    files.set(path, files.get(old)); files.delete(old);
    manifest.journal.files[0].path = path;
    manifest.freeze.journalStems = [request.scenario.agent.name + '/stem'];
    manifest.freeze.conversation = request.scenario.conversation;
    manifest.scenario.id = request.scenario.id;
  }
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  const result = await exportSeed(files, request.continuationMessages ?? [{ text: 'synthetic continuation' }]);
  if (!result.ok) throw new Error(JSON.stringify(result));
  process.stdout.write(Buffer.from(result.bytes).toString('base64'));
} finally { await server.close(); }
