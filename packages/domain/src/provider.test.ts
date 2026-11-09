/**
 * Provider contract types.
 *
 * The `@ts-expect-error` block is the point of this file: each line asserts that a construction the
 * contract forbids does not type-check. An unused `@ts-expect-error` is itself an error, so the block
 * fails the build the moment one of those impossibilities becomes possible — which is what makes the
 * comments evidence rather than documentation.
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import type { OperationType } from './payment.js';
import {
  NO_EFFECT_PROOF_KINDS,
  PROVIDER_ERROR_CATEGORIES,
  type NoEffectProof,
  type NormalizedProviderError,
  type ProviderEvidence,
  type ProviderMoney,
  type ProviderOutcome,
  RESOLUTION_SOURCES,
  RETRY_DIRECTIVES,
  evidence,
  failed,
  rejected,
  retryableNoEffect,
  succeeded,
  unknownOutcome,
} from './provider.js';

const MONEY: ProviderMoney = { currency: 'USD', amountMinor: '10000' };

const ERROR: NormalizedProviderError = {
  category: 'BUSINESS_DECLINE',
  code: 'CARD_DECLINED',
  retryDirective: 'DO_NOT_RETRY',
  retryAfterMs: null,
  safeMessage: 'The card was declined.',
};

const PROOF: NoEffectProof = { kind: 'LOCAL_REJECTION_BEFORE_TRANSMISSION' };

const HINT = {
  providerPaymentId: null,
  providerOperationId: null,
  mayReplaySameKey: true,
  lookupNotBefore: '2026-11-05T18:45:00.000Z',
};

function succeededInput(overrides: Partial<Parameters<typeof succeeded>[0]> = {}) {
  return {
    operationType: 'AUTHORIZE' as OperationType,
    providerPaymentId: 'pp_1',
    providerOperationId: 'po_1',
    providerAuthorizationId: 'pa_1',
    providerCaptureId: null,
    authorizationExpiresAt: null,
    amount: MONEY,
    ...overrides,
  };
}

/* --------------------------------------------------------------------------------------------
 * Type-level impossibilities.
 * ------------------------------------------------------------------------------------------ */
describe('impossible constructions do not compile', () => {
  it('documents them', () => {
    // A FAILED outcome without a no-effect proof: nothing proves the write was not applied.
    // @ts-expect-error - noEffectProof is required on FAILED
    const failedWithoutProof: ProviderOutcome = {
      outcome: 'FAILED',
      providerPaymentId: null,
      providerOperationId: null,
      error: ERROR,
    };

    // A success with no provider operation id cannot be looked up later.
    // @ts-expect-error - providerOperationId is a string on SUCCEEDED
    const successWithoutOperation: ProviderOutcome = {
      outcome: 'SUCCEEDED',
      providerPaymentId: 'pp_1',
      providerOperationId: null,
      providerAuthorizationId: null,
      providerCaptureId: null,
      authorizationExpiresAt: null,
      amount: MONEY,
    };

    // A success with no provider payment id breaks the immutable payment binding.
    // @ts-expect-error - providerPaymentId is a string on SUCCEEDED
    const successWithoutPayment: ProviderOutcome = {
      outcome: 'SUCCEEDED',
      providerPaymentId: null,
      providerOperationId: 'po_1',
      providerAuthorizationId: null,
      providerCaptureId: null,
      authorizationExpiresAt: null,
      amount: MONEY,
    };

    // RETRYABLE_NO_EFFECT without a bounded retry time would retry immediately and forever. The
    // nested directive is valid here on purpose, so the missing property is the only error.
    // @ts-expect-error - retryNotBefore is required
    const retryWithoutDeadline: ProviderOutcome = {
      outcome: 'RETRYABLE_NO_EFFECT',
      providerPaymentId: null,
      providerOperationId: null,
      error: { ...ERROR, retryDirective: 'RETRY_SAME_OPERATION' as const },
      noEffectProof: PROOF,
    };

    // Retrying the same operation under a DO_NOT_RETRY directive is a contradiction. The directive
    // goes on the offending property: TS attributes the error to that line, not to the declaration.
    const retryWithDoNotRetry: ProviderOutcome = {
      outcome: 'RETRYABLE_NO_EFFECT',
      providerPaymentId: null,
      providerOperationId: null,
      // @ts-expect-error - the nested retryDirective must be RETRY_SAME_OPERATION
      error: ERROR,
      noEffectProof: PROOF,
      retryNotBefore: '2026-11-05T18:46:00.000Z',
    };

    // A rejection must say why.
    // @ts-expect-error - error is required on REJECTED
    const rejectionWithoutError: ProviderOutcome = {
      outcome: 'REJECTED',
      providerPaymentId: null,
      providerOperationId: null,
    };

    // A conclusive absence cannot also carry a next-check time.
    const conclusiveWithDelay = {
      outcome: 'NOT_FOUND' as const,
      absenceIsConclusive: true as const,
      checkedAt: '2026-11-05T18:45:00.000Z',
      // @ts-expect-error - nextCheckNotBefore is null when absenceIsConclusive is true
      nextCheckNotBefore: '2026-11-05T19:45:00.000Z',
      evidence: {
        source: 'RECONCILIATION' as const,
        providerObservedAt: null,
        receivedAt: '2026-11-05T18:45:00.000Z',
        providerEventId: null,
        redactedEvidenceRef: 'ref',
      },
    } satisfies import('./provider.js').ProviderLookupResult;

    // Every one of the above is intentionally unused; referencing them keeps noUnusedLocals quiet
    // without making them reachable at runtime.
    expect([
      failedWithoutProof,
      successWithoutOperation,
      successWithoutPayment,
      retryWithoutDeadline,
      retryWithDoNotRetry,
      rejectionWithoutError,
      conclusiveWithDelay,
    ]).toHaveLength(7);
  });
});

