/**
 * Envelope builders for tests.
 *
 * Each one produces a *schema-valid* envelope through `buildEnvelope`, which validates against the
 * checked-in JSON Schema and the semantic rules. That matters for the negative tests: because the
 * starting envelope is known-good, a rejection from `messaging.insert_outbox` is provably the database
 * check under test and not a fixture defect.
 */
import { randomUUID } from 'node:crypto';

import { buildEnvelope } from '@flowledger/contracts';
import type { RegisteredEnvelope } from '@flowledger/contracts';

const SOURCE = 'flowledger.testkit';

function correlation(seed: string): string {
  return `corr-envelope-${seed}`.padEnd(24, '0').slice(0, 32);
}

function envelope(
  type: string,
  fields: Omit<Parameters<typeof buildEnvelope>[0], 'type' | 'source' | 'correlationId'>,
  seed: string,
): RegisteredEnvelope {
  return buildEnvelope({
    // The builder never invents an ID, so the fixture must supply one; tests that care override it.
    id: randomUUID(),
    type,
    source: SOURCE,
    correlationId: correlation(seed),
    ...fields,
  } as Parameters<typeof buildEnvelope>[0]);
}

export function paymentCreatedEnvelope(p: {
  merchantId: string;
  paymentId: string;
  providerAccountId: string;
  amountMinor: bigint;
  feePolicyVersion: number;
  envelopeId?: string;
  causationId?: string;
}): RegisteredEnvelope {
  return envelope(
    'payment.created.v1',
    {
      ...(p.envelopeId === undefined ? {} : { id: p.envelopeId }),
      kind: 'EVENT',
      schemaVersion: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z',
      merchantId: p.merchantId,
      aggregateType: 'payment',
      aggregateId: p.paymentId,
      aggregateVersion: 1,
      orderingKey: p.paymentId,
      causationId: p.causationId ?? 'req_01ARZ3NDEKTSV4RRFFQ69G5FAA',
      data: {
        paymentId: p.paymentId,
        requestedAmount: { amountMinor: p.amountMinor.toString(), currency: 'USD' },
        provider: 'fake-provider',
        providerAccountId: p.providerAccountId,
        feePolicyVersion: p.feePolicyVersion,
      },
    },
    'created',
  );
}

export function executeCommandEnvelope(p: {
  merchantId: string;
  paymentId: string;
  operationId: string;
  expectedPaymentVersion: number;
}): RegisteredEnvelope {
  return envelope(
    'payment.operation.execute.v1',
    {
      kind: 'COMMAND',
      schemaVersion: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z',
      merchantId: p.merchantId,
      aggregateType: 'payment',
      aggregateId: p.paymentId,
      aggregateVersion: p.expectedPaymentVersion,
      orderingKey: p.paymentId,
      causationId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAA',
      data: {
        operationId: p.operationId,
        paymentId: p.paymentId,
        provider: 'fake-provider',
        expectedPaymentVersion: p.expectedPaymentVersion,
      },
    },
    'execute',
  );
}

export function ledgerPostedEnvelope(p: {
  merchantId: string;
  ledgerTransactionId: string;
  paymentId: string;
  paymentOperationId: string;
  operationType?: string;
}): RegisteredEnvelope {
  const operationType = p.operationType ?? 'CAPTURE';
  return envelope(
    'ledger.transaction.posted.v1',
    {
      kind: 'EVENT',
      schemaVersion: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z',
      merchantId: p.merchantId,
      aggregateType: 'ledger_transaction',
      aggregateId: p.ledgerTransactionId,
      aggregateVersion: 1,
      orderingKey: p.ledgerTransactionId,
      causationId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAA',
      data: {
        ledgerTransactionId: p.ledgerTransactionId,
        paymentId: p.paymentId,
        paymentOperationId: p.paymentOperationId,
        postingKey: `capture:${p.ledgerTransactionId}`,
        operationType,
        currency: 'USD',
        entryCount: 2,
        totalDebitsMinor: '100',
        totalCreditsMinor: '100',
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    'ledger',
  );
}

export function webhookDeliverEnvelope(p: {
  merchantId: string;
  deliveryId: string;
  endpointId: string;
  domainEventId: string;
}): RegisteredEnvelope {
  return envelope(
    'merchant.webhook.deliver.v1',
    {
      kind: 'COMMAND',
      schemaVersion: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z',
      merchantId: p.merchantId,
      aggregateType: 'webhook_delivery',
      aggregateId: p.deliveryId,
      aggregateVersion: 1,
      // docs/09 D-06: a delivery's ordering key is its endpoint.
      orderingKey: p.endpointId,
      causationId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAA',
      data: {
        deliveryId: p.deliveryId,
        endpointId: p.endpointId,
        domainEventId: p.domainEventId,
      },
    },
    'webhook',
  );
}

export function settlementPostedEnvelope(p: {
  merchantId: string;
  settlementBatchId: string;
}): RegisteredEnvelope {
  return envelope(
    'settlement.batch.posted.v1',
    {
      kind: 'EVENT',
      schemaVersion: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z',
      merchantId: p.merchantId,
      aggregateType: 'settlement_batch',
      aggregateId: p.settlementBatchId,
      aggregateVersion: 1,
      // A batch's ordering key is its merchant, so one merchant's settlements stay ordered together.
      orderingKey: p.merchantId,
      causationId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAA',
      data: {
        settlementBatchId: p.settlementBatchId,
        settlementRunId: 'srn_01ARZ3NDEKTSV4RRFFQ69G5FAA',
        currency: 'USD',
        cutoffAt: '2026-01-01T00:00:00.000Z',
        memberCount: 1,
        netAmountMinor: '100',
        ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAA',
        postingKey: `settlement:${p.settlementBatchId}`,
        postedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    'settlement',
  );
}
