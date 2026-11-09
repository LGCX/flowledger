# API and idempotency contract

Status: **Draft**  
Last updated: 2026-11-05

## Purpose

This document defines the merchant-facing HTTP boundary for payment creation, provider-backed payment commands, and payment/operation retrieval. It also fixes the API idempotency semantics that turn retried HTTP requests into at most one durable command acceptance.

The HTTP API accepts work; it does not make a provider call inside the request. `201 Created` means a payment was committed. `202 Accepted` means a provider-backed operation, its requested event, and its execution command were committed—not that the provider operation succeeded.

The normative machine-readable form of this contract is [openapi.yaml](../openapi/openapi.yaml). If prose and OpenAPI disagree, implementation MUST stop until the contract is reconciled; code MUST NOT silently select one interpretation.

## General conventions

- The base path is `/v1`.
- Requests and responses use `application/json` encoded as UTF-8, except errors, which use `application/problem+json`.
- Unknown request fields and duplicate JSON object keys MUST be rejected.
- Public entity IDs use a lower-case type prefix, `_`, and a 26-character upper-case Crockford ULID, for example `pay_01ARZ3NDEKTSV4RRFFQ69G5FAV` and `op_01ARZ3NDEKTSV4RRFFQ69G5FAW`. They are opaque and case-sensitive; clients MUST NOT decode them or infer creation time or ordering from them. Event-envelope IDs are UUIDs under `04-EVENT_CONTRACTS.md`, not public entity IDs.
- Timestamps use UTC RFC 3339 with exactly millisecond precision, for example `2026-11-05T18:44:31.123Z`.
- The API MUST reject raw card numbers, security codes, bank credentials, or other raw payment credentials and MUST NOT echo or log them.
- A payment method reference is an opaque sandbox-provider token. It MUST NOT contain a PAN, CVV, bank credential, or secret.
- A merchant MUST NOT select or override `providerAccountId`; FlowLedger derives it from authenticated merchant configuration.
- Request bodies MUST be bounded before parsing; the initial maximum JSON request body is 64 KiB. Response size is bounded by the OpenAPI field and page limits rather than by a separate 64 KiB cap.

## Authentication, authorization, and tenant scope

Merchant endpoints require:

```http
Authorization: Bearer <credential>
```

The authentication layer maps the credential to one merchant principal and a set of scopes. MVP credentials have the form `fl_test_<locator>_<secret>`, where `locator` is a non-secret, unique 12-character Crockford Base32 lookup value and `secret` is 32 random bytes encoded as unpadded base64url. PostgreSQL stores the locator and an HMAC-SHA-256 digest of the complete credential under a versioned pepper held in Secret Manager; the raw credential is shown once and never stored. Verification uses a constant-time comparison.

Two credentials may be active during a rotation, with an intended overlap no longer than seven days. Revocation is immediate, credential expiry is checked on every request, and every credential carries an explicit allowlist of scopes. The token contains no merchant identity and its locator is not authorization by itself.

These boundary rules are fixed:

- Merchant identity MUST come from the authenticated principal, never from a request body, query parameter, or caller-supplied merchant header.
- `payments:write` is required for payment creation and provider-backed commands.
- `payments:read` is required for payment and operation retrieval.
- Every lookup, uniqueness key, command, and query MUST include the authenticated `merchantId`.
- A resource owned by another merchant MUST appear as `404 RESOURCE_NOT_FOUND`, not `403`, to avoid confirming its existence.
- A valid principal without the required scope receives `403 FORBIDDEN`.
- Missing, expired, or invalid credentials receive `401 AUTHENTICATION_REQUIRED` with an appropriate `WWW-Authenticate` header.
- API credentials, bearer tokens, and provider secrets MUST be redacted from logs and traces.

Platform-operator cross-tenant access belongs to a separate administrative surface. The merchant API defined here MUST NOT accept a tenant override, even from an operator credential.

## Money encoding

All request and response amounts use:

```json
{
  "amountMinor": "10000",
  "currency": "USD"
}
```

Rules:

- `amountMinor` MUST be an unsigned base-10 integer string matching `^(0|[1-9][0-9]*)$`.
- JSON numbers, signs, decimal points, exponent notation, leading zeroes, whitespace, and locale separators are invalid.
- Command amounts MUST be positive. Zero is permitted only in response totals.
- The MVP accepts only `USD` and rejects every other currency.
- A single amount MUST NOT exceed `1000000000000` minor units or a stricter merchant limit.
- FlowLedger uses checked integer arithmetic and MUST reject overflow before committing an idempotency record or business effect.

## Resource representations

### Payment

```json
{
  "id": "pay_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "currency": "USD",
  "provider": "fake-provider",
  "requestedAmountMinor": "10000",
  "authorizedAmountMinor": "0",
  "capturedAmountMinor": "0",
  "refundedAmountMinor": "0",
  "voidedAmountMinor": "0",
  "reservedRefundAmountMinor": "0",
  "unresolvedRefundCount": 0,
  "authorizationOutcome": "NOT_REQUESTED",
  "summaryStatus": "REQUIRES_AUTHORIZATION",
  "activeExclusiveOperationId": null,
  "version": 1,
  "createdAt": "2026-11-05T18:44:31.123Z",
  "updatedAt": "2026-11-05T18:44:31.123Z"
}
```

