/**
 * The provider-neutral contract types (docs/06 §Provider-neutral TypeScript interface, §Capability
 * model, §Normalized write results, §Error taxonomy, §Reconciliation lookup and evidence).
 *
 * The types are copied verbatim from the contract: field names, optionality, and the `string` types
 * for opaque provider references and timestamps. Translating them into brands or `Date`s here would
 * create a second vocabulary for the same data and make every adapter boundary a conversion.
 *
 * What the type system cannot say is enforced by the constructors, which throw
 * `INTERNAL_ERROR/VALUE_MALFORMED`: a `FAILED` result with no no-effect proof, a success whose
 * identity fields are missing, or an evidence object whose event id disagrees with its source are all
 * adapter defects, never client errors.
 *
 * The constructors exist because these shapes are the *only* way an outcome crosses into the
 * application. If an adapter could build a `SUCCEEDED` with a null `providerOperationId`, the
 * ambiguity machinery downstream has nothing to look up and the payment would be unresolvable by
 * construction.
 */
import { DomainError } from './errors.js';
import type { OperationType } from './payment.js';
import type { ProviderName } from './values.js';

export type { ProviderName };

export const PROVIDER_ERROR_CATEGORIES = [
  'BUSINESS_DECLINE',
  'INVALID_REQUEST',
  'AUTHENTICATION',
  'PERMISSION',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'TRANSPORT_PRE_SEND',
  'TRANSPORT_AMBIGUOUS',
  'MALFORMED_RESPONSE',
  'UNSUPPORTED_OPERATION',
  'ADAPTER_DEFECT',
] as const;
export type ProviderErrorCategory = (typeof PROVIDER_ERROR_CATEGORIES)[number];

export const RETRY_DIRECTIVES = [
  'DO_NOT_RETRY',
  'RETRY_SAME_OPERATION',
  'RECONCILE_FIRST',
] as const;
export type RetryDirective = (typeof RETRY_DIRECTIVES)[number];

export const NO_EFFECT_PROOF_KINDS = [
  'LOCAL_REJECTION_BEFORE_TRANSMISSION',
  'AUTHENTICATED_PROVIDER_REJECTION',
  'CONCLUSIVE_PROVIDER_LOOKUP_ABSENCE',
] as const;

export const RESOLUTION_SOURCES = ['API_RESPONSE', 'PROVIDER_WEBHOOK', 'RECONCILIATION'] as const;
export type ResolutionSource = (typeof RESOLUTION_SOURCES)[number];

export type ProviderMoney = {
  readonly currency: 'USD';
  readonly amountMinor: string;
};

export type ProviderOperationCommand = {
  readonly operationId: string;
  readonly operationType: OperationType;
  readonly paymentId: string;
  readonly merchantId: string;
  readonly providerAccountId: string;
  readonly providerAccountVersion: number;
  readonly providerPaymentId: string | null;
  readonly providerAuthorizationId: string | null;
  readonly providerCaptureId: string | null;
  readonly paymentMethodReference: string | null;
  readonly amount: ProviderMoney;
  readonly idempotencyKey: string;
  readonly requestDeadline: string;
  readonly correlationId: string;
};

export type ProviderLookup = {
  readonly operationId: string;
  readonly operationType: OperationType;
  readonly providerAccountId: string;
  readonly providerOperationId: string | null;
  readonly providerPaymentId: string | null;
  readonly idempotencyKey: string;
  readonly expectedAmount: ProviderMoney;
};

export type ProviderLookupHint = {
  readonly providerPaymentId: string | null;
  readonly providerOperationId: string | null;
  readonly mayReplaySameKey: boolean;
  readonly lookupNotBefore: string;
};

export type ProviderAuthorizationLookup = {
  readonly paymentId: string;
  readonly authorizationOperationId: string;
  readonly providerAccountId: string;
  readonly providerAccountVersion: number;
  readonly providerPaymentId: string;
  readonly providerAuthorizationId: string;
  readonly expectedAmount: ProviderMoney;
};

export type ProviderWebhookRequest = {
  readonly webhookEndpointId: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawBody: Uint8Array;
  readonly receivedAt: string;
};

