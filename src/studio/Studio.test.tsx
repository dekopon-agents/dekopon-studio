import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../App';
import { studioFixture } from '../record/fixtures';
import { openDirectory } from './open';

function file(path: string, bytes: Uint8Array) {
  const data = Uint8Array.from(bytes).buffer;
  const f = new File([data], path.split('/').at(-1)!);
  Object.defineProperties(f, { webkitRelativePath: { value: 'synthetic/' + path },
    arrayBuffer: { value: async () => data } });
  return f;
}
async function openedStudio() {
  vi.stubGlobal('crypto', webcrypto);
  const files = await studioFixture().files();
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
