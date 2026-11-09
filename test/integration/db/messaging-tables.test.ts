/**
 * Messaging persistence: registry parity, envelope derivation, immutability, and tenant safety.
 *
 * The two most important properties here are that the outbox's repeated envelope columns can never
 * diverge from the envelope itself, and that publication identity survives the hot body being archived
 * away. Both are proven twice — by a trigger that refuses the update, and by a CHECK that would reject
 * the resulting row even with the trigger disabled.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { DomainError, LOGIN_RUNTIME_ROLES, withTransaction } from '@flowledger/database';
import {
  assertConstraintCoverage,
  createTestMerchant,
  disposeTestDatabase,
  fixtureInsertPayment,
  setTestConnection,
  useTestDatabase,
  type TestDatabase,
  type TestMerchant,
} from '@flowledger/testkit';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

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

const HASH = createHash('sha256').update('envelope').digest();

function envelopeFor(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    // Unique per call: the outbox PK is the envelope id, and several cases insert without overriding it.
    id: randomUUID(),
    kind: 'EVENT',
    type: 'payment.created.v1',
    schemaVersion: 1,
    source: 'payment-worker',
    merchantId: merchant.merchantId,
    aggregateType: 'payment',
    aggregateId: 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAA',
    aggregateVersion: 1,
    orderingKey: 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAA',
    correlationId: 'corr-messaging-000001',
    causationId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAA',
    occurredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The outbox row an envelope implies, so each negative case changes exactly one field. */
function outboxRow(
  envelope: Record<string, unknown> = envelopeFor(),
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    envelope_id: envelope.id,
    kind: envelope.kind,
    message_type: envelope.type,
    schema_version: envelope.schemaVersion,
    source: envelope.source,
    merchant_id: envelope.merchantId,
    aggregate_type: envelope.aggregateType,
    aggregate_id: envelope.aggregateId,
    aggregate_version: envelope.aggregateVersion,
    ordering_key: envelope.orderingKey,
    correlation_id: envelope.correlationId,
    causation_id: envelope.causationId,
    occurred_at: envelope.occurredAt,
    envelope: JSON.stringify(envelope),
    envelope_hash: HASH,
    ...overrides,
  };
}

const OUTBOX_COLUMNS = [
  'envelope_id',
  'kind',
  'message_type',
  'schema_version',
  'source',
  'merchant_id',
  'aggregate_type',
  'aggregate_id',
  'aggregate_version',
  'ordering_key',
  'correlation_id',
  'causation_id',
  'occurred_at',
  'envelope',
  'envelope_hash',
  'archived_envelope_reference',
  'available_at',
  'lease_token',
  'lease_expires_at',
  'publication_attempts',
  'published_at',
  'broker_message_id',
  'last_error_class',
] as const;

