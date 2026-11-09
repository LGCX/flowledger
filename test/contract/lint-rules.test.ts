import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: repoRoot });
});

/**
 * Lints an in-memory snippet against the config that would apply to `filePath`.
 * Nothing is written to disk: `filePath` only selects which config objects match.
 */
async function lint(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(repoRoot, filePath) });
  return (result?.messages ?? []).map((message) => message.ruleId ?? '<no rule>');
}

const importFrom = (source: string): string => `import { x } from '${source}';\nexport { x };\n`;

const BOUNDARY: Record<string, { forbidden: string; allowed: string }> = {
  domain: { forbidden: '@flowledger/database', allowed: './local.js' },
  contracts: { forbidden: '@flowledger/domain', allowed: './local.js' },
  config: { forbidden: '@flowledger/domain', allowed: './local.js' },
  observability: { forbidden: '@flowledger/domain', allowed: './local.js' },
  database: { forbidden: '@flowledger/messaging', allowed: '@flowledger/domain' },
  messaging: { forbidden: '@flowledger/domain', allowed: '@flowledger/database' },
  providers: { forbidden: '@flowledger/database', allowed: '@flowledger/domain' },
  testkit: { forbidden: '@flowledger/app-api', allowed: '@flowledger/domain' },
};

describe('package import boundaries (CONVENTIONS §3)', () => {
  for (const [dir, pair] of Object.entries(BOUNDARY)) {
    it(`boundary/${dir}/forbidden`, async () => {
      expect(await lint(importFrom(pair.forbidden), `packages/${dir}/src/a.ts`)).toContain(
        'no-restricted-imports',
      );
    });

    it(`boundary/${dir}/allowed`, async () => {
      expect(await lint(importFrom(pair.allowed), `packages/${dir}/src/a.ts`)).toEqual([]);
    });
  }

  it('packages-cannot-import-apps (package name)', async () => {
    expect(await lint(importFrom('@flowledger/app-api'), 'packages/testkit/src/a.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('packages-cannot-import-apps (relative escape)', async () => {
    expect(
      await lint(importFrom('../../apps/api/src/main.js'), 'packages/testkit/src/a.ts'),
    ).toContain('no-restricted-imports');
  });
});

describe('simulator ground-truth confinement (CONVENTIONS §16)', () => {
  const member = 'export const url = process.env.SIMULATOR_DATABASE_URL;\n';
  const bracket = "export const url = process.env['SIMULATOR_DATABASE_URL'];\n";
  const owner = 'export const url = process.env.PROVIDER_SIMULATOR_DATABASE_URL;\n';

  it('simulator-url/forbidden-in-providers', async () => {
    expect(await lint(member, 'packages/providers/src/a.ts')).toContain('no-restricted-syntax');
  });

  it('simulator-url/forbidden-in-apps-payment-worker', async () => {
    expect(await lint(member, 'apps/payment-worker/src/a.ts')).toContain('no-restricted-syntax');
  });

  it('simulator-url/bracket-access-forbidden', async () => {
    expect(await lint(bracket, 'packages/providers/src/a.ts')).toContain('no-restricted-syntax');
  });

  it('simulator-url/allowed-in-testkit', async () => {
    expect(await lint(member, 'packages/testkit/src/a.ts')).toEqual([]);
  });

  it('simulator-url/allowed-in-cli', async () => {
    expect(await lint(member, 'apps/cli/src/a.ts')).toEqual([]);
  });

  it('simulator-url/allowed-in-contract-tests', async () => {
    expect(await lint(member, 'test/contract/a.test.ts')).toEqual([]);
  });

  it('provider-simulator-url/forbidden-in-api', async () => {
    expect(await lint(owner, 'apps/api/src/a.ts')).toContain('no-restricted-syntax');
  });

  it('provider-simulator-url/allowed-in-provider-simulator', async () => {
    expect(await lint(owner, 'apps/provider-simulator/src/a.ts')).toEqual([]);
  });
});

describe('money code uses bigint only (docs/09 §Static checks)', () => {
  const moneyFile = 'packages/domain/src/money.ts';

  it('money/number-keyword', async () => {
    expect(await lint('export const n: number = 1;\n', moneyFile)).toContain(
      'no-restricted-syntax',
    );
  });

  it('money/Number-call', async () => {
    expect(await lint("export const n = Number('1');\n", moneyFile)).toContain(
      'no-restricted-syntax',
    );
  });

  it('money/parseInt', async () => {
    expect(await lint("export const n = parseInt('1', 10);\n", moneyFile)).toContain(
      'no-restricted-syntax',
    );
  });

  it('money/Math', async () => {
    expect(await lint('export const n = Math.floor(1.4);\n', moneyFile)).toContain(
      'no-restricted-syntax',
    );
  });

  it('money/decimal-literal', async () => {
    expect(await lint('export const n = 1.5;\n', moneyFile)).toContain('no-restricted-syntax');
  });

  it('money/bigint-and-integer-literal-allowed', async () => {
    expect(await lint('export const n = 10n * 2n + 1n;\n', moneyFile)).toEqual([]);
  });

  it('money/control-file-not-checked', async () => {
    expect(await lint('export const n: number = 1;\n', 'packages/domain/src/payment.ts')).toEqual(
      [],
    );
  });

  // Guards the flat-config override hazard: money.ts matches several config objects, and
  // the last match replaces `no-restricted-syntax` wholesale. If the money config listed
  // only money selectors, the ledger and simulator rules would silently stop applying here.
  it('money/ledger-rule-still-applies-in-money-file', async () => {
    expect(
      await lint(
        "export const q = 'INSERT INTO ledger.journal_entries (id) VALUES ($1)';\n",
        moneyFile,
      ),
    ).toContain('no-restricted-syntax');
  });

  it('money/simulator-rule-still-applies-in-money-file', async () => {
    expect(
      await lint('export const u = process.env.SIMULATOR_DATABASE_URL;\n', moneyFile),
    ).toContain('no-restricted-syntax');
  });
});

describe('no literal ledger DML outside protected functions (ADR-0007)', () => {
  const dbFile = 'packages/database/src/a.ts';

  it('ledger-dml/insert', async () => {
    expect(
      await lint(
        "export const q = 'INSERT INTO ledger.journal_entries (id) VALUES ($1)';\n",
        dbFile,
      ),
    ).toContain('no-restricted-syntax');
  });

  it('ledger-dml/update-template-literal', async () => {
    expect(
      await lint('export const q = `update ledger.account_balances set x = 1`;\n', dbFile),
    ).toContain('no-restricted-syntax');
  });

  it('ledger-dml/delete', async () => {
    expect(
      await lint("export const q = 'delete from ledger.journal_entries';\n", dbFile),
    ).toContain('no-restricted-syntax');
  });

  it('ledger-dml/truncate', async () => {
    expect(
      await lint("export const q = 'TRUNCATE TABLE ledger.journal_entries';\n", dbFile),
    ).toContain('no-restricted-syntax');
  });

  it('ledger-dml/reads-and-function-calls-allowed', async () => {
    expect(
      await lint("export const q = 'SELECT ledger.post_payment_operation($1)';\n", dbFile),
    ).toEqual([]);
  });

  it('ledger-dml/select-with-update-in-lock-clause-allowed', async () => {
    expect(
      await lint("export const q = 'SELECT id FROM ledger.accounts FOR UPDATE';\n", dbFile),
    ).toEqual([]);
  });

  it('ledger-dml/testkit-exempt', async () => {
    expect(
      await lint(
        "export const q = 'INSERT INTO ledger.journal_entries (id) VALUES ($1)';\n",
        'packages/testkit/src/a.ts',
      ),
    ).toEqual([]);
  });
});
