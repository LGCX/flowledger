# Event and command contracts

Status: **Draft**  
Last updated: 2026-11-05

## Guarantee

FlowLedger assumes **at-least-once delivery**. It does not claim exactly-once transport.

It provides effectively-once financial effects through:

- Transactional outbox publication.
- Consumer inbox deduplication.
- Durable payment operations.
- Stable provider idempotency keys.
- Database uniqueness constraints.
- Idempotent ledger posting.
- Reconciliation.

A state change and its outgoing message commit in one PostgreSQL transaction. Duplicate publication and delivery are expected behavior.

## Commands versus events

- A **command** is imperative, has one logical handler, and requests work. Example: `payment.operation.execute.v1`.
- An **event** is a past-tense fact, may have zero or more consumers, and MUST NOT be retracted. Example: `payment.capture.succeeded.v1`.

Commands do not prove that a business effect occurred. Events describing confirmed financial effects are written only after those effects commit.

## Envelope

All internal commands and events use this envelope:

```json
{
  "id": "0192f4e7-8b30-7c83-b462-c0d5fe8f132a",
  "kind": "EVENT",
  "type": "payment.created.v1",
  "schemaVersion": 1,
  "source": "flowledger.payment",
  "occurredAt": "2026-11-05T18:44:31.123Z",
  "recordedAt": "2026-11-05T18:44:31.130Z",

  "merchantId": "mer_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "aggregateType": "payment",
  "aggregateId": "pay_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "aggregateVersion": 1,
  "orderingKey": "pay_01ARZ3NDEKTSV4RRFFQ69G5FAV",

  "correlationId": "cor_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "causationId": "cmd_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",

  "data": {
    "paymentId": "pay_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "requestedAmount": {
      "amountMinor": "10000",
      "currency": "USD"
    },
    "provider": "fake-provider",
    "providerAccountId": "pacc_01ARZ3NDEKTSV4RRFFQ69G5FAT",
    "feePolicyVersion": 3
  }
}
```

Envelope rules:

- `id` is globally unique, immutable, and stable across redelivery.
- `kind` is `COMMAND` or `EVENT`.
- `type` uses lower-case dot-separated domain names and ends in `.vN`.
- `schemaVersion` MUST equal the numeric suffix in `type`.
- `occurredAt` is when the domain fact occurred; `recordedAt` is when it was durably stored.
- Consumers MUST NOT infer ordering from timestamps.
- `merchantId` is mandatory for merchant-scoped messages.
- Every version-advancing payment event carries the new payment aggregate version. Operation acceptance, ambiguity/review, terminal resolution, verified authorization expiry, and each newly deduplicated discrepancy advance it exactly once.
- Payment commands carry the payment version observed when the command was created. Retries/rescheduling may therefore repeat a command version; event-contiguity logic MUST NOT be applied to commands.
- Payment messages use payment ID as `orderingKey`.
- `settlement.batch.posted.v1` uses `aggregateType=settlement_batch`, the batch ID as `aggregateId`, the merchant ID as `orderingKey`, and `aggregateVersion=1`. A settlement batch is immutable and emits exactly one event, so it has no version sequence; consumers MUST NOT apply payment-style contiguity logic to it.
- `merchant.webhook.deliver.v1` carries no `orderingKey`.
- Monetary amounts are unsigned decimal strings in minor units.
- `correlationId` remains stable across one end-to-end workflow.
- `causationId` points to the message or API command that directly caused this message.
- Unknown envelope or payload fields and missing required fields are schema errors. Producers validate strictly before writing the outbox, and consumers validate strictly before applying effects.

## Sensitive data

Messages MUST NOT contain:

- Card numbers, security codes, bank credentials, or payment secrets.
- Provider API keys or webhook signing secrets.
- Complete raw provider requests or responses.
- Customer names, email addresses, or other personal data not required by the consumer contract.

Provider identifiers are opaque strings. Merchant-facing webhook payloads use a separate explicit allowlist and never forward the internal envelope wholesale.

## Initial command catalog

