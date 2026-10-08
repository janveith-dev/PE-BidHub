import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@bid/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