`summaryStatus` is display-only. Clients MUST use command responses and server-side transition guards rather than treating this derived value as permission to move money.

`activeExclusiveOperationId` identifies the current unresolved `AUTHORIZE`, `CAPTURE`, or `CANCEL` operation, or is null. It deliberately does **not** account for unresolved refunds, which may exist concurrently; the field is named for exactly what it covers so a client cannot read it as "nothing is in flight."

`reservedRefundAmountMinor` is the total held by refund operations that are accepted but not yet resolved, and `unresolvedRefundCount` is how many there are. They are not confirmed money. A client computing remaining refundable value MUST use:

```text
capturedAmountMinor - refundedAmountMinor - reservedRefundAmountMinor
```

See [ADR-0003](adr/0003-exclusive-operations-and-reserved-refunds.md).

Payment responses include:

```http
ETag: "payment-pay_01ARZ3NDEKTSV4RRFFQ69G5FAV-v1"
```

The ETag changes exactly when the payment aggregate version changes under the rules in `03-PAYMENT_STATE_MACHINE.md`.

### Payment operation

```json
{
  "id": "op_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "paymentId": "pay_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "type": "CAPTURE",
  "amountMinor": "10000",
  "currency": "USD",
  "status": "REQUESTED",
  "provider": "fake-provider",
  "providerOperationId": null,
  "resultCode": null,
  "feePolicyVersion": 3,
  "feeAmountMinor": "300",
  "version": 1,
  "createdAt": "2026-11-05T18:45:00.000Z",
  "resolvedAt": null
}
```

Provider secrets, raw provider payloads, internal exception text, and provider-account credentials MUST NOT appear in this representation. A provider operation ID is an opaque reference, not a credential.

`feePolicyVersion` and `feeAmountMinor` are both null for authorization/cancellation. Operation type determines the direction of the fee effect.

For a capture, both are populated at acceptance: the immutable policy version and the exact fee charged.

For a refund, `feePolicyVersion` is populated at acceptance from the capture's snapshot, but `feeAmountMinor` is **null until the operation resolves**. The incremental fee reversal is computed inside the confirming transaction from confirmed cumulative refunds, because concurrent refunds snapshotted at acceptance would collectively over-reverse the fee. A successful refund exposes the exact reversal; a rejected or failed refund keeps `feeAmountMinor` null, because it reversed nothing. See [ADR-0008](adr/0008-fee-recognized-at-capture.md).

Operation responses include an operation ETag:

```http
ETag: "operation-op_01ARZ3NDEKTSV4RRFFQ69G5FAW-v1"
```

## Endpoint catalog

| Method and path | Required scope | Idempotency key | Success |
| --- | --- | --- | --- |
| `POST /v1/payments` | `payments:write` | Required | `201 Created` |
| `POST /v1/payments/{paymentId}/authorizations` | `payments:write` | Required | `202 Accepted` |
| `POST /v1/payments/{paymentId}/captures` | `payments:write` | Required | `202 Accepted` |
| `POST /v1/payments/{paymentId}/cancellations` | `payments:write` | Required | `202 Accepted` |
| `POST /v1/payments/{paymentId}/refunds` | `payments:write` | Required | `202 Accepted` |
| `GET /v1/payments/{paymentId}` | `payments:read` | Not accepted | `200 OK` |
| `GET /v1/payments` | `payments:read` | Not accepted | `200 OK` |
| `GET /v1/operations/{operationId}` | `payments:read` | Not accepted | `200 OK` |
| `GET /v1/payments/{paymentId}/operations` | `payments:read` | Not accepted | `200 OK` |
| `GET /v1/payments/{paymentId}/timeline` | `payments:read` | Not accepted | `200 OK` |

### Create a payment

```http
POST /v1/payments
Authorization: Bearer ...
Idempotency-Key: 0192f4e7-8b30-7c83-b462-c0d5fe8f132a
Content-Type: application/json
```

```json
{
  "amount": {
    "amountMinor": "10000",
    "currency": "USD"
  },
  "paymentMethodRef": "pm_sandbox_123",
  "provider": "fake-provider"
}
```

- `paymentMethodRef` is required and MUST be a provider-issued sandbox token accepted by the selected route.
- `provider` MAY be omitted to use the merchant's configured routing rule. The committed payment response always exposes the selected provider.
- Routing is deterministic within the deployment environment: an explicit `provider` selects the merchant's one active route for that provider code; omission selects the merchant's one active default route. The create transaction reads that route, its active provider account, and the account's one current immutable configuration version together. It never selects an arbitrary active account or fails over to a different route.
- An unknown/unsupported provider name returns `400 UNSUPPORTED_PROVIDER`; a known provider without an active merchant route/account returns `409 PROVIDER_ROUTE_UNAVAILABLE`; and a syntactically valid but provider-incompatible sandbox token returns `400 INVALID_PAYMENT_METHOD_REFERENCE`. These errors occur before an idempotency/business record is committed.
- The server derives and snapshots `providerAccountId` and `feePolicyVersion`; the caller cannot supply them.
- The payment, idempotency record, and `payment.created.v1` outbox event commit atomically.

