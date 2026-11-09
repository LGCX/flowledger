/**
 * Catalog-wide privilege invariants, asserted over every application schema rather than per table.
 *
 * Only rules the contracts state everywhere belong here. Which tables carry RLS is per table (docs/07
 * puts it on tenant data; ledger buckets, for one, are operator-only), so that stays in each table's
 * own tests.
 *
 * Per-table tests only cover the tables someone remembered to test. The 0280 defect — RLS enabled on
 * `messaging.message_types` with no policy for the role granted SELECT on it, which made every envelope
 * fail as UNREGISTERED_TYPE — was invisible to the table's own tests and surfaced only in 0290. These
 * checks would have refused it in the migration that introduced it, and they cover every later
 * migration automatically.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import {
  disposeTestDatabase,
  setTestConnection,
  useTestDatabase,
  type TestDatabase,
} from '@flowledger/testkit';

const APP_SCHEMAS = [
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
];

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

let database: TestDatabase;

beforeAll(async () => {
  database = await useTestDatabase()();
});

afterAll(async () => {
  if (database !== undefined) await disposeTestDatabase(database);
});

describe('row-level security', () => {
  it('gives every role granted a table privilege at least one policy on an RLS table', async () => {
    // A grant without a policy is a table that role silently sees as empty (or cannot write at all).
    const { rows } = await database.ownerPool.query<{ relation: string; grantee: string }>(
      `SELECT DISTINCT g.table_schema || '.' || g.table_name AS relation, g.grantee
         FROM information_schema.role_table_grants g
         JOIN pg_namespace n ON n.nspname = g.table_schema
         JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = g.table_name
        WHERE g.table_schema = ANY ($1)
          AND c.relrowsecurity
          AND g.grantee <> pg_get_userbyid(c.relowner)
          AND NOT EXISTS (
            SELECT 1 FROM pg_policies p
             WHERE p.schemaname = g.table_schema AND p.tablename = g.table_name
               AND (g.grantee = ANY (p.roles) OR 'public' = ANY (p.roles))
          )
        ORDER BY 1, 2`,
      [APP_SCHEMAS],
    );
    expect(rows).toEqual([]);
  });
});

describe('functions', () => {
  it('pins search_path on every function whose body is resolved at run time', async () => {
    // SQL-standard bodies (`RETURN ...`, prosqlbody non-null) bind names at creation, so they cannot be
    // shadowed by a caller's search_path; every other body can, SECURITY DEFINER or not. "Pinned" means
    // a fixed list naming only pg_catalog, pg_temp, public, or FlowLedger schemas, never "$user". The
    // exact list is the task's choice (P03 uses `pg_catalog` alone, and `pg_catalog, public` where it
    // needs pgcrypto); the next test is what makes listing those schemas safe.
    const { rows } = await database.ownerPool.query<{ fn: string; config: string[] | null }>(
      `SELECT n.nspname || '.' || p.proname AS fn, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE (n.nspname = ANY ($1) OR (n.nspname = 'public' AND p.proname LIKE 'fl\\_%'))
          AND p.prosqlbody IS NULL
        ORDER BY 1`,
      [APP_SCHEMAS],
    );
    const trusted = new Set(['pg_catalog', 'pg_temp', 'public', ...APP_SCHEMAS]);
    const unpinned = rows.filter((row) => {
      const setting = (row.config ?? []).find((entry) => entry.startsWith('search_path='));
      if (setting === undefined) return true;
      const schemas = setting
        .slice('search_path='.length)
        .split(',')
        .map((schema) => schema.trim().replace(/^"|"$/g, ''));
      return schemas.some((schema) => !trusted.has(schema));
    });
    expect(unpinned).toEqual([]);
  });

  it('lets no role but the owner create objects in a schema a pinned search_path names', async () => {
    // A pinned search_path is only as safe as its schemas: if a runtime role could CREATE in `public`
    // or an application schema, it could plant a function that a pinned lookup then resolves.
    const { rows } = await database.ownerPool.query<{ role: string; schema: string }>(
      `SELECT r.rolname AS role, n.nspname AS schema
         FROM pg_namespace n
         CROSS JOIN (
           SELECT rolname, oid FROM pg_roles
            WHERE NOT rolsuper AND rolname NOT LIKE 'pg\\_%' AND rolname <> 'fl_migration_owner'
         ) r
        WHERE (n.nspname = ANY ($1) OR n.nspname = 'public')
          AND r.oid <> n.nspowner
          AND has_schema_privilege(r.oid, n.oid, 'CREATE')
       UNION ALL
       SELECT 'PUBLIC', n.nspname
         FROM pg_namespace n
        WHERE (n.nspname = ANY ($1) OR n.nspname = 'public')
          AND has_schema_privilege('public', n.oid, 'CREATE')
        ORDER BY 1, 2`,
      [APP_SCHEMAS],
    );
    expect(rows).toEqual([]);
  });

  it('grants EXECUTE to PUBLIC only on the pure predicates', async () => {
    const { rows } = await database.ownerPool.query<{ fn: string }>(
      `SELECT n.nspname || '.' || p.proname AS fn
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE (n.nspname = ANY ($1) OR (n.nspname = 'public' AND p.proname LIKE 'fl\\_%'))
          AND has_function_privilege('public', p.oid, 'EXECUTE')
        ORDER BY 1`,
      [APP_SCHEMAS],
    );
    expect(rows.map((row) => row.fn)).toEqual([
      'public.fl_current_merchant_id',
      'public.fl_is_id',
      'public.fl_is_sha256',
    ]);
  });
});
