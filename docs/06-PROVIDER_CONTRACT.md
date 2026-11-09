# Provider contract

Status: **Draft**  
Last updated: 2026-11-05

## Purpose

The provider module translates FlowLedger's provider-neutral payment operations into provider-specific sandbox requests and translates provider evidence back into normalized outcomes.

Adapters MUST preserve the payment and operation invariants defined in `03-PAYMENT_STATE_MACHINE.md`. They do not decide whether a payment command is legal, mutate payment or ledger tables, publish domain events, or treat transport success as financial success.

The provider boundary has five responsibilities:

1. Declare capabilities before a payment is routed.
2. Execute one durable operation using its stable provider idempotency key.
3. Classify the result by financial-effect certainty.
4. Verify and normalize provider notifications.
5. Find authoritative evidence for reconciliation.

## Non-negotiable rules

- A payment is bound to one provider and provider account for its lifetime.
- Every provider write belongs to one existing `PaymentOperation`.
- Every attempt for one operation uses the same provider idempotency key.
- A timeout after request transmission is `UNKNOWN`, not `FAILED`.
- `FAILED` is valid only when the adapter can prove that no provider financial effect occurred.
- A provider adapter never creates a replacement operation.
- No provider network request runs while a payment or ledger database transaction is open.
- A provider result does not change confirmed payment totals until the payment transaction commits.
- Raw provider payloads, credentials, and payment secrets never enter domain events, ordinary logs, or ledger metadata.
- A lease coordinates workers; it is not evidence that a provider action did or did not occur.

## Identifier and amount conventions

FlowLedger public entity IDs use a lower-case prefix, `_`, and a 26-character Crockford ULID:

```text
pay_01ARZ3NDEKTSV4RRFFQ69G5FAV   payment
op_01ARZ3NDEKTSV4RRFFQ69G5FAW    payment operation
pat_01ARZ3NDEKTSV4RRFFQ69G5FAX   provider attempt
ltx_01ARZ3NDEKTSV4RRFFQ69G5FAY   ledger transaction
```

An internal command/event envelope `id` is a UUID, not a prefixed ULID, and remains stable across publication and delivery retries. Provider-issued IDs remain opaque strings and do not have to follow FlowLedger's format.

All amounts crossing the provider boundary are unsigned decimal strings in minor units. Adapters use `bigint` or the checked money type internally and never convert an amount through JavaScript `number`.

## Provider-neutral TypeScript interface

```ts
type ProviderName = string; // validated lower-case adapter-registry key
type OperationType = 'AUTHORIZE' | 'CAPTURE' | 'CANCEL' | 'REFUND';

type ProviderMoney = {
  currency: 'USD';
  amountMinor: string;
};

type ProviderOperationCommand = {
  operationId: string;
  operationType: OperationType;
  paymentId: string;
  merchantId: string;
  providerAccountId: string;
  providerAccountVersion: number;
  providerPaymentId: string | null;
  providerAuthorizationId: string | null;
  providerCaptureId: string | null;
  paymentMethodReference: string | null;
  amount: ProviderMoney;
  idempotencyKey: string;
  requestDeadline: string;
  correlationId: string;
};

type ProviderLookup = {
  operationId: string;
  operationType: OperationType;
  providerAccountId: string;
  providerOperationId: string | null;
  providerPaymentId: string | null;
  idempotencyKey: string;
  expectedAmount: ProviderMoney;
};

type ProviderLookupHint = {
  providerPaymentId: string | null;
  providerOperationId: string | null;
  mayReplaySameKey: boolean;
  lookupNotBefore: string;
};

type ProviderAuthorizationLookup = {
  paymentId: string;
  authorizationOperationId: string;
  providerAccountId: string;
  providerAccountVersion: number;
  providerPaymentId: string;
  providerAuthorizationId: string;
  expectedAmount: ProviderMoney;
};

type ProviderWebhookRequest = {
  webhookEndpointId: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  rawBody: Uint8Array;
  receivedAt: string;
};

type VerifiedProviderWebhook = {
  providerAccountReference: string | null;
  notificationType:
    | 'OPERATION_RESULT'
    | 'AUTHORIZATION_EXPIRED'
    | 'INFORMATIONAL';
  operationType: OperationType | null;
  providerPaymentId: string | null;
  providerOperationId: string | null;
  providerAuthorizationId: string | null;
  providerCaptureId: string | null;
  amount: ProviderMoney | null;
  normalizedResult: ProviderTerminalOutcome | null;
  evidence: ProviderEvidence;
};

interface PaymentProvider {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;

  authorize(
    command: ProviderOperationCommand,
    signal: AbortSignal,
  ): Promise<ProviderWriteResult>;

  capture(
    command: ProviderOperationCommand,
    signal: AbortSignal,
  ): Promise<ProviderWriteResult>;

  cancel(
    command: ProviderOperationCommand,
    signal: AbortSignal,
  ): Promise<ProviderWriteResult>;

  refund(
    command: ProviderOperationCommand,
    signal: AbortSignal,
  ): Promise<ProviderWriteResult>;

  lookup(
    query: ProviderLookup,
    signal: AbortSignal,
  ): Promise<ProviderLookupResult>;

  lookupAuthorizationStatus(
    query: ProviderAuthorizationLookup,
    signal: AbortSignal,
  ): Promise<ProviderAuthorizationLookupResult>;

  verifyWebhook(request: ProviderWebhookRequest): Promise<VerifiedProviderWebhook>;
}
```