async function insertOutbox(row: Record<string, unknown> = outboxRow()): Promise<void> {
  const columns: string[] = OUTBOX_COLUMNS.filter((column) => row[column] !== undefined);
  if (row.recorded_at !== undefined) columns.push('recorded_at');
  const placeholders = columns.map((_unused, index) => `$${String(index + 1)}`);
  await database.ownerPool.query(
    `INSERT INTO messaging.outbox_messages (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    columns.map((column) => row[column]),
  );
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

describe('message type registry', () => {
  it('equals schemas/registry.v1.json exactly, including each aggregate type', async () => {
    const registry = JSON.parse(
      readFileSync(join(repoRoot, 'schemas', 'registry.v1.json'), 'utf8'),
    ) as { messages?: { type: string; kind: string; schema: string }[] };

    const entries = registry.messages ?? [];

    const expected = entries.map((entry) => {
      const type = entry.type;
      const schema = JSON.parse(readFileSync(join(repoRoot, 'schemas', entry.schema), 'utf8')) as {
        allOf?: { properties?: { aggregateType?: { const?: string } } }[];
      };
      const aggregateType = schema.allOf?.[1]?.properties?.aggregateType?.const;
      return [type, entry.kind, entry.schema, aggregateType];
    });

    const { rows } = await database.ownerPool.query<{
      message_type: string;
      kind: string;
      schema_path: string;
      aggregate_type: string;
    }>('SELECT message_type, kind, schema_path, aggregate_type FROM messaging.message_types');

    expect(
      rows.map((row) => [row.message_type, row.kind, row.schema_path, row.aggregate_type]),
    ).toEqual(expected);
  });

  it('refuses update, delete, and truncate', async () => {
    for (const sql of [
      "UPDATE messaging.message_types SET kind = 'EVENT' WHERE message_type = 'payment.created.v1'",
      "DELETE FROM messaging.message_types WHERE message_type = 'payment.created.v1'",
    ]) {
      const result = await runMapped(sql);
      expect(
        ((result as { error?: DomainError }).error as DomainError).code,
        sql.slice(0, 20),
      ).toBe('IMMUTABLE_ROW');
    }

    // The outbox references this table, so PostgreSQL refuses the truncate itself (0A000) before the
    // guard trigger is reached — an earlier and stronger refusal.
    const truncated = await runMapped('TRUNCATE messaging.message_types');
    expect((truncated as { error?: { code?: string } }).error?.code).toBe('0A000');
  });

  it('rejects a schema version that disagrees with the type suffix', async () => {
    const error = await database.ownerPool
      .query(
        `INSERT INTO messaging.message_types VALUES ('test.type.v2', 'EVENT', 1, 'payment', 'x.json')`,
      )
      .catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('message_types_schema_version');
  });
});

describe('outbox envelope derivation', () => {
  it.each<[string, Record<string, unknown>]>([
    ['envelope_id', { envelope_id: '11111111-1111-4111-8111-111111111111' }],
    ['kind', { kind: 'COMMAND' }],
    ['message_type', { message_type: 'payment.authorization.requested.v1' }],
    ['schema_version', { schema_version: 2 }],
    ['source', { source: 'other' }],
    ['merchant_id', { merchant_id: 'mer_UNKNOWN' }],
    ['aggregate_type', { aggregate_type: 'payment_operation' }],
    ['aggregate_id', { aggregate_id: 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAB' }],
    ['aggregate_version', { aggregate_version: 2 }],
    ['ordering_key', { ordering_key: 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAC' }],
    ['correlation_id', { correlation_id: 'corr-messaging-000002' }],
    ['causation_id', { causation_id: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAB' }],
    ['occurred_at', { occurred_at: '2026-01-01T00:00:01.000Z' }],
  ])('rejects a %s that disagrees with the envelope', async (column, override) => {
    const error = await insertOutbox(outboxRow(envelopeFor(), override)).catch(
      (caught: unknown) => caught,
    );
    const constraint = (error as { constraint?: string }).constraint;
    // A diverging merchant fails the FK first; every other case is the derivation proof.
    expect(['outbox_messages_envelope_derivation', 'outbox_messages_merchant_fkey']).toContain(
      constraint,
    );
    if (column !== 'merchant_id') {
      expect(constraint).toBe('outbox_messages_envelope_derivation');
    }
  });

  it('accepts the row its envelope implies', async () => {
    await expect(insertOutbox()).resolves.toBeUndefined();
  });

  it('rejects an unregistered message type', async () => {
    const error = await insertOutbox(
      outboxRow(envelopeFor({ type: 'payment.unregistered.v1' }), {
        message_type: 'payment.unregistered.v1',
      }),
    ).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('outbox_messages_message_type_fkey');
  });

  it('rejects an occurredAt without an explicit offset, so the comparison is TimeZone-free', async () => {
    const envelope = envelopeFor({ occurredAt: '2026-01-01T00:00:00.000' });
    const error = await insertOutbox(
      outboxRow(envelope, { occurred_at: '2026-01-01T00:00:00.000Z' }),
    ).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'outbox_messages_envelope_derivation',
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['kind', { kind: 'COMMAND' }],
    ['aggregateType', { aggregateType: 'ledger_transaction' }],
  ])(
    'rejects a row whose %s agrees with its envelope but not with the registry',
    async (_field, override) => {
      // Envelope and columns agree, so only the registry foreign key can refuse it.
      const envelope = envelopeFor(override);
      const error = await insertOutbox(outboxRow(envelope)).catch((caught: unknown) => caught);
      expect((error as { constraint?: string }).constraint).toBe('outbox_messages_registry_fkey');
    },
  );

  it('rejects an envelope of the wrong JSON type', async () => {
    const error = await insertOutbox(
      outboxRow(envelopeFor(), { envelope: JSON.stringify(['not', 'an', 'object']) }),
    ).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'outbox_messages_envelope_derivation',
    );
  });
});

describe('outbox constraints', () => {
  it.each<[string, Record<string, unknown>]>([
    ['outbox_messages_envelope_hash', { envelope_hash: Buffer.alloc(31, 1) }],
    ['outbox_messages_aggregate_version', { aggregate_version: 0 }],
    ['outbox_messages_publication_attempts', { publication_attempts: -1 }],
    ['outbox_messages_lease_pair', { lease_token: '0f8fad5b-d9cb-469f-a165-70867728950e' }],
    ['outbox_messages_archive_state', { envelope: null }],
  ])('rejects %s', async (constraint, override) => {
    // Built inside the body: `merchant` does not exist while the table above is evaluated.
    const error = await insertOutbox(outboxRow(envelopeFor(), override)).catch(
      (caught: unknown) => caught,
    );
    expect((error as { constraint?: string }).constraint).toBe(constraint);
  });

  it('rejects a kind outside the contract', async () => {
    const error = await insertOutbox(
      outboxRow(envelopeFor({ kind: 'NOTICE' }), { kind: 'NOTICE' }),
    ).catch((caught: unknown) => caught);
    // The derivation proof is satisfied by the matching envelope; the kind CHECK is what refuses it.
    expect((error as { constraint?: string }).constraint).toBe('outbox_messages_kind');
  });

  it('rejects a schema version that disagrees with the type suffix', async () => {
    // The envelope is dropped so the derivation proof cannot fire first.
    const error = await insertOutbox(
      outboxRow(envelopeFor(), {
        envelope: null,
        archived_envelope_reference: 's3://archive/x.json',
        published_at: new Date(),
        schema_version: 2,
      }),
    ).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('outbox_messages_schema_version');
  });
});

describe('outbox guard', () => {
  it('refuses to change any identity column', async () => {
    const row = outboxRow();
    await insertOutbox(row);

    const error = await runMapped(
      'UPDATE messaging.outbox_messages SET merchant_id = $1 WHERE envelope_id = $2',
      [other.merchantId, row.envelope_id],
    );
    const domain = (error as { error?: DomainError }).error as DomainError;
    expect(domain.code).toBe('IMMUTABLE_FIELD');
    expect(domain.detail).toMatchObject({ column: 'merchant_id' });
  });

  it('rejects the same divergence with the guard disabled, via the CHECK', async () => {
    const row = outboxRow(envelopeFor({ id: '22222222-2222-4222-8222-222222222222' }));
    await insertOutbox(row);

    const client = await database.ownerPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'ALTER TABLE messaging.outbox_messages DISABLE TRIGGER outbox_messages_guard',
      );
      const error = await client
        .query('UPDATE messaging.outbox_messages SET merchant_id = $1 WHERE envelope_id = $2', [
          other.merchantId,
          row.envelope_id,
        ])
        .catch((caught: unknown) => caught);
      await client.query('ROLLBACK');

      expect((error as { constraint?: string }).constraint).toBe(
        'outbox_messages_envelope_derivation',
      );
    } finally {
      client.release();
    }
  });

  it('refuses to clear the envelope before publication', async () => {
    const row = outboxRow(envelopeFor({ id: '33333333-3333-4333-8333-333333333333' }));
    await insertOutbox(row);

    const error = await runMapped(
      'UPDATE messaging.outbox_messages SET envelope = NULL WHERE envelope_id = $1',
      [row.envelope_id],
    );
    const domain = (error as { error?: DomainError }).error as DomainError;
    expect(domain.code).toBe('INVALID_TRANSITION');
    expect(domain.detail).toMatchObject({ reason: 'ENVELOPE_CLEARED_BEFORE_ARCHIVE' });
  });

  it('allows clearing the envelope once published and archived', async () => {
    const row = outboxRow(envelopeFor({ id: '44444444-4444-4444-8444-444444444444' }));
    await insertOutbox(row);

    await expect(
      runMapped(
        `UPDATE messaging.outbox_messages
            SET archived_envelope_reference = 's3://archive/4444.json',
                published_at = clock_timestamp(),
                envelope = NULL
          WHERE envelope_id = $1`,
        [row.envelope_id],
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('refuses to decrease publication attempts', async () => {
    const row = outboxRow(envelopeFor({ id: '55555555-5555-4555-8555-555555555555' }));
    await insertOutbox({ ...row, publication_attempts: 3 });

    const error = await runMapped(
      'UPDATE messaging.outbox_messages SET publication_attempts = 2 WHERE envelope_id = $1',
      [row.envelope_id],
    );
    const domain = (error as { error?: DomainError }).error as DomainError;
    expect(domain.code).toBe('INVALID_TRANSITION');
    expect(domain.detail).toMatchObject({ reason: 'ATTEMPTS_DECREASED' });
  });

  it('allows a lease claim and refuses delete or truncate', async () => {
    const row = outboxRow(envelopeFor({ id: '66666666-6666-4666-8666-666666666666' }));
    await insertOutbox(row);

    await expect(
      runMapped(
        `UPDATE messaging.outbox_messages
            SET lease_token = '77777777-7777-4777-8777-777777777777',
                lease_expires_at = clock_timestamp() + interval '30 seconds',
                publication_attempts = publication_attempts + 1
          WHERE envelope_id = $1`,
        [row.envelope_id],
      ),
    ).resolves.toEqual({ ok: true });

    const deleted = await runMapped(
      'DELETE FROM messaging.outbox_messages WHERE envelope_id = $1',
      [row.envelope_id],
    );
    expect(((deleted as { error?: DomainError }).error as DomainError).code).toBe('IMMUTABLE_ROW');

    const truncated = await runMapped('TRUNCATE messaging.outbox_messages');
    expect(((truncated as { error?: DomainError }).error as DomainError).code).toBe(
      'IMMUTABLE_ROW',
    );
  });
});

describe('inbox', () => {
  async function insertInbox(overrides: Readonly<Record<string, unknown>> = {}): Promise<void> {
    await database.ownerPool.query(
      `INSERT INTO messaging.inbox_messages
         (consumer_name, envelope_id, message_type, merchant_id, envelope_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        overrides.consumer_name ?? 'payment-worker',
        overrides.envelope_id ?? '88888888-8888-4888-8888-888888888888',
        overrides.message_type ?? 'payment.created.v1',
        overrides.merchant_id ?? merchant.merchantId,
        overrides.envelope_hash ?? HASH,
      ],
    );
  }

  it('is insert-only', async () => {
    await insertInbox();
    for (const sql of [
      "UPDATE messaging.inbox_messages SET result_reference = 'x'",
      'DELETE FROM messaging.inbox_messages',
      'TRUNCATE messaging.inbox_messages',
    ]) {
      const result = await runMapped(sql);
      expect(
        ((result as { error?: DomainError }).error as DomainError).code,
        sql.slice(0, 20),
      ).toBe('IMMUTABLE_ROW');
    }
  });

  it('rejects a duplicate consumer/envelope pair and a bad consumer name', async () => {
    const duplicate = await insertInbox({
      envelope_id: '99999999-9999-4999-8999-999999999999',
    }).catch((caught: unknown) => caught);
    expect(duplicate).toBeUndefined();

    const again = await insertInbox({ envelope_id: '99999999-9999-4999-8999-999999999999' }).catch(
      (caught: unknown) => caught,
    );
    expect((again as { constraint?: string }).constraint).toBe('inbox_messages_pkey');

    const badName = await insertInbox({
      consumer_name: 'Bad Name',
      envelope_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }).catch((caught: unknown) => caught);
    expect((badName as { constraint?: string }).constraint).toBe('inbox_messages_consumer_name');
  });
});

