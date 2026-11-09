/**
 * `messaging.insert_outbox` — the only way a row enters the outbox.
 *
 * Each negative case starts from a *schema-valid* envelope built through `buildEnvelope` and changes
 * exactly one thing, so a rejection is provably the database check under test rather than a fixture
 * defect. Every case asserts `detail.reason`, not merely that something failed: a test that accepts any
 * error would pass if the wrong check fired.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { DomainError, LOGIN_RUNTIME_ROLES } from '@flowledger/database';
import { newId } from '@flowledger/domain';
import {
  createTestMerchant,
  disposeTestDatabase,
  executeCommandEnvelope,
  fixtureInsertOperation,
  fixtureInsertPayment,
  fixtureSyncPayment,
  ledgerPostedEnvelope,
  paymentCreatedEnvelope,
  setTestConnection,
  settlementPostedEnvelope,
  useTestDatabase,
  webhookDeliverEnvelope,
  withRole,
  type TestDatabase,
  type TestMerchant,
} from '@flowledger/testkit';

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

let database: TestDatabase;
let merchant: TestMerchant;
let other: TestMerchant;

beforeAll(async () => {
  database = await useTestDatabase()();
  merchant = await createTestMerchant(database.ownerPool);
  other = await createTestMerchant(database.ownerPool);
});

afterAll(async () => {
  if (database !== undefined) await disposeTestDatabase(database);
});

/** Calls the function as the role that is allowed to publish. */
async function insert(envelope: unknown): Promise<string> {
  const payload = JSON.stringify(envelope);
  return withRole(database.ownerPool, 'payments_function_owner', async (client) => {
    const { rows } = await client.query<{ envelope_id: string }>(
      'SELECT messaging.insert_outbox($1::jsonb) AS envelope_id',
      [payload],
    );
    return rows[0]?.envelope_id as string;
  });
}

/** Expects `INVALID_ENVELOPE` carrying exactly this reason. */
async function expectReason(envelope: unknown, reason: string): Promise<void> {
  const error = await insert(envelope).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DomainError);
  const domain = error as DomainError;
  expect(domain.code).toBe('INVALID_ENVELOPE');
  expect(domain.detail).toMatchObject({ reason });
}

function mutate(
  envelope: object,
  change: (draft: Record<string, unknown>) => void,
): Record<string, unknown> {
  const draft = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
  change(draft);
  return draft;
}

async function paymentFor(m: TestMerchant, amount = 1_000n): Promise<string> {
  const client = await database.ownerPool.connect();
  try {
    return await fixtureInsertPayment(client, m, { requestedAmountMinor: amount });
  } finally {
    client.release();
  }
}