The application calls the method matching the immutable operation type. An adapter MUST reject an operation that its declared capabilities do not support before transmitting a request.

`paymentMethodReference` is required only for `AUTHORIZE` and MUST be null for capture, cancellation, and refund. The worker decrypts the payment's private sandbox token immediately before building the authorization command. The field is memory-only at this boundary and MUST NOT be placed in an outbox command, provider-attempt row, event, log, trace, or error. Later operations use the append-only provider payment/authorization references instead.

Expected provider outcomes are returned as values. An adapter may throw only for a programmer error or an application-shutdown cancellation. The adapter boundary catches provider SDK exceptions and converts them to a normalized `ProviderWriteResult`, `ProviderLookupResult`, or `ProviderAuthorizationLookupResult`.

## Capability model

```ts
type ProviderCapabilities = {
  contractVersion: 1;
  supportedOperations: readonly OperationType[];

  manualCapture: boolean;
  partialCapture: 'UNSUPPORTED' | 'SUPPORTED_RELEASES_REMAINDER';
  multipleCaptures: boolean;
  partialRefunds: boolean;
  multipleRefunds: boolean;
  cancellationBeforeCapture: boolean;

  authorizationExpiry: {
    statusLookup: boolean;
    returnsExpiryTimestamp: boolean;
    initialCheckAfterSeconds: number;
  };

  writeIdempotency: {
    AUTHORIZE: 'NONE' | 'SAME_KEY_REPLAY';
    CAPTURE: 'NONE' | 'SAME_KEY_REPLAY';
    CANCEL: 'NONE' | 'SAME_KEY_REPLAY';
    REFUND: 'NONE' | 'SAME_KEY_REPLAY';
    documentedRetentionSeconds: number | null;
    maxKeyLength: number;
  };

  lookup: {
    byProviderOperationId: boolean;
    byProviderPaymentId: boolean;
    byIdempotencyKey: boolean;
    absenceConclusiveAfterSeconds: number | null;
  };

  webhooks: {
    signed: boolean;
    stableEventId: boolean;
    timestamped: boolean;
    replayToleranceSeconds: number | null;
  };

  execution: {
    requestTimeoutMs: number;
    processingLeaseMs: number;
    maxInFlightPerAccount: number;
  };
};
```

Capabilities are configuration, not guesses derived from one response. They are validated at process startup and exposed to routing and contract tests.

An MVP provider route is eligible only when it supports:

- Manual authorization followed by capture.
- One full or partial capture that releases the unused authorization.
- Cancellation before capture.
- Multiple sequential partial refunds.
- A read-only lookup path capable of resolving ambiguous writes. A declared same-key replay guarantee is still tested as an adapter capability, but it is not a substitute for lookup eligibility in the MVP.
- Signed webhooks with a stable event identifier.
- A read-only authorization-status lookup capable of distinguishing explicit expiry from absence.

The domain currently permits one capture only, even if a provider advertises multiple captures. A capability never broadens the payment state machine.

`partialCapture` has no `SUPPORTED_RETAINS_REMAINDER` variant. The domain always releases the uncaptured remainder on a successful capture, so a declared retain-remainder behavior would be unreachable configuration: no code path could honor it and no test could exercise it. The variant is omitted rather than carried as dead enum surface. Adding it is part of the future multiple-capture change, where it would acquire meaning.

## Immutable payment binding

Payment creation freezes:

```text
provider
providerAccountId
providerAccountVersion
```

`providerAccountVersion` is the immutable version of the adapter/account behavioral configuration selected by routing. It is the only configuration version carried by the payment and its operations; FlowLedger does not persist a second `providerRoutingVersion` for this binding.

The first successful authorization may add opaque provider references such as `providerPaymentId` and `providerAuthorizationId`. These references are append-only and are reused by later capture, cancellation, refund, webhook-correlation, and reconciliation requests.

Later operations MUST inherit the provider and account from the payment. A request may not override them. Configuration changes affect new payments only.

FlowLedger MUST NOT fail over an in-flight payment to another provider. Reissuing an authorization or capture through another provider can duplicate a real financial effect. Provider migration requires a new payment and an explicit, audited business workflow.

Provider references are opaque. Domain code MUST NOT parse their prefixes or infer status from their format.

## Normalized write results