Success returns the committed Payment representation with:

```http
HTTP/1.1 201 Created
Location: /v1/payments/pay_01ARZ3NDEKTSV4RRFFQ69G5FAV
ETag: "payment-pay_01ARZ3NDEKTSV4RRFFQ69G5FAV-v1"
```

### Authorize a payment

```http
POST /v1/payments/{paymentId}/authorizations
Idempotency-Key: ...
If-Match: "payment-pay_01ARZ3NDEKTSV4RRFFQ69G5FAV-v1"
Content-Type: application/json
```

The request body is `{}`. The operation amount is the payment's immutable requested amount. The command is accepted only under the authorization guards in `03-PAYMENT_STATE_MACHINE.md`.

### Capture a payment

```http
POST /v1/payments/{paymentId}/captures
Idempotency-Key: ...
If-Match: "payment-pay_01ARZ3NDEKTSV4RRFFQ69G5FAV-v3"
Content-Type: application/json
```

```json
{
  "amount": {
    "amountMinor": "10000",
    "currency": "USD"
  }
}
```

The amount is required and may be full or partial. Command acceptance snapshots the exact fee amount and immutable fee-policy version on the operation. One successful capture exhausts the MVP capture capability, including when it is partial.

The amount MUST be at least the bound fee policy's minimum capture amount. A smaller amount returns `422 CAPTURE_BELOW_MINIMUM` and names the minimum in the problem detail, because a policy with a fixed fee component cannot price a capture below that bound. This is a configuration boundary rather than a state conflict, so it is not reported as `409`.

### Cancel an authorization

```http
POST /v1/payments/{paymentId}/cancellations
Idempotency-Key: ...
If-Match: "payment-pay_01ARZ3NDEKTSV4RRFFQ69G5FAV-v3"
Content-Type: application/json
```

The request body is `{}`. Cancellation always requests release of the full remaining authorization; partial cancellation is not supported.

### Refund a payment

```http
POST /v1/payments/{paymentId}/refunds
Idempotency-Key: ...
If-Match: "payment-pay_01ARZ3NDEKTSV4RRFFQ69G5FAV-v5"
Content-Type: application/json
```

```json
{
  "amount": {
    "amountMinor": "2500",
    "currency": "USD"
  }
}
```

Each refund creates a separate operation. Refunds may be in flight concurrently: the MVP places no cap on simultaneously unresolved refunds, and the refundable amount is the only limit.

The guard is evaluated while the payment is locked:

```text
refundedAmountMinor + reservedRefundAmountMinor + requested amount <= capturedAmountMinor
```

A refund that would exceed that bound returns `409 MONETARY_GUARD_FAILED`. Accepting a refund adds its amount to `reservedRefundAmountMinor`; resolution releases the reservation, converting it to `refundedAmountMinor` on success and returning it to available on rejection or definitive failure.

An unresolved refund that becomes `UNKNOWN` keeps holding its reservation, because the provider may yet have applied it. It does not block further refunds against the remaining available amount. See [ADR-0003](adr/0003-exclusive-operations-and-reserved-refunds.md).

### Provider-backed command response

Authorize, capture, cancel, and refund return the committed PaymentOperation representation with:

```http
HTTP/1.1 202 Accepted
Location: /v1/operations/op_01ARZ3NDEKTSV4RRFFQ69G5FAW
ETag: "operation-op_01ARZ3NDEKTSV4RRFFQ69G5FAW-v1"
Retry-After: 1
```

The stored response represents command acceptance and normally has `status=REQUESTED`. It is not rewritten when provider processing later completes. Clients poll `Location` or retrieve the payment for current state.

The acceptance transaction MUST atomically commit:

1. The idempotency record and replayable response.
2. One PaymentOperation with a stable provider idempotency key.
3. The payment's active-operation pointer and incremented aggregate version.
4. The operation-specific `*.requested.v1` event.
5. The `payment.operation.execute.v1` command.

No provider call may occur before this transaction commits.

### Retrieve a payment or operation

`GET /v1/payments/{paymentId}` returns the current confirmed Payment representation and its active exclusive operation reference. `GET /v1/operations/{operationId}` returns the current PaymentOperation representation.

Both endpoints support `If-None-Match`. A matching current ETag returns `304 Not Modified` without a body.

### Retrieve a payment timeline

```http
GET /v1/payments/{paymentId}/timeline
```

Returns one ordered, read-only explanation of everything that happened to a payment: each operation, its provider attempts, the normalized evidence that resolved it, the journal transactions it posted, and the merchant webhook deliveries it produced.

