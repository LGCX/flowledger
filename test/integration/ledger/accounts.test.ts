/**
 * The account model.
 *
 * Most of this file is negative: every check in docs/07 gets a case that inserts a row violating
 * exactly that rule and asserts the constraint name. Asserting the name rather than "it failed" is what
 * makes the suite survive a later migration adding another constraint — a test that accepts any error
 * passes for the wrong reason.
 *
 * The two structural properties are the ones worth reading twice: an account cannot exist without its
 * balance row (deferred to commit), and its `code` cannot disagree with its striping.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { LOGIN_RUNTIME_ROLES } from '@flowledger/database';
import { newId } from '@flowledger/domain';
import {
  createTestMerchant,
  setTestConnection,
  useTestDatabase,
  disposeTestDatabase,
  withRole,
  type TestDatabase,
  type TestMerchant,
} from '@flowledger/testkit';

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

let database: TestDatabase;
let merchant: TestMerchant;

beforeAll(async () => {
  database = await useTestDatabase()();
  merchant = await createTestMerchant(database.ownerPool);
});

afterAll(async () => {
  if (database !== undefined) await disposeTestDatabase(database);
});

let ledgerId: string;

beforeAll(async () => {
  // A ledger row directly as the table owner: this task has no ledger-creation function yet.
  ledgerId = newId('led');
  await database.ownerPool.query(
    `INSERT INTO ledger.ledgers (id, legal_entity_code, environment, currency)
     VALUES ($1, 'FLOWLEDGER_TEST', 'TEST', 'USD')`,
    [ledgerId],
  );
});

interface AccountOverrides {
  readonly id?: string;
  readonly ownerType?: string;
  readonly ownerId?: string | null;
  readonly logicalCode?: string;
  readonly bucketIndex?: number | null;
  readonly bucketCount?: number | null;
  readonly code?: string;
  readonly accountClass?: string;
  readonly normalSide?: string;
  readonly currency?: string;
  readonly status?: string;
  readonly closedAt?: Date | null;
  readonly merchantPostable?: boolean;
}

/**
 * A valid striped platform account, with the balance row its deferred trigger requires.
 *
 * The default logical code carries a counter: several cases commit their rows, and two committed
 * accounts with the same owner, code and currency would collide on `accounts_code_name_key` before the
 * check under test could fire.
 */
let sequence = 0;

function account(overrides: AccountOverrides = {}): Record<string, unknown> {
  const ownerType = overrides.ownerType ?? 'PLATFORM';
  const logicalCode = overrides.logicalCode ?? `platform.fee_revenue_${String(sequence++)}`;
  const bucketIndex = overrides.bucketIndex === undefined ? 3 : overrides.bucketIndex;
  const bucketCount = overrides.bucketCount === undefined ? 32 : overrides.bucketCount;
  const accountClass = overrides.accountClass ?? 'REVENUE';
  const normalSide =
    overrides.normalSide ?? (['ASSET', 'EXPENSE'].includes(accountClass) ? 'DEBIT' : 'CREDIT');
  const code =
    overrides.code ??
    (bucketIndex === null ? logicalCode : `${logicalCode}.${String(bucketIndex).padStart(2, '0')}`);

  return {
    id: overrides.id ?? newId('lac'),
    ledger_id: ledgerId,
    owner_type: ownerType,
    owner_id: overrides.ownerId === undefined ? null : overrides.ownerId,
    logical_code: logicalCode,
    bucket_index: bucketIndex,
    bucket_count: bucketCount,
    code,
    account_class: accountClass,
    normal_side: normalSide,
    currency: overrides.currency ?? 'USD',
    status: overrides.status ?? 'OPEN',
    closed_at: overrides.closedAt ?? null,
    allow_negative: false,
    merchant_postable: overrides.merchantPostable ?? false,
  };
}

const COLUMNS = [
  'id',
  'ledger_id',
  'owner_type',
  'owner_id',
  'logical_code',
  'bucket_index',
  'bucket_count',
  'code',
  'account_class',
  'normal_side',
  'currency',
  'status',
  'closed_at',
  'allow_negative',
  'merchant_postable',
] as const;