```ts
type ResolutionSource =
  | 'API_RESPONSE'
  | 'PROVIDER_WEBHOOK'
  | 'RECONCILIATION';

type ProviderEvidence = {
  source: ResolutionSource;
  providerObservedAt: string | null;
  receivedAt: string;
  providerEventId: string | null;
  redactedEvidenceRef: string;
};

type ProviderOutcome =
  | {
      outcome: 'SUCCEEDED';
      providerPaymentId: string;
      providerOperationId: string;
      providerAuthorizationId: string | null;
      providerCaptureId: string | null;
      authorizationExpiresAt: string | null;
      amount: ProviderMoney;
    }
  | {
      outcome: 'REJECTED';
      providerPaymentId: string | null;
      providerOperationId: string | null;
      error: NormalizedProviderError;
    }
  | {
      outcome: 'FAILED';
      providerPaymentId: string | null;
      providerOperationId: string | null;
      error: NormalizedProviderError;
      noEffectProof: NoEffectProof;
    }
  | {
      outcome: 'RETRYABLE_NO_EFFECT';
      providerPaymentId: string | null;
      providerOperationId: string | null;
      error: NormalizedProviderError & {
        retryDirective: 'RETRY_SAME_OPERATION';
      };
      noEffectProof: NoEffectProof;
      retryNotBefore: string;
    }
  | {
      outcome: 'UNKNOWN';
      providerPaymentId: string | null;
      providerOperationId: string | null;
      error: NormalizedProviderError;
      lookupHint: ProviderLookupHint;
    };

type ProviderTerminalOutcome = Extract<
  ProviderOutcome,
  { outcome: 'SUCCEEDED' | 'REJECTED' | 'FAILED' }
>;

type ProviderWriteResult = ProviderOutcome & {
  evidence: ProviderEvidence;
};
```

`ProviderOutcome` contains only the normalized financial observation. `ProviderEvidence` is attached exactly once by the observation boundary. Webhooks and lookups therefore carry an evidence-free outcome plus one outer `evidence`; they never nest a second evidence object inside the result.

`RETRYABLE_NO_EFFECT` is nonterminal. It is valid only when `NoEffectProof` establishes that the just-finished attempt caused no provider effect and the adapter supplies a bounded `retryNotBefore`. Consuming it completes the attempt, records its evidence, and durably reschedules the same operation and provider key; it never becomes `FAILED`, creates a replacement operation, or emits a terminal lifecycle event.

`ProviderEvidence.providerEventId` is nonnull exactly for `PROVIDER_WEBHOOK`; direct responses and reconciliation lookups set it to null. The evidence source, observation/receipt times, event identity, and redacted reference are represented nowhere else in the normalized result.

A successful `AUTHORIZE` result MUST carry nonnull `providerPaymentId`, `providerOperationId`, and `providerAuthorizationId`; `authorizationExpiresAt` may be null, in which case the immutable provider-account expiry policy schedules the first lookup. Non-authorization successes MUST set `authorizationExpiresAt` null. A successful `CAPTURE` may carry a distinct `providerCaptureId`; other operation types set it null. The payment transition rejects an otherwise successful result that violates this shape as malformed/ambiguous evidence, so authorization success can never commit without the identity required to create its expiry case.

For an `AUTHORIZATION_EXPIRED` notification, `providerAuthorizationId` is required and is compared with the payment's append-once authorization reference. A capture result/webhook that supplies a provider-specific capture object sets `providerCaptureId`; the generic `providerOperationId` remains the identity of the current external operation and MUST NOT be assumed to equal the typed capture reference.

`REQUIRES_REVIEW` is not an adapter result. It is a FlowLedger operation status reached only after the reconciliation policy for an `UNKNOWN` operation is exhausted.

Before applying `SUCCEEDED`, the payment module MUST verify that operation type, amount, currency, provider, provider account, and immutable references agree with the original operation. A mismatch consumes each newly deduplicated contradictory evidence item once, increments the payment version, emits `payment.discrepancy.detected.v1` at that version, and does not change confirmed totals, the subject operation, or the ledger.

## Error taxonomy

```ts
type ProviderErrorCategory =
  | 'BUSINESS_DECLINE'
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION'
  | 'PERMISSION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TRANSPORT_PRE_SEND'
  | 'TRANSPORT_AMBIGUOUS'
  | 'MALFORMED_RESPONSE'
  | 'UNSUPPORTED_OPERATION'
  | 'ADAPTER_DEFECT';

type RetryDirective =
  | 'DO_NOT_RETRY'
  | 'RETRY_SAME_OPERATION'
  | 'RECONCILE_FIRST';

type NormalizedProviderError = {
  category: ProviderErrorCategory;
  code: string;
  retryDirective: RetryDirective;
  retryAfterMs: number | null;
  safeMessage: string;
};

type NoEffectProof =
  | { kind: 'LOCAL_REJECTION_BEFORE_TRANSMISSION' }
  | { kind: 'AUTHENTICATED_PROVIDER_REJECTION'; providerCode: string }
  | { kind: 'CONCLUSIVE_PROVIDER_LOOKUP_ABSENCE'; observedAt: string };
```

The provider's HTTP status does not alone determine financial certainty or retry behavior.

