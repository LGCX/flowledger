/**
 * Migration 0200: schemas, roles, and helpers.
 *
 * The assertions are mostly catalogue queries rather than behaviour, because what this migration
 * promises is a *posture*: no schema reachable by PUBLIC, no role holding superuser or bypassrls, no
 * function executable by default. Those are properties of the cluster that no application test would
 * notice if they were wrong.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import {
  DOMAIN_ERROR_CODES,
  DomainError,
  FUNCTION_OWNER_ROLES,
  LOGIN_RUNTIME_ROLES,
  MIGRATION_OWNER,
  migrate,
  withTransaction,
} from '@flowledger/database';
import {
  createEmptyDatabase,
  disposeTestDatabase,
  setTestConnection,
  useTestDatabase,
  type TestDatabase,
} from '@flowledger/testkit';

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

const SCHEMAS = [
  'identity',
  'providers',
  'payments',
  'api',
  'ledger',
  'settlement',
  'messaging',
  'webhooks',
  'reconciliation',
  'audit',
] as const;

let database: TestDatabase;

beforeAll(async () => {
  database = await useTestDatabase()();
});

afterAll(async () => {
  if (database !== undefined) await disposeTestDatabase(database);
});

describe('roles', () => {
  it('creates every role with the right attributes', async () => {
    const { rows } = await database.ownerPool.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
         FROM pg_roles
        WHERE rolname = ANY($1::text[])`,
      [[...FUNCTION_OWNER_ROLES, ...LOGIN_RUNTIME_ROLES, MIGRATION_OWNER]],
    );

    expect(rows).toHaveLength(FUNCTION_OWNER_ROLES.length + LOGIN_RUNTIME_ROLES.length + 1);

    for (const row of rows) {
      expect(row.rolsuper, row.rolname).toBe(false);
      expect(row.rolbypassrls, row.rolname).toBe(false);

      if (row.rolname === MIGRATION_OWNER) continue;
      // CREATEROLE is required for the migration owner to GRANT roles; nothing else may hold it.
      expect(row.rolcreaterole, row.rolname).toBe(false);
      expect(row.rolcreatedb, row.rolname).toBe(false);

      const isFunctionOwner = (FUNCTION_OWNER_ROLES as readonly string[]).includes(row.rolname);
      expect(row.rolcanlogin, `${row.rolname} login`).toBe(!isFunctionOwner);
    }
  });

  it('makes the migration owner a member of every function-owner role with SET but not INHERIT', async () => {
    // Each role has two membership rows in this topology: the explicit GRANT from 0200, and the
    // implicit creator grant PostgreSQL records when a CREATEROLE role creates another role. The
    // contract is about the explicit one, so the assertion is per role, not per row.
    const { rows } = await database.ownerPool.query<{
      role: string;
      set_option: boolean;
      inherit_option: boolean;
    }>(
      `SELECT r.rolname AS role, m.set_option, m.inherit_option
         FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
         JOIN pg_roles g ON g.oid = m.member
        WHERE g.rolname = $1 AND r.rolname = ANY($2::text[])`,
      [MIGRATION_OWNER, [...FUNCTION_OWNER_ROLES]],
    );

    for (const role of FUNCTION_OWNER_ROLES) {
      const explicit = rows.filter((row) => row.role === role && row.set_option);
      expect(explicit, role).toHaveLength(1);
      expect(explicit[0]?.inherit_option, role).toBe(false);
    }
  });
});

describe('schemas', () => {
  it('creates all ten schemas owned by the migration owner', async () => {
    const { rows } = await database.ownerPool.query<{ nspname: string; owner: string }>(
      `SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner
         FROM pg_namespace n
        WHERE n.nspname = ANY($1::text[])`,
      [[...SCHEMAS]],
    );

    expect(rows.map((row) => row.nspname).sort()).toEqual([...SCHEMAS].sort());
    for (const row of rows) expect(row.owner, row.nspname).toBe(MIGRATION_OWNER);
  });

  it('leaves PUBLIC without USAGE or CREATE on any of them', async () => {
    for (const schema of SCHEMAS) {
      const { rows } = await database.ownerPool.query<{ usage: boolean; create: boolean }>(
        `SELECT has_schema_privilege('public', $1, 'USAGE') AS usage,
                has_schema_privilege('public', $1, 'CREATE') AS create`,
        [schema],
      );
      expect(rows[0], schema).toEqual({ usage: false, create: false });
    }
  });

  it('leaves the runtime roles without schema access yet (grants arrive per table)', async () => {
    for (const role of ['fl_api', 'fl_relay', 'fl_payment_worker'] as const) {
      for (const schema of SCHEMAS) {
        const { rows } = await database.ownerPool.query<{ usage: boolean }>(
          `SELECT has_schema_privilege($1, $2, 'USAGE') AS usage`,
          [role, schema],
        );
        expect(rows[0]?.usage, `${role} on ${schema}`).toBe(false);
      }
    }
  });
});

describe('fl_is_id', () => {
  const cases: readonly [string, string, string, boolean][] = [
    ['valid', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'pay', true],
    ['wrong prefix', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'op', false],
    ['too short', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FA', 'pay', false],
    ['too long', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAVV', 'pay', false],
    ['lower-case ULID', 'pay_01arz3ndektsv4rrffq69g5fav', 'pay', false],
    ['contains I', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAI', 'pay', false],
    ['contains L', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAL', 'pay', false],
    ['contains O', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAO', 'pay', false],
    ['contains U', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAU', 'pay', false],
    ['first ULID char 8', 'pay_81ARZ3NDEKTSV4RRFFQ69G5FAV', 'pay', false],
    ['missing separator', 'pay01ARZ3NDEKTSV4RRFFQ69G5FAV', 'pay', false],
    // Without the leading anchor the pattern would match anywhere in the value, so a prefixed string
    // would pass. This case is what makes the anchor load-bearing.
    ['leading junk', 'xpay_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'pay', false],
    ['trailing newline', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV\n', 'pay', false],
  ];

  it.each(cases)('%s', async (_label, value, prefix, expected) => {
    const { rows } = await database.ownerPool.query<{ ok: boolean }>(
      'SELECT public.fl_is_id($1, $2) AS ok',
      [value, prefix],
    );
    expect(rows[0]?.ok).toBe(expected);
  });

  it('is STRICT: null in, null out', async () => {
    const { rows } = await database.ownerPool.query<{ ok: boolean | null }>(
      'SELECT public.fl_is_id(NULL, $1) AS ok',
      ['pay'],
    );
    expect(rows[0]?.ok).toBeNull();
  });
});

describe('fl_is_sha256', () => {
  it.each([31, 32, 33])('rejects %i bytes unless it is 32', async (length) => {
    const { rows } = await database.ownerPool.query<{ ok: boolean }>(
      'SELECT public.fl_is_sha256($1::bytea) AS ok',
      [Buffer.alloc(length, 7)],
    );
    expect(rows[0]?.ok).toBe(length === 32);
  });
});

describe('fl_current_merchant_id', () => {
  it('is null when unset and when the setting is empty', async () => {
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      const unset = await client.query<{ id: string | null }>(
        'SELECT public.fl_current_merchant_id() AS id',
      );
      expect(unset.rows[0]?.id).toBeNull();

      const empty = await client.query<{ id: string | null }>(
        "SELECT public.fl_current_merchant_id() AS id FROM (SELECT set_config('app.merchant_id', '', true)) AS s",
      );
      expect(empty.rows[0]?.id).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('returns the setting when it is present', async () => {
    const id = await withTransaction(
      database.ownerPool,
      { merchantId: 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      async (client) => {
        const result = await client.query<{ id: string | null }>(
          'SELECT public.fl_current_merchant_id() AS id',
        );
        return result.rows[0]?.id ?? null;
      },
    );
    expect(id).toBe('mer_01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });
});

describe('fl_raise_domain and fl_assert_unchanged', () => {
  it('raises a P0001 code that maps back to a DomainError', async () => {
    const error = await withTransaction(database.ownerPool, {}, async (client) => {
      await client.query(
        `SELECT public.fl_raise_domain('PAYMENT_VERSION_MISMATCH', '{"expected":"2"}')`,
      );
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('PAYMENT_VERSION_MISMATCH');
    expect((error as DomainError).detail).toEqual({ expected: '2' });
  });

  it('every code it can raise is one the mapper knows', async () => {
    // `fl_raise_domain` takes any string; the mapper only recognises DOMAIN_ERROR_CODES. A code used
    // in SQL but absent from the list would surface as a raw pg error at the API boundary.
    const { rows } = await database.ownerPool.query<{ code: string }>(
      'SELECT unnest($1::text[]) AS code',
      [[...DOMAIN_ERROR_CODES]],
    );
    for (const { code } of rows) {
      const error = await withTransaction(database.ownerPool, {}, async (client) => {
        await client.query('SELECT public.fl_raise_domain($1)', [code]);
      }).catch((caught: unknown) => caught);
      expect(error, code).toBeInstanceOf(DomainError);
      expect((error as DomainError).code, code).toBe(code);
    }
  });

  it('raises IMMUTABLE_FIELD naming the changed column', async () => {
    const error = await withTransaction(database.ownerPool, {}, async (client) => {
      await client.query(
        `SELECT public.fl_assert_unchanged('payments.payment', '{"amount":"100"}'::jsonb, '{"amount":"200"}'::jsonb, ARRAY['amount'])`,
      );
    }).catch((caught: unknown) => caught);

    expect((error as DomainError).code).toBe('IMMUTABLE_FIELD');
    expect((error as DomainError).detail).toEqual({ table: 'payments.payment', column: 'amount' });
  });

  it('accepts unchanged columns', async () => {
    await expect(
      withTransaction(database.ownerPool, {}, async (client) => {
        await client.query(
          `SELECT public.fl_assert_unchanged('payments.payment', '{"amount":"100"}'::jsonb, '{"amount":"100"}'::jsonb, ARRAY['amount'])`,
        );
      }),
    ).resolves.toBeUndefined();
  });

  it('reports the first changed column in declaration order', async () => {
    const error = await withTransaction(database.ownerPool, {}, async (client) => {
      await client.query(
        `SELECT public.fl_assert_unchanged('t', '{"a":"1","b":"1"}'::jsonb, '{"a":"2","b":"2"}'::jsonb, ARRAY['b','a'])`,
      );
    }).catch((caught: unknown) => caught);

    expect((error as DomainError).detail).toEqual({ table: 't', column: 'b' });
  });
});

describe('default privileges', () => {
  it('a function created by the owner afterwards is not executable by PUBLIC', async () => {
    await database.ownerPool.query(`
      CREATE OR REPLACE FUNCTION public.fl_probe_not_public() RETURNS int
        LANGUAGE sql IMMUTABLE RETURN 1
    `);
    try {
      const { rows } = await database.ownerPool.query<{ executable: boolean }>(
        "SELECT has_function_privilege('public', 'public.fl_probe_not_public()', 'EXECUTE') AS executable",
      );
      expect(rows[0]?.executable).toBe(false);

      const asApi = await database.ownerPool.query<{ executable: boolean }>(
        "SELECT has_function_privilege('fl_api', 'public.fl_probe_not_public()', 'EXECUTE') AS executable",
      );
      expect(asApi.rows[0]?.executable).toBe(false);
    } finally {
      await database.ownerPool.query('DROP FUNCTION public.fl_probe_not_public()');
    }
  });

  it('grants the pure predicates to PUBLIC, because CHECK constraints evaluate as the caller', async () => {
    const { rows } = await database.ownerPool.query<{ ok: boolean }>(
      "SELECT has_function_privilege('fl_api', 'public.fl_is_id(text,text)', 'EXECUTE') AS ok",
    );
    expect(rows[0]?.ok).toBe(true);
  });
});

describe('fl_assign_function_owner', () => {
  it('reassigns a function to its schema role and leaves no CREATE grant behind', async () => {
    await database.ownerPool.query('CREATE SCHEMA IF NOT EXISTS probe_schema');
    await database.ownerPool.query(`
      CREATE OR REPLACE FUNCTION probe_schema.probe_fn() RETURNS int LANGUAGE sql RETURN 1
    `);

    try {
      await database.ownerPool.query(
        "SELECT public.fl_assign_function_owner('probe_schema.probe_fn()'::regprocedure, 'payments_function_owner')",
      );

      const { rows } = await database.ownerPool.query<{ owner: string }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'probe_schema' AND p.proname = 'probe_fn'`,
      );
      expect(rows[0]?.owner).toBe('payments_function_owner');

      const grant = await database.ownerPool.query<{ can_create: boolean }>(
        "SELECT has_schema_privilege('payments_function_owner', 'probe_schema', 'CREATE') AS can_create",
      );
      expect(grant.rows[0]?.can_create).toBe(false);
    } finally {
      await database.ownerPool.query('DROP SCHEMA probe_schema CASCADE');
    }
  });
});

describe('idempotency across databases', () => {
  it('applies 0200 to a second database in the same cluster while the roles already exist', async () => {
    const second = await createEmptyDatabase();
    try {
      const result = await migrate({
        connectionString: second.ownerUrl,
        upTo: '0200',
        ledgerBucketCount: 32,
      });
      expect(result.applied).toContain('0200_foundation.sql');

      const client = new pg.Client({ connectionString: second.ownerUrl });
      await client.connect();
      try {
        const { rows } = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM pg_namespace WHERE nspname = ANY($1::text[])',
          [[...SCHEMAS]],
        );
        expect(rows[0]?.count).toBe(String(SCHEMAS.length));
      } finally {
        await client.end();
      }
    } finally {
      await second.drop();
    }
  });
});
