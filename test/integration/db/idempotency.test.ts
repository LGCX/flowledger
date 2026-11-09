/**
 * The idempotency boundary and its atomic claim.
 *
 * The concurrency tests are the point of this file. A hundred callers racing on one key must produce
 * exactly one owner and ninety-nine replays — and no promise may reject with `23505`, because a loser
 * seeing a unique violation would have to interpret it, and would sometimes report a failure for a
 * request that actually succeeded.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import {
  DomainError,
  LOGIN_RUNTIME_ROLES,
  mapPgError,
  withTransaction,
} from '@flowledger/database';
import { newId } from '@flowledger/domain';
import {
  assertConstraintCoverage,
  createTestMerchant,
  fixtureInsertOperation,
  fixtureSyncPayment,
  disposeTestDatabase,
  fixtureClaim,
  fixtureInsertIdempotencyRecord,
  fixtureInsertPayment,
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

/** A payment owned by `m`, so the deferred resource-integrity check passes. */
async function paymentFor(m: TestMerchant): Promise<string> {
  const client = await database.ownerPool.connect();
  try {
    return await fixtureInsertPayment(client, m, { requestedAmountMinor: 1_000n });
  } finally {
    client.release();
  }
}

function key(): string {
  return `key_${newId('req')}`;
}

async function runMapped(
  sql: string,
  values: readonly unknown[] = [],
): Promise<{ ok: true } | { error: unknown }> {
  try {
    await withTransaction(database.ownerPool, {}, async (client) => {
      await client.query(sql, [...values]);
    });
    return { ok: true };
  } catch (error) {
    return { error };
  }
}

describe('constraint coverage', () => {
  it('declares every constraint and index', async () => {
    await assertConstraintCoverage(database.ownerPool, 'api.idempotency_records', [
      'idempotency_records_pkey',
      'idempotency_records_merchant_fkey',
      'idempotency_records_credential_fkey',
      'idempotency_records_command_type',
      'idempotency_records_key_format',
      'idempotency_records_request_hash',
      'idempotency_records_response_hash',
      'idempotency_records_correlation_id',
      'idempotency_records_resource_type',
      'idempotency_records_resource_id_format',
      'idempotency_records_http_status',
      'idempotency_records_replay_shape',
      'idempotency_records_replay_window',
    ]);
  });
});