This is the endpoint that makes the system's behavior inspectable without database access, and it is the primary artifact for demonstrating an ambiguous outcome converging on exactly one financial effect.

```json
{
  "paymentId": "pay_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "paymentVersion": 7,
  "entries": [
    {
      "sequence": 1,
      "kind": "PAYMENT_CREATED",
      "occurredAt": "2026-11-05T18:44:31.123Z",
      "paymentVersion": 1,
      "operationId": null,
      "detail": { "requestedAmountMinor": "10000", "currency": "USD" }
    },
    {
      "sequence": 4,
      "kind": "PROVIDER_ATTEMPT",
      "occurredAt": "2026-11-05T18:45:02.900Z",
      "paymentVersion": 3,
      "operationId": "op_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "detail": {
        "attemptNumber": 1,
        "outcomeClass": "AMBIGUOUS",
        "dispatchMarked": true,
        "durationMs": 5004
      }
    },
    {
      "sequence": 7,
      "kind": "LEDGER_POSTING",
      "occurredAt": "2026-11-05T18:47:10.004Z",
      "paymentVersion": 5,
      "operationId": "op_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "detail": {
        "ledgerTransactionId": "ltx_01ARZ3NDEKTSV4RRFFQ69G5FA0",
        "operationType": "CAPTURE",
        "resolutionSource": "RECONCILIATION"
      }
    }
  ],
  "truncated": false
}
```

Rules:

- `kind` is one of `PAYMENT_CREATED`, `OPERATION_ACCEPTED`, `PROVIDER_ATTEMPT`, `PROVIDER_EVIDENCE`, `OPERATION_RESOLVED`, `RECONCILIATION_ACTIVITY`, `DISCREPANCY`, `AUTHORIZATION_EXPIRED`, `LEDGER_POSTING`, `SETTLEMENT`, or `WEBHOOK_DELIVERY`.
- `sequence` is a stable ordinal within one response, derived from database recorded time and a deterministic tiebreak. It is not a durable identifier and MUST NOT be stored by clients.
- Entries are ordered by database-recorded time, never by provider-supplied timestamps.
- The response is bounded. It returns at most 500 entries, newest truncated last, and reports `truncated: true` when a payment exceeded the bound. Collection pagination is not offered here; a payment with more history than this is an operator investigation.
- `detail` is a closed per-`kind` object. It exposes only merchant-safe fields and never provider secrets, raw provider payloads, payment-method references, internal exception text, ledger account identities, or another tenant's data.
- `LEDGER_POSTING` exposes the journal transaction ID, recipe type, and resolution source. Entry-level accounts and amounts are platform-internal and are not exposed to merchants.
- The endpoint is read-only, derived entirely from committed authoritative rows, and carries no ETag, because it aggregates several resources with independent versions.
- `payments:read` is required, and a cross-tenant payment ID returns `404 RESOURCE_NOT_FOUND`.

## Optimistic version preconditions

`If-Match` is optional on provider-backed command endpoints and is not accepted on payment creation. It lets a client assert the Payment version it observed without replacing server-side state and monetary guards.

- The value MUST be exactly one strong Payment ETag returned by this API. Weak tags and lists of tags are rejected.
- For a new idempotency key, a nonmatching current ETag returns `412 PAYMENT_VERSION_MISMATCH` and creates no operation, outbox row, or idempotency record.
- Omitting `If-Match` permits the command to serialize on the payment and evaluate guards against the current version.
- When present, `If-Match` is semantic request input and participates in the idempotency hash.
- Exact idempotency replay is resolved before comparing the current Payment version. Therefore an exact replay returns the original stored response even if the payment has since advanced.
- A replay that changes or removes the original `If-Match` value has a different canonical hash and returns `409 IDEMPOTENCY_CONFLICT`.

`If-Match` is an additional lost-update defense. It does not authorize a transition, bypass the exclusion model or the refund reservation guard, or replace database locking/versioned compare-and-swap.

Including `If-Match` in the hash diverges deliberately from implementations that hash the body only. A retry that refreshes or drops the header is a different semantic request and conflicts, which is what prevents a retry from silently converting a version-guarded command into an unguarded one. Clients MUST retry byte-identically, header included. See [ADR-0006](adr/0006-if-match-in-idempotency-hash.md).

## API idempotency contract

### Required commands and key format

`Idempotency-Key` is mandatory on every merchant `POST` in this document. It is not accepted on `GET` and is not used for provider webhook ingestion.

Keys:

- MUST contain 16 to 128 characters from `[A-Za-z0-9._:-]`.
- Are case-sensitive and opaque.
- MUST NOT contain credentials, customer data, card data, timestamps with business meaning, or other sensitive content.
- SHOULD be generated with at least 128 bits of randomness, such as a UUIDv4 or UUIDv7.

A missing or malformed key is rejected before command execution.

### Scope and uniqueness

The database uniqueness boundary is:

```text
(merchant_id, command_type, idempotency_key)
```

