/**
 * Catalog-wide privilege invariants, asserted over every application schema rather than per table.
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

  it('enables RLS on every application table', async () => {
    const { rows } = await database.ownerPool.query<{ relation: string }>(
      `SELECT n.nspname || '.' || c.relname AS relation
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY ($1) AND c.relkind = 'r' AND NOT c.relrowsecurity
        ORDER BY 1`,
      [APP_SCHEMAS],
    );
    expect(rows).toEqual([]);
  });
});

describe('functions', () => {
  it('pins search_path on every function whose body is resolved at run time', async () => {
    // SQL-standard bodies (`RETURN ...`, prosqlbody non-null) bind names at creation, so they cannot be
    // shadowed by a caller's search_path; every other body can, SECURITY DEFINER or not.
    const { rows } = await database.ownerPool.query<{ fn: string; config: string[] | null }>(
      `SELECT n.nspname || '.' || p.proname AS fn, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE (n.nspname = ANY ($1) OR (n.nspname = 'public' AND p.proname LIKE 'fl\\_%'))
          AND p.prosqlbody IS NULL
          AND NOT coalesce('search_path=pg_catalog, pg_temp' = ANY (p.proconfig), false)
        ORDER BY 1`,
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