describe('acceptance', () => {
  it('stores every relational column equal to its envelope field', async () => {
    const paymentId = await paymentFor(merchant);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });

    const stored = await insert(envelope);

    const { rows } = await database.ownerPool.query<Record<string, string>>(
      `SELECT envelope_id::text, kind, message_type, schema_version::text, source, merchant_id,
              aggregate_type, aggregate_id, aggregate_version::text, ordering_key, correlation_id,
              causation_id, octet_length(envelope_hash)::text AS hash_length,
              (envelope->>'id') AS envelope_id_copy
         FROM messaging.outbox_messages WHERE envelope_id = $1`,
      [stored],
    );

    expect(rows[0]).toEqual({
      envelope_id: envelope.id,
      kind: envelope.kind,
      message_type: envelope.type,
      schema_version: '1',
      source: envelope.source,
      merchant_id: envelope.merchantId,
      aggregate_type: envelope.aggregateType,
      aggregate_id: envelope.aggregateId,
      aggregate_version: String(envelope.aggregateVersion),
      ordering_key: envelope.orderingKey,
      correlation_id: envelope.correlationId,
      causation_id: envelope.causationId,
      hash_length: '32',
      envelope_id_copy: envelope.id,
    });
  });

  it('accepts an execution command whose operation belongs to its payment', async () => {
    const paymentId = await paymentFor(merchant);
    const client = await database.ownerPool.connect();
    let operationId: string;
    try {
      await client.query('BEGIN');
      operationId = await fixtureInsertOperation(client, merchant, paymentId, {
        type: 'AUTHORIZE',
        amountMinor: 100n,
      });
      await fixtureSyncPayment(client, paymentId);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const envelope = executeCommandEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      operationId,
      expectedPaymentVersion: 1,
    });
    await expect(insert(envelope)).resolves.toBe(envelope.id);
  });

  it.each<[string, () => Promise<object>]>([
    [
      'ledger.transaction.posted.v1',
      async () => {
        const paymentId = await paymentFor(merchant);
        const client = await database.ownerPool.connect();
        let operationId: string;
        try {
          await client.query('BEGIN');
          operationId = await fixtureInsertOperation(client, merchant, paymentId, {
            type: 'AUTHORIZE',
            amountMinor: 100n,
          });
          await fixtureSyncPayment(client, paymentId);
          await client.query('COMMIT');
        } finally {
          client.release();
        }
        return ledgerPostedEnvelope({
          merchantId: merchant.merchantId,
          ledgerTransactionId: newId('ltx'),
          paymentId,
          paymentOperationId: operationId,
        });
      },
    ],
    [
      'merchant.webhook.deliver.v1',
      async () =>
        webhookDeliverEnvelope({
          merchantId: merchant.merchantId,
          deliveryId: newId('whd'),
          endpointId: newId('whe'),
          domainEventId: randomUUID(),
        }),
    ],
    [
      'settlement.batch.posted.v1',
      async () =>
        settlementPostedEnvelope({
          merchantId: merchant.merchantId,
          settlementBatchId: newId('sbt'),
        }),
    ],
  ])('accepts %s', async (_type, build) => {
    const envelope = await build();
    await expect(insert(envelope)).resolves.toBe((envelope as { id: string }).id);
  });

  it('stores an upper-case envelope ID lower-cased', async () => {
    const paymentId = await paymentFor(merchant);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
      envelopeId: 'ABCDEF01-2345-4678-89AB-CDEF01234567',
    });

    const stored = await insert(
      mutate(envelope, (draft) => {
        draft.id = 'ABCDEF01-2345-4678-89AB-CDEF01234567';
      }),
    );
    expect(stored).toBe('abcdef01-2345-4678-89ab-cdef01234567');

    const { rows } = await database.ownerPool.query<{ envelope_id_copy: string }>(
      "SELECT envelope->>'id' AS envelope_id_copy FROM messaging.outbox_messages WHERE envelope_id = $1",
      [stored],
    );
    expect(rows[0]?.envelope_id_copy).toBe('abcdef01-2345-4678-89ab-cdef01234567');
  });

  it('rejects a duplicate envelope ID rather than ignoring it', async () => {
    const paymentId = await paymentFor(merchant);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    await insert(envelope);

    const error = await insert(envelope).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('outbox_messages_pkey');
  });
});