`command_type` is one of `CREATE_PAYMENT`, `AUTHORIZE`, `CAPTURE`, `CANCEL`, or `REFUND`.

Consequences:

- The same key cannot identify two payments for the same command type and merchant.
- Reusing one key on two different payment IDs for the same command type is a conflict because the payment ID is part of the request hash.
- Different merchants may independently use the same key.
- The same merchant may reuse the textual key for a different command type, although clients SHOULD use a fresh key for every logical command.

### Canonical request hash

FlowLedger stores a SHA-256 hash of a strict canonical semantic request. The hash input contains:

1. API major version.
2. HTTP method.
3. Canonical route template and normalized path identifiers.
4. `command_type`.
5. The validated request body serialized with JSON Canonicalization Scheme semantics.
6. The exact `If-Match` Payment version precondition when supplied, or an explicit null marker when omitted.

Before hashing, FlowLedger MUST:

- Authenticate and resolve the merchant.
- Reject malformed JSON, duplicate keys, unknown fields, invalid Unicode, and invalid amount encodings.
- Apply schema defaults explicitly; omitted and explicit-default forms MUST either canonicalize identically or be rejected as distinct by the schema.
- Normalize no opaque value beyond schema-defined canonicalization. IDs, payment method references, and idempotency keys remain case-sensitive.

Authorization credentials, request IDs, correlation IDs, trace headers, connection metadata, and content formatting do not participate in the hash. The merchant is part of the uniqueness scope rather than the hash.

Semantically identical JSON with different whitespace or object-key order produces the same hash. A different payment ID, amount, currency, provider choice, payment-method reference, or version precondition produces a different hash.

### Atomic ownership and concurrent requests

The idempotency record, accepted domain effect, outbox records, status code, replayable response body, and replayable headers MUST commit in one PostgreSQL transaction.

For two concurrent requests with the same scope and key:

1. Exactly one transaction may own first execution.
2. The other request waits on the unique row/constraint for a bounded period.
3. If the owner commits, the waiter compares canonical hashes and either replays the stored result or returns an idempotency conflict.
4. If the owner rolls back, a waiter may acquire ownership and execute; no committed business effect existed.
5. If the bounded wait expires while ownership remains unresolved, return `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` with `Retry-After: 1`. The waiting request MUST NOT create another operation or provider action.

No externally visible `IN_PROGRESS` row may be committed separately from the business transaction. A crashed transaction rolls back both ownership and effects.

Provider processing after a `202` response is not an in-progress idempotency request. Once acceptance commits, exact HTTP retries replay the stored `202` even if the PaymentOperation is now `PROCESSING`, terminal, `UNKNOWN`, or `REQUIRES_REVIEW`.

### Response replay

For the same scope, key, and canonical hash, FlowLedger returns the original committed command-acceptance result:

- The original HTTP status (`201` or `202`).
- The original response body.
- The original `Location`, content type, and representation ETag, if present.
- The original workflow `X-Correlation-Id`.

The replay adds:

```http
Idempotent-Replay: true
```

`Date` and `X-Request-Id` are generated for the new HTTP attempt. A replayed representation may be older than current resource state by design; the client follows `Location` to read current state.

If the key exists but the canonical hash differs, return `409 IDEMPOTENCY_CONFLICT`. The response MUST NOT reveal the original request body, hash, credentials, or another tenant's information. No new business effect is created.

### Which responses are stored

Only a successfully committed `201 Created` or `202 Accepted` result becomes replayable.

Authentication failures, schema errors, missing resources, state/monetary guard failures, version-precondition failures, rate limits, idempotency conflicts, and server failures are not stored as command results. Retrying such a request with the same key is allowed if no concurrent or committed owner exists; if the semantic request changes after a result has committed, it conflicts.

This rule prevents a transient validation or infrastructure error from permanently consuming a key while preserving at-most-one accepted command.

### Retention and expired replay

- The complete replay record—canonical hash, status, safe headers, and response body—is retained for 90 days from its original commit. Replays do not extend this period.
- After 90 days, FlowLedger retains a compact tombstone containing the merchant, command type, key, request hash, original resource identity, and commit time for the lifetime of the merchant in the MVP.
- A key is never reusable within its uniqueness scope.
- After the full response expires, any reuse returns `409 IDEMPOTENCY_KEY_EXPIRED` and a safe `resourceLocation` when the original resource still exists. It MUST NOT execute the command again.
- Tombstones MUST NOT contain request bodies, credentials, payment-method references, or other sensitive values.

This favors duplicate-payment prevention over transparent replay after the documented window. Implementations that expire the key itself allow an old retry to become a new command, which for a money-moving command is the exact failure idempotency exists to prevent. See [ADR-0009](adr/0009-idempotency-keys-never-expire.md).

## Request and correlation identifiers

Every response includes a unique server-generated:

```http
X-Request-Id: req_01ARZ3NDEKTSV4RRFFQ69G5FAX
```

Clients MAY provide `X-Correlation-Id` using 16 to 128 characters from `[A-Za-z0-9._:-]`. Otherwise FlowLedger generates one.