| Type | Producer | Logical consumer | Data | Ordering key |
| --- | --- | --- | --- | --- |
| `payment.operation.execute.v1` | Payment API/domain | Payment worker | `operationId`, `paymentId`, `provider`, `expectedPaymentVersion` | Payment ID |
| `payment.operation.reconcile.v1` | Payment worker or stale-operation sweep | Reconciliation worker | `operationId`, `reason`, `notBefore`, `reconciliationAttempt` | Payment ID |
| `merchant.webhook.deliver.v1` | Domain-event projector | Webhook dispatcher | `deliveryId`, `endpointId`, `domainEventId` | None |

Command payloads contain stable identifiers, not mutable snapshots. The consumer reloads authoritative state before acting.

Merchant webhook delivery deliberately carries **no** ordering key. Keying by endpoint ID would serialize every delivery for one merchant's endpoint behind the slowest one, making a single unresponsive endpoint the throughput limit for that merchant's entire notification stream. Merchants order for themselves using `paymentVersion` in the payload, which is the same mechanism internal consumers use and is more reliable than transport ordering. Delivery remains at-least-once and per-endpoint fairness is enforced by the dispatcher's concurrency controls rather than by broker ordering.

## Initial event catalog

| Type | Meaning | Primary consumers |
| --- | --- | --- |
| `payment.created.v1` | Payment aggregate committed | Operator projection, merchant webhook projector |
| `payment.authorization.requested.v1` | Authorization operation durably accepted | Audit/operator projection |
| `payment.authorization.succeeded.v1` | Provider authorization confirmed | Operator projection, merchant webhook projector |
| `payment.authorization.rejected.v1` | Provider made a definitive decline | Operator projection, merchant webhook projector |
| `payment.authorization.failed.v1` | Authorization definitively had no provider effect | Operator projection, alerting as appropriate |
| `payment.authorization.expired.v1` | Provider-reported authorization expiration recorded | Operator projection, merchant webhook projector |
| `payment.capture.requested.v1` | Capture operation durably accepted | Audit/operator projection |
| `payment.capture.succeeded.v1` | Capture and internal journal posting committed | Merchant webhook projector, analytics |
| `payment.capture.rejected.v1` | Provider definitively rejected capture | Operator projection, merchant webhook projector |
| `payment.capture.failed.v1` | Capture definitively had no provider effect | Operator projection, alerting |
| `payment.authorization.cancellation.requested.v1` | Cancellation operation durably accepted | Audit/operator projection |
| `payment.authorization.cancellation.succeeded.v1` | Cancellation confirmed | Merchant webhook projector |
| `payment.authorization.cancellation.rejected.v1` | Provider definitively rejected cancellation | Operator projection, merchant webhook projector |
| `payment.authorization.cancellation.failed.v1` | Cancellation definitively had no provider effect | Operator projection, alerting |
| `payment.refund.requested.v1` | Refund operation durably accepted | Audit/operator projection |
| `payment.refund.succeeded.v1` | Refund and internal journal posting committed | Merchant webhook projector, analytics |
| `payment.refund.rejected.v1` | Provider definitively rejected refund | Operator projection, merchant webhook projector |
| `payment.refund.failed.v1` | Refund definitively had no provider effect | Operator projection, alerting |
| `payment.operation.reconciliation.required.v1` | Operation outcome is ambiguous | Reconciliation scheduler, alerting |
| `payment.operation.review.required.v1` | Automated resolution exhausted policy | Operator queue, alerting |
| `payment.discrepancy.detected.v1` | Provider and internal evidence conflict | Operator queue, alerting |
| `ledger.transaction.posted.v1` | Immutable journal transaction committed | Analytics and audit projections |
| `settlement.batch.posted.v1` | Settlement batch committed, moving merchant clearing to payable | Operator projection, analytics |

Reconciliation that confirms an outcome emits the same specific terminal event that a direct provider response would emit. It MUST include `resolutionSource` as `API_RESPONSE`, `PROVIDER_WEBHOOK`, or `RECONCILIATION`.

## Merchant webhook wire contract

Merchant webhooks are a public projection of selected domain events, not a copy of the internal envelope. The wire payload MUST validate against [`merchant-event.v1.schema.json`](../schemas/webhooks/merchant-event.v1.schema.json). It exposes only payment/operation identifiers, the public event outcome, amount, confirmed totals, summary status, and payment version; provider identifiers, evidence, internal errors, journal accounts, credentials, and raw internal envelopes are excluded.

The MVP public event allowlist is deliberately small. `payment.created.v1` is excluded: the merchant just issued that command synchronously and received `201 Created` with the committed representation, so a webhook for it is pure noise that every merchant integration would have to filter. Notifications exist for outcomes the merchant could not already know.