describe('dead letters', () => {
  const DLQ_COLUMNS = [
    'consumer_name',
    'subscription_name',
    'envelope_id',
    'envelope',
    'envelope_hash',
    'merchant_id',
    'payment_id',
    'operation_id',
    'correlation_id',
    'traceparent',
    'failure_class',
    'attempt_count',
    'error_detail',
    'first_failed_at',
    'last_failed_at',
    'archived_envelope_reference',
  ] as const;

  async function insertDlq(overrides: Readonly<Record<string, unknown>> = {}): Promise<number> {
    const row: Record<string, unknown> = {
      consumer_name: 'payment-worker',
      subscription_name: 'payment-worker-sub',
      envelope_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      envelope: JSON.stringify(envelopeFor()),
      envelope_hash: HASH,
      merchant_id: merchant.merchantId,
      payment_id: null,
      operation_id: null,
      correlation_id: 'corr-deadletter-00001',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      failure_class: 'RETRY_EXHAUSTED',
      attempt_count: 5,
      error_detail: JSON.stringify({ code: 'TIMEOUT' }),
      first_failed_at: new Date(Date.now() - 1000),
      last_failed_at: new Date(),
      ...overrides,
    };
    const columns = DLQ_COLUMNS.filter((column) => row[column] !== undefined);
    const placeholders = columns.map((_unused, index) => `$${String(index + 1)}`);
    const { rows } = await database.ownerPool.query<{ id: string }>(
      `INSERT INTO messaging.dead_letter_records (${columns.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING id`,
      columns.map((column) => row[column]),
    );
    return Number(rows[0]?.id);
  }

  it('requires a merchant when a subject is named', async () => {
    const error = await insertDlq({
      merchant_id: null,
      payment_id: 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAA',
      envelope_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'dead_letter_records_subject_requires_merchant',
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['dead_letter_records_failure_class', { failure_class: 'OTHER' }],
    ['dead_letter_records_attempt_count', { attempt_count: 0 }],
    ['dead_letter_records_error_detail_object', { error_detail: JSON.stringify([]) }],
    ['dead_letter_records_envelope_hash', { envelope_hash: Buffer.alloc(31, 2) }],
    ['dead_letter_records_archive_state', { envelope: null }],
    ['dead_letter_records_traceparent', { traceparent: 'not-a-traceparent' }],
  ])('rejects %s', async (constraint, override) => {
    const error = await insertDlq({
      envelope_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      ...override,
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(constraint);
  });

  it('keeps identity columns immutable and lets attempts grow', async () => {
    const id = await insertDlq({ envelope_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });

    const changed = await runMapped(
      'UPDATE messaging.dead_letter_records SET envelope_hash = $1 WHERE id = $2',
      [Buffer.alloc(32, 3), id],
    );
    const domain = (changed as { error?: DomainError }).error as DomainError;
    expect(domain.code).toBe('IMMUTABLE_FIELD');
    expect(domain.detail).toMatchObject({ column: 'envelope_hash' });

    await expect(
      runMapped(
        `UPDATE messaging.dead_letter_records
            SET attempt_count = 6, last_failed_at = clock_timestamp()
          WHERE id = $1`,
        [id],
      ),
    ).resolves.toEqual({ ok: true });

    const decreased = await runMapped(
      'UPDATE messaging.dead_letter_records SET attempt_count = 4 WHERE id = $1',
      [id],
    );
    expect(((decreased as { error?: DomainError }).error as DomainError).code).toBe(
      'INVALID_TRANSITION',
    );

    const deleted = await runMapped('DELETE FROM messaging.dead_letter_records WHERE id = $1', [
      id,
    ]);
    expect(((deleted as { error?: DomainError }).error as DomainError).code).toBe('IMMUTABLE_ROW');
  });

  it('rejects a duplicate consumer/envelope pair', async () => {
    const envelopeId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await insertDlq({ envelope_id: envelopeId });
    const error = await insertDlq({ envelope_id: envelopeId }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe(
      'dead_letter_records_consumer_envelope_key',
    );
  });

  it('rejects a payment belonging to another merchant', async () => {
    const client = await database.ownerPool.connect();
    let foreignPayment: string;
    try {
      foreignPayment = await fixtureInsertPayment(client, other, { requestedAmountMinor: 100n });
    } finally {
      client.release();
    }

    const error = await insertDlq({
      envelope_id: '12121212-1212-4212-8212-121212121212',
      payment_id: foreignPayment,
    }).catch((caught: unknown) => caught);
    expect((error as { constraint?: string }).constraint).toBe('dead_letter_records_payment_fkey');
  });
});

describe('dead letter replays', () => {
  it('requires an error class exactly when FAILED, and is append-only', async () => {
    const { rows } = await database.ownerPool.query<{ id: string }>(
      `INSERT INTO messaging.dead_letter_records
         (consumer_name, subscription_name, envelope_id, envelope, envelope_hash, correlation_id,
          failure_class, attempt_count, error_detail, first_failed_at, last_failed_at)
       VALUES ('payment-worker', 'sub', '13131313-1313-4313-8313-131313131313', '{}'::jsonb, $1,
               'corr-replay-00000001', 'RETRY_EXHAUSTED', 1, '{}'::jsonb,
               clock_timestamp(), clock_timestamp())
       RETURNING id`,
      [HASH],
    );
    const deadLetterId = Number(rows[0]?.id);

    const missing = await database.ownerPool
      .query(
        `INSERT INTO messaging.dead_letter_replays (dead_letter_id, actor_id, reason, outcome)
         VALUES ($1, 'op_01ARZ3NDEKTSV4RRFFQ69G5FAA', 'operator retry', 'FAILED')`,
        [deadLetterId],
      )
      .catch((caught: unknown) => caught);
    expect((missing as { constraint?: string }).constraint).toBe('dead_letter_replays_error_class');

    await expect(
      database.ownerPool.query(
        `INSERT INTO messaging.dead_letter_replays (dead_letter_id, actor_id, reason, outcome)
         VALUES ($1, 'op_01ARZ3NDEKTSV4RRFFQ69G5FAA', 'operator retry', 'PUBLISHED')`,
        [deadLetterId],
      ),
    ).resolves.toBeDefined();

    for (const sql of [
      "UPDATE messaging.dead_letter_replays SET outcome = 'SKIPPED_TERMINAL'",
      'DELETE FROM messaging.dead_letter_replays',
      'TRUNCATE messaging.dead_letter_replays',
    ]) {
      const result = await runMapped(sql);
      expect(
        ((result as { error?: DomainError }).error as DomainError).code,
        sql.slice(0, 20),
      ).toBe('IMMUTABLE_ROW');
    }
  });
});

describe('constraint coverage', () => {
  it('declares every constraint and index on all five tables', async () => {
    await assertConstraintCoverage(database.ownerPool, 'messaging.outbox_messages', [
      'outbox_messages_pkey',
      'outbox_messages_message_type_fkey',
      'outbox_messages_merchant_fkey',
      'outbox_messages_kind',
      'outbox_messages_schema_version',
      'outbox_messages_aggregate_version',
      'outbox_messages_publication_attempts',
      'outbox_messages_envelope_hash',
      'outbox_messages_lease_pair',
      'outbox_messages_archive_state',
      'outbox_messages_envelope_derivation',
      'outbox_messages_registry_fkey',
    ]);
    await assertConstraintCoverage(database.ownerPool, 'messaging.inbox_messages', [
      'inbox_messages_pkey',
      'inbox_messages_merchant_fkey',
      'inbox_messages_consumer_name',
      'inbox_messages_message_type_format',
      'inbox_messages_envelope_hash',
      'inbox_messages_processed_after_received',
    ]);
    await assertConstraintCoverage(database.ownerPool, 'messaging.dead_letter_records', [
      'dead_letter_records_pkey',
      'dead_letter_records_consumer_envelope_key',
      'dead_letter_records_merchant_fkey',
      'dead_letter_records_payment_fkey',
      'dead_letter_records_operation_fkey',
      'dead_letter_records_subject_requires_merchant',
      'dead_letter_records_failure_class',
      'dead_letter_records_attempt_count',
      'dead_letter_records_envelope_hash',
      'dead_letter_records_envelope_object',
      'dead_letter_records_error_detail_object',
      'dead_letter_records_archive_state',
      'dead_letter_records_failure_window',
      'dead_letter_records_traceparent',
    ]);
    await assertConstraintCoverage(database.ownerPool, 'messaging.dead_letter_replays', [
      'dead_letter_replays_pkey',
      'dead_letter_replays_dead_letter_fkey',
      'dead_letter_replays_outcome',
      'dead_letter_replays_actor',
      'dead_letter_replays_reason',
      'dead_letter_replays_error_class',
    ]);
    await assertConstraintCoverage(database.ownerPool, 'messaging.message_types', [
      'message_types_pkey',
      'message_types_type_format',
      'message_types_kind',
      'message_types_schema_version',
      'message_types_aggregate_type',
      'message_types_schema_path',
      'message_types_registry_key',
    ]);
  });
});

describe('privileges', () => {
  /**
   * Catalog checks for the full matrix, plus one executed probe per role.
   *
   * Executing all 300 statements is slower than the fixture teardown can tolerate, and an aborted
   * statement per privilege adds nothing the catalog does not already answer. The probe keeps the
   * check honest: the catalog is not merely asserted, it is confirmed by a real `42501`.
   */
  it('denies every runtime role every privilege on all five tables', async () => {
    const tables = [
      'messaging.message_types',
      'messaging.outbox_messages',
      'messaging.inbox_messages',
      'messaging.dead_letter_records',
      'messaging.dead_letter_replays',
    ];
    const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];

    for (const role of LOGIN_RUNTIME_ROLES) {
      for (const table of tables) {
        const { rows } = await database.ownerPool.query<{ granted: string }>(
          `SELECT count(*)::text AS granted
             FROM unnest($3::text[]) AS privilege
            WHERE has_table_privilege($1, $2, privilege)`,
          [role, table, privileges],
        );
        expect(rows[0]?.granted, `${role} on ${table}`).toBe('0');
      }

      const client = await database.poolAs(role).connect();
      try {
        const probe = await client
          .query('SELECT 1 FROM messaging.outbox_messages LIMIT 1')
          .catch((caught: unknown) => caught);
        expect((probe as { code?: string }).code, `${role} probe`).toBe('42501');
      } finally {
        client.release();
      }
    }
  });
});