- The correlation ID established by the first committed command is stored with the idempotency result and propagated to its operation, provider attempts, journal posting, outbox messages, traces, and merchant webhook deliveries.
- A later exact replay returns the original workflow correlation ID even if the retry supplies a different one.
- Correlation and request IDs are observability data, not authentication, authorization, idempotency, or ordering keys.
- Invalid client correlation IDs are rejected with `400 INVALID_CORRELATION_ID` rather than sanitized.
- `traceparent` MAY be accepted under the W3C Trace Context format but never participates in business identity or request hashing.

## Canonical error format

Errors use `application/problem+json`:

```json
{
  "type": "urn:flowledger:problem:idempotency-conflict",
  "title": "Idempotency key conflicts with an accepted command",
  "status": 409,
  "code": "IDEMPOTENCY_CONFLICT",
  "detail": "Use the original request or submit this command with a new key.",
  "instance": "/v1/payments/pay_01ARZ3NDEKTSV4RRFFQ69G5FAV/captures",
  "requestId": "req_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "correlationId": "cor_01ARZ3NDEKTSV4RRFFQ69G5FAY"
}
```

`code` is the stable programmatic identifier. `title` and `detail` are human-facing and may gain clarification without a version change. Validation failures MAY add an `errors` array containing safe JSON pointers and reason codes; they MUST NOT echo credentials or prohibited payment data.

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `INVALID_REQUEST` | Malformed JSON, duplicate/unknown fields, or schema failure |
| 400 | `INVALID_AMOUNT` | Amount encoding, range, positivity, or currency is invalid |
| 400 | `PROHIBITED_PAYMENT_DATA` | Raw credentials or card/bank data were submitted |
| 400 | `UNSUPPORTED_PROVIDER` | Caller selected a provider name not offered by this deployment |
| 400 | `INVALID_PAYMENT_METHOD_REFERENCE` | Sandbox token is syntactically valid but incompatible with the selected provider route |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Mutating request omitted the key |
| 400 | `INVALID_IDEMPOTENCY_KEY` | Key format is invalid |
| 400 | `INVALID_CORRELATION_ID` | Caller-supplied correlation ID is invalid |
| 400 | `INVALID_CURSOR` | Pagination cursor is invalid, expired, or belongs to another query scope |
| 401 | `AUTHENTICATION_REQUIRED` | Credential is missing, invalid, or expired |
| 401 | `INVALID_PROVIDER_SIGNATURE` | Provider webhook signature or replay-window validation failed |
| 403 | `FORBIDDEN` | Principal lacks the required scope |
| 404 | `RESOURCE_NOT_FOUND` | Resource is absent or belongs to another merchant |
| 409 | `IDEMPOTENCY_CONFLICT` | Key was committed with different semantic input |
| 409 | `IDEMPOTENCY_REQUEST_IN_PROGRESS` | Concurrent owner has not committed or rolled back yet |
| 409 | `IDEMPOTENCY_KEY_EXPIRED` | Key tombstone remains but replay body has expired |
| 409 | `ACTIVE_OPERATION_EXISTS` | Payment has an unresolved exclusive operation, or an exclusive command was sent while a refund is unresolved |
| 409 | `INVALID_PAYMENT_STATE` | Lifecycle guards reject the requested command |
| 409 | `MONETARY_GUARD_FAILED` | Capture amount exceeds the authorized amount, or `refunded + reserved + requested` exceeds the captured amount |
| 409 | `PROVIDER_ROUTE_UNAVAILABLE` | Provider is supported but the merchant has no active configured route/account |
| 412 | `PAYMENT_VERSION_MISMATCH` | Supplied `If-Match` does not match current Payment version |
| 413 | `REQUEST_TOO_LARGE` | Body exceeds the configured bound |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Request is not supported JSON |
| 422 | `CAPTURE_BELOW_MINIMUM` | Capture amount is below the bound fee policy's minimum capture amount |
| 429 | `RATE_LIMITED` | Merchant or credential rate limit exceeded |
| 500 | `INTERNAL_ERROR` | Unexpected failure with no committed acceptance result |
| 503 | `SERVICE_UNAVAILABLE` | API cannot durably accept work |

`429` and retryable `503` responses SHOULD include `Retry-After`. A provider outage does not by itself make command acceptance unavailable; accepted commands remain durable for asynchronous execution.

## Pagination

Collection endpoints use opaque cursor-based pagination, never numeric offsets.

```http
GET /v1/payments?limit=50&cursor=opaque
GET /v1/payments/{paymentId}/operations?limit=50&cursor=opaque
```

- `limit` defaults to 50 and MUST be between 1 and 100.
- Payments and operations are ordered by `(createdAt DESC, id DESC)`.
- The cursor encodes the authenticated merchant, endpoint, normalized filters, original snapshot upper bound, and last sort tuple. It MUST be integrity protected and MUST NOT expose database keys or tenant data in plaintext.
- A cursor from another merchant, endpoint, or filter set is invalid.
- Newer inserts after the first page's snapshot upper bound do not appear in that traversal.
- Resource state may change between pages, but an item is not duplicated or skipped merely because its status changed.
- Cursors expire after 24 hours. An invalid or expired cursor returns `400 INVALID_CURSOR`.