`settlement.batch.posted.v1` is also excluded from the MVP allowlist. Its public shape does not fit the payment/operation/outcome correlation this contract enforces, and a merchant-facing settlement notification is deferred with the merchant settlement endpoint.

| Public type | Operation type | Public outcome |
| --- | --- | --- |
| `payment.authorization.succeeded.v1` | `AUTHORIZE` | `SUCCEEDED` |
| `payment.authorization.rejected.v1` | `AUTHORIZE` | `REJECTED` |
| `payment.authorization.expired.v1` | `AUTHORIZE` | `EXPIRED` |
| `payment.capture.succeeded.v1` | `CAPTURE` | `SUCCEEDED` |
| `payment.capture.rejected.v1` | `CAPTURE` | `REJECTED` |
| `payment.authorization.cancellation.succeeded.v1` | `CANCEL` | `SUCCEEDED` |
| `payment.authorization.cancellation.rejected.v1` | `CANCEL` | `REJECTED` |
| `payment.refund.succeeded.v1` | `REFUND` | `SUCCEEDED` |
| `payment.refund.rejected.v1` | `REFUND` | `REJECTED` |

The projector snapshots the validated payload, endpoint URL, subscribed event type, signing-secret version reference, and payload SHA-256 digest into one immutable delivery record. A later endpoint or secret rotation does not change an existing delivery. One endpoint/domain-event pair creates at most one delivery.

Every HTTP attempt sends:

```http
Content-Type: application/json
FlowLedger-Webhook-Id: whd_01ARZ3NDEKTSV4RRFFQ69G5FAS
FlowLedger-Webhook-Timestamp: 1793904271
FlowLedger-Webhook-Signature: v1=<lowercase-hex-hmac-sha256>
User-Agent: FlowLedger-Webhooks/1
```

For one attempt, let `rawBody` be the exact transmitted UTF-8 bytes and let `timestamp` be the decimal Unix seconds in the header. The signature input is the byte concatenation:

```text
timestamp + "." + deliveryId + "." + rawBody
```

`FlowLedger-Webhook-Signature` is `v1=` followed by the lower-case hexadecimal HMAC-SHA-256 of that input using the delivery's snapshotted secret version. Receivers SHOULD reject timestamps outside a five-minute tolerance and deduplicate the stable delivery ID. FlowLedger may recompute the timestamp/signature for a retry, but the delivery ID and body bytes remain unchanged. Signature comparison is constant-time; multiple comma-separated `v1=` values are accepted during receiver-side secret rotation.

Delivery behavior is fixed:

- Payloads and responses are bounded to 64 KiB; the connection plus response deadline is 10 seconds.
- Production endpoint URLs require HTTPS. Redirects are never followed. Resolution to loopback, link-local, private, or metadata-service addresses is rejected outside explicitly isolated local tests.
- Any `200` through `299` response is terminal success.
- Network failures, timeouts, `408`, `425`, `429`, and `500` through `599` are retryable. A valid `Retry-After` is honored up to one hour; otherwise the messaging backoff policy applies with jitter.
- Other `300` through `499` responses are terminal delivery failures. They do not change the originating payment or event.
- Delivery is at least once. Attempts are append-only and the terminal delivery state is auditable.
- Endpoint configuration is seeded or changed through separately authenticated operator tooling in the MVP; it is not part of the merchant API contract.
- Deliveries are not broker-ordered. A merchant receiving two notifications for one payment orders them by `data.paymentVersion`, and a merchant that needs a guaranteed-current view reads the payment or its timeline.

## Capture event example

