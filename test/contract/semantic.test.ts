/**
 * Semantic correlation: each rule is rejected on a message that is shape-valid, so the only
 * thing that can reject it is the correlation check.
 *
 * Four rules cannot be exercised through `validateMessage` because JSON Schema already pins
 * the field they check (`schemaVersion`, settlement `aggregateVersion`, the ledger reference
 * shape, the settlement posting key). Their cases call `checkSemantics` directly and assert
 * BOTH that the rule fires and that the schema would have rejected the input — otherwise the
 * test would pass while the semantic rule was dead code.
 */
import { describe, expect, it } from 'vitest';
import {
  type RegisteredEnvelope,
  assertContiguityApplicable,
  checkMerchantWebhookSemantics,
  checkSemantics,
  contiguityApplies,
  validateMerchantWebhookPayload,
  validateMessage,
} from '@flowledger/contracts';
import { registeredTypes } from '@flowledger/contracts';
import { validMessages } from './fixtures/messages.js';
import { boundaryBases, semanticMismatches, withTotals } from './fixtures/semantic-mismatches.js';

type Message = Record<string, unknown>;

function asEnvelope(message: Message): RegisteredEnvelope {
  return message as unknown as RegisteredEnvelope;
}

/** Distinct rule names, so a mutation tripping one rule twice still compares cleanly. */
function rulesOf(violations: readonly { rule: string }[]): string[] {
  return [...new Set(violations.map((violation) => violation.rule))];
}

describe('semantic rules', () => {
  it.each(semanticMismatches.map((entry) => [entry.rule, entry] as const))(
    '%s mismatch detected',
    (rule, entry) => {
      const message = entry.build();

      if (entry.viaSchema) {
        const result = validateMessage(message);
        expect(result.ok, `${rule}: the mismatch was accepted`).toBe(false);
        if (result.ok) return;
        expect(result.failure).toBe('SEMANTIC');
        expect(rulesOf(result.issues)).toEqual([rule]);
      } else {
        // The document is schema-invalid on purpose; only the semantic check can see it.
        expect(validateMessage(message).ok).toBe(false);
        const violations = checkSemantics(asEnvelope(message));
        expect(rulesOf(violations)).toEqual([rule]);
      }
    },
  );

  it('all 26 positive fixtures are free of semantic violations', () => {
    const offenders: string[] = [];
    for (const type of registeredTypes) {
      const fixture = validMessages[type] as unknown as Message;
      const violations = checkSemantics(asEnvelope(fixture));
      if (violations.length > 0) {
        offenders.push(`${type}: ${JSON.stringify(rulesOf(violations))}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('validateMessage reports SEMANTIC for a schema-valid mismatch', () => {
    const message = structuredClone(
      validMessages['payment.operation.execute.v1'] as unknown as Message,
    );
    // Both IDs are well-formed payment IDs; they simply disagree.
    message.aggregateId = 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAB';
    message.data = { ...(message.data as Message), paymentId: 'pay_01ARZ3NDEKTSV4RRFFQ69G5FB9' };

    const result = validateMessage(message);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('SEMANTIC');
    expect(rulesOf(result.issues)).toContain('PAYMENT_AGGREGATE_ID_EQUALS_PAYMENT_ID');
  });

  it('voided boundary: voided == authorized - captured is accepted', () => {
    // 10000 authorized, 0 captured, 10000 voided.
    const atBoundary = structuredClone(
      validMessages[boundaryBases.CANCEL_SUCCEEDED] as unknown as Message,
    );
    expect(checkSemantics(asEnvelope(atBoundary))).toEqual([]);
  });

  it('voided boundary: one unit beyond authorized - captured is rejected', () => {
    const beyond = withTotals(boundaryBases.CANCEL_SUCCEEDED, { voidedAmountMinor: '10001' });
    expect(rulesOf(checkSemantics(asEnvelope(beyond)))).toEqual([
      'TOTALS_SATISFY_PAYMENT_INVARIANTS',
    ]);
  });

  it('refunded == captured is accepted', () => {
    const atBoundary = withTotals(boundaryBases.REFUND_SUCCEEDED, {
      capturedAmountMinor: '3000',
      refundedAmountMinor: '3000',
    });
    expect(checkSemantics(asEnvelope(atBoundary))).toEqual([]);
    // And the same totals via the real validator, which must not reject a legal payment.
    expect(validateMessage(atBoundary).ok).toBe(true);
  });
});

describe('contiguity applicability', () => {
  it('a COMMAND is never subject to contiguity', () => {
    expect(contiguityApplies('COMMAND', 'payment.operation.execute.v1')).toBe(false);
    expect(() => assertContiguityApplicable('COMMAND', 'payment.operation.execute.v1')).toThrow(
      /CONTIGUITY_NOT_APPLICABLE/,
    );
  });

  it('a settlement event is rejected', () => {
    expect(contiguityApplies('EVENT', 'settlement.batch.posted.v1')).toBe(false);
    expect(() => assertContiguityApplicable('EVENT', 'settlement.batch.posted.v1')).toThrow(
      'CONTIGUITY_NOT_APPLICABLE: settlement.batch.posted.v1',
    );
  });

  it('a ledger transaction event is rejected (A-07)', () => {
    expect(contiguityApplies('EVENT', 'ledger.transaction.posted.v1')).toBe(false);
    expect(() => assertContiguityApplicable('EVENT', 'ledger.transaction.posted.v1')).toThrow(
      /CONTIGUITY_NOT_APPLICABLE/,
    );
  });

  it('a payment event is accepted', () => {
    expect(contiguityApplies('EVENT', 'payment.created.v1')).toBe(true);
    expect(() => assertContiguityApplicable('EVENT', 'payment.created.v1')).not.toThrow();
  });
});

describe('merchant payload semantics', () => {
  function payload(): Message {
    return {
      id: '0192f4e7-8b30-7c83-b462-c0d5fe8f132a',
      type: 'payment.capture.succeeded.v1',
      schemaVersion: 1,
      createdAt: '2026-11-05T18:44:31.123Z',
      merchantId: 'mer_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      data: {
        paymentId: 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        paymentVersion: 5,
        operationId: 'op_01ARZ3NDEKTSV4RRFFQ69G5FAX',
        operationType: 'CAPTURE',
        outcome: 'SUCCEEDED',
        amount: { amountMinor: '10000', currency: 'USD' },
        totals: {
          requestedAmountMinor: '10000',
          authorizedAmountMinor: '10000',
          capturedAmountMinor: '10000',
          refundedAmountMinor: '0',
          voidedAmountMinor: '0',
          currency: 'USD',
        },
        summaryStatus: 'CAPTURED',
      },
    };
  }

  it('a consistent payload has no violations', () => {
    expect(checkMerchantWebhookSemantics(payload())).toEqual([]);
  });

  it('a payload whose totals cannot coexist is rejected as SEMANTIC', () => {
    const broken = payload();
    broken.data = {
      ...(broken.data as Message),
      totals: {
        requestedAmountMinor: '10000',
        authorizedAmountMinor: '10000',
        capturedAmountMinor: '10001',
        refundedAmountMinor: '0',
        voidedAmountMinor: '0',
        currency: 'USD',
      },
    };

    // Schema-valid, so only the semantic check can reject it.
    expect(validateMerchantWebhookPayload(broken)).toEqual(
      expect.objectContaining({ ok: false, failure: 'SEMANTIC' }),
    );
  });
});
