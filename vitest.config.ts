import { defineConfig } from 'vitest/config';

const shared = {
  resolve: { conditions: ['@flowledger/source'] },
  // Vitest resolves in SSR mode, where `ssr.resolve.conditions` governs. Without this,
  // a workspace package resolves through its `default` condition to `dist/`, so contract
  // tests silently validate stale build output instead of source.
  ssr: { resolve: { conditions: ['@flowledger/source'] } },
  server: { deps: { inline: [/@flowledger\//] } },
};

export default defineConfig({
  test: {
    passWithNoTests: true, // [ASSUMPTION] see R-07; P00-GATE asserts unit/contracts/integration each run >=1 file
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          // Registers fast-check's global seed/run-count and the counterexample reporter
          // (packages/testkit/src/fast-check-setup.ts).
          setupFiles: ['packages/testkit/src/fast-check-setup.ts'],
        },
      },
      { ...shared, test: { name: 'contracts', include: ['test/contract/**/*.test.ts'] } },
      {
        ...shared,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // One PostgreSQL container per run, with a migrated `fl_template` cloned per test file
          // (packages/testkit/src/pg-global-setup.ts).
          globalSetup: ['packages/testkit/src/pg-global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        ...shared,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          globalSetup: ['packages/testkit/src/pg-global-setup.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
      {
        ...shared,
        test: {
          name: 'chaos',
          include: ['test/chaos/**/*.test.ts'],
          globalSetup: ['packages/testkit/src/pg-global-setup.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