Responses use:

```json
{
  "data": [],
  "page": {
    "nextCursor": null,
    "hasMore": false
  }
}
```

`GET /v1/payments/{paymentId}/operations` verifies payment ownership before returning an empty page. A cross-tenant payment ID returns `404`, not an empty collection.

## Provider webhook ingestion boundary

Provider callbacks use a separate ingress route:

```http
POST /v1/provider-webhooks/{provider}/{endpointKey}
```

This route is not a merchant command endpoint:

- It does not accept merchant bearer authentication, `Idempotency-Key`, `If-Match`, or caller-selected merchant identity.
- `endpointKey` is a random, opaque, non-secret ingress locator assigned by FlowLedger. `(provider, endpointKey)` selects exactly one webhook configuration and signing-secret version before signature verification. One configuration may serve one logical provider account or an allowlisted set backed by the same external sandbox account. The key is routing data, never authentication; the signature remains mandatory.
- The receiver authenticates the exact raw request bytes with the selected provider-specific signature and timestamp policy before parsing or acknowledging the notification.
- After verification, the processor correlates immutable provider object references to an existing operation and proves that its provider account is allowlisted for the selected endpoint. The merchant comes from that stored operation/payment binding, never an untrusted header or payload override. An uncorrelated valid event is parked without inventing tenant state.
- The receiver requires the provider's stable event identifier and deduplicates on webhook endpoint plus that identifier. Providers without stable signed event IDs are ineligible for the MVP.
- A valid new or duplicate notification receives `202 Accepted` only after its unique receipt record commits durably. Duplicate receipt creates no second payment or ledger effect. Processing is asynchronous; a notification sweeper is the durable recovery owner if no immediate processing nudge is published.
- Invalid signatures receive `401`; malformed authenticated payloads receive `400`; unsupported providers receive `404`.
- Raw bytes may exist transiently for signature verification. Storage and logs contain only an allowlisted, redacted normalized record and a digest unless the provider contract explicitly requires encrypted evidence retention.
- Webhook receipt is evidence, not permission to bypass the payment state machine. Resolution locks the original operation and uses the same idempotent terminal transition and ledger posting path as a direct response or reconciliation.
- A webhook response never exposes merchant payment state.

Merchant-facing webhook delivery is asynchronous and outside this ingress endpoint. Its durable delivery identity, retry behavior, failure recovery, and persistence are governed by the event, failure/recovery, and data-model contracts.

## Normative acceptance criteria

The API contract is satisfied only when all of the following hold:

1. Every merchant POST requires a valid idempotency key and commits its replay record atomically with its accepted domain effect and outbox records.
2. A committed create returns `201`; every committed provider-backed command returns `202`; no HTTP request waits for a provider result.
3. Exact retries create no additional payment, operation, event, execution command, provider request, or ledger effect.
4. Same-scope key reuse with different semantic input always returns `409` and creates no effect.
5. Concurrent identical requests converge on one stored result; an unresolved waiter times out safely without becoming a second owner.
6. Payment state and monetary guards execute while the aggregate is locked or under a successful version compare-and-swap.
7. `If-Match` failure creates neither an idempotency record nor an operation; an exact replay bypasses current-version comparison and returns the original result.
8. Merchant identity comes only from authentication, and cross-tenant resource identifiers return `404` without timing-independent guarantees being weakened by a secondary unscoped lookup.
9. All amounts use validated minor-unit strings and are processed without floating point.
10. API, error, log, trace, and webhook paths exclude raw payment credentials and secrets.
11. GET responses reflect committed authoritative state and expose aggregate/operation ETags.
12. Provider webhook duplicates and races resolve through the original operation and cannot post a journal transaction twice.
13. After replay-body expiry, a tombstone prevents key reuse and no new command is accepted under that scope.

## Required implementation tests

### Endpoint and schema tests

- Validate every request and response against the checked-in OpenAPI schema.
- Prove unknown fields, duplicate JSON keys, JSON-number amounts, leading-zero amounts, non-USD currencies, zero command amounts, overflow, and oversized bodies are rejected before effects commit.
- Prove raw card-like input is rejected and absent from application logs, traces, errors, idempotency records, and events.
- Prove `201`, `202`, `Location`, `Retry-After`, ETag, and content types match this contract.

### Authentication and tenant-isolation tests

- Exercise missing, invalid, expired, read-only, and write-capable credentials.
- Attempt every GET and POST with another merchant's payment and operation IDs; prove `404` and no mutation.
- Attempt to smuggle merchant or provider-account identity through bodies, headers, and query parameters; prove it cannot alter tenant scope.

### Idempotency tests