| Observation | Normalized operation outcome |
| --- | --- |
| Provider confirms the requested effect with matching identity, amount, and currency | `SUCCEEDED` |
| Provider makes a definitive business decision such as a card decline | `REJECTED` |
| Local validation fails before transmission | `FAILED` |
| Authenticated provider response proves the write was not applied | `FAILED` |
| DNS/TLS/connect failure that the transport proves occurred before request transmission | `FAILED` or `RETRYABLE_NO_EFFECT` according to policy |
| Response timeout, connection loss after possible transmission, or worker death after dispatch | `UNKNOWN` |
| Malformed success response that cannot prove the effect | `UNKNOWN` |
| Provider `5xx` whose contract does not prove no effect | `UNKNOWN` |
| Rate-limit response that proves the write was not executed | `RETRYABLE_NO_EFFECT` using the same key |
| Contradictory provider evidence | preserve existing state, emit `payment.discrepancy.detected.v1` |

Provider codes are mapped to a small allowlisted FlowLedger `code`. Raw error messages and stack traces do not cross the adapter boundary.

## Stable provider idempotency

Every operation receives this deterministic key before any network attempt:

```text
flowledger:{environment}:{provider}:{operationId}
```

If the provider's key-length limit is smaller, use a versioned deterministic encoding:

```text
fl:v1:{base32(sha256(environment | provider | operationId))}
```

The complete derivation inputs and resulting key are persisted with the operation. The key MUST:

- Be unique to one operation.
- Remain unchanged across worker redelivery, process restart, reconciliation, and same-key replay.
- Never include an attempt number or timestamp.
- Never be reused for another operation, even if the first operation failed.
- Be sent through the provider's native idempotency mechanism when supported.

If a provider reports the same key with different request semantics, the adapter returns `CONFLICT`; FlowLedger emits `payment.discrepancy.detected.v1` and requires operator review.

## Provider attempts and leases

A provider attempt is an operational record, not a new financial command.

```ts
type ProviderAttemptStatus =
  | 'RESERVED'
  | 'DISPATCH_MARKED'
  | 'RESPONSE_RECEIVED'
  | 'COMPLETED'
  | 'ABANDONED';
```

The attempt records:

```text
attemptId
operationId
attemptOrdinal
provider and providerAccountId
stable providerIdempotencyKey
workerId
leaseExpiresAt
dispatchMarkedAt
responseReceivedAt
completedAt
normalized transport classification
redactedEvidenceRef
```

Worker claim rules:

1. Lock the operation.
2. If it is `SUCCEEDED`, `REJECTED`, or `FAILED`, acknowledge without calling the provider.
3. If it is `UNKNOWN` or `REQUIRES_REVIEW`, schedule or inspect reconciliation; do not issue a new write.
4. If another worker owns a live `PROCESSING` lease, do not call the provider.
5. A `REQUESTED` operation with nonnull `notBefore` is not claimable. The due-work scheduler, not an execution worker, clears a due `notBefore` and publishes a fresh execution command atomically.
6. For ready `REQUESTED` (`notBefore=null`), atomically set `PROCESSING`, create the attempt as `RESERVED`, acquire the lease, and increment operation version.
7. Commit the claim before performing network I/O.
8. Immediately before possible request transmission, durably set `dispatchMarkedAt` and `DISPATCH_MARKED`.
9. Call the provider outside the transaction.
10. Persist the normalized result in a new transaction.

If a lease expires while the attempt is `RESERVED` and `dispatchMarkedAt` is null, another worker may claim and execute the same operation.

If a lease expires after `dispatchMarkedAt`, the write may have been transmitted. The stale-operation sweep moves the existing operation to `UNKNOWN`, increments the payment version, emits `payment.operation.reconciliation.required.v1`, and publishes `payment.operation.reconcile.v1`.

For `RETRYABLE_NO_EFFECT`, a guarded transaction consumes the proof-bearing evidence, completes the current attempt, changes `PROCESSING -> REQUESTED`, sets the operation's persistent `notBefore=retryNotBefore`, clears the execution lease, and increments operation version. Payment version and confirmed state do not change. A due scheduler selects `REQUESTED` rows with `notBefore <= database_now()` under `FOR UPDATE SKIP LOCKED`; clearing `notBefore` and inserting a new `payment.operation.execute.v1` outbox envelope for the same operation are one transaction. This provides crash-safe delay without adding `notBefore` to the command schema.

Marking dispatch before the actual send can create a conservative false ambiguity after a crash. That is acceptable; a duplicate financial effect is not.

Lease duration is provider-specific and MUST exceed the configured request deadline plus measured scheduling margin. Lease expiry does not authorize another financial write. A worker that loses its lease may submit evidence, but the payment transition still uses locking/version checks and the original operation ID.

## Timeout and ambiguous-result policy

The adapter uses an explicit request deadline. Deadline expiration aborts local waiting when possible, but it does not prove cancellation at the provider.

After possible transmission, these observations are always ambiguous until provider-specific evidence proves otherwise:

- Response deadline exceeded.
- Socket reset or connection closed without a complete authenticated response.
- Process termination after `dispatchMarkedAt`.
- Provider SDK exception without documented no-effect semantics.
- Malformed or incomplete provider success response.
- Provider response that lacks the identity, amount, or currency needed for correlation.

