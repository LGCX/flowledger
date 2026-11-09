# FlowLedger message schemas

These JSON Schema 2020-12 files are the normative wire contracts for internal Pub/Sub messages. Producers MUST validate before inserting an outbox row in tests and non-production environments. Consumers MUST validate before applying effects.

`webhooks/merchant-event.v1.schema.json` is the separate public merchant-webhook payload contract. It is intentionally not registered as an internal command/event envelope.

Its allowlist covers only outcomes a merchant could not already know. `payment.created.v1` is excluded because the merchant issued that command synchronously and already holds the committed representation. `settlement.batch.posted.v1` is excluded because its shape does not fit the payment/operation/outcome correlation this contract enforces, and a merchant-facing settlement notification is deferred with the merchant settlement endpoint.

## Closed-version policy

Wire schemas are strict:

- Every concrete wire payload object sets `additionalProperties: false`; the shared envelope's abstract `data` slot is intentionally completed by a registered concrete schema through `allOf`.
- Unknown fields are rejected.
- Adding, removing, renaming, or changing a field requires a new `.vN` message type and `schemaVersion`.
- A producer MUST NOT publish a field that is absent from the registered schema.
- Consumers SHOULD support the current and previous registered versions during a rolling deployment.

This policy favors typo detection and reproducible contracts over same-version additive evolution.

## Validator requirements

Validation MUST use a JSON Schema Draft 2020-12 implementation with:

- Remote network fetching disabled.
- Repository-local resolution of every `$ref` by its canonical `$id`.
- `format` assertion enabled for at least `uuid` and RFC 3339 `date-time`.
- Unknown schema keywords treated as configuration errors in CI.
- All schemas compiled during CI, even when no fixture currently references them.

In Draft 2020-12, `format` may otherwise be annotation-only. A validator configuration that does not reject an invalid UUID or date-time does not satisfy this contract.

## Common schemas

- `common/message-envelope.v1.schema.json` — required metadata shared by commands and events.
- `common/entity-ids.v1.schema.json` — canonical prefixed Crockford ULID entity IDs.
- `common/money.v1.schema.json` — non-negative USD integer-minor-unit amount.
- `common/positive-money.v1.schema.json` — positive USD command/operation amount.
- `common/payment-totals.v1.schema.json` — confirmed aggregate totals after a transition.
- `common/provider-result-evidence.v1.schema.json` — normalized provider evidence, errors, and definitive no-effect proof.

Public entity IDs use a lower-case prefix, `_`, and a canonical 26-character Crockford ULID. The first ULID character is `0`–`7`; `I`, `L`, `O`, and `U` are forbidden. Envelope IDs and domain-event IDs are UUIDs, not prefixed entity IDs.

All monetary values are decimal strings in minor units. The maximum accepted value is `1000000000000`. A JavaScript JSON number is invalid for money.

## Commands

- `commands/payment-operation-execute.v1.schema.json`
- `commands/payment-operation-reconcile.v1.schema.json`
- `commands/merchant-webhook-deliver.v1.schema.json`

## Events

- `events/payment-created.v1.schema.json`
- `events/payment-operation-requested.v1.schema.json` — closed family of the four operation-specific requested event types.
- `events/payment-operation-terminal.v1.schema.json` — closed family of confirmed success, rejection, and definitive failure event types.
- `events/payment-authorization-expired.v1.schema.json`
- `events/payment-operation-reconciliation-required.v1.schema.json`
- `events/payment-operation-review-required.v1.schema.json`
- `events/payment-discrepancy-detected.v1.schema.json`
- `events/ledger-transaction-posted.v1.schema.json`
- `events/settlement-batch-posted.v1.schema.json`

One schema may validate a closed family of event types when their payload contract is shared. The top-level `type` enum remains authoritative. Adding a type to a family is a reviewed, versioned contract change.

## Registry manifest

`registry.v1.json` is instance data, not a JSON Schema. Validate it against `registry-manifest.v1.schema.json`.

CI MUST additionally enforce rules that JSON Schema alone cannot express:

