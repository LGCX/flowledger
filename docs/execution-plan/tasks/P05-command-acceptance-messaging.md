# P05 — Durable command acceptance and messaging core

## Phase overview

**Goal.** Make every money-moving command durable before it is acknowledged, and move committed messages reliably: the protected `payments.accept_operation` boundary for `AUTHORIZE`, `CAPTURE`, `CANCEL`, and `REFUND` (exclusion model, refund reservation guard, capture fee snapshot, minimum capture, three-authorization ceiling, `If-Match` per ADR-0006); the four `202 Accepted` endpoints; per-statement failure injection for the acceptance transaction; the `Transport` interface with `InMemoryTransport` and `PubSubTransport`; the outbox relay (`FOR UPDATE SKIP LOCKED`, leases, retry schedule, acknowledgement) in `apps/outbox-relay`; the inbox consumer framework keyed by `(consumer_name, envelope_id)`; strict consumer validation with durable DLQ insertion; aggregate-version gap parking; and sweepers that rediscover unpublished outbox rows and stale accepted operations. The timeline gains the `OPERATION_ACCEPTED` kind.

**Entry criteria.** `P03-GATE` green (ledger core + `flowledger verify`, used here for the reservation-integrity class) and `P04-GATE` green (API app, auth, request pipeline, idempotency pattern, SQL read surface, fault hooks, conformance helper).

**Exit gate (`P05-GATE`, checkpoint C5 "Durable acceptance", Messaging-ready).** Every `docs/10` M5 acceptance bullet passes: `202` only after the full acceptance transaction commits; rollback at every injected statement; 100 duplicates → one operation and one pair of outbox rows; ADR-0006 `If-Match` behavior; `422 CAPTURE_BELOW_MINIMUM` with no rows; concurrent refunds bounded by the locked guard (failure source asserted); exclusive/refund mutual exclusion; fee snapshot immutability; authorization ceiling; command OpenAPI conformance; relay crash after publish republishes the same envelope ID; consumer crash before/after commit; DLQ for invalid/unsupported messages with no effect; version gaps parked; `flowledger verify` reports zero findings.

**Migration range.** `0500`–`0599`, in task order: `0500` (T01), `0510` (T02), `0520` (T08), `0530` (T09), `0550` (T11), `0560` (T12).

### Interfaces consumed from earlier phases

| From | Interface |
| --- | --- |
| P00 | `packages/contracts` `buildEnvelope()`, Ajv envelope validator, semantic validator, registry (type → schema), generated types (`Envelope`); app shells for `apps/outbox-relay`, `apps/payment-worker` with config + graceful shutdown + health; Docker Compose with the Pub/Sub emulator. |
| P01 | `packages/domain`: `newId`/`ID_PREFIXES`, `MinorUnits`; `computeCaptureFee(gross, basisPoints, fixedAmount)`; `computeRequestHash({ commandType, pathParams, body, ifMatch })` (`ifMatch` = exact header text or null); `deriveProviderIdempotencyKey({ environment, provider, operationId, maxKeyLength })` with `ProviderEnvironment = 'local' \| 'test' \| 'sandbox'`; `MESSAGE_RETRY_SCHEDULE_MS` + `backoff(schedule, failuresSoFar, random)` (1 s, 5 s, 30 s, 2 m, 10 m, 30 m, 1 h with jitter). |
| P02 | `api.claim_idempotency_key(...)` (claim-first full-record insert; `OWNER`/`REPLAY`/`CONFLICT`/`EXPIRED`; bounded wait → `IDEMPOTENCY_REQUEST_IN_PROGRESS`); `public.fl_current_merchant_id()`, `public.fl_assign_function_owner`; fixtures `createTestMerchant`, `fixtureInsertIdempotencyRecord`, `fixtureCapturedPayment`; payment/operation update rule (every `UPDATE` sets `version = OLD.version + 1`); tables per `docs/07` incl. the deferred consistency trigger on `payments.payments`/`payments.payment_operations`, `payment_operations_one_active_exclusive` and successful-operation partial unique indexes, `payments.fee_policies` checks, `messaging.outbox_messages`, `messaging.inbox_messages`, `messaging.dead_letter_records`; `messaging.insert_outbox(envelope jsonb)`; roles (`payments_function_owner`, `messaging_function_owner`, `fl_api`, `fl_relay`, `fl_payment_worker`, `fl_reconciler`, `fl_webhook_worker`, `fl_webhook_projector`, `fl_webhook_dispatcher`); `withTransaction`; `DomainError`; Testcontainers fixture and seed builders. |
| P03 | `flowledger verify` (reservation-integrity and payment-totals classes) via `pnpm verify:ledger`. |
| P04 | `createApiApp`, `OPERATIONS`/`NOT_YET_IMPLEMENTED` (`apps/api/src/http/operations.ts`), `ProblemError`, `PROBLEMS`, `preparePost` (`apps/api/src/http/route-pipeline.ts`), `parsePaymentETag`, request principal; SQL `payments.fault_point`, `payments.peek_idempotency`, `payments.format_ts`, `payments.operation_representation`, `payments.payment_timeline` (kind-rank table); TS wrappers in `packages/database/src/functions/payments.ts`; `packages/testkit` `startTestApi`, `installSqlFaultHooks`/`armSqlFault`/`disarmSqlFaults` (incl. the `commit` deferred fault trigger on `api.idempotency_records`), `assertConformsToOpenApi`, routing fixtures; `packages/contracts/src/timeline-detail.ts`. |

### Interfaces provided to later phases

| Interface | Path / signature | Used by |
| --- | --- | --- |
| Acceptance boundary | `payments.begin_operation(...)`, `payments.accept_operation(...)`; wrappers `beginOperation`, `acceptOperation` | P06+ (tests), P12 load |
| Transport | `packages/messaging/src/transport.ts` `Transport`, `ReceivedMessage`, `Unsubscribe`; `InMemoryTransport` (`in-memory-transport.ts`); `PubSubTransport` (`pubsub-transport.ts`) | P06–P10, P13 |
| Topology | `packages/messaging/src/topology.json` + `topology.ts` (`TOPICS`, `SUBSCRIPTIONS`, `topicForKind`, `ensureTopology(pubsub)`) | P06, P09, P13 (Terraform reads the JSON) |
| Relay | `packages/messaging/src/relay.ts` `relayOnce`, `startRelay`; SQL `messaging.claim_outbox_batch`, `messaging.mark_outbox_published`, `messaging.record_outbox_failure` | P12, P13 |
| Consumer framework | `packages/messaging/src/consumer.ts` `startConsumer(opts)`, `processDelivery(opts, msg)`, `HandlerResult`; `packages/messaging/src/consumers.ts` names; `packages/messaging/src/version-gate.ts` `classifyAggregateVersion` | P06 payment worker, P08 reconciler, P09 projector/dispatcher |
| Inbox / DLQ SQL | `messaging.record_inbox_message(text, jsonb)`, `messaging.insert_dead_letter(...)` | P06–P10, P10/P11 DLQ replay tooling |
| Crash points | `packages/config/src/crash-points.ts` `crashPoint(name)`; `packages/testkit/src/crash-points.ts` `armCrashPoint`, `disarmCrashPoints` | P06–P10 |
| Requested-operation sweeper | `payments.find_stale_requested_operations`, `payments.reenqueue_requested_operation`; `apps/payment-worker/src/sweepers/requested-operation-sweeper.ts` | P06 (hosts it), P08 |
| Operation-state fixture | `packages/testkit/src/fixtures/operations.ts` `forceOperationOutcome(...)` (superuser fixture until P06/P07 real transitions exist) | P06, P07 tests that need pre-resolved state |

### Design decisions fixed by this phase

1. **Two-call acceptance transaction** (same rationale as P04 Design decision 1). `payments.begin_operation` answers a committed replay via `payments.peek_idempotency` (P04), reads the payment's immutable fields **without a lock**, builds the replay body (`payments.new_operation_representation`), claims the key with P02 `api.claim_idempotency_key` (bounded 2 000 ms), **then** locks the payment `FOR UPDATE` — canonical order key → payment (`docs/07` §Transaction and lock ownership) — and returns the snapshot TypeScript needs to build and Ajv-validate both envelopes. `payments.accept_operation` proves the claim belongs to this transaction, re-locks (already held), evaluates **every** guard, inserts, asserts the committed operation equals the claimed body, and writes the outbox rows. Holding the payment lock between the calls serializes concurrent commands on one payment without retries; the single retry case is a `CANCEL` whose unlocked amount read was stale (`INTERNAL_STALE_SNAPSHOT`, TS retries up to 3 times).
2. **Replay before version comparison** (ADR-0006): both functions resolve the idempotency record before reading the payment version; `If-Match` is compared only for a new key, inside `accept_operation`, after the payment lock.
3. **Guard order** (fixes which code wins): role/merchant → replay/conflict/expired (peek, then claim) → payment lock (`404`) → `If-Match` (`412`) → snapshot check (internal) → exclusion (`409 ACTIVE_OPERATION_EXISTS`) → lifecycle state (`409 INVALID_PAYMENT_STATE`) → monetary (`409 MONETARY_GUARD_FAILED`) → minimum capture (`422 CAPTURE_BELOW_MINIMUM`) → fee/key verification (internal) → writes.
4. **Envelope versions.** The requested event and the execute command both carry `aggregateVersion = newPaymentVersion`; the command's `data.expectedPaymentVersion = newPaymentVersion` (semantic validator requires equality). `causationId` = the HTTP request ID (P04 risk R-08). `source = 'flowledger.payment'`.
5. **Topic names** are `flowledger-commands-v1` and `flowledger-events-v1` (`docs/04` §MVP messaging decisions; CONVENTIONS §9). `merchant.webhook.deliver.v1` carries the endpoint ID as `orderingKey` per its machine schema (pending README D-06); the relay passes whatever `orderingKey` the envelope has and the dispatcher subscription is unordered.
7. **Envelopes are built entirely in TypeScript** for every message P05 emits (requested events, execute commands); `docs/07` requires SQL-side completion only for ledger/settlement events (CONVENTIONS §9 exception), so P05 SQL functions verify envelope fields but never fill them.
6. **Crash points.** `crashPoint(name)` lives in `packages/config` (packages may not import `packages/testkit`, CONVENTIONS §3); it is a no-op unless `FLOWLEDGER_FAULT_HOOKS=1`. Armed in-process via testkit (throws `CrashPointError`) or per process via `FLOWLEDGER_CRASH_POINTS=<name,…>` (sends `SIGKILL` to itself). SQL statement faults reuse P04's `payments.fault_point` mechanism.

---

### P05-T01 — `accept_operation` core: claim, replay, `If-Match`, exclusion, `AUTHORIZE`, `CANCEL`

**Task ID:** `P05-T01`
**Feature:** Protected command acceptance (exclusive authorization/cancellation commands)
**Commit:** `feat(db): add protected accept_operation for authorize and cancel`
**Priority:** Critical
**Dependencies:** `P04-GATE`, `P03-GATE`
**Estimated complexity:** L
**Contract references:** `docs/03` §Operation exclusion model, §Command acceptance, §Authorize (guards), §Cancel authorization (guards), §Aggregate and operation version rules, §MVP policy decisions (authorization retries); `docs/07` §`payments.payment_operations` (columns, partial indexes, fee columns for authorize/cancel), §Protected payment transition functions (`accept_operation`), §`api.idempotency_records`, §Transaction and lock ownership (accept row, canonical lock order); `docs/05` §Optimistic version preconditions, §Provider-backed command response, §API idempotency contract; ADR-0003, ADR-0006, ADR-0009; `schemas/events/payment-operation-requested.v1.schema.json`; `schemas/commands/payment-operation-execute.v1.schema.json`
**Files:** create: `migrations/0500_accept_operation.sql`, `test/integration/db/accept-operation-exclusive.test.ts`; modify: `packages/database/src/functions/payments.ts`, `packages/database/src/errors.ts`; must not touch: `migrations/04*`, `migrations/02*`, `migrations/03*`, `apps/**`

**Objective** — Implement the single protected path that turns an authorize/cancel request into one durable `REQUESTED` operation, the exclusive pointer, one payment-version increment, two outbox rows, and the replay record — atomically, with deterministic replay/conflict and ADR-0006 semantics.

**Implementation instructions**
1. Helper `payments.new_operation_representation(p_operation_id text, p_payment_id text, p_type text, p_amount_minor bigint, p_provider_code text, p_fee_policy_version integer, p_fee_amount_minor bigint, p_now timestamptz) RETURNS jsonb IMMUTABLE` — exactly what `payments.operation_representation` (P04-T06) returns for a just-accepted operation: `status 'REQUESTED'`, `providerOperationId`/`resultCode`/`resolvedAt` null, `feePolicyVersion` (null for `AUTHORIZE`/`CANCEL`), `feeAmountMinor` (capture fee text; null otherwise), `version 1`, `createdAt = payments.format_ts(p_now)`. Must not raise on any input (guards run later).
2. `payments.begin_operation(p_command_type text, p_idempotency_key text, p_request_hash bytea, p_payment_id text, p_operation_id text, p_amount_minor bigint /*CAPTURE/REFUND body amount; NULL otherwise*/, p_correlation_id text, p_credential_id text) RETURNS TABLE (outcome text, http_status smallint, response_body text, response_headers jsonb, payment_version bigint, provider_code text, provider_account_id text, amount_minor bigint, fee_policy_version integer, fee_basis_points integer, fee_fixed_amount_minor bigint, fee_amount_minor bigint, created_at timestamptz)` — `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`, owner `payments_function_owner`; statements in order:
   1. `p_command_type` ∈ `AUTHORIZE, CAPTURE, CANCEL, REFUND` (else `INVALID_REQUEST`); merchant = `public.fl_current_merchant_id()` (NULL → `AUTHENTICATION_REQUIRED`); `pg_has_role(session_user,'fl_api','MEMBER')` else `FORBIDDEN`.
   2. `payments.peek_idempotency(v_merchant, p_command_type, p_idempotency_key, p_request_hash)` row → return `outcome='REPLAY'` (snapshot columns NULL).
   3. Unlocked read of the payment (`merchant_id = v_merchant AND id = p_payment_id`; none → `RESOURCE_NOT_FOUND`) and its bound `provider_code`. Amount: `AUTHORIZE` → `requested_amount_minor`; `CANCEL` → `authorized_amount_minor - voided_amount_minor`; `CAPTURE`/`REFUND` → `p_amount_minor`. Fee columns: NULL in this task; `CAPTURE`/`REFUND` → raise `INTERNAL_COMMAND_NOT_SUPPORTED` until P05-T02 replaces the body with the same signature.
   4. `v_now := clock_timestamp()`; `v_body := payments.new_operation_representation(…)`; `v_headers := jsonb_build_object('Location','/v1/operations/'||p_operation_id,'ETag','"operation-'||p_operation_id||'-v1"','Content-Type','application/json','X-Correlation-Id',p_correlation_id)`.
   5. `api.claim_idempotency_key(v_merchant, p_command_type, p_idempotency_key, p_request_hash, 'PAYMENT_OPERATION', p_operation_id, 202, v_body, v_headers, sha256(convert_to(v_body::text,'UTF8')), p_correlation_id, p_credential_id, 2000)`: `REPLAY` → return it; `CONFLICT` → raise `IDEMPOTENCY_CONFLICT`; `EXPIRED` → raise `IDEMPOTENCY_KEY_EXPIRED` with `DETAIL {"resourceLocation":"/v1/operations/<resource_id>"}`; `OWNER` → continue. `PERFORM payments.fault_point('accept.after_idempotency_claim')`.
   6. `SELECT … FROM payments.payments WHERE merchant_id = v_merchant AND id = p_payment_id FOR UPDATE`. `PERFORM payments.fault_point('accept.after_payment_lock')`.
   7. Return `outcome='NEW'` with the locked `version`, provider code/account, amount, fee columns, `created_at = v_now`.
