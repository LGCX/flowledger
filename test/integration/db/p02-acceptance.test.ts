/**
 * P02 acceptance: the M2 primitives compose, and they compose atomically.
 *
 * The centre of this file is the composition case. Claiming an idempotency key, creating the payment it
 * names, and recording the outbox event must commit together or leave *nothing* behind — a partial
 * effect here would mean a merchant was charged for a payment that does not exist, or a payment existed
 * with no event for the workers to act on.
 */
import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { migrate } from '@flowledger/database';
import { newId } from '@flowledger/domain';
import {
  createEmptyDatabase,
  createTestMerchant,
  fixtureInsertPayment,
  disposeTestDatabase,
  paymentCreatedEnvelope,
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

describe('migration history', () => {
  it('applies every M2 migration in order, once', async () => {
    const empty = await createEmptyDatabase();
    try {
      const first = await migrate({ connectionString: empty.ownerUrl, ledgerBucketCount: 32 });
      expect(first.applied.length).toBeGreaterThanOrEqual(10);

      // Order, not just membership: an out-of-order run would have been rejected, but asserting the
      // sequence is what proves the numbered batches mean what they say.
      expect([...first.applied]).toEqual([...first.applied].sort());
      expect(first.applied[0]).toMatch(/^0200_/);
      expect(first.applied.at(-1)).toMatch(/^0290_/);

      const second = await migrate({ connectionString: empty.ownerUrl, ledgerBucketCount: 32 });
      expect(second.applied).toEqual([]);
    } finally {
      await empty.drop();
    }
  }, 120_000);
});

/** One client that can act as the payment function owner. */
async function functionOwnerClient(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

// Explicit casts throughout: without them the call binds to the `unknown` overload, which does not
// exist, and PostgreSQL reports "function does not exist" rather than an argument-type problem.
const CLAIM = `SELECT outcome, resource_id, http_status, response_body
                 FROM api.claim_idempotency_key($1::text, 'CREATE_PAYMENT', $2::text, $3::bytea,
                        'PAYMENT', $4::text, 201::smallint, $5::jsonb, '{}'::jsonb, $6::bytea,
                        $7::text, $8::text, 2000)`;

describe('composition', () => {
  it('commits claim, payment and outbox together', async () => {
    const client = await functionOwnerClient(database.urlAs('fl_migration_owner'));
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE payments_function_owner');
      await client.query("SELECT set_config('app.merchant_id', $1, true)", [merchant.merchantId]);

      const paymentId = newId('pay');
      const key = `acceptance-compose-${newId('req')}`;
      const body = JSON.stringify({ id: paymentId });
      const digest = createHash('sha256').update(body, 'utf8').digest();

      const claimed = await client.query<{ outcome: string; resource_id: string }>(CLAIM, [
        merchant.merchantId,
        key,
        digest,
        paymentId,
        body,
        digest,
        `corr-acceptance-${paymentId.slice(-8)}`,
        merchant.credentialId,
      ]);
      expect(claimed.rows[0]?.outcome).toBe('OWNER');

      await fixtureInsertPayment(client, merchant, { id: paymentId, requestedAmountMinor: 1_000n });

      const envelope = paymentCreatedEnvelope({
        merchantId: merchant.merchantId,
        paymentId,
        providerAccountId: merchant.providerAccountId,
        amountMinor: 1_000n,
        feePolicyVersion: merchant.feePolicyVersion,
      });
      await client.query('SELECT messaging.insert_outbox($1::jsonb)', [JSON.stringify(envelope)]);

      await client.query('COMMIT');

      const counts = await database.ownerPool.query<Record<string, string>>(
        `SELECT (SELECT count(*) FROM api.idempotency_records WHERE idempotency_key = $1)::text AS records,
                (SELECT count(*) FROM payments.payments WHERE id = $2)::text AS payments,
                (SELECT count(*) FROM messaging.outbox_messages WHERE envelope_id = $3)::text AS outbox`,
        [key, paymentId, envelope.id],
      );
      expect(counts.rows[0]).toEqual({ records: '1', payments: '1', outbox: '1' });
    } finally {
      await client.end();
    }
  }, 60_000);

  it('leaves no partial effect when the transaction fails after all three writes', async () => {
    const client = await functionOwnerClient(database.urlAs('fl_migration_owner'));
    const paymentId = newId('pay');
    const key = `acceptance-rollback-${newId('req')}`;
    const body = JSON.stringify({ id: paymentId });
    const digest = createHash('sha256').update(body, 'utf8').digest();
    let envelopeId: string;

    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE payments_function_owner');
      await client.query("SELECT set_config('app.merchant_id', $1, true)", [merchant.merchantId]);

      await client.query(CLAIM, [
        merchant.merchantId,
        key,
        digest,
        paymentId,
        body,
        digest,
        `corr-rollback-${paymentId.slice(-8)}`,
        merchant.credentialId,
      ]);

      await fixtureInsertPayment(client, merchant, { id: paymentId, requestedAmountMinor: 1_000n });

      const envelope = paymentCreatedEnvelope({
        merchantId: merchant.merchantId,
        paymentId,
        providerAccountId: merchant.providerAccountId,
        amountMinor: 1_000n,
        feePolicyVersion: merchant.feePolicyVersion,
      });
      envelopeId = envelope.id as string;
      await client.query('SELECT messaging.insert_outbox($1::jsonb)', [JSON.stringify(envelope)]);

      // A failure after every write: the whole unit must vanish, not just the last statement.
      await client.query('SELECT 1/0').catch(() => undefined);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }

    const counts = await database.ownerPool.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM api.idempotency_records WHERE idempotency_key = $1)::text AS records,
              (SELECT count(*) FROM payments.payments WHERE id = $2)::text AS payments,
              (SELECT count(*) FROM messaging.outbox_messages WHERE envelope_id = $3)::text AS outbox`,
      [key, paymentId, envelopeId],
    );
    expect(counts.rows[0]).toEqual({ records: '0', payments: '0', outbox: '0' });
  }, 60_000);

  it('replays a committed claim instead of creating a second record', async () => {
    const client = await functionOwnerClient(database.urlAs('fl_migration_owner'));
    const paymentId = newId('pay');
    const key = `acceptance-replay-${newId('req')}`;
    const body = JSON.stringify({ id: paymentId });
    const digest = createHash('sha256').update(body, 'utf8').digest();

    try {
      for (const expected of ['OWNER', 'REPLAY']) {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE payments_function_owner');
        await client.query("SELECT set_config('app.merchant_id', $1, true)", [merchant.merchantId]);

        const { rows } = await client.query<{
          outcome: string;
          resource_id: string;
          response_body: unknown;
        }>(CLAIM, [
          merchant.merchantId,
          key,
          digest,
          paymentId,
          body,
          digest,
          `corr-replay-${paymentId.slice(-8)}`,
          merchant.credentialId,
        ]);

        // The payment must exist for the deferred resource check whenever the claim commits.
        if (expected === 'OWNER') {
          await fixtureInsertPayment(client, merchant, {
            id: paymentId,
            requestedAmountMinor: 1_000n,
          });
        }

        await client.query('COMMIT');
        expect(rows[0]?.outcome).toBe(expected);

        if (expected === 'REPLAY') {
          // The stored body is returned verbatim, which is what makes a replay indistinguishable to the
          // caller from the original response.
          expect(rows[0]?.resource_id).toBe(paymentId);
          expect(rows[0]?.response_body).toEqual({ id: paymentId });
        }
      }

      const { rows } = await database.ownerPool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM api.idempotency_records WHERE idempotency_key = $1',
        [key],
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await client.end();
    }
  }, 60_000);
});