/* --------------------------------------------------------------------------------------------
 * Runtime constructor rules.
 * ------------------------------------------------------------------------------------------ */
function expectMalformed(fn: () => unknown, field: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const domainError = error as DomainError;
    expect(`${domainError.code}/${domainError.reason}`).toBe('INTERNAL_ERROR/VALUE_MALFORMED');
    expect(domainError.detail?.field).toBe(field);
    return;
  }
  throw new Error(`expected a VALUE_MALFORMED error for ${field}`);
}

describe('succeeded', () => {
  it('accepts an authorization with an expiry', () => {
    const outcome = succeeded(
      succeededInput({ authorizationExpiresAt: '2026-11-05T19:45:00.000Z' }),
    );
    expect(outcome.outcome).toBe('SUCCEEDED');
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it('requires an authorization id for AUTHORIZE', () => {
    expectMalformed(
      () => succeeded(succeededInput({ providerAuthorizationId: null })),
      'providerAuthorizationId',
    );
  });

  it('rejects an expiry on a non-authorization success', () => {
    expectMalformed(
      () =>
        succeeded(
          succeededInput({
            operationType: 'CAPTURE',
            authorizationExpiresAt: '2026-11-05T19:45:00.000Z',
          }),
        ),
      'authorizationExpiresAt',
    );
  });

  it('rejects a capture id on a non-capture success', () => {
    expectMalformed(
      () => succeeded(succeededInput({ providerCaptureId: 'pc_1' })),
      'providerCaptureId',
    );
  });

  it('accepts a capture id on a capture success', () => {
    expect(
      succeeded(
        succeededInput({
          operationType: 'CAPTURE',
          providerAuthorizationId: null,
          providerCaptureId: 'pc_1',
        }),
      ).providerCaptureId,
    ).toBe('pc_1');
  });

  it.each(['providerPaymentId', 'providerOperationId'] as const)('rejects an empty %s', (field) => {
    expectMalformed(() => succeeded(succeededInput({ [field]: '' })), field);
  });

  it('rejects an empty amount', () => {
    expectMalformed(
      () => succeeded(succeededInput({ amount: { currency: 'USD', amountMinor: '' } })),
      'amount.amountMinor',
    );
  });
});

describe('rejected and failed', () => {
  it('accepts a rejection with normalized identities', () => {
    expect(
      rejected({ providerPaymentId: 'pp_1', providerOperationId: null, error: ERROR }).outcome,
    ).toBe('REJECTED');
  });

  it('requires a no-effect proof at the constructor', () => {
    expect(
      failed({
        providerPaymentId: null,
        providerOperationId: null,
        error: ERROR,
        noEffectProof: PROOF,
      }).outcome,
    ).toBe('FAILED');
    // The type forbids omitting it; this asserts the runtime shape carries it through.
    expect(
      failed({
        providerPaymentId: null,
        providerOperationId: null,
        error: ERROR,
        noEffectProof: PROOF,
      }).noEffectProof,
    ).toEqual(PROOF);
  });

  it.each([
    ['error.safeMessage', { ...ERROR, safeMessage: '' }],
    ['error.safeMessage', { ...ERROR, safeMessage: 'x'.repeat(501) }],
    ['error.code', { ...ERROR, code: '' }],
    ['error.code', { ...ERROR, code: 'x'.repeat(129) }],
  ])('rejects an out-of-bounds %s', (field, error) => {
    expectMalformed(
      () => rejected({ providerPaymentId: null, providerOperationId: null, error }),
      field,
    );
  });
});

describe('retryableNoEffect', () => {
  const NOW = '2026-11-05T18:45:00.000Z';
  const base = {
    providerPaymentId: null,
    providerOperationId: null,
    error: { ...ERROR, retryDirective: 'RETRY_SAME_OPERATION' as const },
    noEffectProof: PROOF,
    now: NOW,
    maxDelayMs: 60_000,
  };

  it('accepts a bounded future deadline', () => {
    const outcome = retryableNoEffect({ ...base, retryNotBefore: '2026-11-05T18:45:30.000Z' });
    expect(outcome.outcome).toBe('RETRYABLE_NO_EFFECT');
    expect(outcome.retryNotBefore).toBe('2026-11-05T18:45:30.000Z');
  });

  it('rejects a deadline at or before now', () => {
    expectMalformed(() => retryableNoEffect({ ...base, retryNotBefore: NOW }), 'retryNotBefore');
    expectMalformed(
      () => retryableNoEffect({ ...base, retryNotBefore: '2026-11-05T18:44:59.000Z' }),
      'retryNotBefore',
    );
  });

  it('rejects a deadline beyond the maximum delay', () => {
    expectMalformed(
      () => retryableNoEffect({ ...base, retryNotBefore: '2026-11-05T18:47:00.000Z' }),
      'retryNotBefore',
    );
  });

  it('rejects an unparseable deadline', () => {
    expectMalformed(
      () => retryableNoEffect({ ...base, retryNotBefore: 'not-a-time' }),
      'retryNotBefore',
    );
  });

  it('keeps the same-operation directive on the outcome', () => {
    const outcome = retryableNoEffect({ ...base, retryNotBefore: '2026-11-05T18:45:30.000Z' });
    expect(outcome.error.retryDirective).toBe('RETRY_SAME_OPERATION');
  });
});

describe('unknownOutcome', () => {
  it('carries the lookup hint verbatim', () => {
    const outcome = unknownOutcome({
      providerPaymentId: 'pp_1',
      providerOperationId: null,
      error: { ...ERROR, category: 'TRANSPORT_AMBIGUOUS', retryDirective: 'RECONCILE_FIRST' },
      lookupHint: HINT,
    });
    expect(outcome.outcome).toBe('UNKNOWN');
    expect(outcome.lookupHint).toEqual(HINT);
    expect(outcome.lookupHint).not.toBe(HINT);
  });
});

describe('evidence', () => {
  const base: ProviderEvidence = {
    source: 'API_RESPONSE',
    providerObservedAt: null,
    receivedAt: '2026-11-05T18:45:00.000Z',
    providerEventId: null,
    redactedEvidenceRef: 'provider-response/01',
  };

  it.each(RESOLUTION_SOURCES)('accepts %s with a null event id', (source) => {
    if (source === 'PROVIDER_WEBHOOK') return;
    expect(evidence({ ...base, source }).source).toBe(source);
  });

  it('requires an event id for a webhook', () => {
    expect(
      evidence({ ...base, source: 'PROVIDER_WEBHOOK', providerEventId: 'evt_1' }).providerEventId,
    ).toBe('evt_1');
    expectMalformed(() => evidence({ ...base, source: 'PROVIDER_WEBHOOK' }), 'providerEventId');
  });

  it('rejects an event id on a non-webhook source', () => {
    expectMalformed(
      () => evidence({ ...base, source: 'API_RESPONSE', providerEventId: 'evt_1' }),
      'providerEventId',
    );
  });

  it('rejects a malformed timestamp', () => {
    expectMalformed(() => evidence({ ...base, receivedAt: 'yesterday' }), 'receivedAt');
  });

  it('rejects an empty redacted reference', () => {
    expectMalformed(() => evidence({ ...base, redactedEvidenceRef: '' }), 'redactedEvidenceRef');
  });
});

describe('closed unions match the schema enums', () => {
  it('has 13 error categories in contract order', () => {
    expect(PROVIDER_ERROR_CATEGORIES).toHaveLength(13);
    expect(PROVIDER_ERROR_CATEGORIES[0]).toBe('BUSINESS_DECLINE');
    expect(PROVIDER_ERROR_CATEGORIES.at(-1)).toBe('ADAPTER_DEFECT');
  });

  it('has three retry directives', () => {
    expect(RETRY_DIRECTIVES).toEqual(['DO_NOT_RETRY', 'RETRY_SAME_OPERATION', 'RECONCILE_FIRST']);
  });

  it('has three no-effect proof kinds', () => {
    expect(NO_EFFECT_PROOF_KINDS).toEqual([
      'LOCAL_REJECTION_BEFORE_TRANSMISSION',
      'AUTHENTICATED_PROVIDER_REJECTION',
      'CONCLUSIVE_PROVIDER_LOOKUP_ABSENCE',
    ]);
  });

  it('has three resolution sources', () => {
    expect(RESOLUTION_SOURCES).toEqual(['API_RESPONSE', 'PROVIDER_WEBHOOK', 'RECONCILIATION']);
  });
});
