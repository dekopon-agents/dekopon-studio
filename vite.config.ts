import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/studio/',
  test: { environment: 'jsdom', include: ['src/**/*.test.tsx', 'scripts/**/*.test.mjs'] },
});