1. Each `(kind, type)` pair is unique.
2. Every referenced schema path exists beneath `commands/` or `events/`.
3. The referenced schema accepts the registry entry's exact `kind` and `type`.
4. Every initial command/event type declared in the contract is registered.
5. No registered schema has an unresolved `$ref`.

`uniqueItems` rejects identical registry rows but cannot reject two different rows with the same `(kind, type)`, so the first rule requires a semantic check.

## Required post-schema semantic correlation validator

JSON Schema validates shapes and local constraints. The shared message-validation library MUST run these equality and ownership checks after schema validation:

- For every payment command/event, `aggregateId === data.paymentId` and `orderingKey === data.paymentId`.
- For `payment.operation.execute.v1`, `aggregateVersion === data.expectedPaymentVersion`.
- For `merchant.webhook.deliver.v1`, `aggregateId === data.deliveryId`, and no `orderingKey` is set. Delivery is deliberately unordered so one unresponsive endpoint cannot serialize a merchant's whole notification stream; consumers order by `data.paymentVersion`.
- For `ledger.transaction.posted.v1`, `aggregateId === data.ledgerTransactionId`.
- For `settlement.batch.posted.v1`, `aggregateId === data.settlementBatchId`, `orderingKey === merchantId`, `aggregateVersion === 1`, and `data.postingKey === 'settlement:' + data.settlementBatchId`. A consumer applying payment-style version contiguity to this type is a configuration error, because a batch is immutable and emits exactly one event.
- For a `SETTLEMENT` ledger posting, `data.settlementBatchId` is non-null while `data.paymentId` and `data.paymentOperationId` are null; for `CAPTURE`/`REFUND` the inverse holds.
- An operation ID resolves to the stated payment and merchant.
- Provider, provider account, provider payment/operation references, and provider idempotency key match the immutable original operation.
- `data.resolutionSource === data.evidence.source` when both fields exist.
- For terminal rejection/failure, `data.resultCode === data.normalizedError.code`.
- A terminal success amount, currency, and operation type match the original accepted operation.
- `totalsAfter` satisfies all payment invariants, including `captured <= authorized`, `refunded <= captured`, and `voided <= authorized - captured`.
- For `ledger.transaction.posted.v1`, total debits equal total credits.
- A capture/refund success references the journal transaction posted with the original operation's stable posting key.

Failure of a semantic correlation check is an invariant error. The consumer MUST NOT apply the message or infer a financial outcome; it follows the DLQ/discrepancy policy.

## Provider-result requirements

Terminal event schemas enforce:

- `SUCCEEDED` requires non-empty provider payment and operation identifiers and no normalized error.
- `REJECTED` requires a normalized error.
- `FAILED` requires both a normalized error and definitive `noEffectProof`.
- Every terminal result requires a redacted provider evidence record.
- Only successful capture/refund events carry a ledger transaction ID.
- Capture-only and refund-only fee fields are forbidden on unrelated event types.
- A capture success carries its snapshotted fee. A refund carries a fee amount only when it succeeded, because the incremental reversal is computed in the confirming transaction rather than snapshotted at acceptance; a rejected or failed refund reversed nothing.

`UNKNOWN` and `REQUIRES_REVIEW` are not terminal provider-result event types. They use the reconciliation-required and review-required events respectively.

## Local validation expectations

At minimum, CI MUST:

1. Parse every `*.json` file.
2. Compile every schema under Draft 2020-12 with format assertion.
3. Validate the registry manifest.
4. Resolve every local `$ref` without network access.
5. Validate one positive and multiple negative fixtures for each registered type.
6. Prove negative fixtures fail for unknown fields, invalid UUID/date-time, overflow ULID, wrong entity prefix, zero operation amount, amount above the maximum, mismatched event outcome, missing evidence, and invalid conditional fields.
7. Run the post-schema semantic correlation validator against valid-shape/mismatched-identity fixtures.

Schema IDs use `https://flowledger.dev/schemas/...` as stable logical identifiers; no network fetch is required. Repository-relative `$ref` values resolve against those identifiers and the matching local files.
