/**
 * A populated M2 database, and the fixture later phases migrate forward from.
 *
 * Two merchants, each with one untouched payment and one awaiting authorization. The second is what
 * makes the fixture useful: it holds an exclusive operation in flight, an idempotency record, an inbox
 * row, a dead letter and a replay, so a later migration meets realistic state rather than an empty schema.
 *
 * No operation is terminal (risk R8): P06 adds an evidence foreign key to operations, and a terminal
 * operation would need evidence rows this fixture cannot invent before P06 exists.
 */
import type pg from 'pg';

import { executeCommandEnvelope, paymentCreatedEnvelope } from '../envelopes.js';
import { createTestMerchant, type TestMerchant } from './merchant.js';
import { fixtureInsertOperation, fixtureInsertPayment, fixtureSyncPayment } from './payments.js';

export interface PopulatedP02 {
  readonly merchants: readonly TestMerchant[];
  readonly outboxIds: readonly string[];
}

/** Inserts an outbox row as the only role allowed to publish. */
async function insertOutbox(pool: pg.Pool, envelope: object): Promise<string> {
  const envelopeId = (envelope as { id: string }).id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE payments_function_owner');
    await client.query('SELECT messaging.insert_outbox($1::jsonb)', [JSON.stringify(envelope)]);
    await client.query('COMMIT');
    return envelopeId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertIdempotency(
  client: pg.ClientBase,
  merchant: TestMerchant,
  commandType: string,
  key: string,
  resourceType: string,
  resourceId: string,
  correlationId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO api.idempotency_records
       (merchant_id, command_type, idempotency_key, request_hash, resource_type, resource_id,
        http_status, response_body, response_headers, response_hash, correlation_id, credential_id,
        committed_at, replay_expires_at)
     VALUES ($1, $2, $3, sha256(convert_to($4, 'UTF8')), $5, $4,
             CASE WHEN $2 = 'CREATE_PAYMENT' THEN 201 ELSE 202 END,
             jsonb_build_object('id', $4), '{"content-type":"application/json"}'::jsonb,
             sha256(convert_to($4, 'UTF8')), $6, $7, clock_timestamp(),
             clock_timestamp() + interval '90 days')`,
    [
      merchant.merchantId,
      commandType,
      key,
      resourceId,
      resourceType,
      correlationId,
      merchant.credentialId,
    ],
  );
}

export async function populateP02(pool: pg.Pool): Promise<PopulatedP02> {
  const merchants: TestMerchant[] = [];
  const outboxIds: string[] = [];

  for (const index of [0, 1] as const) {
    const merchant = await createTestMerchant(pool);
    merchants.push(merchant);

    // Threaded out of the transaction blocks: `insert_outbox` needs the real ids, and a freshly minted
    // one would be rejected as SUBJECT_NOT_FOUND.
    let createdPaymentId: string;
    let pendingPaymentId: string;
    let authorizeOperationId: string;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      createdPaymentId = await fixtureInsertPayment(client, merchant, {
        requestedAmountMinor: 5_000n,
      });
      await client.query('COMMIT');

      await insertIdempotency(
        client,
        merchant,
        'CREATE_PAYMENT',
        `fixture-create-${String(index)}-000000`,
        'PAYMENT',
        createdPaymentId,
        `corr-p02-fixture-${String(index)}-000001`,
      );

      pendingPaymentId = await fixtureInsertPayment(client, merchant, {
        requestedAmountMinor: 2_500n,
      });

      await client.query('BEGIN');
      authorizeOperationId = await fixtureInsertOperation(client, merchant, pendingPaymentId, {
        type: 'AUTHORIZE',
        amountMinor: 2_500n,
      });
      await fixtureSyncPayment(client, pendingPaymentId);
      await client.query('COMMIT');

      await insertIdempotency(
        client,
        merchant,
        'AUTHORIZE',
        `fixture-authorize-${String(index)}-00000`,
        'PAYMENT_OPERATION',
        authorizeOperationId,
        `corr-p02-fixture-${String(index)}-000002`,
      );

      await client.query(
        `INSERT INTO messaging.inbox_messages
           (consumer_name, envelope_id, message_type, merchant_id, envelope_hash)
         VALUES ('payment-worker', gen_random_uuid(), 'payment.created.v1', $1,
                 sha256(convert_to($2, 'UTF8')))`,
        [merchant.merchantId, `inbox-${String(index)}`],
      );

      const deadLetter = await client.query<{ id: string }>(
        `INSERT INTO messaging.dead_letter_records
           (consumer_name, subscription_name, envelope_id, envelope, envelope_hash, merchant_id,
            correlation_id, failure_class, attempt_count, error_detail, first_failed_at, last_failed_at)
         VALUES ('payment-worker', 'payment-worker-sub', gen_random_uuid(),
                 jsonb_build_object('note', 'fixture'), sha256(convert_to($1, 'UTF8')), $2, $3,
                 'RETRY_EXHAUSTED', 5, '{"code":"TIMEOUT"}'::jsonb, clock_timestamp(), clock_timestamp())
         RETURNING id`,
        [`dlq-${String(index)}`, merchant.merchantId, `corr-p02-fixture-${String(index)}-000003`],
      );
      await client.query(
        `INSERT INTO messaging.dead_letter_replays (dead_letter_id, actor_id, reason, outcome)
         VALUES ($1, 'operator-fixture', 'fixture replay', 'PUBLISHED')`,
        [Number(deadLetter.rows[0]?.id)],
      );
    } finally {
      client.release();
    }

    outboxIds.push(
      await insertOutbox(
        pool,
        paymentCreatedEnvelope({
          merchantId: merchant.merchantId,
          paymentId: createdPaymentId,
          providerAccountId: merchant.providerAccountId,
          amountMinor: 5_000n,
          feePolicyVersion: merchant.feePolicyVersion,
        }),
      ),
      await insertOutbox(
        pool,
        executeCommandEnvelope({
          merchantId: merchant.merchantId,
          paymentId: pendingPaymentId,
          operationId: authorizeOperationId,
          expectedPaymentVersion: 2,
        }),
      ),
    );
  }

  return { merchants, outboxIds };
}