describe('rejections', () => {
  it('rejects a non-object', async () => {
    await expectReason([{ id: 'x' }], 'NOT_OBJECT');
  });

  it('rejects an unknown field', async () => {
    const paymentId = await paymentFor(merchant);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    await expectReason(
      mutate(envelope, (draft) => {
        draft.foo = 'bar';
      }),
      'UNKNOWN_FIELD',
    );
  });

  it('rejects a missing causationId', async () => {
    const paymentId = await paymentFor(merchant);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    await expectReason(
      mutate(envelope, (draft) => {
        delete draft.causationId;
      }),
      'MISSING_FIELD',
    );
  });

  it.each<[string, (draft: Record<string, unknown>) => void]>([
    [
      'a malformed id',
      (draft) => {
        draft.id = 'not-a-uuid';
      },
    ],
    [
      'a malformed occurredAt',
      (draft) => {
        draft.occurredAt = '2026-01-01 00:00:00';
      },
    ],
    [
      'a source without the flowledger prefix',
      (draft) => {
        draft.source = 'payment-worker';
      },
    ],
    [
      'a merchantId with the wrong prefix',
      (draft) => {
        draft.merchantId = `pay_${'A'.repeat(26)}`;
      },
    ],
    [
      'a string schemaVersion',
      (draft) => {
        draft.schemaVersion = '1';
      },
    ],
  ])('rejects %s', async (_label, change) => {
    const paymentId = await paymentFor(merchant);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    await expectReason(mutate(envelope, change), 'INVALID_FIELD_FORMAT');
  });

  it('rejects an unregistered type', async () => {
    const paymentId = await paymentFor(merchant);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    await expectReason(
      mutate(envelope, (draft) => {
        draft.type = 'payment.created.v2';
      }),
      'UNREGISTERED_TYPE',
    );
  });

  it('rejects a kind that disagrees with the registry', async () => {
    const paymentId = await paymentFor(merchant);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    await expectReason(
      mutate(envelope, (draft) => {
        draft.kind = 'COMMAND';
      }),
      'KIND_MISMATCH',
    );
  });

  it('rejects a schema version that disagrees with the registered version', async () => {
    const paymentId = await paymentFor(merchant);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    await expectReason(
      mutate(envelope, (draft) => {
        draft.schemaVersion = 2;
      }),
      'SCHEMA_VERSION_MISMATCH',
    );
  });

  it('rejects an aggregate type that disagrees with the registry', async () => {
    const paymentId = await paymentFor(merchant);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    await expectReason(
      mutate(envelope, (draft) => {
        draft.aggregateType = 'payment_operation';
      }),
      'AGGREGATE_TYPE_MISMATCH',
    );
  });

  it('rejects an aggregateId that disagrees with the payload', async () => {
    const paymentId = await paymentFor(merchant);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    await expectReason(
      mutate(envelope, (draft) => {
        const aggregateId = newId('pay');
        draft.aggregateId = aggregateId;
        draft.orderingKey = aggregateId;
      }),
      'AGGREGATE_ID_MISMATCH',
    );
  });

  it('rejects an orderingKey that disagrees with the payload', async () => {
    const paymentId = await paymentFor(merchant);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    await expectReason(
      mutate(envelope, (draft) => {
        draft.orderingKey = newId('pay');
      }),
      'ORDERING_KEY_MISMATCH',
    );
  });

  it('rejects an execution command whose version is not the expected payment version', async () => {
    const paymentId = await paymentFor(merchant);
    const client = await database.ownerPool.connect();
    let operationId: string;
    try {
      await client.query('BEGIN');
      operationId = await fixtureInsertOperation(client, merchant, paymentId, {
        type: 'AUTHORIZE',
        amountMinor: 100n,
      });
      await fixtureSyncPayment(client, paymentId);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const envelope = executeCommandEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      operationId,
      expectedPaymentVersion: 1,
    });
    await expectReason(
      mutate(envelope, (draft) => {
        draft.aggregateVersion = 2;
      }),
      'AGGREGATE_VERSION_MISMATCH',
    );
  });

  it('rejects a nonexistent payment', async () => {
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId: newId('pay'),
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    await expectReason(envelope, 'SUBJECT_NOT_FOUND');
  });

  it('rejects a payment owned by another merchant', async () => {
    const foreignPayment = await paymentFor(other);
    const envelope = paymentCreatedEnvelope({
      merchantId: merchant.merchantId,
      paymentId: foreignPayment,
      providerAccountId: merchant.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    await expectReason(envelope, 'SUBJECT_NOT_FOUND');
  });

  it('rejects an operation belonging to another payment', async () => {
    const paymentId = await paymentFor(merchant);
    const otherPayment = await paymentFor(merchant);
    const client = await database.ownerPool.connect();
    let foreignOperation: string;
    try {
      await client.query('BEGIN');
      foreignOperation = await fixtureInsertOperation(client, merchant, otherPayment, {
        type: 'AUTHORIZE',
        amountMinor: 100n,
      });
      await fixtureSyncPayment(client, otherPayment);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const envelope = executeCommandEnvelope({
      merchantId: merchant.merchantId,
      paymentId,
      operationId: foreignOperation,
      expectedPaymentVersion: 1,
    });
    await expectReason(envelope, 'SUBJECT_NOT_FOUND');
  });

  it('rejects a ledger aggregate that disagrees with the payload', async () => {
    const paymentId = await paymentFor(merchant);
    const client = await database.ownerPool.connect();
    let operationId: string;
    try {
      await client.query('BEGIN');
      operationId = await fixtureInsertOperation(client, merchant, paymentId, {
        type: 'AUTHORIZE',
        amountMinor: 100n,
      });
      await fixtureSyncPayment(client, paymentId);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const envelope = ledgerPostedEnvelope({
      merchantId: merchant.merchantId,
      ledgerTransactionId: newId('ltx'),
      paymentId,
      paymentOperationId: operationId,
    });
    await expectReason(
      mutate(envelope, (draft) => {
        draft.aggregateId = newId('ltx');
      }),
      'AGGREGATE_ID_MISMATCH',
    );
  });

  it('rejects a webhook ordering key that is not the endpoint', async () => {
    const envelope = webhookDeliverEnvelope({
      merchantId: merchant.merchantId,
      deliveryId: newId('whd'),
      endpointId: newId('whe'),
      domainEventId: randomUUID(),
    });
    await expectReason(
      mutate(envelope, (draft) => {
        draft.orderingKey = newId('whe');
      }),
      'ORDERING_KEY_MISMATCH',
    );
  });

  it.each<[string, (draft: Record<string, unknown>) => void, string]>([
    [
      'a settlement ordering key that is not the merchant',
      (draft) => {
        draft.orderingKey = newId('mer');
      },
      'ORDERING_KEY_MISMATCH',
    ],
    [
      'a settlement aggregate version other than 1',
      (draft) => {
        draft.aggregateVersion = 2;
      },
      'AGGREGATE_VERSION_MISMATCH',
    ],
    [
      'a settlement posting key that is not settlement:<id>',
      (draft) => {
        (draft.data as Record<string, unknown>).postingKey =
          'capture:ltx_01ARZ3NDEKTSV4RRFFQ69G5FAA';
      },
      'POSTING_KEY_MISMATCH',
    ],
  ])('rejects %s', async (_label, change, reason) => {
    const envelope = settlementPostedEnvelope({
      merchantId: merchant.merchantId,
      settlementBatchId: newId('sbt'),
    });
    await expectReason(mutate(envelope, change), reason);
  });
});

describe('atomicity', () => {
  it('leaves nothing committed when a rejected call aborts the transaction', async () => {
    // A merchant of its own, so the count cannot include rows other cases committed.
    const isolated = await createTestMerchant(database.ownerPool);
    const paymentId = await paymentFor(isolated);
    const valid = paymentCreatedEnvelope({
      merchantId: isolated.merchantId,
      paymentId,
      providerAccountId: isolated.providerAccountId,
      amountMinor: 1_000n,
      feePolicyVersion: 1,
    });
    const invalid = mutate(valid, (draft) => {
      draft.orderingKey = newId('pay');
    });

    const error = await withRole(database.ownerPool, 'payments_function_owner', async (client) => {
      await client.query('BEGIN');
      await client.query('SELECT messaging.insert_outbox($1::jsonb)', [JSON.stringify(valid)]);
      const thrown = await client
        .query('SELECT messaging.insert_outbox($1::jsonb)', [JSON.stringify(invalid)])
        .catch((caught: unknown) => caught);
      await client.query('ROLLBACK');
      return thrown;
    });

    // The error was caught inside the transaction, so it is still the raw SQLSTATE form: the detail is
    // the JSON text `fl_raise_domain` attached.
    const detail = JSON.parse(String((error as { detail?: string }).detail)) as { reason: string };
    expect(detail.reason).toBe('ORDERING_KEY_MISMATCH');

    const { rows } = await database.ownerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM messaging.outbox_messages WHERE merchant_id = $1',
      [isolated.merchantId],
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('privileges', () => {
  it('lets no runtime role execute or insert directly', async () => {
    for (const role of LOGIN_RUNTIME_ROLES) {
      const client = await database.poolAs(role).connect();
      try {
        const execute = await client
          .query("SELECT messaging.insert_outbox('{}'::jsonb)")
          .catch((caught: unknown) => caught);
        expect((execute as { code?: string }).code, `${role} execute`).toBe('42501');

        const direct = await client
          .query(
            `INSERT INTO messaging.outbox_messages (envelope_id, kind, message_type, schema_version,
               source, merchant_id, aggregate_type, aggregate_id, aggregate_version, ordering_key,
               correlation_id, causation_id, occurred_at, envelope_hash)
             VALUES (gen_random_uuid(), 'EVENT', 'payment.created.v1', 1, 'flowledger.x',
                     '${merchant.merchantId}', 'payment', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAA', 1,
                     'pay_01ARZ3NDEKTSV4RRFFQ69G5FAA', 'corr-insert-00000001',
                     'req_01ARZ3NDEKTSV4RRFFQ69G5FAA', clock_timestamp(), '\\x00')`,
          )
          .catch((caught: unknown) => caught);
        expect((direct as { code?: string }).code, `${role} insert`).toBe('42501');
      } finally {
        client.release();
      }
    }
  });

  it('is SECURITY DEFINER with a pinned search_path, and grants nothing to PUBLIC', async () => {
    const { rows } = await database.ownerPool.query<{
      prosecdef: boolean;
      proconfig: string[] | null;
      public_execute: boolean;
    }>(
      `SELECT p.prosecdef, p.proconfig,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'messaging' AND p.proname = 'insert_outbox'`,
    );

    expect(rows[0]?.prosecdef).toBe(true);
    expect(rows[0]?.proconfig).toContain('search_path=pg_catalog, pg_temp');
    expect(rows[0]?.public_execute).toBe(false);
  });
});