export type ProviderCapabilities = {
  readonly contractVersion: 1;
  readonly supportedOperations: readonly OperationType[];

  readonly manualCapture: boolean;
  readonly partialCapture: 'UNSUPPORTED' | 'SUPPORTED_RELEASES_REMAINDER';
  readonly multipleCaptures: boolean;
  readonly partialRefunds: boolean;
  readonly multipleRefunds: boolean;
  readonly cancellationBeforeCapture: boolean;

  readonly authorizationExpiry: {
    readonly statusLookup: boolean;
    readonly returnsExpiryTimestamp: boolean;
    readonly initialCheckAfterSeconds: number;
  };

  readonly writeIdempotency: {
    readonly AUTHORIZE: 'NONE' | 'SAME_KEY_REPLAY';
    readonly CAPTURE: 'NONE' | 'SAME_KEY_REPLAY';
    readonly CANCEL: 'NONE' | 'SAME_KEY_REPLAY';
    readonly REFUND: 'NONE' | 'SAME_KEY_REPLAY';
    readonly documentedRetentionSeconds: number | null;
    readonly maxKeyLength: number;
  };

  readonly lookup: {
    readonly byProviderOperationId: boolean;
    readonly byProviderPaymentId: boolean;
    readonly byIdempotencyKey: boolean;
    readonly absenceConclusiveAfterSeconds: number | null;
  };

  readonly webhooks: {
    readonly signed: boolean;
    readonly stableEventId: boolean;
    readonly timestamped: boolean;
    readonly replayToleranceSeconds: number | null;
  };

  readonly execution: {
    readonly requestTimeoutMs: number;
    readonly processingLeaseMs: number;
    readonly maxInFlightPerAccount: number;
  };
};

export type ProviderEvidence = {
  readonly source: ResolutionSource;
  readonly providerObservedAt: string | null;
  readonly receivedAt: string;
  readonly providerEventId: string | null;
  readonly redactedEvidenceRef: string;
};

export type NormalizedProviderError = {
  readonly category: ProviderErrorCategory;
  readonly code: string;
  readonly retryDirective: RetryDirective;
  readonly retryAfterMs: number | null;
  readonly safeMessage: string;
};

export type NoEffectProof =
  | { readonly kind: 'LOCAL_REJECTION_BEFORE_TRANSMISSION' }
  | { readonly kind: 'AUTHENTICATED_PROVIDER_REJECTION'; readonly providerCode: string }
  | { readonly kind: 'CONCLUSIVE_PROVIDER_LOOKUP_ABSENCE'; readonly observedAt: string };

export type SucceededOutcome = {
  readonly outcome: 'SUCCEEDED';
  readonly providerPaymentId: string;
  readonly providerOperationId: string;
  readonly providerAuthorizationId: string | null;
  readonly providerCaptureId: string | null;
  readonly authorizationExpiresAt: string | null;
  readonly amount: ProviderMoney;
};

export type RejectedOutcome = {
  readonly outcome: 'REJECTED';
  readonly providerPaymentId: string | null;
  readonly providerOperationId: string | null;
  readonly error: NormalizedProviderError;
};

export type FailedOutcome = {
  readonly outcome: 'FAILED';
  readonly providerPaymentId: string | null;
  readonly providerOperationId: string | null;
  readonly error: NormalizedProviderError;
  readonly noEffectProof: NoEffectProof;
};

export type RetryableNoEffectOutcome = {
  readonly outcome: 'RETRYABLE_NO_EFFECT';
  readonly providerPaymentId: string | null;
  readonly providerOperationId: string | null;
  readonly error: NormalizedProviderError & { readonly retryDirective: 'RETRY_SAME_OPERATION' };
  readonly noEffectProof: NoEffectProof;
  readonly retryNotBefore: string;
};

export type UnknownOutcome = {
  readonly outcome: 'UNKNOWN';
  readonly providerPaymentId: string | null;
  readonly providerOperationId: string | null;
  readonly error: NormalizedProviderError;
  readonly lookupHint: ProviderLookupHint;
};

export type ProviderOutcome =
  SucceededOutcome | RejectedOutcome | FailedOutcome | RetryableNoEffectOutcome | UnknownOutcome;

export type ProviderTerminalOutcome = Extract<
  ProviderOutcome,
  { outcome: 'SUCCEEDED' | 'REJECTED' | 'FAILED' }
>;

export type ProviderWriteResult = ProviderOutcome & {
  readonly evidence: ProviderEvidence;
};