describe('constraint negatives', () => {
  it.each<[string, Record<string, unknown>]>([
    ['idempotency_records_key_format', { idempotencyKey: 'x'.repeat(15) }],
    ['idempotency_records_key_format', { idempotencyKey: 'x'.repeat(129) }],
    ['idempotency_records_key_format', { idempotencyKey: `bad/key/${'x'.repeat(16)}` }],
    ['idempotency_records_command_type', { commandType: 'DELETE_PAYMENT' }],
    ['idempotency_records_http_status', { httpStatus: 200 }],
    [
      'idempotency_records_resource_type',
      { commandType: 'CREATE_PAYMENT', resourceType: 'PAYMENT_OPERATION' },
    ],
  ])('rejects %s via %o', async (constraint, over) => {
    const paymentId = await paymentFor(merchant);
    const client = await database.ownerPool.connect();
    try {
      const commandType = (over.commandType as string | undefined) ?? 'CREATE_PAYMENT';
      const resourceType = (over.resourceType as string | undefined) ?? 'PAYMENT';
      const resourceId = resourceType === 'PAYMENT' ? paymentId : 'op_01ARZ3NDEKTSV4RRFFQ69G5FAA';
      const error = await fixtureInsertIdempotencyRecord(client, merchant, {
        commandType,
        idempotencyKey: (over.idempotencyKey as string | undefined) ?? key(),
        resourceId,
        resourceType,
        ...(over.httpStatus === undefined ? {} : { httpStatus: over.httpStatus as number }),
      }).catch((caught: unknown) => caught);
      expect((error as { constraint?: string }).constraint).toBe(constraint);
    } finally {
      client.release();
    }
  });

  it('rejects a replay window that is not exactly 90 days', async () => {
    const paymentId = await paymentFor(merchant);
    const client = await database.ownerPool.connect();
    try {
      const error = await client
        .query(
          `INSERT INTO api.idempotency_records
             (merchant_id, command_type, idempotency_key, request_hash, resource_type, resource_id,
              http_status, response_body, response_headers, response_hash, correlation_id,
              credential_id, committed_at, replay_expires_at)
           VALUES ($1, 'CREATE_PAYMENT', $2, $3, 'PAYMENT', $4, 201, '{}'::jsonb, '{}'::jsonb, $3,
                   'corr-window-00000001', $5, clock_timestamp(), clock_timestamp() + interval '89 days')`,
          [merchant.merchantId, key(), Buffer.alloc(32, 1), paymentId, merchant.credentialId],
        )
        .catch((caught: unknown) => caught);
      expect((error as { constraint?: string }).constraint).toBe(
        'idempotency_records_replay_window',
      );
    } finally {
      client.release();
    }
  });

  /**
   * `+ interval '90 days'` is calendar arithmetic in the session TimeZone, so across a DST change it
   * is 89d23h or 90d01h. The window must be the same duration whatever the client's TimeZone is.
   * 2026-08-11 + 90 days crosses the US DST end on 2026-11-01.
   */
  it('measures the window in hours, independent of the session TimeZone', async () => {
    const paymentId = await paymentFor(merchant);
    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL timezone = 'America/Chicago'");
      const committedAt = new Date('2026-08-11T12:00:00Z');

      // Exactly 2160 hours: accepted under a DST-observing session.
      await fixtureInsertIdempotencyRecord(client, merchant, {
        idempotencyKey: key(),
        resourceId: paymentId,
        committedAt,
      });

      // Calendar days under that session are 2161 hours here: refused.
      await client.query('SAVEPOINT calendar');
      const error = await client
        .query(
          `INSERT INTO api.idempotency_records
             (merchant_id, command_type, idempotency_key, request_hash, resource_type, resource_id,
              http_status, response_body, response_headers, response_hash, correlation_id,
              credential_id, committed_at, replay_expires_at)
           VALUES ($1, 'CREATE_PAYMENT', $2, $3, 'PAYMENT', $4, 201, '{}'::jsonb, '{}'::jsonb, $3,
                   'corr-window-00000002', $5, $6::timestamptz, $6::timestamptz + interval '90 days')`,
          [
            merchant.merchantId,
            key(),
            Buffer.alloc(32, 1),
            paymentId,
            merchant.credentialId,
            committedAt,
          ],
        )
        .catch((caught: unknown) => caught);
      expect((error as { constraint?: string }).constraint).toBe(
        'idempotency_records_replay_window',
      );
      await client.query('ROLLBACK TO SAVEPOINT calendar');

      // The claim itself writes a row the CHECK accepts under the same session.
      await client.query('SET LOCAL ROLE payments_function_owner');
      await client.query("SELECT set_config('app.merchant_id', $1, true)", [merchant.merchantId]);
      const { rows } = await client.query<{ outcome: string }>(
        `SELECT outcome FROM api.claim_idempotency_key($1, 'CREATE_PAYMENT', $2, $3, 'PAYMENT', $4,
           201::smallint, '{}'::jsonb, '{}'::jsonb, $3, 'corr-window-00000003', $5)`,
        [merchant.merchantId, key(), Buffer.alloc(32, 2), paymentId, merchant.credentialId],
      );
      expect(rows[0]?.outcome).toBe('OWNER');
      const window = await client.query<{ hours: string }>(
        `SELECT (extract(epoch FROM replay_expires_at - committed_at) / 3600)::bigint::text AS hours
           FROM api.idempotency_records WHERE correlation_id = 'corr-window-00000003'`,
      );
      expect(window.rows[0]?.hours).toBe('2160');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('claim concurrency', () => {
  it('elects exactly one owner among 100 identical claims', async () => {
    const paymentId = await paymentFor(merchant);
    const idempotencyKey = key();
    const requestHash = Buffer.alloc(32, 7);

    const outcomes = await Promise.all(
      Array.from({ length: 100 }, () =>
        fixtureClaim(database.ownerPool, merchant, {
          idempotencyKey,
          resourceId: paymentId,
          requestHash,
          holdMs: 50,
        }).catch((error: unknown) => error as Error),
      ),
    );

    const failures = outcomes.filter((outcome) => outcome instanceof Error);
    // A loser must never see a unique violation: it would have to interpret it, and would sometimes
    // report a failure for a request that actually succeeded.
    expect(failures.map((error) => (error as { code?: string }).code)).toEqual([]);

    const results = outcomes as { outcome: string; response_body: unknown }[];
    expect(results.filter((row) => row.outcome === 'OWNER')).toHaveLength(1);
    expect(results.filter((row) => row.outcome === 'REPLAY')).toHaveLength(99);

    const ownerBody = results.find((row) => row.outcome === 'OWNER')?.response_body;
    for (const replay of results.filter((row) => row.outcome === 'REPLAY')) {
      expect(replay.response_body).toEqual(ownerBody);
    }

    const { rows } = await database.ownerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM api.idempotency_records WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    expect(rows[0]?.count).toBe('1');
  }, 60_000);

  it('separates replays from conflicts when hashes diverge', async () => {
    const paymentId = await paymentFor(merchant);
    const idempotencyKey = key();
    const hashA = Buffer.alloc(32, 1);
    const hashB = Buffer.alloc(32, 2);

    const outcomes = await Promise.all(
      Array.from({ length: 100 }, (_unused, index) =>
        fixtureClaim(database.ownerPool, merchant, {
          idempotencyKey,
          resourceId: paymentId,
          requestHash: index < 50 ? hashA : hashB,
          holdMs: 30,
        }).catch((error: unknown) => error as Error),
      ),
    );
    expect(outcomes.filter((row) => row instanceof Error)).toEqual([]);

    const results = outcomes as { outcome: string }[];
    const owners = results.filter((row) => row.outcome === 'OWNER');
    expect(owners).toHaveLength(1);

    const ownerIndex = results.findIndex((row) => row.outcome === 'OWNER');
    const ownerHash = ownerIndex < 50 ? hashA : hashB;
    for (const [index, row] of results.entries()) {
      if (index === ownerIndex) continue;
      const sameHash = (index < 50 ? hashA : hashB).equals(ownerHash);
      expect(row.outcome, `claim ${String(index)}`).toBe(sameHash ? 'REPLAY' : 'CONFLICT');
    }
  }, 60_000);

  it('lets a waiter become the owner when the first claim rolls back', async () => {
    const paymentId = await paymentFor(merchant);
    const idempotencyKey = key();
    const ownerHash = Buffer.alloc(32, 3);
    const waiterHash = Buffer.alloc(32, 4);

    const first = fixtureClaim(database.ownerPool, merchant, {
      idempotencyKey,
      resourceId: paymentId,
      requestHash: ownerHash,
      holdMs: 400,
      finish: 'rollback',
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = fixtureClaim(database.ownerPool, merchant, {
      idempotencyKey,
      resourceId: paymentId,
      requestHash: waiterHash,
      holdMs: 10,
    });

    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome.outcome).toBe('OWNER');
    expect(secondOutcome.outcome).toBe('OWNER');

    const { rows } = await database.ownerPool.query<{ request_hash: Buffer }>(
      'SELECT request_hash FROM api.idempotency_records WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.request_hash.equals(waiterHash)).toBe(true);
  }, 30_000);

  it('raises IDEMPOTENCY_REQUEST_IN_PROGRESS when the owner holds too long', async () => {
    const paymentId = await paymentFor(merchant);
    const idempotencyKey = key();

    const slow = fixtureClaim(database.ownerPool, merchant, {
      idempotencyKey,
      resourceId: paymentId,
      holdMs: 1_500,
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const impatient = await fixtureClaim(database.ownerPool, merchant, {
      idempotencyKey,
      resourceId: paymentId,
      lockTimeoutMs: 200,
    }).catch((error: unknown) => error);

    expect((impatient as DomainError).code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
    await slow;

    const { rows } = await database.ownerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM api.idempotency_records WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    expect(rows[0]?.count).toBe('1');
  }, 30_000);
});

describe('expiry', () => {
  it('reports EXPIRED past the window, for either hash, and leaves the row alone', async () => {
    const paymentId = await paymentFor(merchant);
    const idempotencyKey = key();
    const client = await database.ownerPool.connect();
    try {
      await fixtureInsertIdempotencyRecord(client, merchant, {
        idempotencyKey,
        resourceId: paymentId,
        daysOld: 91,
      });
    } finally {
      client.release();
    }

    const same = await fixtureClaim(database.ownerPool, merchant, {
      idempotencyKey,
      resourceId: paymentId,
    });
    const different = await fixtureClaim(database.ownerPool, merchant, {
      idempotencyKey,
      resourceId: paymentId,
      requestHash: Buffer.alloc(32, 9),
    });

    expect(same.outcome).toBe('EXPIRED');
    expect(same.resource_id).toBe(paymentId);
    expect(different.outcome).toBe('EXPIRED');

    const { rows } = await database.ownerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM api.idempotency_records WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it.each([
    ['89 days is still a replay', 89, 'REPLAY'],
    ['90 days is expired', 90, 'EXPIRED'],
  ])('%s', async (_label, daysOld, expected) => {
    const paymentId = await paymentFor(merchant);
    const idempotencyKey = key();
    const requestHash = Buffer.alloc(32, 5);
    const client = await database.ownerPool.connect();
    try {
      await fixtureInsertIdempotencyRecord(client, merchant, {
        idempotencyKey,
        resourceId: paymentId,
        requestHash,
        daysOld,
      });
    } finally {
      client.release();
    }

    const outcome = await fixtureClaim(database.ownerPool, merchant, {
      idempotencyKey,
      resourceId: paymentId,
      requestHash,
    });
    expect(outcome.outcome).toBe(expected);
  });
});

describe('tombstone', () => {
  it('refuses to tombstone before the window and allows it after', async () => {
    const paymentId = await paymentFor(merchant);
    const early = key();
    const late = key();

    const client = await database.ownerPool.connect();
    try {
      await fixtureInsertIdempotencyRecord(client, merchant, {
        idempotencyKey: early,
        resourceId: paymentId,
        daysOld: 89,
      });
      await fixtureInsertIdempotencyRecord(client, merchant, {
        idempotencyKey: late,
        resourceId: paymentId,
        daysOld: 91,
      });
    } finally {
      client.release();
    }

    const earlyResult = await runMapped(
      `UPDATE api.idempotency_records
          SET tombstoned_at = clock_timestamp(), response_body = NULL, response_headers = NULL
        WHERE idempotency_key = $1`,
      [early],
    );
    expect(((earlyResult as { error?: DomainError }).error as DomainError).code).toBe(
      'INVALID_TRANSITION',
    );

    const lateResult = await runMapped(
      `UPDATE api.idempotency_records
          SET tombstoned_at = clock_timestamp(), response_body = NULL, response_headers = NULL
        WHERE idempotency_key = $1`,
      [late],
    );
    expect(lateResult).toEqual({ ok: true });
  });

  it('reports EXPIRED for a tombstoned record', async () => {
    const paymentId = await paymentFor(merchant);
    const idempotencyKey = key();
    const client = await database.ownerPool.connect();
    try {
      await fixtureInsertIdempotencyRecord(client, merchant, {
        idempotencyKey,
        resourceId: paymentId,
        daysOld: 91,
      });
    } finally {
      client.release();
    }
    await database.ownerPool.query(
      `UPDATE api.idempotency_records
          SET tombstoned_at = clock_timestamp(), response_body = NULL, response_headers = NULL
        WHERE idempotency_key = $1`,
      [idempotencyKey],
    );

    const outcome = await fixtureClaim(database.ownerPool, merchant, {
      idempotencyKey,
      resourceId: paymentId,
    });
    expect(outcome.outcome).toBe('EXPIRED');
  });

  it('keeps request_hash and key immutable, and refuses delete', async () => {
    const paymentId = await paymentFor(merchant);
    const idempotencyKey = key();
    const client = await database.ownerPool.connect();
    try {
      await fixtureInsertIdempotencyRecord(client, merchant, {
        idempotencyKey,
        resourceId: paymentId,
      });
    } finally {
      client.release();
    }

    const changed = await runMapped(
      'UPDATE api.idempotency_records SET request_hash = $1 WHERE idempotency_key = $2',
      [Buffer.alloc(32, 8), idempotencyKey],
    );
    const domain = (changed as { error?: DomainError }).error as DomainError;
    expect(domain.code).toBe('IMMUTABLE_FIELD');
    expect(domain.detail).toMatchObject({ column: 'request_hash' });

    const deleted = await runMapped(
      'DELETE FROM api.idempotency_records WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    expect(((deleted as { error?: DomainError }).error as DomainError).code).toBe('IMMUTABLE_ROW');
  });
});

describe('scope', () => {
  it('isolates the same key text across merchants and command types', async () => {
    const other = await createTestMerchant(database.ownerPool);
    const otherPayment = await paymentFor(other);
    const myPayment = await paymentFor(merchant);
    const idempotencyKey = key();

    const mine = await fixtureClaim(database.ownerPool, merchant, {
      idempotencyKey,
      resourceId: myPayment,
    });
    const theirs = await fixtureClaim(database.ownerPool, other, {
      idempotencyKey,
      resourceId: otherPayment,
    });
    expect([mine.outcome, theirs.outcome]).toEqual(['OWNER', 'OWNER']);

    // Same merchant, different command type: a separate boundary.
    const client = await database.ownerPool.connect();
    let operationId: string;
    try {
      await client.query('BEGIN');
      operationId = await fixtureInsertOperation(client, merchant, myPayment, {
        type: 'AUTHORIZE',
        amountMinor: 100n,
      });
      await fixtureSyncPayment(client, myPayment);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const authorize = await fixtureClaim(database.ownerPool, merchant, {
      commandType: 'AUTHORIZE',
      idempotencyKey,
      resourceId: operationId,
      resourceType: 'PAYMENT_OPERATION',
      httpStatus: 202,
    });
    expect(authorize.outcome).toBe('OWNER');
  });

  it('refuses a claim whose tenant context disagrees', async () => {
    const other = await createTestMerchant(database.ownerPool);
    const myPayment = await paymentFor(merchant);

    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE payments_function_owner');
      await client.query("SELECT set_config('app.merchant_id', $1, true)", [other.merchantId]);
      const error = await client
        .query(
          `SELECT * FROM api.claim_idempotency_key($1, 'CREATE_PAYMENT', $2, $3, 'PAYMENT', $4,
                   201::smallint, '{}'::jsonb, '{}'::jsonb, $3, 'corr-tenant-00000001', $5, 2000)`,
          [merchant.merchantId, key(), Buffer.alloc(32, 1), myPayment, merchant.credentialId],
        )
        .catch((caught: unknown) => mapPgError(caught));
      await client.query('ROLLBACK');
      expect((error as DomainError).code).toBe('TENANT_CONTEXT_MISMATCH');
    } finally {
      client.release();
    }
  });
});

describe('resource integrity', () => {
  it('rejects a payment resource owned by another merchant', async () => {
    const other = await createTestMerchant(database.ownerPool);
    const otherPayment = await paymentFor(other);

    const error = await fixtureClaim(database.ownerPool, merchant, {
      idempotencyKey: key(),
      resourceId: otherPayment,
    }).catch((caught: unknown) => caught);

    expect((error as { constraint?: string }).constraint).toBe(
      'idempotency_records_resource_integrity',
    );
  });

  it('rejects an operation whose type differs from the command', async () => {
    const paymentId = await paymentFor(merchant);
    const client = await database.ownerPool.connect();
    let operationId: string;
    try {
      await client.query('BEGIN');
      operationId = await fixtureInsertOperation(client, merchant, paymentId, {
        type: 'CAPTURE',
        amountMinor: 100n,
      });
      await fixtureSyncPayment(client, paymentId);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const error = await fixtureClaim(database.ownerPool, merchant, {
      commandType: 'REFUND',
      idempotencyKey: key(),
      resourceId: operationId,
      resourceType: 'PAYMENT_OPERATION',
      httpStatus: 202,
    }).catch((caught: unknown) => caught);

    expect((error as { constraint?: string }).constraint).toBe(
      'idempotency_records_resource_integrity',
    );
  });
});

describe('privileges', () => {
  it('denies every runtime role table access and EXECUTE on the claim', async () => {
    for (const role of LOGIN_RUNTIME_ROLES) {
      const client = await database.poolAs(role).connect();
      try {
        for (const sql of [
          'SELECT 1 FROM api.idempotency_records LIMIT 1',
          `INSERT INTO api.idempotency_records (merchant_id, command_type, idempotency_key, request_hash,
             resource_type, resource_id, http_status, response_hash, correlation_id, credential_id,
             replay_expires_at)
           VALUES ('${merchant.merchantId}', 'CREATE_PAYMENT', 'xxxxxxxxxxxxxxxx', decode('01', 'hex'),
                   'PAYMENT', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAA', 201, decode('01', 'hex'),
                   'corr-claim-000000001', '${merchant.credentialId}', clock_timestamp())`,
          'UPDATE api.idempotency_records SET tombstoned_at = NULL',
          'DELETE FROM api.idempotency_records',
        ]) {
          const error = await client.query(sql).catch((caught: unknown) => caught);
          expect((error as { code?: string }).code, `${role}: ${sql.slice(0, 24)}`).toBe('42501');
        }

        const execute = await client
          .query(
            `SELECT * FROM api.claim_idempotency_key('m', 'CREATE_PAYMENT', 'k', decode('01', 'hex'),
                     'PAYMENT', 'p', 201::smallint, '{}'::jsonb, '{}'::jsonb, decode('01', 'hex'),
                     'corr-000000000001', 'corr-000000000002', 2000)`,
          )
          .catch((caught: unknown) => caught);
        expect((execute as { code?: string }).code, role).toBe('42501');
      } finally {
        client.release();
      }
    }
  });
});