- Retry each command with byte-identical and semantically identical differently formatted JSON; prove the stored response is replayed.
- Change each semantic input independently—payment ID, amount, currency, provider, payment-method reference, and `If-Match`—and prove `409 IDEMPOTENCY_CONFLICT`.
- Send at least 100 concurrent identical requests and prove one accepted effect, one operation, one requested event, and one execution command.
- Race different payloads under one key and prove at most one commits while all others conflict.
- Inject failure before and after each database write and at commit-response loss; prove rollback or exact replay without duplicate effects.
- Hold the owner transaction beyond the wait budget and prove `IDEMPOTENCY_REQUEST_IN_PROGRESS` with no second owner.
- Advance the payment after acceptance, replay the original key, and prove the original response is returned while GET shows current state.
- Age a replay record past 90 days and prove its tombstone returns `IDEMPOTENCY_KEY_EXPIRED` and prevents execution.
- Prove the same text key is isolated across merchants and scoped by command type.

### Concurrency and version tests

- Race commands with the same Payment ETag; prove transactional state guards permit only a valid winner.
- Prove stale `If-Match` returns `412` without consuming the key.
- Prove omitted `If-Match` still serializes correctly and cannot bypass the exclusion model or monetary guards.
- Race refunds against the last refundable amount and prove confirmed plus reserved work cannot over-refund. Assert the losing request received `MONETARY_GUARD_FAILED` from the locked guard, not a uniqueness conflict.
- Accept several refunds concurrently inside the refundable amount; prove each returns `202`, `reservedRefundAmountMinor` equals their sum, and `unresolvedRefundCount` equals their count.
- Leave one refund `UNKNOWN`; prove further refunds against the remaining available amount are accepted and the reserved portion stays unavailable.
- Reject or fail an unresolved refund; prove the reservation is released, `feeAmountMinor` stays null, and the released amount becomes refundable again.
- Attempt an exclusive command while a refund is unresolved and prove `409 ACTIVE_OPERATION_EXISTS`; prove the reverse ordering is rejected too.
- Attempt a capture below the policy minimum and prove `422 CAPTURE_BELOW_MINIMUM` with no idempotency, operation, or outbox row.

### Retrieval and pagination tests

- Prove Payment and PaymentOperation ETags change only with their respective versions and `If-None-Match` returns `304` correctly.
- Prove the timeline endpoint returns entries ordered by database-recorded time, includes every operation/attempt/evidence/posting/delivery for the payment, truncates at the documented bound with `truncated: true`, exposes no prohibited field in any `detail` variant, and returns `404` for a cross-tenant payment ID.
- Prove a timeline for an ambiguous-then-reconciled capture shows the ambiguous attempt, the reconciliation evidence, and exactly one `LEDGER_POSTING` entry.
- Traverse collections while inserting newer resources and changing statuses; prove snapshot traversal has no duplicates or omissions caused by those changes.
- Reject altered, expired, cross-merchant, cross-endpoint, and filter-mismatched cursors.

### Provider webhook boundary tests

- Verify signatures against exact raw bytes and reject tampering, stale timestamps, wrong secrets, and oversized payloads.
- Deliver one provider event concurrently and repeatedly; prove one durable receipt and at most one terminal operation/ledger effect.
- Race a webhook with a direct provider response and reconciliation; prove they converge through the original operation.
- Confirm webhook errors and stored evidence contain no provider secret, raw payment credential, or unallowlisted personal data.

## MVP API decisions

- **Payment-method references:** The deterministic fake provider accepts only generated `pm_fake_...` tokens and the unreliable simulator accepts the same token family. The routing decision determines which validator applies; raw payment credentials remain forbidden. No real-provider token format is accepted in the MVP, per [ADR-0011](adr/0011-simulated-providers-only-in-mvp.md).
- **Settlement surface:** Settlement batches are ledger and operator state in the MVP. A merchant-facing settlement list endpoint is deferred; the timeline endpoint exposes a payment's `SETTLEMENT` entry so a merchant can see that its captured value settled. See [ADR-0012](adr/0012-ledger-only-settlement.md).
- **Contract direction:** The checked-in OpenAPI 3.1 document is the source contract. TypeScript request/response types and test clients are generated from it. NestJS route metadata is compared with the checked-in document in CI; implementation-generated drift fails the build rather than overwriting the contract.
- **Credential policy:** The test-key format, digest, scope, rotation, expiry, and revocation rules above are the MVP authentication contract. A later full threat model may strengthen storage or issuance without weakening tenant derivation or request authorization.

## API decisions

- [ADR-0003: Exclusive operation classes with reserved refund amounts](adr/0003-exclusive-operations-and-reserved-refunds.md)
- [ADR-0006: `If-Match` participates in the canonical idempotency hash](adr/0006-if-match-in-idempotency-hash.md)
- [ADR-0008: Fee recognized at capture; refund reversal computed at confirmation](adr/0008-fee-recognized-at-capture.md)
- [ADR-0009: API idempotency keys never expire; replay bodies expire at 90 days](adr/0009-idempotency-keys-never-expire.md)