async function insertAccount(
  client: import('pg').ClientBase,
  row: Record<string, unknown>,
  withBalance = true,
): Promise<string> {
  const columns = COLUMNS.filter((column) => row[column] !== undefined);
  await client.query(
    `INSERT INTO ledger.accounts (${columns.join(', ')})
     VALUES (${columns.map((_unused, index) => `$${String(index + 1)}`).join(', ')})`,
    columns.map((column) => row[column]),
  );
  if (withBalance) {
    await client.query(
      `INSERT INTO ledger.account_balances (account_id, ledger_id, normal_side) VALUES ($1, $2, $3)`,
      [row.id, row.ledger_id, row.normal_side],
    );
  }
  return row.id as string;
}

/** Runs in one transaction; returns the error (raw, with detail) or null. */
async function attempt(
  fn: (client: import('pg').ClientBase) => Promise<unknown>,
): Promise<{ code?: string; constraint?: string; rule?: string } | null> {
  const client = await database.ownerPool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
    return null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const raw = error as { code?: string; constraint?: string; detail?: string };
    let rule: string | undefined;
    if (typeof raw.detail === 'string') {
      try {
        rule = (JSON.parse(raw.detail) as { rule?: string }).rule;
      } catch {
        rule = undefined;
      }
    }
    return {
      ...(raw.code === undefined ? {} : { code: raw.code }),
      ...(raw.constraint === undefined ? {} : { constraint: raw.constraint }),
      ...(rule === undefined ? {} : { rule }),
    };
  } finally {
    client.release();
  }
}

describe('constraint negatives', () => {
  it.each<[string, AccountOverrides, string]>([
    ['a malformed id', { id: 'lac_not-a-ulid' }, 'accounts_id_format'],
    // `accounts_owner_type` cannot be reached on its own: every logical code starts `platform.` or
    // `merchant.`, so a bogus owner type trips `accounts_logical_code_owner` first. This asserts the
    // constraint that actually fires and records the subsumption.
    [
      'an owner type outside the class',
      { ownerType: 'BANK', bucketIndex: null, bucketCount: null },
      'accounts_logical_code_owner',
    ],
    [
      'a merchant account without an owner',
      {
        ownerType: 'MERCHANT',
        ownerId: null,
        logicalCode: 'merchant.payable',
        bucketIndex: null,
        bucketCount: null,
      },
      'accounts_owner_id_iff_merchant',
    ],
    [
      'a platform account with an owner',
      { ownerId: 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAA' },
      'accounts_owner_id_iff_merchant',
    ],
    [
      'a logical code without a known prefix',
      { logicalCode: 'assets.cash' },
      'accounts_logical_code_format',
    ],
    [
      'a logical code whose prefix contradicts the owner',
      { logicalCode: 'merchant.clearing' },
      'accounts_logical_code_owner',
    ],
    ['a bucket index without a count', { bucketCount: null }, 'accounts_bucket_pair'],
    [
      'a bucket count without an index',
      { bucketIndex: null, bucketCount: 32 },
      'accounts_bucket_pair',
    ],
    ['a bucket index equal to the count', { bucketIndex: 32 }, 'accounts_bucket_range'],
    ['a bucket count of zero', { bucketIndex: 0, bucketCount: 0 }, 'accounts_bucket_range'],
    ['a negative bucket index', { bucketIndex: -1, bucketCount: 4 }, 'accounts_bucket_range'],
    [
      'a code that disagrees with the striping',
      { code: 'platform.fee_revenue' },
      'accounts_code_derived',
    ],
    ['an unknown account class', { accountClass: 'CONTRA' }, 'accounts_class'],
    [
      'a normal side that contradicts the class',
      { accountClass: 'REVENUE', normalSide: 'DEBIT' },
      'accounts_normal_side',
    ],
    ['a currency other than USD', { currency: 'EUR' }, 'accounts_currency'],
    ['an unknown status', { status: 'FROZEN' }, 'accounts_status'],
    ['a status of CLOSED without a closed time', { status: 'CLOSED' }, 'accounts_closed_at'],
    [
      'a merchant account marked merchant-postable',
      {
        ownerType: 'MERCHANT',
        ownerId: 'merchant',
        logicalCode: 'merchant.payable',
        bucketIndex: null,
        bucketCount: null,
        merchantPostable: true,
      },
      'accounts_merchant_postable',
    ],
  ])('rejects %s', async (_label, overrides, constraint) => {
    const result = await attempt((client) => insertAccount(client, account(overrides)));
    expect(result).toMatchObject({ code: '23514', constraint });
  });

  it('rejects a merchant account carrying a bucket index', async () => {
    const result = await attempt((client) =>
      insertAccount(
        client,
        account({
          ownerType: 'MERCHANT',
          ownerId: merchant.merchantId,
          logicalCode: 'merchant.payable',
          merchantPostable: false,
        }),
      ),
    );
    // A merchant account may not be striped at all; the pair checks fire before `bucket_platform_only`
    // only when the count is absent, so this asserts the specific rule.
    expect(result?.code).toBe('23514');
    expect(['accounts_bucket_platform_only', 'accounts_logical_code_owner']).toContain(
      result?.constraint,
    );
  });

  it('rejects a ledger that does not exist', async () => {
    // The composite FK (ledger_id, currency) is what refuses it: there is no ledger to carry the
    // currency, so this is a foreign-key miss rather than a check violation.
    const missing = await attempt((client) =>
      insertAccount(client, { ...account(), ledger_id: newId('led') }),
    );
    expect(missing).toMatchObject({ code: '23503', constraint: 'accounts_ledger_currency_fkey' });
  });

  it('rejects a duplicate logical identity and a duplicate merchant code', async () => {
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const shared = {
        logicalCode: 'platform.rounding_expense',
        bucketIndex: 7,
        accountClass: 'EXPENSE',
      };
      await insertAccount(client, account(shared));
      const duplicate = await insertAccount(client, account(shared)).catch(
        (caught: unknown) => caught,
      );
      await client.query('ROLLBACK');
      // Two rows with the same owner, code and currency fail the code key first; the logical-identity
      // key guards the case where the code matches but the striping does not.
      expect((duplicate as { constraint?: string }).constraint).toBe('accounts_code_name_key');
    } finally {
      client.release();
    }
  });
});

