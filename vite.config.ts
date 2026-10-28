import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/studio/',
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'] },
});