3. `payments.accept_operation(p_command_type text, p_idempotency_key text, p_payment_id text, p_operation_id text, p_amount_minor bigint, p_if_match text /*raw strong ETag or NULL*/, p_expected_payment_version bigint, p_provider_idempotency_key text, p_fee_amount_minor bigint /*CAPTURE only*/, p_created_at timestamptz, p_correlation_id text, p_requested_event jsonb, p_execute_command jsonb) RETURNS TABLE (outcome text, http_status smallint, response_body text, response_headers jsonb)`, statements in this exact order:
   1. Command/merchant/role checks as in step 2.1.
   2. **Claim proof:** the `(v_merchant, p_command_type, p_idempotency_key)` record must exist with `resource_id = p_operation_id` and no `payments.payment_operations` row with that ID may exist (a committed record always has its operation — P02 deferred trigger), else `INTERNAL_CLAIM_REQUIRED`.
   3. Lock payment `FOR UPDATE` (already held; merchant-scoped).
   4. If `p_if_match IS NOT NULL AND p_if_match <> '"payment-' || id || '-v' || version || '"'` → raise `PAYMENT_VERSION_MISMATCH`.
   5. `version <> p_expected_payment_version` → raise `INTERNAL_SNAPSHOT_MISMATCH` (cannot happen while the lock from `begin_operation` is held).
   6. Exclusion: `active_exclusive_operation_id IS NOT NULL` → `ACTIVE_OPERATION_EXISTS`; for `AUTHORIZE`/`CAPTURE`/`CANCEL`, `unresolved_refund_count > 0` → `ACTIVE_OPERATION_EXISTS`.
   7. `AUTHORIZE` guards (`docs/03` §Authorize): `authorization_outcome IN ('NOT_REQUESTED','DECLINED')` and authorized = captured = refunded = voided = 0, else `INVALID_PAYMENT_STATE`; count of this payment's `AUTHORIZE` operations `>= 3` → `INVALID_PAYMENT_STATE` with `DETAIL '{"reason":"AUTHORIZATION_ATTEMPTS_EXHAUSTED"}'`; the latest existing `AUTHORIZE` operation by `(created_at, id)`, if any, must be `REJECTED` or `FAILED`, else `INVALID_PAYMENT_STATE` (fails closed; `UNKNOWN`/`REQUIRES_REVIEW` are already blocked by step 6). Amount must equal `requested_amount_minor`, else `INTERNAL_SNAPSHOT_MISMATCH`.
   8. `CANCEL` guards (`docs/03` §Cancel authorization): `authorization_outcome = 'AUTHORIZED'`, captured = 0, refunded = 0, else `INVALID_PAYMENT_STATE`. Amount = `authorized_amount_minor - voided_amount_minor` under the lock; if `p_amount_minor` differs (the unlocked read in `begin_operation` was stale) → `INTERNAL_STALE_SNAPSHOT` (TS retries).
   9. `p_provider_idempotency_key` must match `'^flowledger:(local|test|sandbox):' || provider_code || ':' || p_operation_id || '$'` (literals escaped), else `INTERNAL_SNAPSHOT_MISMATCH`; `p_fee_amount_minor` must be NULL.
   10. `INSERT INTO payments.payment_operations (id, merchant_id, payment_id, type, amount_minor, currency, status, provider_account_id, provider_account_version, provider_idempotency_key, provider_operation_id, capture_operation_id, fee_policy_id, fee_policy_version, fee_basis_points, fee_fixed_amount_minor, fee_capture_rounding_mode, fee_refund_mode, fee_effect_type, fee_effect_amount_minor, version, not_before, created_at, updated_at) VALUES (p_operation_id, v_merchant, p_payment_id, p_command_type, v_amount, 'USD', 'REQUESTED', payment.provider_account_id, payment.provider_account_version, p_provider_idempotency_key, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'NONE', NULL, 1, NULL, p_created_at, p_created_at)`. `PERFORM payments.fault_point('accept.after_operation_insert')`.
   11. `payments.operation_representation(p_operation_id) <> record.response_body` → `INTERNAL_REPRESENTATION_MISMATCH`.
   12. `UPDATE payments.payments SET active_exclusive_operation_id = p_operation_id, version = version + 1, updated_at = clock_timestamp() WHERE …` (one `UPDATE`, version + 1, per P02's update rule; refund branch added in T02). `PERFORM payments.fault_point('accept.after_payment_update')`.
   13. Verify `p_requested_event`: `kind='EVENT'`, `type` = `payment.authorization.requested.v1` (AUTHORIZE) / `payment.authorization.cancellation.requested.v1` (CANCEL), `merchantId`, `aggregateType='payment'`, `aggregateId = orderingKey = data.paymentId = p_payment_id`, `aggregateVersion = new version`, `correlationId = p_correlation_id`, `data.operationId`, `data.operationType = p_command_type`, `data.amount = {"amountMinor": v_amount::text, "currency": "USD"}`, `data.provider`, `data.providerAccountId`, `data.providerIdempotencyKey = p_provider_idempotency_key`. Verify `p_execute_command`: `kind='COMMAND'`, `type='payment.operation.execute.v1'`, same merchant/aggregate/ordering/correlation, `aggregateVersion = data.expectedPaymentVersion = new version`, `data.operationId`, `data.paymentId`, `data.provider`. Mismatch → `INTERNAL_ENVELOPE_MISMATCH`.
   14. `PERFORM messaging.insert_outbox(p_requested_event)`; `PERFORM payments.fault_point('accept.after_requested_event')`; `PERFORM messaging.insert_outbox(p_execute_command)`; `PERFORM payments.fault_point('accept.after_execute_command')`.
   15. Return `('ACCEPTED', 202, record.response_body::text, record.response_headers)`.
4. Migration tail: owners via `public.fl_assign_function_owner`; `GRANT SELECT, INSERT ON payments.payment_operations` and `GRANT SELECT, UPDATE ON payments.payments` to `payments_function_owner` (no-op if granted); `REVOKE ALL ON FUNCTION … FROM PUBLIC`; `GRANT EXECUTE ON FUNCTION payments.begin_operation(…), payments.accept_operation(…) TO fl_api`.
5. `packages/database/src/functions/payments.ts`: `beginOperation(client, args)` and `acceptOperation(client, args)` with `bigint` money and typed results. `packages/database/src/errors.ts`: register `INTERNAL_SNAPSHOT_MISMATCH`, `INTERNAL_STALE_SNAPSHOT`, `INTERNAL_COMMAND_NOT_SUPPORTED`, `INTERNAL_INVARIANT_VIOLATION` (CONVENTIONS §7); P04's `INTERNAL_CLAIM_REQUIRED`, `INTERNAL_REPRESENTATION_MISMATCH`, `INTERNAL_ENVELOPE_MISMATCH`, `INTERNAL_FAULT_INJECTED` are reused.

**Expected behavior**
- New authorize on a fresh payment (version 1) → `ACCEPTED`, operation `REQUESTED` v1 with amount = requested, payment version 2, pointer = operation, two outbox rows (`payment.authorization.requested.v1` and `payment.operation.execute.v1`, both `aggregateVersion` 2), idempotency record `202`.
- Same key/hash again → `REPLAY` with identical body text; still one operation.
- Same key, different hash → `IDEMPOTENCY_CONFLICT`.
- New key while the authorization is unresolved → `ACTIVE_OPERATION_EXISTS`.
- New key with `If-Match` `"payment-…-v1"` after version 2 → `PAYMENT_VERSION_MISMATCH`, no rows.
- Cancel on `NOT_REQUESTED` payment → `INVALID_PAYMENT_STATE`.

**Acceptance criteria**
- [ ] All accepted writes (claim, operation, pointer, version, two outbox rows) commit together and the claimed body equals the committed operation representation; every guard failure leaves zero new rows (operation, outbox, idempotency) and unchanged payment version.
- [ ] Replay precedes `If-Match` comparison: an exact replay after the payment advanced returns the stored `202` body.
- [ ] Error codes raised are exactly those of Design decision 3 in that order.
- [ ] Operation row: `fee_effect_type = 'NONE'`, all fee columns NULL, `provider_account_*` equal to the payment binding.
- [ ] `fl_api` cannot `INSERT`/`UPDATE` `payments.payment_operations` or `payments.payments` directly (`42501`).

**Testing requirements**
- `test/integration/db/accept-operation-exclusive.test.ts` (as `fl_api` with merchant context; envelopes built via `buildEnvelope` + validator in the test helper `acceptViaSql(…)`):
  - authorize happy path (all rows and versions above); cancel happy path after `forceOperationOutcome(authorize, 'SUCCEEDED')` (fixture from P05-T04 — if T04 is not merged yet, define the minimal fixture in this test file and move it in T04);
  - replay identical body; conflict on changed hash; replay after the payment advanced (force outcome bumps version) still returns the original `202` body;
  - `If-Match` matching current → accepted; stale with new key → `PAYMENT_VERSION_MISMATCH` and the key is reusable afterwards with a fresh request; `If-Match` naming another payment → `PAYMENT_VERSION_MISMATCH`;
  - exclusion: second authorize with a new key → `ACTIVE_OPERATION_EXISTS`;
  - cancel guards: `NOT_REQUESTED` → `INVALID_PAYMENT_STATE`; cancel while authorize unresolved (`REQUESTED` and `UNKNOWN`) → `ACTIVE_OPERATION_EXISTS`;
  - ceiling: three authorize operations each forced `REJECTED` → fourth with a new key → `INVALID_PAYMENT_STATE` with `AUTHORIZATION_ATTEMPTS_EXHAUSTED`; forced `FAILED` predecessor → next allowed; forced `UNKNOWN` predecessor → `ACTIVE_OPERATION_EXISTS`; forced `SUCCEEDED` → `INVALID_PAYMENT_STATE`;
  - `INTERNAL_ENVELOPE_MISMATCH` for wrong `aggregateVersion` and wrong `expectedPaymentVersion`; `INTERNAL_SNAPSHOT_MISMATCH` for wrong amount and wrong provider key;
  - foreign merchant context → `RESOURCE_NOT_FOUND`; direct DML as `fl_api` → `42501`.
- Command: `pnpm vitest run --project integration test/integration/db/accept-operation-exclusive.test.ts`.

**Non-goals** — Capture and refund (T02), HTTP endpoints (T03), provider execution (P06).

**Handoff checklist**
- [ ] Ceiling test observed failing when the `>= 3` check is removed.
- [ ] Replay-after-advance test observed failing when the `If-Match` check is moved before the replay lookup.
- [ ] `pnpm check`, `pnpm test:integration` green.

---

### P05-T02 — `accept_operation`: `CAPTURE` fee snapshot and minimum, `REFUND` reservation guard

**Task ID:** `P05-T02`
**Feature:** Capture/refund acceptance with fee snapshot and reservation
**Commit:** `feat(db): accept capture with fee snapshot and refunds under reservation guard`
**Priority:** Critical
**Dependencies:** `P05-T01`
**Estimated complexity:** L
**Contract references:** `docs/03` §Monetary invariants, §Operation exclusion model, §Command acceptance step 6–7, §Capture, §Refund; `docs/02` §Capture-fee calculation, §Minimum capture amount; `docs/07` §`payments.fee_policies`, §`payments.payment_operations` (capture/refund fee columns, `capture_operation_id`), §Protected payment transition functions (`accept_operation`, "Refund acceptance locks the payment…"); `docs/05` §Capture a payment, §Refund a payment; ADR-0003, ADR-0008
**Files:** create: `migrations/0510_accept_capture_refund.sql`, `test/integration/db/accept-operation-capture-refund.test.ts`; modify: none; must not touch: `migrations/0500_accept_operation.sql` (forward-only), `apps/**`

**Objective** — Extend both acceptance functions (same signatures, `CREATE OR REPLACE`) so a capture snapshots the immutable fee inputs and exact fee and enforces the policy minimum, and a refund reserves its amount under the locked guard `refunded + reserved + amount <= captured` without storing any fee effect.

**Implementation instructions**
1. `CREATE OR REPLACE payments.begin_operation(...)` (identical signature/return type) adds:
   - `CAPTURE`: fee columns from the **payment-bound** (immutable) policy row (`payments.fee_policies WHERE merchant_id = v_merchant AND id = payment.fee_policy_id AND version = payment.fee_policy_version`) — `fee_policy_version`, `fee_basis_points`, `fee_fixed_amount_minor`, and `fee_amount_minor` = the SQL fee formula below for `p_amount_minor`; these feed the claimed replay body.
   - `REFUND`: `fee_policy_version` from the one `SUCCEEDED` `CAPTURE` operation's snapshot (NULL if none — the guard then fails after the claim and everything rolls back); `fee_amount_minor` NULL.
2. `CREATE OR REPLACE payments.accept_operation(...)` (identical signature) keeps every T01 statement and fault point, and replaces the `INTERNAL_COMMAND_NOT_SUPPORTED` branch with:
   - **CAPTURE guards** (after exclusion, step 5): `authorization_outcome = 'AUTHORIZED'`, captured = 0, refunded = 0, and no `SUCCEEDED` capture operation exists, else `INVALID_PAYMENT_STATE`; `p_amount_minor > authorized_amount_minor` → `MONETARY_GUARD_FAILED`; `p_amount_minor < policy.minimum_capture_amount_minor` → raise `CAPTURE_BELOW_MINIMUM` with `DETAIL json_build_object('minimumCaptureAmountMinor', minimum::text)::text`.
   - **Fee**: `v_fee := floor((p_amount_minor::numeric * policy.basis_points + 5000) / 10000)::bigint + policy.fixed_amount_minor`. P02's `minimum_capture_amount_minor >= GREATEST(fixed,1)` check and `fee_policies_fee_within_minimum` check make `fee > gross` unreachable for any amount ≥ the minimum; the boundary `fee == gross` stays valid. Still assert `0 <= v_fee <= p_amount_minor` else raise `INTERNAL_INVARIANT_VIOLATION` (internal; never capped); `p_fee_amount_minor <> v_fee` → `INTERNAL_SNAPSHOT_MISMATCH`.
   - **CAPTURE insert**: `fee_policy_id`, `fee_policy_version`, `fee_basis_points`, `fee_fixed_amount_minor`, `fee_capture_rounding_mode` (`policy.capture_rounding_mode`), `fee_refund_mode` (`policy.refund_fee_mode`) from the payment-bound policy; `fee_effect_type = 'CHARGE'`; `fee_effect_amount_minor = v_fee`; `capture_operation_id` NULL. Capture gross `G` is the operation's `amount_minor`.
   - **CAPTURE payment update**: set `active_exclusive_operation_id`, version + 1 (as T01).
   - **REFUND guards**: exclusion step 5 already rejects an unresolved exclusive op; a `SUCCEEDED` capture must exist and `captured_amount_minor > 0`, else `INVALID_PAYMENT_STATE`; `refunded_amount_minor + reserved_refund_amount_minor + p_amount_minor > captured_amount_minor` → `MONETARY_GUARD_FAILED` (evaluated here under the payment row lock — this, not any index, is the over-refund guard). `p_fee_amount_minor` must be NULL.
   - **REFUND insert**: `capture_operation_id` = the succeeded capture; fee snapshot columns copied from that capture row (all six inputs); `fee_effect_type = 'REFUND'`; `fee_effect_amount_minor = NULL`.
   - **REFUND payment update**: `reserved_refund_amount_minor = reserved_refund_amount_minor + p_amount_minor`, `unresolved_refund_count = unresolved_refund_count + 1`, version + 1, `updated_at`; pointer unchanged.
   - **Envelope verification**: `CAPTURE` → `type = 'payment.capture.requested.v1'`, `data.feePolicyVersion = policy.version`, `data.feeAmountMinor = v_fee::text`; `REFUND` → `type = 'payment.refund.requested.v1'` and `data` has neither `feePolicyVersion` nor `feeAmountMinor` (schema forbids them).
3. No new grants beyond `GRANT SELECT ON payments.fee_policies TO payments_function_owner` (no-op if present).

**Expected behavior** (policy: 290 bp, fixed 30, minimum 30)
- Capture 10 000 of authorized 10 000 → fee `floor((10000*290+5000)/10000)+30 = 320`; operation `fee_effect_amount_minor = 320`, `fee_policy_version` = payment-bound version; event `feeAmountMinor:"320"`.
- Capture 29 → `CAPTURE_BELOW_MINIMUM`, `DETAIL {"minimumCaptureAmountMinor":"30"}`, zero rows.
- Policy (0 bp, fixed 500, minimum 500), capture 500 → accepted, fee 500 = gross.
- Captured 10 000, refunded 0: refunds 4 000 + 4 000 accepted (reserved 8 000, count 2); refund 2 001 → `MONETARY_GUARD_FAILED`; refund 2 000 → accepted (reserved 10 000).
- Capture while a refund is unresolved → `ACTIVE_OPERATION_EXISTS`; refund while a capture is unresolved → `ACTIVE_OPERATION_EXISTS`.

**Acceptance criteria**
- [ ] Capture operations carry the complete six-field fee snapshot plus `fee_effect_amount_minor` from acceptance; refund operations carry the capture's snapshot, `capture_operation_id`, and `fee_effect_amount_minor IS NULL`.
- [ ] The over-refund rejection is raised by the `MONETARY_GUARD_FAILED` branch, never by a unique index or check constraint.
- [ ] `422 CAPTURE_BELOW_MINIMUM` path creates no operation, idempotency, or outbox row.
- [ ] Superseding the active fee policy after acceptance changes neither the capture's snapshot nor a later refund's copied snapshot.

**Testing requirements**
- `test/integration/db/accept-operation-capture-refund.test.ts`:
  - fee golden vectors through the function: below-half (`G=1, B=4999` → 0), exact-half (`G=1, B=5000` → 1), above-half; fixed+percentage composition; zero fee policy (0 bp, 0 fixed, minimum 1); `fee == gross`; minimum boundary (`minimum - 1` rejected, `minimum` accepted);
  - capture guards: before authorization → `INVALID_PAYMENT_STATE`; amount > authorized → `MONETARY_GUARD_FAILED`; second capture after a forced succeeded capture → `INVALID_PAYMENT_STATE`;
  - wrong `p_fee_amount_minor` → `INTERNAL_SNAPSHOT_MISMATCH`;
  - refunds: several fitting refunds accepted with exact reserved sum and count; exceeding amount → `MONETARY_GUARD_FAILED` and assert via `GET DIAGNOSTICS`/error message that the SQLSTATE is `P0001` with message `MONETARY_GUARD_FAILED` (not `23505`/`23514`); exact-fit refund accepted; refund before capture → `INVALID_PAYMENT_STATE`;
  - snapshot immutability: supersede the fee policy (P04 routing fixture `supersedeFeePolicy`), then capture → snapshot equals the payment-bound version, not the new one; refund after that copies the capture snapshot;
  - direct `UPDATE payments.payment_operations SET fee_effect_amount_minor = 1` on a refund as superuser under `SET LOCAL ROLE payments_function_owner` → rejected by P02's check/trigger (acceptance must not and cannot set a refund fee effect);
  - fee policy insert with `fixed_amount_minor = 600, minimum_capture_amount_minor = 500` as superuser → `23514` (structural guarantee, P02 check).
- Command: `pnpm vitest run --project integration test/integration/db/accept-operation-capture-refund.test.ts`.

**Non-goals** — Refund fee reversal at confirmation (P07), provider execution.

**Handoff checklist**
- [ ] Guard-source assertion observed failing when the guard is removed (the test then sees acceptance or a `23514` row-check violation instead of `MONETARY_GUARD_FAILED`).
- [ ] `pnpm check`, `pnpm test:integration` green.

---

### P05-T03 — Command acceptance endpoints

**Task ID:** `P05-T03`
**Feature:** `POST /v1/payments/{paymentId}/authorizations|captures|cancellations|refunds`
**Commit:** `feat(api): add durable 202 command acceptance endpoints`
**Priority:** Critical
**Dependencies:** `P05-T02`
**Estimated complexity:** L
**Contract references:** `docs/05` §Authorize a payment, §Capture a payment, §Cancel an authorization, §Refund a payment, §Provider-backed command response, §Optimistic version preconditions, §API idempotency contract, §Canonical error format; `openapi.yaml` `authorizePayment`, `capturePayment`, `cancelPaymentAuthorization`, `refundPayment`, `OperationAccepted`, `Problem409Response`, `Problem412Response`, `Problem422Response`, `IfMatch`; ADR-0006; `docs/04` §Envelope
**Files:** create: `apps/api/src/operations/commands.controller.ts`, `apps/api/src/operations/accept-operation.service.ts`, `test/integration/api/commands.test.ts`, `test/integration/api/commands-idempotency.test.ts`, `test/integration/api/commands-conformance.test.ts`; modify: `apps/api/src/http/operations.ts`, `apps/api/src/operations/operations.module.ts`, `apps/api/src/errors/problem-filter.ts`, `packages/config/src/api.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/**`, `openapi/**`

**Objective** — Return `202 Accepted` with the stored operation representation only after the acceptance transaction commits; reject with the exact contracted codes otherwise.

**Status codes, headers, and problem codes (all four operations, from `openapi.yaml`)**

| Status | Headers | `code` values |
| --- | --- | --- |
| `202` | `Location` (`^/v1/operations/op_…$`), `ETag` (`"operation-<id>-v1"`), `Retry-After: 1`, `X-Request-Id`, `X-Correlation-Id`, `Idempotent-Replay: true` only on replay | — |
| `400` | `X-Request-Id`, `X-Correlation-Id` | `INVALID_REQUEST` (malformed path ID, unknown/extra field, `{}` violations, malformed `If-Match`), `INVALID_AMOUNT` (captures/refunds), `PROHIBITED_PAYMENT_DATA`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_CORRELATION_ID` |
| `401` | + `WWW-Authenticate` | `AUTHENTICATION_REQUIRED` |
| `403` | | `FORBIDDEN` |
| `404` | | `RESOURCE_NOT_FOUND` (absent or foreign payment) |
| `409` | + `Retry-After: 1` for in-progress | `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_REQUEST_IN_PROGRESS`, `IDEMPOTENCY_KEY_EXPIRED` (+ `resourceLocation` `/v1/operations/op_…`), `ACTIVE_OPERATION_EXISTS`, `INVALID_PAYMENT_STATE`, `MONETARY_GUARD_FAILED` |
| `412` | | `PAYMENT_VERSION_MISMATCH` |
| `413` / `415` | | `REQUEST_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| `422` | **captures only** | `CAPTURE_BELOW_MINIMUM` (detail names the minimum) |
| `429` | | `RATE_LIMITED` — not emitted |
| `500` / `503` | `503` + `Retry-After: 1` | `INTERNAL_ERROR` / `SERVICE_UNAVAILABLE` |

**Implementation instructions**
1. `apps/api/src/http/operations.ts`: add `authorizePayment` (`POST /v1/payments/{paymentId}/authorizations`, `AUTHORIZE`), `capturePayment` (`…/captures`, `CAPTURE`), `cancelPaymentAuthorization` (`…/cancellations`, `CANCEL`), `refundPayment` (`…/refunds`, `REFUND`), all `scopes: ['payments:write']`; remove them from `NOT_YET_IMPLEMENTED`. The P04 contract test `test/contract/api-operations.test.ts` must pass unchanged.
2. `packages/config/src/api.ts`: `FLOWLEDGER_ENVIRONMENT` (one of P01 `ProviderEnvironment`: `local`, `test`, `sandbox`; `.env.example` value `local`), the `{environment}` segment of the provider idempotency key **[ASSUMPTION: name; risk R-04]**.
3. `accept-operation.service.ts` `acceptCommand(request, commandType)`:
   1. `preparePost` (prohibited data → schema → `Idempotency-Key`); `If-Match` optional → `parsePaymentETag` (format errors `400 INVALID_REQUEST`), keep the **raw** header string.
   2. `requestHash = computeRequestHash({ commandType, pathParams: { paymentId }, body, ifMatch: rawIfMatch ?? null })` (P01) — `If-Match` is semantic input (ADR-0006).
   3. `operationId = newId(ID_PREFIXES.operation)`; up to 3 attempts on `DomainError('INTERNAL_STALE_SNAPSHOT')` (only a stale `CANCEL` amount), each one `withTransaction(pool, { merchantId, correlationId }, …)`:
      - `beginOperation(client, { …, operationId, amount: CAPTURE/REFUND ? BigInt(body.amount.amountMinor) : null, correlationId, credentialId })` → `REPLAY` returns immediately; else use its `amount_minor`, `created_at`, and fee columns;
      - `CAPTURE` fee = `computeCaptureFee(amount, basisPoints, fixedAmount)` (P01) and it must equal the snapshot's `fee_amount_minor` (else `500`);
      - `providerKey = deriveProviderIdempotencyKey({ environment: FLOWLEDGER_ENVIRONMENT, provider: provider_code, operationId, maxKeyLength: 255 })` (P01); `newVersion = payment_version + 1`;
      - build both envelopes with `buildEnvelope` (`id: randomUUID()` each, `source: 'flowledger.payment'`, `causationId: request.requestId`, `occurredAt = recordedAt = new Date().toISOString()`), validate with schema + semantic validators;
      - `acceptOperation(…, p_if_match: rawIfMatch ?? null, p_expected_payment_version: payment_version, p_created_at: created_at, …)`.
         4. Reply after commit: `202`, `Location`/`ETag`/`Content-Type`/`X-Correlation-Id` from stored `response_headers`, `Retry-After: 1`, `Idempotent-Replay: true` on replay, body = stored text verbatim.
4. `problem-filter.ts`: `CAPTURE_BELOW_MINIMUM` → `detail = 'Capture amount must be at least ' + DETAIL.minimumCaptureAmountMinor + ' minor units.'`; `IDEMPOTENCY_KEY_EXPIRED` → `resourceLocation` from DETAIL (already in P04); `INVALID_PAYMENT_STATE`, `ACTIVE_OPERATION_EXISTS`, `MONETARY_GUARD_FAILED`, `PAYMENT_VERSION_MISMATCH`, `RESOURCE_NOT_FOUND` → their codes with default detail; every `INTERNAL_*` code (incl. `INTERNAL_STALE_SNAPSHOT` after 3 attempts) → `500 INTERNAL_ERROR`.

**Expected behavior** — See P05-T01/T02 expected behavior mapped to HTTP; `POST …/authorizations` with body `{"x":1}` → `400 INVALID_REQUEST`; capture of `"29"` with minimum 30 → `422 CAPTURE_BELOW_MINIMUM`, detail mentions `30`.

**Acceptance criteria**
- [ ] `202` is emitted only after commit (the P04 `commit` fault point yields `500`, never `202`).
- [ ] Every response from the four operations passes `assertConformsToOpenApi` (including `422` validated against `Problem422`, P04 risk R-10).
- [ ] Exact replay returns stored `202`, original `X-Correlation-Id`, `Idempotent-Replay: true`, byte-identical body, even after the payment advanced.
- [ ] Changing, adding, or removing `If-Match` on a reused key → `409 IDEMPOTENCY_CONFLICT`; stale `If-Match` with a new key → `412` and the key remains usable.

**Testing requirements**
- `test/integration/api/commands.test.ts`: happy path for each command (DB rows, both outbox envelopes validate against their schemas, `aggregateVersion` equality); each `409`/`412`/`422`/`404`/`400` code with a zero-row assertion on `payments.payment_operations`, `messaging.outbox_messages`, `api.idempotency_records` for that key; cross-tenant payment ID → `404` and no mutation; body smuggling `providerAccountId` → `400 INVALID_REQUEST`.
- `test/integration/api/commands-idempotency.test.ts`: byte-identical and reformatted replays; replay after payment advanced (force outcome) still returns the original `202` while `GET /v1/payments/{id}` shows the new version; `If-Match` changed/added/removed on the same key → `409 IDEMPOTENCY_CONFLICT`; stale `If-Match` new key → `412` then a corrected request with the same key → `202`; held owner (direct `fl_api` connection that ran `begin_operation` and keeps its transaction open) → `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` + `Retry-After: 1`; aged record (P02 `fixtureInsertIdempotencyRecord`, committed 91 days ago) → `409 IDEMPOTENCY_KEY_EXPIRED` with `resourceLocation: /v1/operations/op_…`; same key text on a different command type for the same payment is independent; same key reused on a different payment ID for the same command → `409 IDEMPOTENCY_CONFLICT`.
- `test/integration/api/commands-conformance.test.ts`: one case per (operation, status, code) in the table above that P05 can emit; `429` documented as not emitted.
- Commands: `pnpm vitest run --project integration test/integration/api/commands.test.ts test/integration/api/commands-idempotency.test.ts test/integration/api/commands-conformance.test.ts`.

**Non-goals** — Rate limiting; provider execution.

**Handoff checklist**
- [ ] `If-Match`-in-hash test observed failing when `ifMatch` is passed as `null` to the hash.
- [ ] `pnpm check`, `pnpm test:integration` green.

---

### P05-T04 — Concurrency and guard-source suite with operation-state fixtures

**Task ID:** `P05-T04`
**Feature:** Exclusion model and reservation guard under concurrency
**Commit:** `test(api): prove exclusion and reservation guard under concurrent acceptance`
**Priority:** Critical
**Dependencies:** `P05-T03`
**Estimated complexity:** M
**Contract references:** `docs/03` §Operation exclusion model, §Refund, §Required model tests (race/reservation/exclusion bullets), §MVP policy decisions; `docs/05` §Concurrency and version tests; `docs/07` §Schema acceptance tests (reservation, exclusion, guard source); `docs/09` §PostgreSQL integration tests (100 duplicates, refund race, fitting refunds, exclusive vs refund); `docs/10` M5 acceptance bullets 3, 8, 9, 10, 11
**Files:** create: `packages/testkit/src/fixtures/operations.ts`, `test/integration/api/commands-concurrency.test.ts`; modify: `packages/testkit/src/index.ts`, `test/integration/db/accept-operation-exclusive.test.ts` (import the fixture instead of any local copy); must not touch: `migrations/**`, `apps/**`

**Objective** — Prove under real concurrency that duplicates converge, fitting refunds all succeed, over-refund is stopped by the locked monetary guard (not an index), exclusive and refund operations never coexist, and the authorization ceiling holds.

**Implementation instructions**
1. `packages/testkit/src/fixtures/operations.ts` — clearly named superuser fixture (until P06/P07 provide real transitions): `forceOperationOutcome(adminUrl, { operationId, outcome: 'SUCCEEDED' | 'REJECTED' | 'FAILED' | 'UNKNOWN' })`. In one transaction, as superuser with `SET LOCAL ROLE payments_function_owner`, lock payment then operation and apply exactly the `docs/03` outcome tables:
   - `UNKNOWN`: operation `status='UNKNOWN'`, version + 1; payment version + 1; pointer/reservation retained.
   - `AUTHORIZE` `SUCCEEDED`: `authorized_amount_minor = requested`, `authorization_outcome='AUTHORIZED'`, pointer NULL; operation `SUCCEEDED`, `provider_operation_id='fixture-'||id`, `resolution_source='API_RESPONSE'`, `resolution_evidence_id` placeholder, `resolved_at`, version + 1; payment version + 1. `REJECTED`: outcome `DECLINED`, pointer NULL, `result_code='FIXTURE_DECLINE'`. `FAILED`: outcome unchanged, pointer NULL, `result_code='FIXTURE_NO_EFFECT'`.
   - `CAPTURE` `SUCCEEDED`: `captured = amount`, `voided = authorized - captured`, pointer NULL.
   - `CANCEL` `SUCCEEDED`: outcome `CANCELED`, `voided = authorized`, pointer NULL.
   - `REFUND` `SUCCEEDED`: `reserved -= amount`, `count -= 1`, `refunded += amount`, operation `fee_effect_amount_minor = floor(F*R1/G) - floor(F*R0/G)` (F, G from the capture operation; R0 = refunded before, R1 = after). `REJECTED`/`FAILED`: `reserved -= amount`, `count -= 1`, fee effect stays NULL.
   - The commit must pass P02's deferred consistency trigger. If a P02 guard trigger rejects the fixture role, stop and report (CONVENTIONS §14).
2. `test/integration/api/commands-concurrency.test.ts` (HTTP via `startTestApi` with `DATABASE_POOL_MAX ≥ 20`; each case on a fresh payment):
   - **duplicates:** 100 concurrent identical capture requests (same key) → exactly one `payments.payment_operations` row, one `payment.capture.requested.v1` and one `payment.operation.execute.v1` outbox row for that operation, every response `202` with identical body or `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`;
   - **different payloads one key:** 10 concurrent refunds with distinct amounts under one key → at most one operation; others `409 IDEMPOTENCY_CONFLICT`/`IN_PROGRESS`;
   - **fitting refunds:** captured 10 000; 10 concurrent refunds of 1 000 with distinct keys → all `202`; `reserved_refund_amount_minor = 10 000`, `unresolved_refund_count = 10`, equal to `SUM/COUNT` over unresolved refund rows;
   - **last-amount race:** captured 10 000, refunded+reserved 9 000; 2 concurrent refunds of 1 000 → exactly one `202`, one `409` whose body `code` is `MONETARY_GUARD_FAILED`; additionally assert in the DB log path (call `accept_operation` concurrently via SQL in a sibling case) that the losing error is `P0001`/`MONETARY_GUARD_FAILED`, not `23505`/`23514`;
   - **randomized interleavings:** fast-check (≥ 50 runs, seed persisted) over sequences of concurrent refund batches with random amounts and random fixture resolutions (`SUCCEEDED`/`REJECTED`/`FAILED`/`UNKNOWN`) between batches → after every commit `refunded + reserved <= captured` and reservation scalars equal the operation-row aggregate;
   - **UNKNOWN refund keeps reservation:** force one refund `UNKNOWN`; a further refund within remaining available is accepted; one exceeding `captured - refunded - reserved` is `409 MONETARY_GUARD_FAILED`;
   - **released reservation:** force a refund `REJECTED` → reservation released, `feeAmountMinor` null in `GET /v1/operations/{id}`, released amount refundable again;
   - **exclusive vs refund:** with one refund unresolved, capture/cancel/authorize → `409 ACTIVE_OPERATION_EXISTS`; with a capture unresolved, refund → `409 ACTIVE_OPERATION_EXISTS`;
   - **same-ETag race:** two different commands (capture vs cancel) with the same current `If-Match` and distinct keys concurrently → exactly one `202`, the other `412` or `409 ACTIVE_OPERATION_EXISTS`;
   - **omitted If-Match** still serializes (concurrent capture + cancel without `If-Match` → one `202`, one `409 ACTIVE_OPERATION_EXISTS`);
   - **authorization ceiling:** attempts 1–3 accepted only after `REJECTED`/`FAILED` predecessors; 4th → `409 INVALID_PAYMENT_STATE`; `UNKNOWN` predecessor and `REQUIRES_REVIEW` predecessor (fixture sets status directly, version + 1) → new key → `409 ACTIVE_OPERATION_EXISTS`;
   - **fee policy change:** after capture acceptance, supersede the policy; refund acceptance copies the capture snapshot; the capture row's six snapshot fields are unchanged.
- Command: `pnpm vitest run --project integration test/integration/api/commands-concurrency.test.ts`.

**Expected behavior** — As listed.

**Acceptance criteria**
- [ ] Each listed case exists and passes.
- [ ] The last-amount race asserts the failure code is the guard's.
- [ ] Fixture writes pass P02's deferred trigger (no `session_replication_role` tricks).

**Testing requirements** — As in step 2; plus the fixture's own sanity case (force each outcome on each type, then run the reservation/pointer consistency query) inside the same test file.

**Non-goals** — Real provider resolution (P06/P07 re-run these tests through real transitions).

**Handoff checklist**
- [ ] Fitting-refunds case observed failing when a unique index on unresolved refunds is temporarily added in a scratch migration (then removed).
- [ ] `pnpm test:integration` green.

---

### P05-T05 — Per-statement failure injection and crash/replay for acceptance

**Task ID:** `P05-T05`
**Feature:** All-or-nothing acceptance transaction
**Commit:** `test(api): inject failures after every acceptance statement`
**Priority:** Critical
**Dependencies:** `P05-T03`
**Estimated complexity:** M
**Contract references:** `docs/08` §API acceptance, §Required failure-injection tests (API and outbox; Refund reservation first bullet); `docs/09` §PostgreSQL integration tests ("failure injected after each statement"); `docs/05` §Idempotency tests ("Inject failure before and after each database write and at commit-response loss"); `docs/10` M5 acceptance bullets 1, 2
**Files:** create: `test/chaos/accept-operation-faults.test.ts`; modify: none; must not touch: `migrations/**`, `apps/**`, `packages/**`

**Objective** — Prove that a failure after any statement of the acceptance transaction rolls back idempotency, operation, pointer/reservation, version, and both outbox rows together, and that a lost response is recovered by exact replay.

**Implementation instructions**
1. Hook mechanism (from P04-T07): migrations ship `payments.fault_point(p_point text)` as a no-op; `installSqlFaultHooks(adminUrl)` (requires `FLOWLEDGER_FAULT_HOOKS=1`, refuses otherwise) replaces it in the **test database only** with a body raising `P0001 INTERNAL_FAULT_INJECTED` when `public.testkit_fault_points` contains the point, and installs the deferred `commit` trigger on `api.idempotency_records`. Production databases never contain the raising body or the table.
2. `test/chaos/accept-operation-faults.test.ts`, parameterized over command types `AUTHORIZE`, `CAPTURE`, `CANCEL`, `REFUND` (each on a payment prepared with fixtures into the right state) × points `accept.after_idempotency_claim`, `accept.after_payment_lock`, `accept.after_operation_insert`, `accept.after_payment_update`, `accept.after_requested_event`, `accept.after_execute_command`, `commit`:
   - snapshot before: payment row (`version`, pointer, reservation fields), counts of operations/outbox/idempotency for the payment and key;
   - arm the point, send the HTTP command, expect `500 INTERNAL_ERROR` (never `202`);
   - assert the snapshot is unchanged (no operation, no outbox rows, no idempotency record, same version, same pointer/reservation);
   - disarm, resend the identical request with the same key → `202`; resend again → replay (proves the key was not consumed and only one effect exists).
3. Lost response: send a command, drop the response object, resend → same `op_` ID, one operation, one pair of outbox rows.
4. Crash after refund acceptance commit: accept two refunds, then `pg_terminate_backend` every `fl_api` backend and restart the test API; assert reservation scalars equal the unresolved-refund aggregate and run `pnpm verify:ledger` (P03) as a child process against the test DB → exit 0 with zero reservation-integrity findings.

**Expected behavior** — 28 fault cases (4 commands × 7 points) each return `500` with no partial effect and succeed on clean retry.

**Acceptance criteria**
- [ ] Every (command, point) pair is covered; removing any `PERFORM payments.fault_point(...)` line from `accept_operation` makes its case fail (the request would succeed).
- [ ] `flowledger verify` reports zero findings after the crash case.

**Testing requirements** — `pnpm test:chaos` (sets `FLOWLEDGER_FAULT_HOOKS=1`); `pnpm verify:ledger` invoked by the test.

**Non-goals** — Relay/consumer crash points (T08, T10).

**Handoff checklist**
- [ ] One fault case observed failing after deleting its `fault_point` call in a scratch copy of the function (then restored).
- [ ] `pnpm test:chaos` green.

---

### P05-T06 — `Transport` interface, `InMemoryTransport`, and topology

**Task ID:** `P05-T06`
**Feature:** Transport abstraction and deterministic in-process transport
**Commit:** `feat(messaging): add transport interface, in-memory transport, and topology`
**Priority:** Critical
**Dependencies:** `P04-GATE`
**Estimated complexity:** M
**Contract references:** CONVENTIONS §9 (interface, exactly two implementations, topology constants); `docs/04` §Transactional outbox (stable envelope `id` in payload and attribute; broker message ID is metadata), §Ordering and gaps, §MVP messaging decisions (topic names, one subscription + DLQ per consumer); `docs/08` §Retry classification (delays)
**Files:** create: `packages/messaging/src/transport.ts`, `packages/messaging/src/in-memory-transport.ts`, `packages/messaging/src/in-memory-transport.test.ts`, `packages/messaging/src/topology.json`, `packages/messaging/src/topology.ts`, `packages/messaging/src/topology.test.ts`, `packages/messaging/src/consumers.ts`; modify: `packages/messaging/src/index.ts`, `packages/messaging/package.json`; must not touch: `migrations/**`

**Objective** — One transport contract every producer/consumer codes against, with a deterministic in-process implementation for unit and integration tests and one checked-in topology list shared by the emulator bootstrap and Terraform.

**Implementation instructions**
1. `transport.ts`, exactly per CONVENTIONS §9:
   ```ts
   export interface ReceivedMessage { data: Buffer; attributes: Readonly<Record<string, string>>; brokerMessageId: string; deliveryAttempt: number; orderingKey?: string }
   export type Unsubscribe = () => Promise<void>;
   export interface Transport {
     publish(topic: string, envelope: Envelope, orderingKey?: string): Promise<string>; // broker message ID
     subscribe(subscription: string, handler: (msg: ReceivedMessage) => Promise<'ack' | 'nack'>): Promise<Unsubscribe>;
     close(): Promise<void>;
   }
   export function messageAttributes(envelope: Envelope): Record<string, string> // { envelopeId, type, kind, schemaVersion }
   ```
   Payload = UTF-8 `JSON.stringify(envelope)` (the original envelope; no re-generated `id`).
2. `topology.json` **[contract names, risk R-01]**:
   ```json
   { "topics": { "COMMAND": "flowledger-commands-v1", "EVENT": "flowledger-events-v1" },
     "subscriptions": [
       { "name": "flowledger-payment-worker-v1", "consumer": "payment-worker", "topic": "flowledger-commands-v1", "messageTypes": ["payment.operation.execute.v1"], "ordered": true, "deadLetterTopic": "flowledger-payment-worker-dlq-v1" },
       { "name": "flowledger-reconciler-v1", "consumer": "reconciler", "topic": "flowledger-commands-v1", "messageTypes": ["payment.operation.reconcile.v1"], "ordered": true, "deadLetterTopic": "flowledger-reconciler-dlq-v1" },
       { "name": "flowledger-merchant-webhook-dispatcher-v1", "consumer": "merchant-webhook-dispatcher", "topic": "flowledger-commands-v1", "messageTypes": ["merchant.webhook.deliver.v1"], "ordered": false, "deadLetterTopic": "flowledger-merchant-webhook-dispatcher-dlq-v1" },
       { "name": "flowledger-merchant-webhook-projector-v1", "consumer": "merchant-webhook-projector", "topic": "flowledger-events-v1", "messageTypes": [], "ordered": true, "deadLetterTopic": "flowledger-merchant-webhook-projector-dlq-v1" } ] }
   ```
   (`provider-webhook-worker` has no catalog message to subscribe to; P09 adds a subscription if it introduces one — risk R-07.)
   `topology.ts`: typed re-export, `topicForKind(kind)`, `subscriptionFor(consumer)`, `pubsubFilter(sub)` (`attributes.type = "x"` joined with ` OR `; empty list → no filter), `MAX_DELIVERY_ATTEMPTS = 8` (1 + seven retries of `docs/04` §Retry and dead-letter policy).
3. `consumers.ts`: `export const CONSUMERS = ['payment-worker','reconciler','provider-webhook-worker','merchant-webhook-projector','merchant-webhook-dispatcher'] as const; export type ConsumerName = typeof CONSUMERS[number];`.
4. `InMemoryTransport implements Transport` (constructor `{ topology?, redeliveryDelayMs?: (attempt: number) => number }`, default delay = P01 `backoff(MESSAGE_RETRY_SCHEDULE_MS, attempt - 1, Math.random)`):
   - `publish` routes to every subscription of that topic whose `messageTypes` is empty or contains `envelope.type`; each delivery gets a fresh `brokerMessageId = randomUUID()` (so republishing the same envelope yields new broker IDs); `publish` resolves to a fresh `randomUUID()` publish ID;
   - `subscribe` attaches one handler per subscription; messages with the same `orderingKey` on an `ordered` subscription are delivered strictly one at a time in publish order; others concurrently;
   - handler `'nack'` or throw → redeliver the same bytes with `deliveryAttempt + 1` after `redeliveryDelayMs(attempt)`; `'ack'` removes it;
   - test helpers (class members, not on the interface): `published` (array of `{ topic, envelope, orderingKey, brokerMessageId }`), `failNextPublish(error)`, `onAck(cb)`, `idle(): Promise<void>` (resolves when no message is pending or in flight), `deliverRaw(subscription, data: Buffer, attributes)` (for malformed-message tests).
5. `package.json`: no new dependency for this task.

**Expected behavior** — Publishing one envelope twice to a topic with one matching subscription produces two deliveries with identical `data` and different `brokerMessageId`; a nack redelivers with `deliveryAttempt` 2.

**Acceptance criteria**
- [ ] Interface text matches CONVENTIONS §9 exactly.
- [ ] Per-ordering-key serialization holds on ordered subscriptions (no overlap of handler executions for one key).
- [ ] Topology JSON is the single source for names (no topic/subscription string literal elsewhere in `packages/messaging`).

**Testing requirements**
- `packages/messaging/src/in-memory-transport.test.ts`: routing by type filter; empty filter receives all events; ordering serialization (handler with artificial delay, assert no concurrent execution per key and in-order completion); concurrency across keys; nack redelivery attempt counting with `redeliveryDelayMs: () => 0`; throw treated as nack; `failNextPublish` rejects exactly one publish; `idle()` semantics; `close()` stops redelivery timers.
- `packages/messaging/src/topology.test.ts`: every `consumer` is in `CONSUMERS`; every `messageTypes` entry exists in `schemas/registry.v1.json` with the right kind for the topic; names unique; `pubsubFilter` output for 0, 1, 2 types.
- Command: `pnpm vitest run --project unit packages/messaging/src`.

**Non-goals** — Pub/Sub client (T07), relay (T08), consumer framework (T10).

**Handoff checklist**
- [ ] Ordering test observed failing when per-key serialization is disabled.
- [ ] `pnpm check` green.

---

### P05-T07 — `PubSubTransport`, topology bootstrap, and emulator e2e

**Task ID:** `P05-T07`
**Feature:** Google Pub/Sub transport adapter
**Commit:** `feat(messaging): add pubsub transport with ordered publish and topology bootstrap`
**Priority:** High
**Dependencies:** `P05-T06`
**Estimated complexity:** M
**Contract references:** CONVENTIONS §2 (`@google-cloud/pubsub`), §9; `docs/04` §Transactional outbox (envelope ID attribute; broker `messageId` never a dedupe key), §Ordering and gaps (ordering per payment ID), §MVP messaging decisions; `docs/10` M5 F7
**Files:** create: `packages/messaging/src/pubsub-transport.ts`, `apps/cli/src/commands/messaging-bootstrap.ts`, `test/e2e/messaging/pubsub-transport.test.ts`; modify: `packages/messaging/src/topology.ts` (add `ensureTopology`), `packages/messaging/src/index.ts`, `packages/messaging/package.json`, `apps/cli/src/main.ts`, `packages/config/src/messaging.ts` (create if absent), `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/**`

**Objective** — Implement the deployed/e2e transport against Pub/Sub (emulator locally) with per-payment ordering and the checked-in topology.

**Implementation instructions**
1. `packages/config/src/messaging.ts`: `PUBSUB_PROJECT_ID` (`.env.example`: `flowledger-local`), optional `PUBSUB_EMULATOR_HOST` (`.env.example`: `localhost:8085`; the Google client reads it natively).
2. `PubSubTransport implements Transport` (constructor `{ projectId, maxMessagesInFlight = 10 }`):
   - `publish`: `pubsub.topic(name, { messageOrdering: true }).publishMessage({ data, attributes: messageAttributes(envelope), orderingKey })` and resolve to the returned Pub/Sub `messageId`; on rejection with an `orderingKey`, call `topic.resumePublishing(orderingKey)` then rethrow (the relay records the failure).
   - `subscribe`: `subscription.on('message', …)` with `flowControl.maxMessages = maxMessagesInFlight`; map to `ReceivedMessage` (`deliveryAttempt = message.deliveryAttempt || 1`); `await handler(m)` then `m.ack()` or `m.nack()`; handler throw → `nack()`. Returns an `Unsubscribe` that removes listeners and closes the subscription.
   - `close()`: closes all subscriptions and `pubsub.close()`.
3. `topology.ts` `ensureTopology(pubsub)`: idempotently create both topics, every dead-letter topic, and every subscription with `filter = pubsubFilter(sub)`, `enableMessageOrdering = sub.ordered`, `ackDeadlineSeconds = 60`, `retryPolicy { minimumBackoff: 1s, maximumBackoff: 600s }`, `deadLetterPolicy { deadLetterTopic, maxDeliveryAttempts: MAX_DELIVERY_ATTEMPTS + 2 }` (the application DLQs at 8; the broker dead-letter topic is the backstop).
4. `apps/cli/src/commands/messaging-bootstrap.ts`: `flowledger messaging bootstrap` runs `ensureTopology` against `PUBSUB_PROJECT_ID`; document `pnpm --filter @flowledger/app-cli exec flowledger messaging bootstrap` in `docs/CONFIG.md`.
5. `test/e2e/messaging/pubsub-transport.test.ts`: use `PUBSUB_EMULATOR_HOST` if set, else start the emulator with `testcontainers` `GenericContainer` using the image tag pinned in `docs/VERSIONS.md` / Compose (command `gcloud beta emulators pubsub start --host-port=0.0.0.0:8085`), then `ensureTopology`.

**Expected behavior** — An envelope published twice arrives twice with equal `attributes.envelopeId` and different `brokerMessageId`; messages with the same ordering key arrive in publish order on an ordered subscription; a filtered subscription receives only its types.

**Acceptance criteria**
- [ ] `attributes.envelopeId === envelope.id` on every published message.
- [ ] `ensureTopology` is idempotent (second run makes no changes, no errors).
- [ ] No transport code reads `brokerMessageId` for deduplication.

**Testing requirements**
- `test/e2e/messaging/pubsub-transport.test.ts`: duplicate publish → two deliveries, same envelope ID; ordering for 20 messages on one key; type filter isolation between `payment-worker` and `reconciler` subscriptions; nack → redelivery; `ensureTopology` twice.
- Command: `pnpm vitest run --project e2e test/e2e/messaging/pubsub-transport.test.ts`.

**Non-goals** — Terraform (P13); application-level DLQ (T10); emulator dead-letter behavior (not relied upon, risk R-06).

**Handoff checklist**
- [ ] Image tag pinned and recorded.
- [ ] `pnpm check`, `pnpm test:e2e` (this file) green.

---

### P05-T08 — Outbox relay: claim, publish, acknowledge, retry, crash safety

**Task ID:** `P05-T08`
**Feature:** Transactional outbox relay (`apps/outbox-relay`)
**Commit:** `feat(messaging): add outbox relay with skip-locked leases and retry schedule`
**Priority:** Critical
**Dependencies:** `P05-T06`
**Estimated complexity:** L
**Contract references:** `docs/04` §Transactional outbox, §Retry and dead-letter policy, §MVP messaging decisions (retention: unpublished rows never purged); `docs/07` §`messaging.outbox_messages` (claim index, lease-recovery index, mutable columns), §Transaction and lock ownership ("Publish outbox"); `docs/08` §Transactional outbox crash matrix, §Sweep and claim defaults (relay: continuous, 500, 30 s), §Retry classification; `docs/10` M5 F6
**Files:** create: `migrations/0520_outbox_relay.sql`, `packages/messaging/src/relay.ts`, `packages/config/src/crash-points.ts`, `packages/testkit/src/crash-points.ts`, `packages/config/src/outbox-relay.ts`, `apps/outbox-relay/src/relay.module.ts`, `test/integration/messaging/outbox-relay.test.ts`; modify: `apps/outbox-relay/src/main.ts`, `packages/messaging/src/index.ts`, `packages/config/src/index.ts`, `packages/testkit/src/index.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/0500*`, `migrations/0510*`, `apps/api/**`

**Objective** — Publish every committed outbox envelope at least once with its stable UUID, mark it published only after broker acknowledgement, retry with the contracted schedule, and recover from relay crashes by lease expiry.

**Implementation instructions**
1. `migrations/0520_outbox_relay.sql` (functions owned by `messaging_function_owner`, `SECURITY DEFINER`, fixed `search_path`):
   - `messaging.outbox_retry_delay(p_attempts integer) RETURNS interval VOLATILE`: attempts 1 → 1 s, 2 → 5 s, 3 → 30 s, 4 → 2 min, 5 → 10 min, 6 → 30 min, ≥ 7 → 1 h; multiplied by `(0.8 + random() * 0.4)` jitter. No DLQ for publication: unpublished rows are never purged (`docs/04` §MVP messaging decisions).
   - `messaging.claim_outbox_batch(p_limit integer, p_lease_seconds integer) RETURNS TABLE (envelope_id uuid, lease_token uuid, envelope jsonb, kind text, message_type text, ordering_key text, publication_attempts integer)`:
     ```sql
     v_token := gen_random_uuid();
     RETURN QUERY
     UPDATE messaging.outbox_messages o
        SET lease_token = v_token,
            lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
            publication_attempts = o.publication_attempts + 1
      WHERE o.envelope_id IN (
            SELECT envelope_id FROM messaging.outbox_messages
             WHERE published_at IS NULL AND available_at <= clock_timestamp()
               AND (lease_token IS NULL OR lease_expires_at <= clock_timestamp())
             ORDER BY available_at, recorded_at, envelope_id
             LIMIT p_limit FOR UPDATE SKIP LOCKED)
     RETURNING o.envelope_id, o.lease_token, o.envelope, o.kind, o.message_type, o.ordering_key, o.publication_attempts;
     ```
     (expired leases are rediscovered by the same predicate — this is the "unpublished outbox sweeper").
   - `messaging.mark_outbox_published(p_envelope_id uuid, p_broker_message_id text) RETURNS boolean`: `UPDATE … SET published_at = clock_timestamp(), broker_message_id = p_broker_message_id, lease_token = NULL, lease_expires_at = NULL, last_error_class = NULL WHERE envelope_id = p_envelope_id AND published_at IS NULL` — marks even if another relay re-leased the row meanwhile (publication did happen).
   - `messaging.record_outbox_failure(p_envelope_id uuid, p_lease_token uuid, p_error_class text) RETURNS boolean`: only `WHERE lease_token = p_lease_token AND published_at IS NULL`; sets `lease_token = NULL, lease_expires_at = NULL, last_error_class = p_error_class, available_at = clock_timestamp() + messaging.outbox_retry_delay(publication_attempts)`. `p_error_class` must be one of `PUBLISH_TIMEOUT`, `PUBLISH_REJECTED`, `TRANSPORT_UNAVAILABLE` **[ASSUMPTION]**.
   - Tail: `GRANT SELECT, UPDATE ON messaging.outbox_messages TO messaging_function_owner` (no-op if granted); revoke from PUBLIC; `GRANT EXECUTE` on the three public functions to `fl_relay`.
2. `packages/config/src/crash-points.ts`: `export function crashPoint(name: string): void` — no-op unless `process.env.FLOWLEDGER_FAULT_HOOKS === '1'`; if `name` is armed in-process (`globalThis.__flowledgerCrashPoints: Set<string>`) throw `CrashPointError(name)`; if listed in `FLOWLEDGER_CRASH_POINTS` (comma-separated) call `process.kill(process.pid, 'SIGKILL')`. `packages/testkit/src/crash-points.ts`: `armCrashPoint(name)`, `disarmCrashPoints()`.
3. `packages/messaging/src/relay.ts`:
   ```ts
   export interface RelayDeps { pool: Pool; transport: Transport }
   export interface RelayOptions { batchSize?: number /*500*/; leaseSeconds?: number /*30*/; publishTimeoutMs?: number /*10000*/; keyConcurrency?: number /*32*/ }
   export async function relayOnce(deps: RelayDeps, opts?: RelayOptions): Promise<{ claimed: number; published: number; failed: number }>;
   export function startRelay(deps: RelayDeps, opts?: RelayOptions & { idleDelayMs?: number /*200*/ }): { stop(): Promise<void> };
   ```
   `relayOnce`: call `claim_outbox_batch` (single autocommit statement — lease commits before any network I/O); group rows by `ordering_key` preserving claim order; process up to `keyConcurrency` groups concurrently, rows within a group sequentially: `crashPoint('relay.before_publish')` → `transport.publish(topicForKind(kind), envelope, envelope.orderingKey)` with timeout → `crashPoint('relay.after_publish_before_mark')` → `mark_outbox_published(envelope.id, brokerMessageId)` (the ID `publish` resolved to). On publish error: `record_outbox_failure` with class (`PUBLISH_TIMEOUT` for timeout, `TRANSPORT_UNAVAILABLE` for connection/unavailable errors, else `PUBLISH_REJECTED`), and record the same failure for the **remaining rows of that group without publishing them** (preserves per-key order). Never construct a new envelope or `id`. `startRelay` loops `relayOnce`, sleeping `idleDelayMs` only when `claimed === 0`; `stop()` waits for the in-flight iteration.
4. `apps/outbox-relay`: Nest standalone application context (`NestFactory.createApplicationContext(RelayModule)`); config `packages/config/src/outbox-relay.ts` (`DATABASE_URL` for `fl_relay`, `PUBSUB_PROJECT_ID`); uses `PubSubTransport`; graceful shutdown on `SIGTERM`: `stop()` → `transport.close()` → `pool.end()`; keep P00's health/readiness.

**Expected behavior**
- Two committed envelopes → published once each and `published_at` set.
- `failNextPublish` → `last_error_class='PUBLISH_REJECTED'`, `available_at ≈ now + 1 s`, unpublished; next eligible cycle publishes it.
- Crash at `relay.after_publish_before_mark` → transport saw the envelope; row unpublished with a lease; after lease expiry (`leaseSeconds: 1`) the next `relayOnce` republishes the **same envelope UUID** and marks it.
- Two relays running concurrently never claim the same row in overlapping leases.

**Acceptance criteria**
- [ ] No database transaction or row lock is open during `transport.publish` (claim is a committed statement).
- [ ] `published_at` is set only after `publish` resolves.
- [ ] Envelope UUID on republish equals the original; broker message IDs differ.
- [ ] Retry delays follow 1 s, 5 s, 30 s, 2 m, 10 m, 30 m, 1 h (± 20 % jitter) by attempt number.

**Testing requirements**
- `test/integration/messaging/outbox-relay.test.ts` (Testcontainers; outbox rows created through the real acceptance API or `messaging.insert_outbox` as the function owner; `InMemoryTransport`):
  - happy path publish + mark; topic routing by kind;
  - publish failure → backoff fields; `outbox_retry_delay` values for attempts 1–8 (bounds with jitter);
  - crash before publish (`relay.before_publish` armed) → row leased, unpublished, transport saw nothing; after expiry published once;
  - crash after publish before mark → republished same UUID after lease expiry (`published` array has two entries with equal `envelope.id`, different `brokerMessageId`);
  - two concurrent `relayOnce` calls over 1 000 rows → every row published at least once, no row claimed by both inside one lease window (compare lease tokens), all rows marked;
  - per-key order: three envelopes for one payment, the first fails → none of the three published this cycle; next cycle publishes them in order;
  - `fl_relay` cannot `UPDATE messaging.outbox_messages` directly (`42501`).
- Commands: `FLOWLEDGER_FAULT_HOOKS=1 pnpm vitest run --project integration test/integration/messaging/outbox-relay.test.ts`; `pnpm check`.

**Non-goals** — Metrics (`outbox_oldest_unpublished_age` etc., P11); outbox archival (deferred).

**Handoff checklist**
- [ ] Crash-after-publish test observed failing when `mark_outbox_published` is called before `publish`.
- [ ] `pnpm check`, `pnpm test:integration` green.

---

### P05-T09 — Inbox and dead-letter SQL boundaries

**Task ID:** `P05-T09`
**Feature:** Protected inbox recording and DLQ insertion
**Commit:** `feat(db): add protected inbox recording and dead-letter insertion functions`
**Priority:** Critical
**Dependencies:** `P05-T01`
**Estimated complexity:** M
**Contract references:** `docs/07` §`messaging.inbox_messages`, §`messaging.dead_letter_records`, §Mutability rules (inbox insert-only); `docs/04` §Inbox consumption, §Retry and dead-letter policy (DLQ record contents); `docs/08` §DLQ contract; `docs/10` M2 last bullet ("direct runtime DML cannot forge … inbox, or DLQ identity/content fields")
**Files:** create: `migrations/0530_inbox_dead_letter.sql`, `test/integration/db/inbox-dead-letter.test.ts`; modify: `packages/database/src/functions/messaging.ts` (create if absent), `packages/database/src/errors.ts` (register `INTERNAL_ENVELOPE_HASH_MISMATCH`, `INTERNAL_INVALID_CONSUMER`, `INTERNAL_INVALID_DEAD_LETTER`); must not touch: `migrations/052*`, `apps/**`

**Objective** — Give consumers one protected way to record an inbox row (deduplicated by `(consumer_name, envelope_id)`, detecting UUID reuse with changed bytes) and one protected way to insert a DLQ record with contracted metadata.

**Implementation instructions**
1. `messaging.record_inbox_message(p_consumer_name text, p_envelope jsonb) RETURNS text` (`SECURITY DEFINER`, owner `messaging_function_owner`):
   - `p_consumer_name` must be one of `payment-worker`, `reconciler`, `provider-webhook-worker`, `merchant-webhook-projector`, `merchant-webhook-dispatcher`, else raise `INTERNAL_INVALID_CONSUMER` (internal).
   - `v_id := (p_envelope->>'id')::uuid`; `v_type := p_envelope->>'type'`; `v_merchant := p_envelope->>'merchantId'` (required, `^mer_[0-7][0-9A-HJKMNP-TV-Z]{25}$`); `v_hash := sha256(convert_to(p_envelope::text, 'UTF8'))` (jsonb text is key-order and whitespace normalized).
   - `INSERT INTO messaging.inbox_messages (consumer_name, envelope_id, message_type, merchant_id, envelope_hash, received_at, processed_at, result_reference) VALUES (…, clock_timestamp(), clock_timestamp(), NULL) ON CONFLICT DO NOTHING`; inserted → `'NEW'`; else existing hash equal → `'DUPLICATE'`; different → raise `INTERNAL_ENVELOPE_HASH_MISMATCH` (invariant; consumer DLQs it).
2. `messaging.insert_dead_letter(p_consumer_name text, p_subscription_name text, p_envelope_id uuid, p_envelope jsonb /*nullable when unparseable*/, p_envelope_hash bytea, p_failure_class text, p_attempt_count integer, p_error_detail jsonb, p_correlation_id text, p_traceparent text) RETURNS bigint`:
   - `p_failure_class` ∈ `SCHEMA_INVALID`, `INVARIANT_VIOLATION`, `UNSUPPORTED_VERSION`, `RETRY_EXHAUSTED` (P02 `dead_letter_records_failure_class` check); `p_error_detail` must be a JSON object with only keys `code`, `errors` (array of `{pointer, keyword}`), `message` (≤ 500 chars) — else raise `INTERNAL_INVALID_DEAD_LETTER`.
   - Derive `merchant_id`, `payment_id`, `operation_id` from `p_envelope` (`merchantId`, `data.paymentId`, `data.operationId`) only when they match their ID patterns **and** the referenced row exists for that merchant (`EXISTS` checks), else NULL — so a garbage envelope can never violate a tenant-safe FK.
   - `INSERT … (first_failed_at, last_failed_at) VALUES (clock_timestamp(), clock_timestamp()) ON CONFLICT (consumer_name, envelope_id) DO NOTHING RETURNING id`; on conflict return the existing `id`.
   - The envelope is stored as received (the original envelope, `docs/04` §Retry and dead-letter policy and `docs/08` §DLQ contract); redaction applies to `error_detail` and to DLQ previews (P11) — risk R-05.
3. Tail: `GRANT SELECT, INSERT ON messaging.inbox_messages, messaging.dead_letter_records TO messaging_function_owner`; `GRANT SELECT ON payments.payments, payments.payment_operations TO messaging_function_owner`; revoke from PUBLIC; `GRANT EXECUTE` on both functions to `fl_payment_worker, fl_reconciler, fl_webhook_worker, fl_webhook_projector, fl_webhook_dispatcher`.
4. `packages/database/src/functions/messaging.ts`: `recordInboxMessage(client, consumer, envelope)`, `insertDeadLetter(client, args)`.

**Expected behavior** — First record → `NEW`; same envelope with keys reordered → `DUPLICATE`; same `id` with a changed `data` field → `INTERNAL_ENVELOPE_HASH_MISMATCH`; DLQ insert twice for the same `(consumer, envelope_id)` → one row, same `id` returned.

**Acceptance criteria**
- [ ] Inbox rows are only creatable through the function; consumer roles have no direct `INSERT`/`UPDATE` on inbox or DLQ tables (`42501`).
- [ ] `merchant_id` on the inbox row always equals the envelope's `merchantId`.
- [ ] DLQ rows contain envelope ID, consumer, subscription, failure class, attempt count, redacted detail, correlation, optional traceparent, and derived subject IDs.

**Testing requirements**
- `test/integration/db/inbox-dead-letter.test.ts`: NEW/DUPLICATE/hash mismatch; same envelope under two consumer names → two rows; invalid consumer; 50 concurrent `record_inbox_message` for one envelope → exactly one `NEW`; DLQ with a nonexistent `paymentId` → `payment_id` NULL, no FK error; DLQ with foreign-merchant payment ID → NULL; idempotent DLQ insert; malformed `p_error_detail` (extra key `value`) rejected; direct DML by each consumer role rejected.
- Command: `pnpm vitest run --project integration test/integration/db/inbox-dead-letter.test.ts`.

**Non-goals** — Consumer runtime (T10); DLQ replay/resolution tooling (P10/P11).

**Handoff checklist**
- [ ] Hash-mismatch test observed failing when the hash comparison is removed.
- [ ] `pnpm test:integration` green.

---

### P05-T10 — Inbox consumer framework, strict validation, DLQ classification, and gap parking

**Task ID:** `P05-T10`
**Feature:** Shared subscriber code: validate → inbox + effect → commit → ack
**Commit:** `feat(messaging): add inbox consumer framework with dlq and version-gap parking`
**Priority:** Critical
**Dependencies:** `P05-T06`, `P05-T09`
**Estimated complexity:** L
**Contract references:** `docs/04` §Inbox consumption, §Ordering and gaps, §Schema evolution (unsupported version → DLQ + alert), §Retry and dead-letter policy; `docs/08` §Message acknowledgement and DLQ, §DLQ contract, §Required failure-injection tests (Messaging and DLQ); `docs/09` §Messaging integration tests; `schemas/README.md` §Required post-schema semantic correlation validator; CONVENTIONS §9, §12; `docs/10` M5 F8, F9 and acceptance bullets 14–16
**Files:** create: `packages/messaging/src/consumer.ts`, `packages/messaging/src/version-gate.ts`, `packages/messaging/src/version-gate.test.ts`, `test/integration/messaging/consumer.test.ts`; modify: `packages/messaging/src/index.ts`; must not touch: `migrations/**`, `apps/**`

**Objective** — Make it structurally impossible for a consumer to acknowledge before its database commit, to apply an invalid or unsupported message, or to silently apply an out-of-order lifecycle event.

**Implementation instructions**
1. `version-gate.ts`: `classifyAggregateVersion(current: number | null, incoming: number): 'APPLY' | 'STALE' | 'GAP'` — `null` current: `incoming === 1 ? 'APPLY' : 'GAP'`; `incoming === current + 1` → `APPLY`; `incoming <= current` → `STALE`; else `GAP`. Doc comment: only consumers that receive **every** version-advancing payment event may use it (`docs/04` §Ordering and gaps); never for commands or `settlement.batch.posted.v1`.
2. `consumer.ts`:
   ```ts
   export type HandlerResult = { kind: 'APPLIED'; resultReference?: string } | { kind: 'GAP' };
   export interface ConsumerOptions {
     consumer: ConsumerName; transport: Transport; pool: Pool;
     handle(tx: PoolClient, envelope: Envelope): Promise<HandlerResult>;
     maxDeliveryAttempts?: number; // default MAX_DELIVERY_ATTEMPTS (8)
   }
   export async function processDelivery(opts: ConsumerOptions, msg: ReceivedMessage): Promise<'ack' | 'nack'>;
   export function startConsumer(opts: ConsumerOptions): Promise<Unsubscribe>; // subscribes to subscriptionFor(consumer).name with processDelivery
   ```
   `processDelivery` steps:
   1. Parse `msg.data` as UTF-8 JSON (`JSON.parse` is acceptable here: producers are internal and schema validation follows). Failure → DLQ `SCHEMA_INVALID` (`code: 'MALFORMED_JSON'`) → `'ack'`.
   2. Classify: if `type` is a string not registered in `schemas/registry.v1.json` (contracts registry lookup) → `UNSUPPORTED_VERSION`; else Ajv schema validation failure → `SCHEMA_INVALID`; else semantic correlation failure → `INVARIANT_VIOLATION`. Each → DLQ → `'ack'`. Validation precedes every database effect.
   3. `withTransaction(pool, { merchantId: envelope.merchantId, correlationId: envelope.correlationId }, async (tx) => …)`: `recordInboxMessage(tx, consumer, envelope)`; `'DUPLICATE'` → return (commit, then `'ack'`); `'NEW'` → `crashPoint('consumer.before_effect')` → `handle(tx, envelope)`; `GAP` → throw an internal `GapParked` to roll back (no inbox row) → `'nack'`; `APPLIED` → `crashPoint('consumer.before_commit')` → commit.
   4. After the transaction resolves: `crashPoint('consumer.after_commit_before_ack')` → return `'ack'`. **No code path returns `'ack'` before the transaction promise resolves.**
   5. `DomainError('INTERNAL_ENVELOPE_HASH_MISMATCH')` → DLQ `INVARIANT_VIOLATION` → `'ack'`. Any other error or `GapParked`: if `msg.deliveryAttempt >= maxDeliveryAttempts` → DLQ `RETRY_EXHAUSTED` (`code: 'AGGREGATE_VERSION_GAP'` for gaps, else the error class name) → `'ack'`; else `'nack'`.
   6. DLQ insertion (own `withTransaction`, no merchant context): `envelope_id` = parsed `id` if a UUID, else `attributes.envelopeId` if a UUID, else a deterministic UUID from the first 16 bytes of `sha256(data)`; `envelope` = parsed object or NULL; `envelope_hash = sha256(data)`; `attempt_count = msg.deliveryAttempt`; `error_detail` = `{ code, errors: [{pointer, keyword}] }` only (no values) passed through the redaction allowlist; `correlation_id` = envelope `correlationId` if it matches the contract pattern, else `'unavailable'` **[ASSUMPTION]**; `traceparent` if it matches the envelope schema pattern. If DLQ insertion itself fails → `'nack'` (never ack an unrecorded failure).
3. Redelivery delay is the transport's job (`InMemoryTransport` uses P01 `backoff(MESSAGE_RETRY_SCHEDULE_MS, …)`; Pub/Sub uses the subscription retry policy — approximation, risk R-06).

**Expected behavior** — Valid new envelope → one inbox row + handler effect, `ack` after commit; duplicate → no handler call, `ack`; `payment.created.v2` → DLQ `UNSUPPORTED_VERSION`, no inbox row, no effect, `ack`; unknown field → DLQ `SCHEMA_INVALID`; semantic mismatch (`aggregateId ≠ data.paymentId`) → DLQ `INVARIANT_VIOLATION`; handler throws 8 times → DLQ `RETRY_EXHAUSTED`, `attempt_count = 8`.

**Acceptance criteria**
- [ ] Acknowledgement happens strictly after commit (proved by an `onAck` hook that reads the inbox row through a separate pool connection and must see it).
- [ ] Crash before commit → redelivery reprocesses and produces exactly one effect; crash after commit before ack → redelivery is `DUPLICATE` and produces no second effect.
- [ ] Invalid/unsupported messages never call `handle` and never insert an inbox row.
- [ ] A `GAP` leaves no inbox row and is redelivered; exhaustion DLQs it with `AGGREGATE_VERSION_GAP`.

**Testing requirements**
- `packages/messaging/src/version-gate.test.ts`: null/1, null/2, n/n+1, n/n, n/n−1, n/n+2.
- `test/integration/messaging/consumer.test.ts` (Testcontainers; `InMemoryTransport` with zero redelivery delay; a test handler for consumer `payment-worker` that inserts into a superuser-created `public.test_effects(envelope_id uuid PRIMARY KEY)` granted to `fl_payment_worker`, and a gap-aware test handler keeping per-payment versions in `public.test_versions`):
  - same envelope published 3 times with different broker IDs → one inbox row, one effect;
  - crash points `consumer.before_effect`, `consumer.before_commit` (armed in-process) → redelivery → one effect; `consumer.after_commit_before_ack` → redelivery → `DUPLICATE`, one effect;
  - ack-after-commit `onAck` visibility check for 50 messages;
  - DLQ classes: malformed JSON, unregistered type `payment.created.v2`, unknown field, invalid UUID `id`, semantic mismatch, hash mismatch (same `id`, changed data) — each asserts the DLQ row's class, `consumer_name`, `subscription_name`, `attempt_count`, `envelope_id`, `correlation_id`, derived `payment_id`/`operation_id`, and zero rows in `public.test_effects`;
  - retry exhaustion at exactly 8 attempts;
  - gap: deliver versions 1, 3, 2 → 3 parked (no inbox row) until 2 applies, final applied order 1, 2, 3; stale redelivery of version 1 after 3 → recorded and acked without effect;
  - DLQ placement never changes payment state (payment row unchanged for a DLQ'd execute command referencing a real payment);
  - prohibited-data fixture placed inside an invalid envelope's unknown field → `error_detail` contains no fixture string.
- Commands: `FLOWLEDGER_FAULT_HOOKS=1 pnpm vitest run --project integration test/integration/messaging/consumer.test.ts`, `pnpm vitest run --project unit packages/messaging/src/version-gate.test.ts`.

**Non-goals** — Real business handlers (P06+), DLQ replay (P10/P11), metrics (P11).

**Handoff checklist**
- [ ] Ack-after-commit test observed failing when `'ack'` is returned from inside the transaction callback.
- [ ] `pnpm check`, `pnpm test:integration` green.

---

### P05-T11 — Stale accepted-operation sweeper

**Task ID:** `P05-T11`
**Feature:** Rediscover committed `REQUESTED` operations whose execution nudge was lost
**Commit:** `feat(worker): add sweeper that re-enqueues stale requested operations`
**Priority:** High
**Dependencies:** `P05-T08`, `P05-T09`
**Estimated complexity:** M
**Contract references:** `docs/08` §Recovery owners ("periodic sweepers MUST rediscover outstanding work"), §Runbook: stale `REQUESTED` operation, §Sweep and claim defaults (`REQUESTED`/stale-`PROCESSING` sweeper every 15 s, claim 100), §Recovery objectives (`REQUESTED` claim age critical > 60 s), §DLQ contract (orphan detector); `docs/03` §Aggregate and operation version rules; `docs/04` §Inbox consumption ("The message is a durable nudge"); `docs/07` §Protected payment transition functions; `docs/10` M5 F10
**Files:** create: `migrations/0550_requested_operation_sweeper.sql`, `apps/payment-worker/src/sweepers/requested-operation-sweeper.ts`, `test/integration/worker/requested-operation-sweeper.test.ts`; modify: `apps/payment-worker/src/main.ts`, `packages/config/src/payment-worker.ts` (create if absent), `packages/database/src/functions/payments.ts`; must not touch: `migrations/05[0-4]*`, `apps/api/**`

**Objective** — If an execute command is lost after acceptance (dropped by the broker, never consumed), a sweeper writes a fresh `payment.operation.execute.v1` envelope for the **same** operation and provider key — never a new operation.

**Implementation instructions**
1. `migrations/0550_requested_operation_sweeper.sql`:
   - Index: `CREATE INDEX outbox_execute_operation ON messaging.outbox_messages ((envelope->'data'->>'operationId'), recorded_at) WHERE message_type = 'payment.operation.execute.v1';`
   - `payments.find_stale_requested_operations(p_min_age_seconds integer, p_limit integer) RETURNS TABLE (operation_id text, payment_id text, merchant_id text, provider_code text, payment_version bigint)` — `STABLE SECURITY DEFINER`, owner `payments_function_owner`, cross-tenant: operations with `status = 'REQUESTED' AND not_before IS NULL AND updated_at <= clock_timestamp() - make_interval(secs => p_min_age_seconds)` and **no** execute envelope for that operation that is unpublished or `recorded_at > clock_timestamp() - make_interval(secs => p_min_age_seconds)`, and **no** unresolved DLQ record (`dead_letter_records.operation_id = op.id AND resolved_at IS NULL`); ordered by `updated_at, id`, limited.
   - `payments.reenqueue_requested_operation(p_operation_id text, p_min_age_seconds integer, p_execute_command jsonb) RETURNS boolean`: `SELECT … FROM payments.payment_operations WHERE id = p_operation_id FOR UPDATE SKIP LOCKED` (none → `false`); re-check every candidate condition (else `false`); read the payment's current `version` (no lock); verify `p_execute_command` (`type = 'payment.operation.execute.v1'`, `kind = 'COMMAND'`, `merchantId`, `aggregateId = orderingKey = data.paymentId`, `data.operationId = p_operation_id`, `data.provider` = bound provider code, `aggregateVersion = data.expectedPaymentVersion = payment.version`) else `INTERNAL_ENVELOPE_MISMATCH`; `PERFORM messaging.insert_outbox(p_execute_command)`; return `true`. The operation row is **not** updated (no operation-version change: no operation-owned state changes, `docs/03` §Aggregate and operation version rules); payment version unchanged.
   - Tail: grants `SELECT ON messaging.outbox_messages, messaging.dead_letter_records TO payments_function_owner`; revoke from PUBLIC; `GRANT EXECUTE` on both to `fl_payment_worker`. Cross-tenant reads require P02 RLS to admit `payments_function_owner` without `app.merchant_id` (risk R-02).
2. `requested-operation-sweeper.ts`: `sweepStaleRequestedOperations({ pool }, { minAgeSeconds = 60, limit = 100 }): Promise<number>` — find candidates; for each, in its own `withTransaction(pool, { merchantId, correlationId: 'sweeper:' + operation_id }, …)` build the command with `buildEnvelope` (new `randomUUID()`, `causationId = operation_id`, `correlationId` = the operation's original correlation from `api.idempotency_records` is not needed — use `'sweeper:' + operation_id` **[ASSUMPTION: correlation for sweeper-created commands, risk R-08]**), validate, call `reenqueue_requested_operation`; return the count re-enqueued. `startRequestedOperationSweeper` runs it every 15 s; `apps/payment-worker/src/main.ts` starts it and stops it on shutdown. Config `packages/config/src/payment-worker.ts`: `DATABASE_URL` (role `fl_payment_worker`).

**Expected behavior** — Accepted operation whose execute envelope was published > 60 s ago with no consumer action → one new execute envelope (new UUID, same `operationId`, same provider key on the operation row); an immediate second sweep → nothing (recent envelope exists); an operation with an unpublished execute envelope → nothing; with an unresolved DLQ record → nothing; terminal or `PROCESSING` operations → nothing.

**Acceptance criteria**
- [ ] The sweeper never inserts into `payments.payment_operations` and never changes `provider_idempotency_key`, operation version, or payment version.
- [ ] Two concurrent sweeps produce at most one new envelope per operation (`SKIP LOCKED` + recent-envelope re-check).
- [ ] Candidates exclude operations with unresolved DLQ records.

**Testing requirements**
- `test/integration/worker/requested-operation-sweeper.test.ts` (use `minAgeSeconds: 1` and a 1.1 s wait instead of timestamp manipulation): broker-dropped command (relay publishes into an `InMemoryTransport` with no subscriber) → sweep re-enqueues one envelope; relay publishes it; second immediate sweep → 0; unpublished envelope → 0; DLQ'd → 0; `PROCESSING`/`UNKNOWN`/terminal (forced via fixture) → 0; concurrent sweeps → one envelope; operation and payment versions unchanged; envelope validates and passes the semantic validator.
- Command: `pnpm vitest run --project integration test/integration/worker/requested-operation-sweeper.test.ts`.

**Non-goals** — Stale `PROCESSING` handling (P06 `requeue_stale_pre_dispatch`, P08 `mark_unknown`), due `not_before` scheduling (P06 `enqueue_due_operations`), the full DLQ/orphan detector (P10).

**Handoff checklist**
- [ ] Recent-envelope test observed failing when the `recorded_at` window check is removed (sweeper re-enqueues every run).
- [ ] `pnpm check`, `pnpm test:integration` green.

---

### P05-T12 — Timeline kind `OPERATION_ACCEPTED`

**Task ID:** `P05-T12`
**Feature:** Timeline entry for each accepted operation
**Commit:** `feat(api): add operation accepted entries to the payment timeline`
**Priority:** Medium
**Dependencies:** `P05-T03`
**Estimated complexity:** S
**Contract references:** `docs/05` §Retrieve a payment timeline; `openapi.yaml` `PaymentTimelineEntry`; `docs/10` M4 F5 ("Entry kinds … are added as those milestones land"), M4 A8
**Files:** modify (commit 1, contract update): `docs/05-API_AND_IDEMPOTENCY_CONTRACT.md`; create (commit 2): `migrations/0560_timeline_operation_accepted.sql`, `test/integration/api/timeline-operations.test.ts`; modify: `packages/contracts/src/timeline-detail.ts`, `packages/contracts/src/timeline-detail.test.ts`; must not touch: `migrations/0430_payment_timeline.sql`, `openapi/**`

**Commits.** Two commits: first `docs(contracts): add OPERATION_ACCEPTED timeline detail shape` (human-approved; extends the detail-shape table created by P04-T12 step 0 with `OPERATION_ACCEPTED` → `{ operationType, amountMinor, currency }`), then the feature commit. Commit 2 waits for approval of commit 1.

**Objective** — Show every accepted operation on the timeline with the payment version its acceptance produced, and prove ordering and truncation with real multi-kind data.

**Implementation instructions**
1. `migrations/0560_timeline_operation_accepted.sql`: `CREATE OR REPLACE FUNCTION payments.payment_timeline(p_payment_id text)` (same signature, same `PAYMENT_CREATED` branch and ordering/limit from P04-T12) adding:
   ```sql
   UNION ALL
   SELECT 'OPERATION_ACCEPTED', o.created_at, om.aggregate_version, o.id,
          jsonb_build_object('operationType', o.type, 'amountMinor', o.amount_minor::text, 'currency', o.currency), 2
   FROM payments.payment_operations o
   JOIN messaging.outbox_messages om
     ON om.merchant_id = o.merchant_id AND om.aggregate_id = o.payment_id
    AND om.message_type IN ('payment.authorization.requested.v1','payment.capture.requested.v1',
                            'payment.authorization.cancellation.requested.v1','payment.refund.requested.v1')
    AND om.envelope->'data'->>'operationId' = o.id
   WHERE o.merchant_id = v_merchant AND o.payment_id = p_payment_id
   ```
   The acceptance version is not stored on the operation row, so it is read from the requested event's `aggregate_version` (risk R-09). Grant `SELECT ON messaging.outbox_messages TO payments_function_owner` (no-op if granted).
2. `timeline-detail.ts`: add `OPERATION_ACCEPTED: { type:'object', additionalProperties:false, required:['operationType','amountMinor','currency'], properties:{ operationType:{ enum:['AUTHORIZE','CAPTURE','CANCEL','REFUND'] }, amountMinor:{ type:'string', pattern:'^(?:[1-9][0-9]{0,11}|1000000000000)$' }, currency:{ const:'USD' } } }` exactly as enumerated in `docs/05` by commit 1 (risk R-09).

**Expected behavior** — After create → authorize → (forced success) → capture: entries `PAYMENT_CREATED` (v1), `OPERATION_ACCEPTED` AUTHORIZE (v2), `OPERATION_ACCEPTED` CAPTURE (v4, because the forced authorization success advanced to v3).

**Acceptance criteria**
- [ ] Each accepted operation appears exactly once with `operationId`, the acceptance-produced `paymentVersion`, and a detail passing the closed schema.
- [ ] Ordering is by database `created_at`, then kind rank.
- [ ] More than 500 entries → exactly 500 returned, `truncated: true`, newest omitted.

**Testing requirements**
- `test/integration/api/timeline-operations.test.ts`: the expected sequence above; `paymentVersion` per entry equals the requested event's `aggregateVersion`; truncation: capture 1 000, then 502 refunds of 1 minor unit via the API (sequential) → 1 + 2 + 502 = 505 rows → 500 entries, `truncated: true`, last returned entry is not the newest refund; cross-tenant `404`; response contains no prohibited-data fixture.
- `packages/contracts/src/timeline-detail.test.ts`: `OPERATION_ACCEPTED` valid/extra-field/invalid type cases.
- Commands: `pnpm vitest run --project integration test/integration/api/timeline-operations.test.ts`, `pnpm vitest run --project unit packages/contracts/src/timeline-detail.test.ts`.

**Non-goals** — `OPERATION_RESOLVED`, provider kinds (P06+).

**Handoff checklist**
- [ ] Truncation test observed failing when the SQL limit is raised to 600.
- [ ] `pnpm test:integration` green.

---

### P05-GATE — Durable acceptance and messaging milestone verification

**Task ID:** `P05-GATE`
**Feature:** M5 exit gate (checkpoint C5, Messaging-ready)
**Commit:** `test(messaging): verify p05 durable acceptance and messaging milestone`
**Priority:** Critical
**Dependencies:** `P05-T01` … `P05-T12`
**Estimated complexity:** M
**Contract references:** `docs/10` M5 §Test and acceptance criteria (every bullet); `docs/05` §Normative acceptance criteria 1–7; `docs/04` §Required contract tests (outbox/inbox/DLQ/ordering rows); `docs/08` §Required failure-injection tests (API and outbox; Refund reservation bullet 1; Messaging and DLQ); `docs/09` §Messaging integration tests, §Quality gates (Messaging-ready)
**Files:** create: `test/e2e/messaging/p05-gate.test.ts`, `docs/evidence/P05.md`, `test/fixtures/db/P05.sql`, `test/integration/db/migrate-from-p04.test.ts`; modify: none; must not touch: `apps/**`, `packages/**`, `migrations/**`

**Objective** — Prove the milestone end to end with spawned processes and the Pub/Sub emulator, plus the full chaos and integration lanes.

**Implementation instructions**
1. `test/integration/db/migrate-from-p04.test.ts`: restore `test/fixtures/db/P04.sql`, apply `0500`–`0560`, assert success and that P04 payments remain readable.
2. `test/e2e/messaging/p05-gate.test.ts`: Testcontainers PG + emulator; migrate, seed, `ensureTopology`; spawn `apps/api` and `apps/outbox-relay` (env from `.env.example` + container URLs); in-process test consumer via `PubSubTransport` + `startConsumer({ consumer: 'payment-worker', handle: record-only })`:
   - create → authorize → `202`; execute command reaches the consumer exactly once in inbox terms;
   - 100 duplicate capture calls (after a fixture-forced authorization success) → one operation and one pair of outbox rows, all published;
   - relay crash: restart the relay with `FLOWLEDGER_FAULT_HOOKS=1 FLOWLEDGER_CRASH_POINTS=relay.after_publish_before_mark`, accept a refund, wait for the relay to die, restart it without the crash point → the consumer receives the same envelope UUID twice and records one inbox row;
   - consumer crash after commit before ack (in-process crash point) → redelivery recorded as duplicate;
   - publish a hand-built `payment.created.v2` envelope and a schema-invalid envelope directly to the commands/events topics → DLQ rows with correct classes, no inbox rows;
   - stale `If-Match` → `412` with no rows; capture below minimum → `422` with no rows;
   - finally `pnpm verify:ledger` → zero findings (reservation integrity, payment totals).
3. Run `pnpm test:chaos` (P04 + P05 fault suites) and `pnpm test:integration` in the gate command list.
4. Dump `test/fixtures/db/P05.sql`; write `docs/evidence/P05.md` mapping every `docs/10` M5 bullet to test case names and recording command outputs.

**Expected behavior** — All scenarios pass; evidence maps every bullet.

**Acceptance criteria**
- [ ] Every `docs/10` M5 acceptance bullet maps to a passing named case in `docs/evidence/P05.md`.
- [ ] `flowledger verify` exits 0 after the e2e run.
- [ ] No feature code changed.

**Testing requirements** — `pnpm test:e2e -- test/e2e/messaging/p05-gate.test.ts`, `pnpm test:chaos`, `pnpm test:integration`, `pnpm verify:ledger`, `pnpm check`.

**Non-goals** — Provider execution (P06).

**Handoff checklist**
- [ ] Evidence and fixture dump committed.
- [ ] All listed lanes green.

---

## Parallelization

| Can run concurrently | Notes / shared files that conflict |
| --- | --- |
| Track A (acceptance): `T01 → T02 → T03 → {T04, T05, T12}` | T01/T02 are `SECURITY DEFINER` bodies (README §5.4 single-owner): one agent at a time. T03 edits `apps/api/src/http/operations.ts` and `problem-filter.ts` (single-owner surface with `problem-map.ts`). T04, T05, T12 are test-heavy and can run in parallel after T03 (T12 owns migration `0560`). |
| Track B (messaging): `T06 → {T07, T08}`, `T09` (after T01 only for migration ordering) `→ T10` | T07 and T08 both modify `packages/messaging/src/index.ts`, `packages/config/src/*`, `.env.example`, `docs/CONFIG.md` — rebase carefully. T08 (`0520`) and T09 (`0530`) are separate files but the same single-owner migration surface: sequence their SQL review. |
| `T11` after T08 + T09 | Owns `0550`; touches `apps/payment-worker` (P06 will extend the same app; no conflict inside P05). |
| Tracks A and B are independent until `P05-GATE`. | Migration numbers are fixed per task, so parallel tracks never collide on filenames; merge order should still follow numeric order. |

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| docs/10 M5 F1: authorize/capture/cancel/refund acceptance endpoints | T03 | `test/integration/api/commands.test.ts` :: happy path per command |
| docs/10 M5 F2: one transaction — claim, lock/version, guards, operation, pointer/reservation, version, requested event, execute command, replay | T01, T02 | `accept-operation-exclusive.test.ts` :: authorize happy path rows; `accept-operation-faults.test.ts` |
| docs/10 M5 F3: exclusion model + reservation guard + deferred trigger | T01, T02, T04 | `commands-concurrency.test.ts` :: exclusive vs refund / fitting refunds / randomized interleavings |
| docs/10 M5 F4: capture fee snapshot, minimum capture, refund copies inputs with no fee effect | T02 | `accept-operation-capture-refund.test.ts` :: golden vectors / minimum boundary / refund snapshot |
| docs/10 M5 F5: three-authorization ceiling, predecessor rule | T01, T04 | `accept-operation-exclusive.test.ts` :: ceiling; `commands-concurrency.test.ts` :: authorization ceiling |
| docs/10 M5 F6: relay SKIP LOCKED, leases, retry schedule, ack, stable UUIDs | T08 | `outbox-relay.test.ts` :: all cases |
| docs/10 M5 F7: Pub/Sub transport + deterministic local transport | T06, T07 | `in-memory-transport.test.ts`; `test/e2e/messaging/pubsub-transport.test.ts` |
| docs/10 M5 F8: inbox `(consumer_name, envelope_id)` not broker ID | T09, T10 | `consumer.test.ts` :: republish with different broker IDs |
| docs/10 M5 F9: strict validation + durable DLQ, no domain effect | T09, T10 | `consumer.test.ts` :: DLQ classes |
| docs/10 M5 F10: sweepers for unpublished outbox and accepted operations | T08 (lease rediscovery), T11 | `outbox-relay.test.ts` :: crash before publish; `requested-operation-sweeper.test.ts` |
| docs/10 M5 A1: `202` only after full commit | T03, T05 | `accept-operation-faults.test.ts` :: `commit` point → 500 |
| docs/10 M5 A2: failure after each statement rolls back everything | T05 | `accept-operation-faults.test.ts` :: 4 commands × 7 points |
| docs/10 M5 A3: 100 duplicates → one operation, one pair of outbox rows | T04, GATE | `commands-concurrency.test.ts` :: duplicates; `p05-gate.test.ts` |
| docs/10 M5 A4: stale new-key `If-Match` → `412`, key not consumed, no rows | T01, T03 | `commands-idempotency.test.ts` :: stale If-Match then corrected |
| docs/10 M5 A5: exact replay before version compare | T01, T03 | `commands-idempotency.test.ts` :: replay after advance |
| docs/10 M5 A6: changed/added/removed `If-Match` → `409 IDEMPOTENCY_CONFLICT` | T03 | `commands-idempotency.test.ts` :: If-Match changes |
| docs/10 M5 A7: capture below minimum → `422`, no rows; fixed > minimum uninsertable; `fee == gross` valid | T02, T03 | `accept-operation-capture-refund.test.ts` :: minimum / policy check / fee==gross |
| docs/10 M5 A8: concurrent fitting refunds all `202`; over-refund `409` from locked guard | T02, T04 | `commands-concurrency.test.ts` :: fitting refunds / last-amount race (guard source) |
| docs/10 M5 A9: exclusive rejected while refund unresolved and vice versa | T02, T04 | `commands-concurrency.test.ts` :: exclusive vs refund |
| docs/10 M5 A10: fee policy change after acceptance changes nothing stored | T02, T04 | `commands-concurrency.test.ts` :: fee policy change |
| docs/10 M5 A11: authorization attempts 1–3 / 4th rejected / UNKNOWN & REQUIRES_REVIEW never permit replacement | T01, T04 | `commands-concurrency.test.ts` :: authorization ceiling |
| docs/10 M5 A12: command OpenAPI conformance (statuses, codes, headers) | T03 | `commands-conformance.test.ts` |
| docs/10 M5 A13: relay crash after publish republishes same envelope ID | T08, GATE | `outbox-relay.test.ts` :: crash after publish; `p05-gate.test.ts` :: relay crash |
| docs/10 M5 A14: consumer crash before commit replays; after commit no second effect | T10 | `consumer.test.ts` :: crash points |
| docs/10 M5 A15: unknown versions/invalid messages → DLQ with metadata, no effect | T10, GATE | `consumer.test.ts` :: DLQ classes |
| docs/10 M5 A16: version gaps parked/rebuilt, not applied | T10 | `consumer.test.ts` :: gap 1,3,2 |
| docs/03 §Command acceptance steps 1–9 | T01, T02 | `accept-operation-exclusive.test.ts`, `accept-operation-capture-refund.test.ts` |
| docs/03 §Command acceptance: later operations inherit provider/account binding | T01 | `accept-operation-exclusive.test.ts` :: row binding |
| docs/03 §Aggregate version rules: acceptance increments payment version once; operation starts at v1 | T01, T02 | `accept-operation-exclusive.test.ts` :: versions |
| docs/03 §Refund: ambiguous refund keeps reservation, does not block remaining | T04 | `commands-concurrency.test.ts` :: UNKNOWN refund |
| docs/03 §Required model tests: reject/fail releases reservation, no fee reversal consumed | T04 | `commands-concurrency.test.ts` :: released reservation |
| docs/02 §Capture-fee calculation (HALF_UP, checked, never capped) | T02 | `accept-operation-capture-refund.test.ts` :: golden vectors |
| docs/07 §`accept_operation` contract (all bullets) | T01, T02 | both DB test files |
| docs/07 §Schema acceptance: guard source, reservation equality, exclusive vs refund, minimum before rows, refund fee null until terminal | T02, T04 | `accept-operation-capture-refund.test.ts` :: direct fee update rejected; `commands-concurrency.test.ts` |
| docs/07 §`outbox_messages`: claim with SKIP LOCKED, commit lease, publish without lock, ack after | T08 | `outbox-relay.test.ts` |
| docs/07 §`inbox_messages`: row and effects commit together; UUID reuse with different hash is a discrepancy | T09, T10 | `inbox-dead-letter.test.ts` :: hash mismatch; `consumer.test.ts` |
| docs/07 §`dead_letter_records`: unique per consumer/envelope; tenant-safe subject IDs | T09 | `inbox-dead-letter.test.ts` |
| docs/05 Normative 5: concurrent identical requests converge; waiter times out safely | T03, T04 | `commands-idempotency.test.ts` :: held owner |
| docs/05 Normative 6: guards under aggregate lock | T01, T02 | guard-source assertions |
| docs/05 Normative 7: `If-Match` failure creates nothing; replay bypasses compare | T03 | `commands-idempotency.test.ts` |
| docs/05 §Idempotency tests: different payment ID same key/command → conflict; key scoped by command type | T03 | `commands-idempotency.test.ts` |
| docs/04 §Transactional outbox 1–4; never new envelope ID | T08 | `outbox-relay.test.ts` |
| docs/04 §Inbox: ack only after commit; duplicate acked after dedupe | T10 | `consumer.test.ts` :: onAck visibility |
| docs/04 §Ordering and gaps rules 1–4; filtered consumers must not use contiguity | T10 | `version-gate.test.ts`; `consumer.test.ts` :: gap |
| docs/04 §Schema evolution: unsupported version → DLQ | T10 | `consumer.test.ts` :: `payment.created.v2` |
| docs/04 §Retry and DLQ policy (1s…1h then DLQ; DLQ fields) | T08, T10 | `outbox-relay.test.ts` :: delays; `consumer.test.ts` :: exhaustion at 8 |
| docs/04 §MVP messaging decisions: two topics, subscription + DLQ per consumer | T06, T07 | `topology.test.ts`; `pubsub-transport.test.ts` |
| docs/08 §API acceptance: crash after command commit → same `op_` on replay; response never before commit | T05 | `accept-operation-faults.test.ts` :: lost response / commit |
| docs/08 §Transactional outbox crash matrix (5 rows) | T08 | `outbox-relay.test.ts` :: before publish / after publish / failure |
| docs/08 §Message ack and DLQ matrix rows 1–4 | T10 | `consumer.test.ts` |
| docs/08 §Required tests "Crash outbox relay before publish, during uncertain publish, after broker ack" | T08, GATE | `outbox-relay.test.ts`; `p05-gate.test.ts` |
| docs/08 §Required tests "Refund reservation: crash after acceptance commit" | T05 | `accept-operation-faults.test.ts` :: crash after refund acceptance + verify |
| docs/08 §Required tests "Messaging and DLQ" bullets 1–3, 5 | T10, T11 | `consumer.test.ts`; `requested-operation-sweeper.test.ts` |
| docs/08 §Runbook stale REQUESTED: replay/create command for same operation, never new op/key | T11 | `requested-operation-sweeper.test.ts` |
| docs/09 §PostgreSQL integration: acceptance atomic; failure after each statement; 100 concurrent commands; refund race guard; fitting refunds; exclusive vs refund; fee policy fixed > min | T02, T04, T05 | as above |
| docs/09 §Messaging integration bullets 1–5, 7 | T08, T10 | `outbox-relay.test.ts`; `consumer.test.ts` (bullet 6 execution-command redelivery by status is P06) |
| docs/10 M4 A8 (timeline ordering + truncation with real data) | T12 | `timeline-operations.test.ts` |

## Phase risks / open questions

| ID | Risk / question | Impact | Severity | Recommended resolution | Blocked tasks |
| --- | --- | --- | --- | --- | --- |
| R-01 | Topic names were inconsistent between CONVENTIONS §9 and `docs/04` line 359; CONVENTIONS now uses the contract names. `merchant.webhook.deliver.v1` ordering key: `docs/04` line 79 says none, the machine schema/`docs/07` outbox `ordering_key NOT NULL` imply endpoint ID (README D-06 pending). | Topology/relay mismatch if D-06 resolves differently. | Low | Use `-v1` topics; relay forwards the envelope's `orderingKey` unchanged; dispatcher subscription unordered so either D-06 outcome works without code change. | T06, T07, T08 |
| R-02 | Sweeper and relay functions read across tenants without `app.merchant_id`; P02 RLS policies may hide rows from `payments_function_owner`/`messaging_function_owner`. | Sweeper/relay see nothing. | Medium | P02 RLS must exempt function-owner roles (or grant `BYPASSRLS`); if not, T08/T11 migrations add `FOR SELECT TO <owner> USING (true)` policies limited to those tables. | T08, T11 |
| R-03 | Outbox `last_error_class` values are described in prose only (`docs/07` line 1097); DLQ classes follow P02's check (`SCHEMA_INVALID`, `INVARIANT_VIOLATION`, `UNSUPPORTED_VERSION`, `RETRY_EXHAUSTED`). | Check mismatch if P02 later constrains `last_error_class`. | Low | Relay classes `PUBLISH_TIMEOUT`, `PUBLISH_REJECTED`, `TRANSPORT_UNAVAILABLE`. | T08 |
| R-04 | The `{environment}` segment of the provider idempotency key (`docs/03` line 113; example `test` in `docs/04` line 215) has no configured source. | Different processes could derive different keys (only acceptance derives it; it is stored). | Low | `FLOWLEDGER_ENVIRONMENT` env var read only by the API at acceptance; SQL validates the key's structure. | T03 |
| R-05 | `docs/07` line 1127 stores the "original **redacted** envelope" in the DLQ, while `docs/04` line 326 and `docs/08` §DLQ contract require the original envelope (needed for UUID-preserving replay). | Redacting could make replay impossible; not redacting could store prohibited data from malformed producers. | Medium | Store the original envelope (internal producers validate strictly before outbox); redact `error_detail` and all previews (P11). Reconcile `docs/07` wording. | T09, T10 |
| R-06 | Pub/Sub retry backoff caps at 600 s and the emulator's dead-letter/`deliveryAttempt` support is incomplete, so the `30m`/`1h` steps and attempt counting are approximate on Pub/Sub. | Retry schedule differs from `docs/04` §Retry on the real broker. | Low | Contract says "approximately"; exact schedule is enforced and tested with `InMemoryTransport`; `deliveryAttempt` defaults to 1 when absent. Revisit in P13 if needed (durable attempt counter). | T07, T10 |
| R-07 | CONVENTIONS §9 requires one subscription per consumer name, but `provider-webhook-worker` consumes no cataloged message (`docs/04` §Initial command catalog). | Empty subscription or missing name. | Low | No subscription for it in P05; P09 adds one only if it introduces a nudge message. | T06 |
| R-08 | `correlationId` for sweeper-created execute commands is undefined (`docs/05` line 499 says correlation propagates from the original command). | Trace continuity. | Low | Use `sweeper:<operationId>`; P11 may switch to the original correlation from `api.idempotency_records`. | T11 |
| R-09 | `OPERATION_ACCEPTED` needs the payment version produced by acceptance, which `payments.payment_operations` does not store (`docs/07` §`payment_operations`); detail shape not enumerated (`openapi.yaml` lines 1303–1306 vs `docs/05` lines 314–363). | Timeline depends on outbox rows; would break after outbox archival. | Medium | Read `aggregate_version` from the requested event (archival is deferred in the MVP); recommend adding `accepted_payment_version` to `payment_operations` and enumerating detail shapes in `docs/05`. | T12 |
| R-10 | `openapi.yaml` `refundPayment` description (lines 272–273) says "Only one unresolved operation is permitted", contradicting `docs/05` line 263, `docs/03` §Operation exclusion model, and ADR-0003. | An agent may add a one-unresolved-refund rule. | Medium | Follow ADR-0003 (concurrent refunds); fix the openapi description in a contract commit. | T02, T03 |
| R-11 | Resolved: CONVENTIONS §9 `Transport.publish` returns `Promise<string>` (broker message ID); the relay passes it to `mark_outbox_published`, which records `broker_message_id` (metadata only, never a dedupe key). | — | Low | Closed. | T06, T08 |
| R-12 | README §8.3 places `crashPoint(name)` in `packages/testkit`, but CONVENTIONS §3 forbids packages (e.g. `packages/messaging`) from importing testkit. | Relay/consumer crash points could not be placed. | Low | Primitive in `packages/config/src/crash-points.ts`; testkit only arms/disarms. | T08, T10 |
| R-13 | Error code for the fourth authorization attempt is not specified (`docs/03` §MVP policy decisions; `docs/10` M5 "the fourth is rejected"). | Clients may see an unexpected code. | Low | `409 INVALID_PAYMENT_STATE` with `DETAIL {"reason":"AUTHORIZATION_ATTEMPTS_EXHAUSTED"}` (not exposed in the problem body). | T01 |
| R-14 | Until P06/P07 exist, pre-resolved operation states come from the superuser `forceOperationOutcome` fixture, which depends on P02 guard triggers permitting `payments_function_owner`. | Concurrency/ceiling tests blocked if P02 triggers reject it. | Medium | Fixture writes contract-consistent state and must pass the deferred trigger; if blocked, stop and report; P06/P07 re-run T04's suite through real transitions. | T04 |
| R-15 | Two-call acceptance deviates from the single-function wording of `docs/07` §Protected payment transition functions; P02's claim-first design forces the replay body to be computed before the operation row exists. | Reviewers may flag non-literal implementation; body could diverge. | Medium | `accept_operation` fails closed without a same-transaction claim, performs every lock and guard, and asserts the committed representation equals the claimed body; record the pattern in `docs/07` via a contract commit. Requires P02 triggers to accept explicit `created_at`/`updated_at` from the function. | T01, T02 |