describe('boundaries', () => {
  it.each<[number, number]>([
    [0, 1],
    [99, 100],
  ])('accepts bucket_index %i of bucket_count %i', async (index, count) => {
    const result = await attempt((client) =>
      insertAccount(client, account({ bucketIndex: index, bucketCount: count })),
    );
    expect(result).toBeNull();
  });
});

describe('balance row rules', () => {
  it('rejects an account committed without a balance row', async () => {
    const result = await attempt((client) => insertAccount(client, account(), false));
    // Deferred to commit: the insert itself succeeds and the transaction fails at COMMIT.
    expect(result).toMatchObject({ code: 'P0001', rule: 'ACCOUNT_WITHOUT_BALANCE' });
  });

  it('rejects a normal balance that disagrees with the totals', async () => {
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const id = await insertAccount(client, account());
      const error = await client
        .query(
          'UPDATE ledger.account_balances SET debit_total_minor = 100, version = version + 1 WHERE account_id = $1',
          [id],
        )
        .catch((caught: unknown) => caught);
      await client.query('ROLLBACK');
      expect((error as { constraint?: string }).constraint).toBe('account_balances_normal_balance');
    } finally {
      client.release();
    }
  });

  it('rejects a non-increasing balance version', async () => {
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const id = await insertAccount(client, account());
      const error = await client
        .query(
          'UPDATE ledger.account_balances SET updated_at = clock_timestamp() WHERE account_id = $1',
          [id],
        )
        .catch((caught: unknown) => caught);
      await client.query('ROLLBACK');
      expect((error as { code?: string }).code).toBe('P0001');
      expect(
        JSON.parse(String((error as { detail?: string }).detail)) as { rule: string },
      ).toMatchObject({ rule: 'BALANCE_VERSION_NOT_INCREMENTED' });
    } finally {
      client.release();
    }
  });
});