The reconciliation-required event maps those observations to the closed reason vocabulary `TIMEOUT_AFTER_SEND`, `CONNECTION_LOST_AFTER_SEND`, `PROVIDER_5XX_AMBIGUOUS`, `SDK_EXCEPTION_AFTER_SEND`, `MALFORMED_PROVIDER_RESPONSE`, `MISSING_PROVIDER_CORRELATION`, `WORKER_CRASH_AFTER_SEND`, `STALE_PROCESSING`, or `ADAPTER_DEFECT`. Adapters MUST choose the most specific reason; this code is operational classification only and never financial evidence.

For ambiguity, FlowLedger:

1. Retains the original operation and key.
2. Sets the operation to `UNKNOWN`.
3. Leaves confirmed totals and the ledger unchanged.
4. Emits `payment.operation.reconciliation.required.v1`.
5. Schedules `payment.operation.reconcile.v1`.
6. Blocks conflicting commands.

There is no blind retry. After a possibly transmitted attempt becomes ambiguous, the MVP performs only read-only reconciliation, even when an adapter advertises `SAME_KEY_REPLAY`; `UNKNOWN` and `REQUIRES_REVIEW` have no transition back to provider execution. Same-key behavior remains an adapter conformance property and a future guarded-recovery option. A new write for the same operation occurs only after typed `RETRYABLE_NO_EFFECT` evidence proves the previous attempt had no effect and the existing operation is durably rescheduled through `REQUESTED` with the original key.

## Provider webhook contract

### HTTP ingestion

The receiver MUST:

1. Resolve the opaque route key to one stable logical provider webhook endpoint, its bounded active/overlap signing-secret versions, and allowlisted logical provider-account set without trusting a merchant identifier in the payload. Secret rotation preserves the endpoint/deduplication identity.
2. Preserve the exact raw request bytes needed for signature verification.
3. Verify the provider signature before parsing or acting.
4. Enforce the provider's timestamp/replay tolerance when supported.
5. Retain the signed provider-account reference when present; do not assign a merchant until immutable provider object references correlate to an existing operation whose account is allowlisted for this endpoint.
6. Extract a stable provider event ID.
7. Durably insert the redacted notification using unique key `(webhook_endpoint_id, provider_event_id)`, recording the exact secret version that verified it and comparing content hashes on conflict.
8. Return success only after durable insertion.

An invalid signature returns a non-success response, increments a security metric, and creates no provider evidence. A duplicate valid event returns success after confirming the original row exists.

If the receiver crashes before durable insertion, the provider must retry. If it crashes after insertion but before the HTTP response, redelivery is deduplicated by the provider event ID.

### Asynchronous application

Webhook processing:

- Correlates by immutable provider references and provider-account binding.
- Verifies operation type, amount, currency, and provider identity.
- Applies the normal operation transition under the payment lock.
- Uses `resolutionSource=PROVIDER_WEBHOOK` in the specific terminal event.
- Posts capture/refund journals with the original operation posting key.
- Records an agreeing late notification as corroborating evidence only.
- Emits `payment.discrepancy.detected.v1` for contradictory evidence.
- Parks uncorrelated valid notifications for reconciliation; it never invents a payment or operation.

Out-of-order delivery is expected. Webhook order and provider timestamps do not override the payment state machine.

Applying a newly deduplicated contradictory notification and creating/updating its discrepancy case is one payment transaction: it increments payment version and emits exactly one discrepancy event. Replaying the same provider evidence is a no-op. Operation version is unchanged unless a separate guarded operation-state transition is also required.

Raw webhook bodies MAY be stored only in the encrypted, access-restricted evidence quarantine described below. Domain tables store the normalized allowlisted fields and a digest/evidence reference, not the raw body.

## Reconciliation lookup and evidence

`lookup` is read-only. It MUST NOT create, confirm, capture, cancel, or refund anything.

The adapter searches in this order when supported:

1. Exact `providerOperationId`.
2. Immutable `providerPaymentId` plus expected operation type.
3. Stable provider idempotency key.

```ts
type ProviderLookupResult =
  | {
      outcome: 'FOUND';
      result: ProviderTerminalOutcome;
      evidence: ProviderEvidence;
    }
  | {
      outcome: 'NOT_FOUND';
      absenceIsConclusive: true;
      checkedAt: string;
      nextCheckNotBefore: null;
      evidence: ProviderEvidence;
    }
  | {
      outcome: 'NOT_FOUND';
      absenceIsConclusive: false;
      checkedAt: string;
      nextCheckNotBefore: string;
      evidence: ProviderEvidence;
    }
  | {
      outcome: 'INCONCLUSIVE';
      error: NormalizedProviderError;
      evidence: ProviderEvidence;
    };

type ProviderAuthorizationLookupResult =
  | {
      outcome: 'ACTIVE';
      providerPaymentId: string;
      providerAuthorizationId: string;
      authorizationExpiresAt: string | null;
      nextCheckNotBefore: string;
      evidence: ProviderEvidence;
    }
  | {
      outcome: 'EXPIRED';
      providerPaymentId: string;
      providerAuthorizationId: string;
      expiredAt: string | null;
      evidence: ProviderEvidence;
    }
  | {
      outcome: 'INCONCLUSIVE';
      error: NormalizedProviderError;
      evidence: ProviderEvidence;
    };
```