export type VerifiedProviderWebhook = {
  readonly providerAccountReference: string | null;
  readonly notificationType: 'OPERATION_RESULT' | 'AUTHORIZATION_EXPIRED' | 'INFORMATIONAL';
  readonly operationType: OperationType | null;
  readonly providerPaymentId: string | null;
  readonly providerOperationId: string | null;
  readonly providerAuthorizationId: string | null;
  readonly providerCaptureId: string | null;
  readonly amount: ProviderMoney | null;
  readonly normalizedResult: ProviderTerminalOutcome | null;
  readonly evidence: ProviderEvidence;
};

export type ProviderLookupResult =
  | {
      readonly outcome: 'FOUND';
      readonly result: ProviderTerminalOutcome;
      readonly evidence: ProviderEvidence;
    }
  | {
      readonly outcome: 'NOT_FOUND';
      readonly absenceIsConclusive: true;
      readonly checkedAt: string;
      readonly nextCheckNotBefore: null;
      readonly evidence: ProviderEvidence;
    }
  | {
      readonly outcome: 'NOT_FOUND';
      readonly absenceIsConclusive: false;
      readonly checkedAt: string;
      readonly nextCheckNotBefore: string;
      readonly evidence: ProviderEvidence;
    }
  | {
      readonly outcome: 'INCONCLUSIVE';
      readonly error: NormalizedProviderError;
      readonly evidence: ProviderEvidence;
    };

export type ProviderAuthorizationLookupResult =
  | {
      readonly outcome: 'ACTIVE';
      readonly providerPaymentId: string;
      readonly providerAuthorizationId: string;
      readonly authorizationExpiresAt: string | null;
      readonly nextCheckNotBefore: string;
      readonly evidence: ProviderEvidence;
    }
  | {
      readonly outcome: 'EXPIRED';
      readonly providerPaymentId: string;
      readonly providerAuthorizationId: string;
      readonly expiredAt: string | null;
      readonly evidence: ProviderEvidence;
    }
  | {
      readonly outcome: 'INCONCLUSIVE';
      readonly error: NormalizedProviderError;
      readonly evidence: ProviderEvidence;
    };

export interface PaymentProvider {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;

  authorize(command: ProviderOperationCommand, signal: AbortSignal): Promise<ProviderWriteResult>;
  capture(command: ProviderOperationCommand, signal: AbortSignal): Promise<ProviderWriteResult>;
  cancel(command: ProviderOperationCommand, signal: AbortSignal): Promise<ProviderWriteResult>;
  refund(command: ProviderOperationCommand, signal: AbortSignal): Promise<ProviderWriteResult>;

  lookup(query: ProviderLookup, signal: AbortSignal): Promise<ProviderLookupResult>;
  lookupAuthorizationStatus(
    query: ProviderAuthorizationLookup,
    signal: AbortSignal,
  ): Promise<ProviderAuthorizationLookupResult>;

  verifyWebhook(request: ProviderWebhookRequest): Promise<VerifiedProviderWebhook>;
}

function malformed(field: string, reason: string): DomainError {
  // Adapter defects, never client errors: this constructor is reached only from adapter code.
  return new DomainError('INTERNAL_ERROR', 'VALUE_MALFORMED', { field, reason });
}

function requireNonEmpty(value: string | null, field: string): string {
  if (value === null || value.length === 0) {
    throw malformed(field, 'must be a non-empty string');
  }
  return value;
}

function requireLength(value: string, field: string, min: number, max: number): string {
  if (value.length < min || value.length > max) {
    throw malformed(field, `must be ${String(min)}–${String(max)} characters`);
  }
  return value;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function requireTimestamp(value: string, field: string): string {
  if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw malformed(field, 'must be an ISO 8601 UTC timestamp');
  }
  return value;
}

/** docs/06 §Normalized write results: a success must carry the identity of what it succeeded at. */
export function succeeded(input: {
  operationType: OperationType;
  providerPaymentId: string;
  providerOperationId: string;
  providerAuthorizationId: string | null;
  providerCaptureId: string | null;
  authorizationExpiresAt: string | null;
  amount: ProviderMoney;
}): SucceededOutcome {
  requireNonEmpty(input.providerPaymentId, 'providerPaymentId');
  requireNonEmpty(input.providerOperationId, 'providerOperationId');

  if (input.operationType === 'AUTHORIZE') {
    requireNonEmpty(input.providerAuthorizationId, 'providerAuthorizationId');
  } else if (input.authorizationExpiresAt !== null) {
    // Only an authorization can expire, so only an authorization carries an expiry.
    throw malformed('authorizationExpiresAt', 'must be null for a non-authorization success');
  }

  if (input.operationType !== 'CAPTURE' && input.providerCaptureId !== null) {
    throw malformed('providerCaptureId', 'must be null for a non-capture success');
  }

  requireNonEmpty(input.amount.amountMinor, 'amount.amountMinor');

  return Object.freeze({
    outcome: 'SUCCEEDED' as const,
    providerPaymentId: input.providerPaymentId,
    providerOperationId: input.providerOperationId,
    providerAuthorizationId: input.providerAuthorizationId,
    providerCaptureId: input.providerCaptureId,
    authorizationExpiresAt: input.authorizationExpiresAt,
    amount: Object.freeze({ ...input.amount }),
  });
}