describe('triggers', () => {
  it.each<[string, string]>([
    ['logical_code', "SET logical_code = 'platform.other'"],
    ['normal_side', "SET normal_side = 'DEBIT'"],
    ['bucket_index', 'SET bucket_index = 4'],
  ])('refuses to change %s', async (_column, assignment) => {
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const id = await insertAccount(client, account());
      const error = await client
        .query(`UPDATE ledger.accounts ${assignment} WHERE id = $1`, [id])
        .catch((caught: unknown) => caught);
      await client.query('ROLLBACK');
      expect(
        JSON.parse(String((error as { detail?: string }).detail)) as { rule: string },
      ).toMatchObject({
        rule: 'ACCOUNT_IMMUTABLE',
      });
    } finally {
      client.release();
    }
  });

  it('allows closing once and refuses to reopen', async () => {
    const closed = await attempt(async (client) => {
      const id = await insertAccount(client, account());
      await client.query(
        "UPDATE ledger.accounts SET status = 'CLOSED', closed_at = clock_timestamp() WHERE id = $1",
        [id],
      );
    });
    expect(closed).toBeNull();

    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const id = await insertAccount(client, account({ status: 'CLOSED', closedAt: new Date() }));
      const error = await client
        .query("UPDATE ledger.accounts SET status = 'OPEN', closed_at = NULL WHERE id = $1", [id])
        .catch((caught: unknown) => caught);
      await client.query('ROLLBACK');
      expect(
        JSON.parse(String((error as { detail?: string }).detail)) as { rule: string },
      ).toMatchObject({
        rule: 'ACCOUNT_CLOSE_ONE_WAY',
      });
    } finally {
      client.release();
    }
  });

  it('refuses delete and truncate even as the table owner', async () => {
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const id = await insertAccount(client, account());
      const deleted = await client
        .query('DELETE FROM ledger.accounts WHERE id = $1', [id])
        .catch((caught: unknown) => caught);
      await client.query('ROLLBACK');
      expect(
        JSON.parse(String((deleted as { detail?: string }).detail)) as { rule: string },
      ).toMatchObject({
        rule: 'ACCOUNT_IMMUTABLE',
      });
    } finally {
      client.release();
    }

    // `CASCADE` reaches `account_balances` through the foreign key, so the failure comes from whichever
    // trigger runs first; both are the same refusal and the rule names which.
    const truncated = await attempt((client) => client.query('TRUNCATE ledger.accounts CASCADE'));
    expect(truncated?.code).toBe('P0001');
    expect(['ACCOUNT_IMMUTABLE', 'BALANCE_IMMUTABLE']).toContain(truncated?.rule);

    const balances = await attempt((client) =>
      client.query('TRUNCATE ledger.account_balances CASCADE'),
    );
    expect(balances).toMatchObject({ code: 'P0001', rule: 'BALANCE_IMMUTABLE' });
  });
});