```json
{
  "id": "0192f4e7-8b30-7c83-b462-c0d5fe8f132a",
  "kind": "EVENT",
  "type": "payment.capture.succeeded.v1",
  "schemaVersion": 1,
  "source": "flowledger.payment",
  "occurredAt": "2026-11-05T18:44:31.123Z",
  "recordedAt": "2026-11-05T18:44:31.130Z",
  "merchantId": "mer_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "aggregateType": "payment",
  "aggregateId": "pay_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "aggregateVersion": 5,
  "orderingKey": "pay_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "correlationId": "cor_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "causationId": "op_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "data": {
    "operationId": "op_01ARZ3NDEKTSV4RRFFQ69G5FAX",
    "paymentId": "pay_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "operationType": "CAPTURE",
    "outcome": "SUCCEEDED",
    "provider": "fake-provider",
    "providerAccountId": "pacc_01ARZ3NDEKTSV4RRFFQ69G5FAY",
    "providerIdempotencyKey": "flowledger:test:fake-provider:op_01ARZ3NDEKTSV4RRFFQ69G5FAX",
    "providerPaymentId": "provider_payment_123",
    "providerOperationId": "provider_capture_123",
    "amount": {
      "amountMinor": "10000",
      "currency": "USD"
    },
    "totalsAfter": {
      "requestedAmountMinor": "10000",
      "authorizedAmountMinor": "10000",
      "capturedAmountMinor": "10000",
      "refundedAmountMinor": "0",
      "voidedAmountMinor": "0",
      "currency": "USD"
    },
    "resolutionSource": "API_RESPONSE",
    "resultCode": null,
    "ledgerTransactionId": "ltx_01ARZ3NDEKTSV4RRFFQ69G5FA0",
    "evidence": {
      "source": "API_RESPONSE",
      "providerObservedAt": "2026-11-05T18:44:31.120Z",
      "receivedAt": "2026-11-05T18:44:31.123Z",
      "providerEventId": null,
      "redactedEvidenceRef": "pev_01ARZ3NDEKTSV4RRFFQ69G5FA1"
    },
    "normalizedError": null,
    "noEffectProof": null,
    "feeAmountMinor": "300"
  }
}
```

Resulting totals are included for projection convenience. Consumers MUST still treat the payment service as authoritative when rebuilding or resolving a discrepancy.

## Transactional outbox

Every outgoing command or event is inserted into the outbox in the same database transaction as its causal state change.

The relay:

1. Claims unpublished rows with bounded leases and `SKIP LOCKED` or equivalent behavior.
2. Publishes the original envelope using its stable envelope `id` in the payload and a broker attribute.
3. Marks the row published only after broker acknowledgement.
4. Retries rows whose lease expires.

A crash after publish and before marking creates duplicate publication. Consumers MUST handle it. The relay MUST NOT generate a new envelope `id` on retry. Google Pub/Sub's generated `messageId` is transport metadata and MUST NOT be used as the business deduplication key because a republished outbox envelope receives a new broker ID.

## Inbox consumption

For ordinary event consumers, the inbox record and all local effects commit in one database transaction. The consumer acknowledges only after commit.

The unique key is:

```text
(consumer_name, envelope_id)
```

`envelope_id` stores the envelope's `id`, not the Pub/Sub-generated `messageId`. An existing key means the delivery is a duplicate and may be acknowledged after verifying the earlier transaction committed.

Execution commands that involve a provider require an additional rule: the durable payment operation is the work record. On command redelivery, a worker reloads the operation:

- Terminal operation: acknowledge without a provider call.
- `REQUESTED`: claim and execute it.
- Actively leased `PROCESSING`: do not start a second provider call.
- Stale `PROCESSING`: mark or reconcile it as potentially `UNKNOWN` according to provider policy.
- `UNKNOWN` or `REQUIRES_REVIEW`: schedule/read reconciliation; do not create a replacement operation.

The message is a durable nudge, not the only record that work exists.

## Ordering and gaps

There is no global ordering guarantee.

Pub/Sub ordering is enabled per payment ID, but correctness MUST also use aggregate version. A consumer receiving the complete payment lifecycle stream applies:

1. Existing inbox ID: duplicate; acknowledge.
2. `aggregateVersion == currentVersion + 1`: apply.
3. `aggregateVersion <= currentVersion`: stale or duplicate; record and acknowledge.
4. `aggregateVersion > currentVersion + 1`: park as a gap and retry or rebuild from the authoritative API/store.

A filtered consumer may legitimately skip versions and MUST NOT use contiguous-version enforcement unless it receives all version-advancing events.

## Schema evolution

- Each message schema has a checked-in JSON Schema and contract tests before publication.
- A published version is shape-frozen: fields MUST NOT be added, removed, renamed, repurposed, or have their type changed within that version.
- Any wire-shape change, including a new optional field, increments the `.vN` suffix and `schemaVersion`.
- A semantic change creates a new type even if the JSON shape is similar.
- Producers and consumers SHOULD support current and previous versions during rolling deployment.
- An unsupported version is a terminal schema error and goes to the DLQ with an alert; it is not silently discarded.

