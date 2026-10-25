import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import App from './App';

afterEach(cleanup);

test('landing view names the Studio and describes its purpose', () => {
  render(<App />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Dekopon Studio');
  expect(screen.getByText('Inspect forensic chat records and explore agent context in your browser.')).toBeTruthy();
});