`NormalizedProviderError.retryAfterMs` is the only retry-duration hint for an `INCONCLUSIVE` result; there is no second top-level value. The reconciler bounds that hint by policy, computes an absolute database-time `nextCheckNotBefore`, and persists it in evidence and the case before committing the reschedule.

`NOT_FOUND` is not automatically proof of failure. It is conclusive only if the provider capability defines an absence-consistency window, that window has elapsed, and the lookup covered every applicable immutable identifier. A conclusive absence maps deterministically to normalized `FAILED` evidence with category `NOT_FOUND`, code `PROVIDER_OPERATION_NOT_FOUND_CONCLUSIVE`, directive `DO_NOT_RETRY`, and `CONCLUSIVE_PROVIDER_LOOKUP_ABSENCE { observedAt: checkedAt }`; it then resolves through the normal terminal path. A nonconclusive absence maps to `UNKNOWN`/`CASE_OBSERVATION` evidence with category `NOT_FOUND`, code `PROVIDER_OPERATION_NOT_FOUND_INCONCLUSIVE`, directive `RECONCILE_FIRST`, and the returned absolute `nextCheckNotBefore`; it reschedules the existing case and leaves the operation unchanged.

An ordinary `INCONCLUSIVE` operation lookup maps to `UNKNOWN`/`CASE_OBSERVATION` evidence using its exact normalized error. An inconclusive authorization-status lookup maps to `AUTHORIZATION_INCONCLUSIVE`/`CASE_OBSERVATION`. Neither is a terminal operation result or no-effect proof. For both, the bounded absolute next-check time is persisted before the case is rescheduled, so a crash cannot lose or reinterpret the adapter hint.

Evidence strength for resolving an operation is:

1. A current authoritative provider transaction/settlement lookup tied to the immutable provider operation ID.
2. A current provider-object lookup tied to the immutable payment and operation.
3. A verified signed webhook tied to the operation.
4. An authenticated synchronous provider response.
5. Transport observations, which may prove pre-send failure but never prove provider success.

This hierarchy guides investigation; it does not silently overwrite a terminal FlowLedger fact. When newly deduplicated valid evidence conflicts with an already terminal operation, record both, increment payment version, emit one `payment.discrepancy.detected.v1` at that version, and require audited recovery. Reprocessing the same evidence changes neither version nor case.

### Authorization-expiry lookup

`lookupAuthorizationStatus` is a separate read-only query because expiry changes the payment after the authorization operation is already terminal. Authorization success creates a durable `AUTHORIZATION_EXPIRY` reconciliation case for that operation. Its first check uses `authorizationExpiresAt` when the provider returns one, otherwise the configured provider-account age threshold. `ACTIVE` reschedules that same case at `nextCheckNotBefore`; `INCONCLUSIVE` applies bounded reconciliation backoff; neither changes payment version. Confirmed capture or cancellation closes that authorization and dismisses any open expiry case in the same terminal-transition transaction.

Only an authenticated `EXPIRED` lookup result or a signature-verified `AUTHORIZATION_EXPIRED` webhook is expiry evidence. Missing objects, local clock passage, `NOT_FOUND`, and provider timestamps by themselves are never enough. The payment transition locks the payment and requires `AUTHORIZED`, no confirmed capture/refund/void, no active operation, matching provider-account/payment/authorization references, and newly deduplicated evidence. It then sets `EXPIRED`, voids the full authorization, increments payment version, closes the case, and emits `payment.authorization.expired.v1`. The successful authorization operation and its version remain unchanged.

Reconciliation that resolves an operation uses the normal terminal event:

```text
payment.authorization.succeeded.v1
payment.authorization.rejected.v1
payment.authorization.failed.v1
payment.capture.succeeded.v1
payment.capture.rejected.v1
payment.capture.failed.v1
payment.authorization.cancellation.succeeded.v1
payment.authorization.cancellation.rejected.v1
payment.authorization.cancellation.failed.v1
payment.refund.succeeded.v1
payment.refund.rejected.v1
payment.refund.failed.v1
```

The event carries `resolutionSource=RECONCILIATION`. It is not replaced by a generic reconciliation-success event.

## Rate limits, fairness, and circuit breaking

- Enforce a token bucket and in-flight limit per `(provider, providerAccountId)`.
- Apply a per-merchant concurrency share so one hot merchant cannot consume the full provider budget.
- Respect authenticated provider retry hints within configured maximums.
- Reschedule durable work with the operation row's persistent `notBefore`; do not hold a worker, database lock, or lease while sleeping. A future timestamp is not embedded only in an ephemeral message.
- A locally open circuit before dispatch leaves the operation safely queued; it does not mark it `FAILED` or `UNKNOWN`.
- A circuit may open on transport errors, provider `5xx`, or latency thresholds, but business declines do not count as circuit failures.
- Provider pools and breakers are isolated. One provider outage MUST NOT exhaust another provider's workers.
- Once a request may have been transmitted, circuit-breaker behavior cannot convert ambiguity into safe retry.