describe('create_account', () => {
  it('creates a striped platform account with a zeroed balance', async () => {
    const accountId = await withRole(
      database.ownerPool,
      'ledger_function_owner',
      async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT ledger.create_account($1::text, 'PLATFORM', NULL, 'platform.fee_revenue',
                                      3::smallint, 32::smallint, 'REVENUE', true, true) AS id`,
          [ledgerId],
        );
        return rows[0]?.id as string;
      },
    );

    const { rows } = await database.ownerPool.query<Record<string, unknown>>(
      `SELECT a.code, a.normal_side, a.status, a.bucket_index, a.bucket_count, a.merchant_postable,
              b.debit_total_minor::text AS debit, b.credit_total_minor::text AS credit,
              b.normal_balance_minor::text AS balance, b.version::text AS version
         FROM ledger.accounts a JOIN ledger.account_balances b ON b.account_id = a.id
        WHERE a.id = $1`,
      [accountId],
    );
    expect(rows[0]).toEqual({
      code: 'platform.fee_revenue.03',
      normal_side: 'CREDIT',
      status: 'OPEN',
      bucket_index: 3,
      bucket_count: 32,
      merchant_postable: true,
      debit: '0',
      credit: '0',
      balance: '0',
      version: '0',
    });
  });

  it('creates an unstriped merchant account', async () => {
    const accountId = await withRole(
      database.ownerPool,
      'ledger_function_owner',
      async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT ledger.create_account($1::text, 'MERCHANT', $2::text, 'merchant.payable', NULL, NULL,
                                      'LIABILITY', false, false) AS id`,
          [ledgerId, merchant.merchantId],
        );
        return rows[0]?.id as string;
      },
    );

    const { rows } = await database.ownerPool.query<{ code: string; normal_side: string }>(
      'SELECT code, normal_side FROM ledger.accounts WHERE id = $1',
      [accountId],
    );
    expect(rows[0]).toEqual({ code: 'merchant.payable', normal_side: 'CREDIT' });
  });

  it('rejects an unknown ledger', async () => {
    const error = await withRole(database.ownerPool, 'ledger_function_owner', async (client) =>
      client
        .query(
          `SELECT ledger.create_account($1::text, 'PLATFORM', NULL, 'platform.fee_revenue',
                                       3::smallint, 32::smallint, 'REVENUE', true, true)`,
          [newId('led')],
        )
        .catch((caught: unknown) => caught),
    );
    expect(
      JSON.parse(String((error as { detail?: string }).detail)) as { rule: string },
    ).toMatchObject({
      rule: 'LEDGER_NOT_FOUND',
    });
  });
});

describe('logical balance view', () => {
  it('aggregates stripes into one row per logical account', async () => {
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      await insertAccount(
        client,
        account({
          logicalCode: 'platform.processor_receivable',
          bucketIndex: 1,
          bucketCount: 4,
          accountClass: 'ASSET',
        }),
      );
      await insertAccount(
        client,
        account({
          logicalCode: 'platform.processor_receivable',
          bucketIndex: 2,
          bucketCount: 4,
          accountClass: 'ASSET',
        }),
      );
      const { rows } = await client.query<{ bucket_rows: number; rows_for_code: string }>(
        `SELECT bucket_rows, count(*) OVER ()::text AS rows_for_code
           FROM ledger.logical_account_balances
          WHERE logical_code = 'platform.processor_receivable'`,
        [],
      );
      await client.query('ROLLBACK');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.bucket_rows).toBe(2);
    } finally {
      client.release();
    }
  });
});

describe('privileges', () => {
  const RELATIONS = [
    'ledger.ledgers',
    'ledger.accounts',
    'ledger.account_balances',
    'ledger.logical_account_balances',
  ];

  it('gives fl_api and every other runtime role 42501 except the operator reader', async () => {
    const failures: string[] = [];
    for (const role of LOGIN_RUNTIME_ROLES) {
      if (role === 'fl_operator_readonly') continue;
      const client = await database.poolAs(role).connect();
      try {
        for (const relation of RELATIONS) {
          const error = await client
            .query(`SELECT 1 FROM ${relation} LIMIT 1`)
            .catch((caught: unknown) => caught);
          const code = (error as { code?: string } | undefined)?.code;
          if (code !== '42501') failures.push(`${role} ${relation}: ${String(code)}`);
        }
      } finally {
        client.release();
      }
    }
    expect(failures).toEqual([]);
  });

  it('lets fl_operator_readonly read but not write', async () => {
    const client = await database.poolAs('fl_operator_readonly').connect();
    try {
      for (const relation of RELATIONS) {
        await expect(
          client.query(`SELECT count(*) FROM ${relation}`),
          relation,
        ).resolves.toBeDefined();
      }
      const write = await client
        .query("UPDATE ledger.accounts SET status = 'CLOSED'")
        .catch((caught: unknown) => caught);
      expect((write as { code?: string }).code).toBe('42501');
    } finally {
      client.release();
    }
  });
});
