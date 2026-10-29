import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../App';
import { permissionFixture, studioFixture } from '../record/fixtures';
import { exportSeed } from '../record';
import { openDirectory } from './open';

function file(path: string, bytes: Uint8Array) {
  const data = Uint8Array.from(bytes).buffer;
  const f = new File([data], path.split('/').at(-1)!);
  Object.defineProperties(f, { webkitRelativePath: { value: 'synthetic/' + path },
    arrayBuffer: { value: async () => data } });
  return f;
}
async function openedStudio(fixture = studioFixture()) {
  vi.stubGlobal('crypto', webcrypto);
  const files = await fixture.files();
  render(<App />);
  fireEvent.change(screen.getByLabelText('Open bundle directory'), {
    target: { files: [...files].map(([path, bytes]) => file(path, bytes)) },
  });
  await screen.findByRole('heading', { name: 'Opened bundle' });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('stepping back after forward restores the same call input', async () => {
  await openedStudio();
  const input = screen.getByLabelText('Call input').textContent;
  fireEvent.click(screen.getByRole('button', { name: 'Context view' }));
  let advanced = 0;
  do {
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
    advanced++;
  } while (!screen.queryByLabelText('Call input') && advanced < 20);
  expect(screen.getByLabelText('Call input').textContent).not.toBe(input);
  for (let i = 0; i < advanced; i++) fireEvent.click(screen.getByRole('button', { name: 'Previous step' }));
  expect(screen.getByLabelText('Call input').textContent).toBe(input);
});
test('a steered call is aborted and not counted toward the step cap', async () => {
  await openedStudio();
  fireEvent.click(screen.getByRole('button', { name: 'Message 1 · attempt 2 · model turn 2' }));
  expect(screen.getByText('Aborted (steered) · does not consume a completed step')).toBeTruthy();
  expect(screen.getByLabelText('Step budget').textContent).toBe('1 recorded completed steps / 4 cap');
  fireEvent.click(screen.getByRole('button', { name: 'Message 1 · attempt 3 · model turn 2' }));
  expect(screen.getByLabelText('Step budget').textContent).toBe('2 recorded completed steps / 4 cap');
  expect(screen.getByLabelText('Call input').textContent).toContain('steer: include the synthetic detail');
});
test('summary-input-unavailable renders as a gap with its missing attribute', async () => {
  await openedStudio();
  fireEvent.click(screen.getByRole('button', { name: 'Summary observation' }));
  expect(screen.getAllByText('Gap: summary-input-unavailable').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Missing attribute: agent.model.prompt').length).toBeGreaterThan(0);
});
test('an attachment source appears nowhere in the DOM', async () => {
  await openedStudio();
  expect(screen.getByText('Retained original items')).toBeTruthy();
  expect(document.documentElement.outerHTML).not.toContain('SOURCE_CANARY');
  expect(document.documentElement.outerHTML).not.toContain('NESTED_CANARY');
});
test('mailbox inventories and RUNNING/COMPLETING intervals stay unknown beside recorded depths', async () => {
  await openedStudio();
  fireEvent.click(screen.getByRole('button', { name: 'Context view' }));
  fireEvent.click(screen.getByRole('button', { name: 'Recorded admission · queued' }));
  expect(screen.getByRole('heading', { name: 'Steer queue inventory: unknown' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Follow-up queue inventory: unknown' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'RUNNING interval: unknown' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'COMPLETING interval: unknown' })).toBeTruthy();
  expect(screen.getByRole('table').textContent).toContain('steered');
  expect(screen.getByRole('table').textContent).toContain('queued');
});
test('folder opening refuses duplicate paths and mixed roots before reading bytes', async () => {
  const f = file('manifest.json', new TextEncoder().encode('{}'));
  expect(await openDirectory([f, f])).toMatchObject({ ok: false, errors: [{ kind: 'bundle-path' }] });
  const other = new File([], 'manifest.json');
  Object.defineProperty(other, 'webkitRelativePath', { value: 'other/manifest.json' });
  expect(await openDirectory([f, other])).toMatchObject({ ok: false, errors: [{ kind: 'bundle-path' }] });
});


test('permissions show the recorded space denier and the active principal changes with the next message', async () => {
  await openedStudio(permissionFixture());
  fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
  expect(screen.getByRole('region', { name: 'Multi-user permissions' }).textContent).toContain('"space"');
  expect(screen.getAllByText('alice · p1').length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText('Permission message'), { target: { value: '1' } });
  expect(screen.getByText('bob · p1')).toBeTruthy();
  expect(screen.getAllByText('Prompt labels can include replayed history; this handle is not corroborated by a current-turn broker decision.').length).toBeGreaterThan(0);
});
test('the real wasm policy module returns the missing-world path without changing recorded decisions', async () => {
  await openedStudio(permissionFixture());
  fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
  fireEvent.change(screen.getByLabelText('What-if principal'), { target: { value: 'bob' } });
  fireEvent.change(screen.getByLabelText('What-if capability'), { target: { value: 'fixture.write' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check what-if availability' }));
  expect(await screen.findByText('dekopon-policy 0.70.0 · evaluation unavailable: missing-world')).toBeTruthy();
  const denied = screen.getByRole('region', { name: 'Broker decision decision-space-denial' });
  expect(within(denied).getByLabelText('Recorded allowed').textContent).toBe('false');
  expect(within(denied).getByLabelText('Denied by').textContent).toBe('"space"');
});


test('multipart participant observations keep join-like user text unverified after an identity match', async () => {
  await openedStudio(permissionFixture());
  fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
  const image = screen.getByRole('region', { name: 'Participant alice · call 1000000000000003 · message 0' });
  expect(JSON.parse(within(image).getByLabelText('Unverified join-line text').textContent!))
    .toBe('[gateway: participant joined; channel-downscoped capabilities: fixture: read, write]');
  const repeat = screen.getByRole('region', { name: 'Participant alice · call 1000000000000008 · message 1' });
  expect(JSON.parse(within(repeat).getByLabelText('Unverified join-line text').textContent!))
    .toBe('[gateway: participant joined; channel-downscoped capabilities: imaginary-admin: write]');
  expect(within(repeat).getByRole('note').textContent).toContain('participant capability surface');
  expect(within(repeat).getByText('Identity-only match in current-turn broker span (does not verify capabilities): 1000000000000102')).toBeTruthy();
});

test('reopening a seed preserves continuation text and stable message labels', async () => {
  await openedStudio();
  const continuationMessages = [{ text: 'Continue 🦀\nwith synthetic detail.' }, { text: 'Second <tag>.' }];
  const seed = await exportSeed(await studioFixture().files(), continuationMessages);
  if (!seed.ok) throw new Error('synthetic seed export failed');
  fireEvent.change(screen.getByLabelText('Open seed'), { target: { files: [file('dekopon-seed-v1.json', seed.bytes)] } });
  await screen.findByText('Seed opened and verified.');
  for (const [i, message] of continuationMessages.entries())
    expect((screen.getByLabelText(`Continuation message ${i + 1}`) as HTMLTextAreaElement).value).toBe(message.text);
});