Rate-limit metrics include accepted, delayed, dispatched, throttled, in-flight, and queue-age measurements by provider account and merchant. Secrets and high-cardinality customer identifiers are excluded from metric labels.

## Adapter implementations

### Deterministic fake provider

The fake adapter is a complete reference implementation, not a mock that always succeeds. It MUST:

- Implement authorization, one capture, cancellation, multiple refunds, lookup, and signed webhooks.
- Persist provider-side state separately from FlowLedger state.
- Deduplicate writes by stable provider idempotency key and reject changed semantics for a reused key.
- Return the exact original result for identical same-key replay.
- Use deterministic identifiers and a controllable clock.
- Support configured success, business rejection, and definitive no-effect failure.
- Produce a stable event ID and verifiable signature for each webhook.
- Expose ground truth only to test harnesses, never to FlowLedger reconciliation code.

### Unreliable provider

The unreliable adapter wraps the fake provider and injects deterministic, seeded faults:

- Latency before dispatch.
- Confirmed failure before transmission.
- Timeout before provider commit.
- Timeout after provider commit.
- Connection loss after provider commit.
- Rate limiting with a retry hint.
- Provider `5xx` with configurable effect certainty.
- Malformed success responses.
- Duplicate webhooks.
- Delayed and out-of-order webhooks.
- Contradictory test evidence for discrepancy handling.

Fault selection is recorded in test-only diagnostics. The application sees only the same normalized adapter contract it would see from a real provider.

### Real provider adapters are deferred

The MVP ships no real-provider adapter. The deterministic fake and the seeded unreliable simulator are the only implementations, as decided in [ADR-0011](adr/0011-simulated-providers-only-in-mvp.md).

The reasons are specific to what this project demonstrates:

- A clean clone runs every test offline, with no credentials, no network, and no shared sandbox state. That is what makes the benchmark and chaos workloads reproducible by a reviewer rather than only by the author.
- The failure modes that matter here — timeout after the provider committed, connection loss after dispatch, malformed success, duplicate and out-of-order webhooks, contradictory evidence — cannot be requested from a real sandbox on demand. The simulator produces them deterministically from a recorded seed.
- A real sandbox cannot participate in high-volume load tests, so it could never appear in the measured results.

Nothing in this contract is shaped around that omission. The provider-neutral interface, capability model, normalized outcome taxonomy, evidence rules, and the shared conformance suite are all written for a real adapter and are proven by two independent implementations passing the same suite.

A future real adapter is an additive change: implement `PaymentProvider`, declare truthful capabilities, pin an explicit upstream API version, map provider statuses into the normalized taxonomy without letting provider SDK objects escape into domain types, and pass the existing conformance suite. Its sandbox tests would be tagged separately from deterministic CI, use isolated test objects, and bound request volume.

The capability model retains fields no MVP adapter needs, notably `writeIdempotency` and `documentedRetentionSeconds`. They stay because they are what a real adapter must declare, and they remain conformance-tested against the fakes.

## Redaction and retained evidence

Adapters use an explicit allowlist. Permitted normalized fields are:

```text
provider name and account reference
opaque provider payment/operation/event references
operation type
amount and currency
normalized provider status and code
provider and local timestamps
HTTP status
request duration
evidence digest/reference
```

The following are prohibited from logs, traces, domain events, ledger metadata, and ordinary attempt rows:

```text
API keys and webhook secrets
Authorization headers
raw payment credentials
PAN, CVV, bank-account credentials
full request or response bodies
customer names, email addresses, and addresses
provider SDK objects and stack traces containing payloads
```

Redaction runs before serialization to application logs. Failure to redact is treated as a security defect, not an observability tradeoff.

## Required contract tests

Every adapter runs the same provider contract suite. A capability may skip only a test for a feature it truthfully marks unsupported; it may not skip an MVP-required capability.

### Capability and binding

- Startup validation rejects inconsistent capability combinations.
- An adapter cannot execute an unsupported operation.
- Later operations use the payment's original provider and provider account.
- A routing/configuration change does not alter an existing payment.

### Idempotency and attempts

- One hundred identical same-key requests produce one provider-side effect and the same result.
- The same key with changed amount, currency, operation type, or payment reference produces `CONFLICT`.
- Every attempt for an operation uses the identical key.
- A live lease prevents a second dispatch.
- A stale lease before `dispatchMarkedAt` can be reclaimed safely.
- A stale lease after `dispatchMarkedAt` becomes `UNKNOWN` and does not issue a blind write.
- A proven-no-effect retry completes its attempt, returns the same operation to `REQUESTED`, persists `notBefore`, and later dispatches with the identical key; crashes before or after due-command insertion cannot lose the work or dispatch early.

### Result classification

- Business decline maps to `REJECTED`.
- Proven pre-send failure maps to `FAILED` or safe same-operation retry.
- Timeout after provider commit maps to `UNKNOWN`, even though test ground truth is success.
- Malformed success and connection loss after dispatch map to `UNKNOWN`.
- No `FAILED` result exists without `NoEffectProof`.
- No `RETRYABLE_NO_EFFECT` result exists without `NoEffectProof`, `RETRY_SAME_OPERATION`, and a bounded future `retryNotBefore`.
- Amount, currency, identity, or type mismatch creates a discrepancy and no confirmed effect.