function validatedError(error: NormalizedProviderError): NormalizedProviderError {
  requireLength(error.safeMessage, 'error.safeMessage', 1, 500);
  requireLength(error.code, 'error.code', 1, 128);
  return error;
}

export function rejected(input: {
  providerPaymentId: string | null;
  providerOperationId: string | null;
  error: NormalizedProviderError;
}): RejectedOutcome {
  return Object.freeze({
    outcome: 'REJECTED' as const,
    providerPaymentId: input.providerPaymentId,
    providerOperationId: input.providerOperationId,
    error: validatedError(input.error),
  });
}

/** A failure is only sayable with a proof that nothing happened. */
export function failed(input: {
  providerPaymentId: string | null;
  providerOperationId: string | null;
  error: NormalizedProviderError;
  noEffectProof: NoEffectProof;
}): FailedOutcome {
  return Object.freeze({
    outcome: 'FAILED' as const,
    providerPaymentId: input.providerPaymentId,
    providerOperationId: input.providerOperationId,
    error: validatedError(input.error),
    noEffectProof: Object.freeze({ ...input.noEffectProof }),
  });
}

export function retryableNoEffect(input: {
  providerPaymentId: string | null;
  providerOperationId: string | null;
  error: NormalizedProviderError & { retryDirective: 'RETRY_SAME_OPERATION' };
  noEffectProof: NoEffectProof;
  retryNotBefore: string;
  now: string;
  maxDelayMs: number;
}): RetryableNoEffectOutcome {
  requireTimestamp(input.retryNotBefore, 'retryNotBefore');
  requireTimestamp(input.now, 'now');

  const delay = Date.parse(input.retryNotBefore) - Date.parse(input.now);
  if (delay <= 0) {
    throw malformed('retryNotBefore', 'must be strictly after now');
  }
  if (delay > input.maxDelayMs) {
    throw malformed('retryNotBefore', 'must be within the configured maximum delay');
  }

  return Object.freeze({
    outcome: 'RETRYABLE_NO_EFFECT' as const,
    providerPaymentId: input.providerPaymentId,
    providerOperationId: input.providerOperationId,
    error: validatedError(input.error) as NormalizedProviderError & {
      retryDirective: 'RETRY_SAME_OPERATION';
    },
    noEffectProof: Object.freeze({ ...input.noEffectProof }),
    retryNotBefore: input.retryNotBefore,
  });
}

export function unknownOutcome(input: {
  providerPaymentId: string | null;
  providerOperationId: string | null;
  error: NormalizedProviderError;
  lookupHint: ProviderLookupHint;
}): UnknownOutcome {
  return Object.freeze({
    outcome: 'UNKNOWN' as const,
    providerPaymentId: input.providerPaymentId,
    providerOperationId: input.providerOperationId,
    error: validatedError(input.error),
    lookupHint: Object.freeze({ ...input.lookupHint }),
  });
}

/**
 * Evidence is attached exactly once by the observation boundary, and its event id is nonnull exactly
 * for a webhook. A direct response or a lookup that carried an event id would let two different
 * observations claim the same dedup identity.
 */
export function evidence(input: ProviderEvidence): ProviderEvidence {
  if (input.source === 'PROVIDER_WEBHOOK') {
    requireNonEmpty(input.providerEventId, 'providerEventId');
  } else if (input.providerEventId !== null) {
    throw malformed('providerEventId', 'must be null unless source is PROVIDER_WEBHOOK');
  }
  requireNonEmpty(input.redactedEvidenceRef, 'redactedEvidenceRef');
  requireTimestamp(input.receivedAt, 'receivedAt');
  if (input.providerObservedAt !== null)
    requireTimestamp(input.providerObservedAt, 'providerObservedAt');

  return Object.freeze({ ...input });
}
