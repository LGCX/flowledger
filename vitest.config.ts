import { defineConfig } from 'vitest/config';

const shared = { resolve: { conditions: ['@flowledger/source'] } };

export default defineConfig({
  test: {
    passWithNoTests: true, // [ASSUMPTION] see R-07; P00-GATE asserts unit/contracts/integration each run >=1 file
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
        },
      },
      { ...shared, test: { name: 'contracts', include: ['test/contract/**/*.test.ts'] } },
      {
        ...shared,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        ...shared,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
      {
        ...shared,
        test: {
          name: 'chaos',
          include: ['test/chaos/**/*.test.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