### Webhooks and reconciliation

- Valid signatures ingest; tampered signatures do not.
- Duplicate provider event IDs create one durable notification.
- Crash after ingestion but before HTTP response is safe on redelivery.
- Out-of-order webhooks cannot bypass state guards.
- A success webhook and lookup resolve the original operation and posting key once.
- An uncorrelated webhook is parked and does not create domain state.
- `NOT_FOUND` remains inconclusive until the provider-specific consistency window passes.
- Contradictory terminal evidence emits `payment.discrepancy.detected.v1`.
- Each newly deduplicated contradiction increments payment version once; a duplicate does not increment it again or change operation version.
- Authorization-status `ACTIVE` and `INCONCLUSIVE` results only reschedule the expiry case; explicit `EXPIRED` evidence applies once under the no-capture/no-active-operation guards and never changes the terminal authorization operation.

### Rate limiting and isolation

- Provider and account concurrency limits are never exceeded.
- A hot merchant cannot starve another merchant indefinitely.
- Retry hints are respected without sleeping inside a worker.
- A future operation `notBefore` is unclaimable, and due scheduling clears it only in the same transaction that inserts the replacement execution envelope.
- An open circuit before dispatch creates no provider attempt ambiguity.
- One provider outage does not consume another provider's worker capacity.

### Redaction

- Snapshot scans of logs, traces, attempt rows, events, and errors contain no prohibited fields.
- Raw provider bodies cannot be assigned to domain result types.
- Stored evidence remains sufficient to correlate and reproduce the normalized decision.

### Capability semantics

- Manual authorization, full capture, partial capture, cancellation, and multiple partial refunds follow declared capability semantics on every adapter.
- A declared `SAME_KEY_REPLAY` adapter returns the original provider-side effect for an identical same-key request, and the suite proves a new key is never substituted. The declaration is exercised as an adapter property; the MVP never invokes it from `UNKNOWN` or `REQUIRES_REVIEW`.
- Signed event verification and event-ID deduplication work against each adapter's fixtures.
- Startup validation rejects a capability set that declares partial capture without release-remainder semantics, or lookup support that cannot distinguish explicit absence from inconclusive absence.

## MVP provider decisions

### Deadlines and leases

Initial adapter limits are deterministic configuration and are covered by tests:

| Adapter | Request deadline | Processing lease | Maximum in-flight per provider account |
| --- | ---: | ---: | ---: |
| Deterministic fake | 5 seconds | 15 seconds | 100 |
| Seeded unreliable fake | 10 seconds | 30 seconds | 100 |

A future real adapter declares its own row. The constraint below is what any such row must satisfy; it is not specific to the fakes.

The lease is deliberately longer than the request deadline. A benchmark may lower concurrency or increase a deadline/lease pair after measuring latency, but `processingLeaseMs` MUST remain at least the request deadline plus 10 seconds and lease expiry after `dispatchMarkedAt` MUST still produce `UNKNOWN`, never an automatic new-key write.

### Evidence retention

Raw evidence is exceptional, not routine. When an ambiguous, malformed, or disputed provider exchange requires it, store the minimum raw bytes in a separate encrypted object with a per-environment KMS key, deny application-wide listing, grant access only to the incident-investigator role, audit every read, and delete it automatically after 90 days. The database stores a SHA-256 digest, object reference, content length, provider/account reference, and retention deadline. Normalized allowlisted evidence remains in PostgreSQL under the operational retention policy; secrets and raw payment credentials are prohibited even in quarantine.

### Retry and account policy

- A payment permits at most three authorization operations, as specified by the payment state machine. Transport attempts using one operation's stable key do not consume an additional authorization operation.
- Each merchant receives its own logical provider account even though the simulated adapters share process-level state. `providerAccountId` remains mandatory in bindings, deduplication keys, evidence, and rate limits so a later real or connected-account model does not require changing the domain contract.
- Ambiguous-outcome resolution is read-only in the MVP. `SAME_KEY_REPLAY` is recorded and conformance-tested but is not invoked from `UNKNOWN` or `REQUIRES_REVIEW`; only proof-bearing `RETRYABLE_NO_EFFECT` may reschedule a provider write for the same operation and key. See [ADR-0004](adr/0004-read-only-ambiguity-resolution.md).
- A lookup whose adapter contract marks absence as conclusive resolves the operation to `FAILED` with `CONCLUSIVE_PROVIDER_LOOKUP_ABSENCE`; it is not automatically requeued. A later business retry, if the payment state machine permits one, is a new API command and operation. Inconclusive absence remains `UNKNOWN`.
- No real-provider adapter ships in the MVP. See [ADR-0011](adr/0011-simulated-providers-only-in-mvp.md).

## Provider decisions

- [ADR-0004: Ambiguous outcomes resolve read-only](adr/0004-read-only-ambiguity-resolution.md)
- [ADR-0011: Simulated providers only in the MVP; a real adapter is deferred](adr/0011-simulated-providers-only-in-mvp.md)
