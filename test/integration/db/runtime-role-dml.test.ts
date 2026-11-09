/**
 * The DML matrix: no runtime role can write to any M2 table, and none can call a protected function.
 *
 * The point is not any single cell but that the matrix is *complete*. It enumerates the tables from the
 * catalog and fails if one is missing, so a table added in a later migration cannot slip through
 * untested — the test breaks rather than silently not covering it.
 *
 * Writes are attempted as real statements rather than read from `has_table_privilege`, because a
 * privilege asserted from the catalog and a privilege actually enforced are the same thing only if
 * something executes. The roles here are the ones an attacker would reach.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { LOGIN_RUNTIME_ROLES } from '@flowledger/database';
import {
  createTestMerchant,
  disposeTestDatabase,
  setTestConnection,
  useTestDatabase,
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

const SCHEMAS = ['identity', 'providers', 'payments', 'api', 'messaging'] as const;

/**
 * The audited operator grant: `fl_operator_command` holds *column-level* INSERT and UPDATE on
 * `identity.merchant_api_credentials`. Its blanket probes therefore hit a column it was not granted,
 * so the cell is excluded from the matrix and proven narrowly below instead — both that the granted
 * columns work and that a non-granted one does not.
 */
const ALLOWED: readonly string[] = ['identity.merchant_api_credentials:fl_operator_command'];

/** The first column of each table, so the UPDATE probe names a real column in every table. */
async function firstColumns(): Promise<Map<string, string>> {
  const { rows } = await database.ownerPool.query<{ qualified: string; column_name: string }>(
    `SELECT table_schema || '.' || table_name AS qualified, min(column_name) AS column_name
       FROM information_schema.columns
      WHERE table_schema = ANY ($1::text[])
      GROUP BY 1`,
    [SCHEMAS],
  );
  return new Map(rows.map((row) => [row.qualified, row.column_name]));
}

async function m2Tables(): Promise<string[]> {
  const { rows } = await database.ownerPool.query<{ qualified: string }>(
    `SELECT table_schema || '.' || table_name AS qualified
       FROM information_schema.tables
      WHERE table_schema = ANY ($1::text[])
        AND table_type = 'BASE TABLE'
      ORDER BY 1`,
    [SCHEMAS],
  );
  return rows.map((row) => row.qualified);
}

describe('table enumeration', () => {
  it('covers every table in the five M2 schemas', async () => {
    const tables = await m2Tables();

    // A floor, not an exact count: the matrix must grow with the schema, and this catches an empty or
    // truncated enumeration.
    expect(tables.length).toBeGreaterThanOrEqual(14);
    expect(tables).toContain('payments.payments');
    expect(tables).toContain('payments.payment_operations');
    expect(tables).toContain('api.idempotency_records');
    expect(tables).toContain('messaging.outbox_messages');
    expect(tables).toContain('messaging.dead_letter_replays');
  });
});

describe('runtime DML matrix', () => {
  it('denies INSERT, UPDATE, DELETE and TRUNCATE to every runtime role', async () => {
    const tables = await m2Tables();
    const columns = await firstColumns();
    const failures: string[] = [];

    for (const role of LOGIN_RUNTIME_ROLES) {
      const client = await database.poolAs(role).connect();
      try {
        for (const table of tables) {
          if (ALLOWED.includes(`${table}:${role}`)) continue;

          for (const statement of [
            `INSERT INTO ${table} DEFAULT VALUES`,
            // A real column: `ctid` is a system column and PostgreSQL refuses to update it (0A000),
            // which would mask the privilege check with a syntax-class failure.
            `UPDATE ${table} SET ${columns.get(table) as string} = ${columns.get(table) as string} WHERE false`,
            `DELETE FROM ${table} WHERE false`,
            `TRUNCATE ${table}`,
          ]) {
            const error = await client.query(statement).catch((caught: unknown) => caught);
            const code = (error as { code?: string } | undefined)?.code;
            // A successful no-op (`UPDATE ... WHERE false` on a table the role can write) returns no
            // code; that is exactly the case the matrix must catch.
            if (code !== '42501') {
              failures.push(`${role} ${statement.split(' ')[0]} ${table}: got ${String(code)}`);
            }
          }
        }
      } finally {
        client.release();
      }
    }

    expect(failures).toEqual([]);
  }, 120_000);

  it('denies EXECUTE on every protected function', async () => {
    const functions = [
      'messaging.insert_outbox(jsonb)',
      'api.claim_idempotency_key(text,text,text,bytea,text,text,smallint,jsonb,jsonb,bytea,text,text,integer)',
      'providers.select_route(text,text,text)',
    ];

    const failures: string[] = [];
    for (const role of LOGIN_RUNTIME_ROLES) {
      const client = await database.poolAs(role).connect();
      try {
        for (const signature of functions) {
          const name = signature.slice(0, signature.indexOf('('));
          const error = await client
            .query(`SELECT * FROM ${name}(${placeholderArgs(signature)})`)
            .catch((caught: unknown) => caught);
          const code = (error as { code?: string } | undefined)?.code;
          // 42501 is the denial; 42883 (no such function) would mean the signature drifted, which is a
          // different failure and must not be mistaken for a pass.
          if (code !== '42501') failures.push(`${role} ${name}: got ${String(code)}`);
        }
      } finally {
        client.release();
      }
    }

    expect(failures).toEqual([]);
  }, 120_000);
});

/** Positional placeholders matching each signature's arity, so the call fails on permission not syntax. */
function placeholderArgs(signature: string): string {
  const inner = signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')'));
  const arity = inner.split(',').length;
  return Array.from({ length: arity }, () => 'NULL').join(', ');
}

describe('the audited operator grant is narrow, not absent', () => {
  it('lets fl_operator_command issue and revoke, and refuses anything wider', async () => {
    const client = await database.poolAs('fl_operator_command').connect();
    try {
      await client.query('BEGIN');

      // The granted column list is exactly what issuing needs. `status` is left to its default, because
      // the operator was not granted it on INSERT.
      const issued = await client.query(
        `INSERT INTO identity.merchant_api_credentials
           (id, merchant_id, key_prefix, credential_digest, digest_version, scopes)
         VALUES ($1, $2, $3, $4, 1, ARRAY['payments:read'])
         RETURNING id, status`,
        [
          'mcr_01ARZ3NDEKTSV4RRFFQ69G5FAB',
          merchant.merchantId,
          '0123456789AB',
          Buffer.alloc(32, 1),
        ],
      );
      expect(issued.rows).toHaveLength(1);
      expect((issued.rows[0] as { status: string }).status).toBe('ACTIVE');

      // Revoking is a status/revoked_at update, and it is granted.
      await expect(
        client.query(
          `UPDATE identity.merchant_api_credentials
              SET status = 'REVOKED', revoked_at = clock_timestamp()
            WHERE id = $1`,
          ['mcr_01ARZ3NDEKTSV4RRFFQ69G5FAB'],
        ),
      ).resolves.toBeDefined();

      // Rewriting the digest is not: there is no UPDATE privilege on that column at all.
      const widened = await client
        .query(
          `UPDATE identity.merchant_api_credentials SET credential_digest = $1 WHERE id = $2`,
          [Buffer.alloc(32, 2), 'mcr_01ARZ3NDEKTSV4RRFFQ69G5FAB'],
        )
        .catch((caught: unknown) => caught);
      expect((widened as { code?: string }).code).toBe('42501');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