## Retry and dead-letter policy

Default message-processing delays are approximately:

```text
1s, 5s, 30s, 2m, 10m, 30m, 1h, then DLQ
```

Classification:

| Failure | Retry? | Action |
| --- | --- | --- |
| Database or network temporarily unavailable | Yes | Backoff with jitter |
| Handler rate limited | Yes | Respect retry hint and back off |
| Schema validation failed | No | DLQ and alert |
| Invariant violation | No automatic retry | DLQ, discrepancy, and operator review |
| Unsupported message version | No | DLQ and alert |
| Duplicate delivery | No work needed | Acknowledge after dedupe check |
| Ambiguous provider outcome | Not as a new write | Mark/reconcile the existing operation |

A DLQ record MUST retain the original envelope, consumer name, failure classification, attempt count, and redacted error detail. DLQ placement is a delivery outcome, not a financial resolution.

## Reconciliation messages

Suggested fast schedule for unknown operations:

```text
5s, 30s, 2m, 10m, 1h
```

After the policy is exhausted, emit `payment.operation.review.required.v1`. Also run a periodic sweep for stale `REQUESTED`/`PROCESSING` operations and a broader provider comparison.

Reconciliation compares provider identity, idempotency key, amount, currency, external status, internal status, and expected ledger posting key. It resolves through the normal domain transition path and never edits journal history.

## Required contract tests

- Validate every produced envelope and payload against its checked-in schema.
- Validate every public merchant webhook payload against its checked-in schema and the type/operation/outcome correlation table.
- Publish the same outbox row repeatedly and prove each consumer produces one local effect.
- Crash the relay after broker publish and before marking the row; prove safe duplicate delivery.
- Crash a consumer before and after commit; prove replay is correct.
- Deliver payment events out of order and prove gap handling or safe rebuild.
- Deliver an unknown schema version and prove DLQ plus alert metadata.
- Redeliver a provider execution command while the operation is terminal, processing, unknown, and stale; prove no duplicate financial request.
- Scan representative messages to prove prohibited data is absent.
- Verify merchant webhook signature golden vectors, secret-version snapshots, retry classification, timestamp tolerance, no-redirect/SSRF policy, stable delivery IDs/bodies, and endpoint/event deduplication.
- Prove `payment.created.v1` produces no merchant webhook delivery, and that a merchant webhook payload whose type is outside the allowlist fails validation before a delivery row exists.
- Prove `merchant.webhook.deliver.v1` is published without an ordering key and that one slow endpoint does not delay deliveries to another endpoint of the same merchant.
- Validate `settlement.batch.posted.v1` against its schema, prove its aggregate/ordering identity rules, and prove a consumer applying payment-style version contiguity to it is rejected by the semantic correlation validator.
- Prove the ledger event accepts `SETTLEMENT` as an operation type and that a settlement posting carries no payment or payment-operation reference.

## MVP messaging decisions

- **Topic topology:** Use separate `flowledger-commands-v1` and `flowledger-events-v1` topics. Each logical consumer owns a subscription and DLQ; consumers do not share a subscription when they need independent delivery.
- **Schema registry:** JSON Schemas and the type-to-schema registry are checked into this repository. CI validates every fixture and verifies that every cataloged message type is registered. A managed registry is deferred.
- **Leases:** Worker request deadlines and processing leases are provider capabilities defined in the provider contract. Expiry never authorizes a blind write retry; a stale post-request lease moves the operation to `UNKNOWN` and reconciliation.
- **Retention:** Published outbox rows remain queryable in PostgreSQL for 30 days, then their immutable envelopes are archived for one year before deletion. Unpublished rows are never age-purged. Inbox deduplication records for financial consumers do not expire in the MVP; later compaction must preserve an immutable envelope-ID tombstone.
- **Merchant webhook ordering:** Deliveries carry no ordering key. Per-endpoint fairness and backpressure are dispatcher concerns; event order is a consumer concern resolved with `paymentVersion`.
- **Public allowlist scope:** Only outcomes a merchant cannot already know from its own synchronous command are published. `payment.created.v1` and `settlement.batch.posted.v1` are internal-only in the MVP.
