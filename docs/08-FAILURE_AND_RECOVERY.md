# Failure and recovery contract

Status: **Draft**  
Last updated: 2026-11-05

## Purpose

This document defines what FlowLedger does when a process, network call, message delivery, provider, or database operation fails at any meaningful crash point.

Recovery is part of the correctness model. A handler is incomplete unless its committed state tells another process how to continue without guessing whether money moved.

## Recovery axioms

1. PostgreSQL state, not process memory or Pub/Sub acknowledgement, records accepted work.
2. A committed payment or ledger effect is never rolled back because a response or acknowledgement was lost.
3. An uncommitted database transaction has no business effect.
4. At-least-once publication and delivery imply duplicates; stable IDs and uniqueness constraints reduce them to one business effect.
5. A provider write that may have been transmitted is ambiguous until verified provider evidence resolves it.
6. FlowLedger never creates a replacement operation to recover an existing provider operation.
7. Provider write recovery reuses the original `op_` ID and provider idempotency key.
8. `UNKNOWN` and `REQUIRES_REVIEW` do not change confirmed payment totals or create speculative journal entries. An ambiguous refund keeps holding its reservation, because the provider may yet have applied it; releasing a reservation to unblock a payment is forbidden.
9. DLQ placement is a message-delivery state, not a financial outcome.
10. Operator recovery uses audited domain commands; direct database editing is outside the recovery contract.
11. Capture/refund confirmation, payment totals, ledger posting, balance projection, and outgoing events share one PostgreSQL transaction.
12. A message is acknowledged only after the handler's durable effects commit.

Public entity identifiers use a lower-case prefix, `_`, and a 26-character Crockford ULID, for example `pay_01ARZ3NDEKTSV4RRFFQ69G5FAV`, `op_01ARZ3NDEKTSV4RRFFQ69G5FAW`, and `ltx_01ARZ3NDEKTSV4RRFFQ69G5FAY`. Internal command/event envelope `id` values are UUIDs and remain stable across publication and delivery retries.

## Recovery owners

| Failure surface | Primary recovery owner | Durable work record |
| --- | --- | --- |
| Lost API response | Merchant client plus API idempotency handler | API idempotency record |
| Unpublished or multiply published outbox row | Outbox relay | Outbox row with stable envelope UUID |
| Undelivered or redelivered command/event | Subscriber and Pub/Sub | Inbox row plus domain work record |
| Stale payment operation before provider dispatch | Payment worker/stale-operation sweep | Operation and provider-attempt lease |
| Possible provider write | Reconciliation worker | Original operation, provider key, and evidence |
| Provider webhook delivery | Provider webhook receiver/processor | Verified notification row |
| Capture/refund journal application | Payment and ledger modules in one transaction | Operation ID and ledger posting key |
| Merchant webhook delivery | Merchant webhook dispatcher | Webhook-delivery record |
| Abandoned settlement run | Settlement worker/stale-run sweeper | Settlement run row |
| Contradictory evidence or exhausted reconciliation | Platform operator | Review case and append-only evidence |

The recovery owner may schedule work through Pub/Sub, but the message is a nudge. Losing a message does not erase the durable work record; periodic sweepers MUST rediscover outstanding work.

## Crash-point matrix

### API acceptance

| Crash point | Durable state | Risk | Required recovery |
| --- | --- | --- | --- |
| Before the command transaction begins | Nothing accepted | Client does not know whether to retry | Client retries with the same idempotency key |
| During validation or before transaction commit | Transaction rolls back; no payment/operation/outbox effect | Duplicate client retry | Same-key retry executes normally |
| After `CreatePayment` commit but before `201 Created` reaches the client | Payment, idempotency result, and `payment.created.v1` outbox row exist | Client believes creation failed | Same-key retry returns the original `pay_` ID and stored response |
| After provider-backed command commit but before `202 Accepted` reaches the client | Operation is `REQUESTED`; the exclusive pointer or refund reservation, idempotency result, requested event, and execution command exist | Client may submit again | Same-key retry returns the original `op_` ID. A different key on an exclusive command meets the exclusion guard; a different key on a refund is a genuinely new refund and is accepted only if the reservation guard still permits it, which is why the idempotency key is the client's duplicate protection here, not the exclusion model |
| Response is attempted before commit | Forbidden implementation | API could claim acceptance for lost work | Integration test MUST prove responses are emitted only after commit |

No API handler calls a provider. Therefore an API crash cannot by itself create an ambiguous provider outcome.

### Transactional outbox

| Crash point | Durable state | Risk | Required recovery |
| --- | --- | --- | --- |
| Before outbox claim | Unpublished row | Work waits | Relay claims it later |
| After claim but before publish | Row has a lease and remains unpublished | Work delayed until lease expiry | Relay reclaims the same row and envelope UUID |
| During publish with no broker acknowledgement | Publication may or may not have occurred | Duplicate publication | Retry the same envelope UUID |
| After broker acknowledgement but before marking published | Broker has message; row remains unpublished | Definite duplicate publication on retry | Consumer inbox deduplicates by `(consumer_name, envelope_id)` |
| After marking published | Row records completion | None beyond broker delivery | Normal subscriber retry policy |

The relay MUST NOT generate a new envelope UUID when retrying. Pub/Sub's `messageId` is transport metadata and is never a business deduplication key.

### Worker claim and provider dispatch

| Crash point | Durable state | Risk | Required recovery |
| --- | --- | --- | --- |
| Before consuming/claiming execution command | Operation remains `REQUESTED` | Delayed work | Message redelivery or `REQUESTED` sweeper republishes `payment.operation.execute.v1` |
| After inbox check but before claim commit | Transaction rolls back | Redelivery | Retry normally |
| After operation becomes `PROCESSING` and attempt is `RESERVED`, before `dispatchMarkedAt` | Live or stale lease; no recorded possible transmission | Worker dies before call | After lease expiry, another worker reclaims the same operation and key |
| After `dispatchMarkedAt` commits but before the network stack sends bytes | Operation is `PROCESSING`; transmission cannot be disproved by local state | Conservative false ambiguity | Stale sweep moves the original operation to `UNKNOWN`; reconcile rather than blind retry |
| While provider request is in flight | Operation is `PROCESSING`; provider may apply it | Duplicate charge/capture/refund if reissued | Deadline or stale lease leads to `UNKNOWN` and reconciliation |
| Provider commits effect, response is lost | Operation is still `PROCESSING` locally | External/internal divergence | Move to `UNKNOWN`; lookup/webhook resolves original operation |
| Complete provider response arrives, process crashes before it is durably recorded | Operation remains `PROCESSING` | Valid evidence lost from memory | Stale sweep makes it `UNKNOWN`; reconciliation reacquires evidence |
| Normalized result is stored but terminal payment transaction has not committed | No confirmed payment effect; intermediate evidence may exist | Duplicate result handling | Reapply stored evidence idempotently under operation/payment lock |
| During terminal payment transaction before commit | Entire transaction rolls back, including payment totals, ledger, balances, and outbox | Provider may have succeeded but internal effect is absent | Reload state and apply the same verified result, or reconcile if evidence was lost |
| Terminal transaction commits, process crashes before command acknowledgement | Operation terminal; confirmed totals and any ledger/outbox effects exist | Command redelivery | Reload terminal operation and acknowledge without provider call |
| Command acknowledgement succeeds | Durable terminal state already exists | None | No action |

A stale `PROCESSING` lease does not authorize another write once `dispatchMarkedAt` exists. It authorizes investigation.

### Provider result resolution

| Crash point | Durable state | Risk | Required recovery |
| --- | --- | --- | --- |
| Adapter returns `FAILED` with no durable `NoEffectProof` | Contract violation | A real effect could be discarded | Reject the result, mark `UNKNOWN`, alert on adapter defect |
| Adapter returns `UNKNOWN`, crash before state commit | Operation may remain `PROCESSING` | Reconciliation not yet scheduled | Stale sweep transitions it to `UNKNOWN` |
| `UNKNOWN` transition commits, reconcile command not yet published | Operation is `UNKNOWN`; reconciliation event/command outbox rows exist | Delayed resolution | Outbox relay publishes; unknown-operation sweeper is backup |
| Reconciliation lookup begins and worker crashes | No provider write occurs | Delayed resolution only | Retry read-only lookup |
| Lookup finds success, crash before terminal commit | Operation remains `UNKNOWN` or evidence is durably staged | Internal effect missing | Reapply verified evidence using original operation and posting key |
| Reconciliation terminal commit succeeds, acknowledgement is lost | Original operation is terminal | Duplicate reconciliation | Reload and acknowledge; no second ledger posting |
| Automated lookup remains inconclusive through policy | Operation remains unresolved | Conflicting commands stay blocked | Set `REQUIRES_REVIEW` and emit `payment.operation.review.required.v1` |

Transitioning an operation to `UNKNOWN` increments the payment version, creates the durable ambiguity/stale reconciliation case and initial activity, and emits `payment.operation.reconciliation.required.v1` plus its reconcile command in the same transaction. Resolution locks and resolves that case in the same transaction as the original operation/payment transition, then emits the normal operation-specific terminal event with `resolutionSource=RECONCILIATION`.

### Provider webhook ingestion and processing

| Crash point | Durable state | Risk | Required recovery |
| --- | --- | --- | --- |
| Signature is invalid or outside replay tolerance | No trusted notification | Spoofing or misconfiguration | Reject, record redacted security metric, investigate repeated failures |
| Valid request arrives; receiver crashes before insert | No notification row | Provider event temporarily lost | Provider retries because no success response was returned |
| Notification insert commits; receiver crashes before success response | Unique notification row exists | Duplicate provider delivery | Return success on duplicate after unique-key lookup |
| Receiver responds successfully; async processing has not begun | Unprocessed verified row | Processing delay | Notification sweeper republishes processing work |
| Processor crashes before transition commit | Payment transaction rolls back | Redelivery | Process the same verified notification again |
| Payment/ledger transition commits; processor crashes before acknowledgement | Operation terminal and notification application recorded | Duplicate webhook processing | Inbox/notification application key reduces it to corroborating evidence |
| Verified webhook cannot be correlated | Parked notification | A real provider effect may be unmatched | Reconciliation/operator queue investigates; never create a payment from the webhook |
| Late webhook agrees with terminal state | Corroborating evidence | Duplicate domain effect | Record evidence only |
| Late webhook contradicts terminal state | Both pieces of evidence retained | Potential financial discrepancy | Emit `payment.discrepancy.detected.v1`; manual review |

Provider webhook deduplication uses `(webhook_endpoint_id, provider_event_id)`, not an event timestamp or payload ordering. Tenant/provider-account identity is attached only after verified immutable references match an existing operation and the account is allowlisted for that endpoint.

### Ledger and balance projection

| Crash point | Durable state | Risk | Required recovery |
| --- | --- | --- | --- |
| Before journal posting begins | No ledger effect | Confirmed provider result not yet reflected | Apply the original operation result |
| During posting before transaction commit | Journal, entries, balance updates, payment transition, and outbox all roll back | Partial financial record | None can be visible; retry with the same posting key |
| Database commit result is lost to the worker | Commit may or may not have occurred | Duplicate posting attempt | Reload operation and posting key before acting |
| Posting committed, worker crashes before command acknowledgement | One complete journal transaction exists | Duplicate delivery | Existing operation/posting key returns the original transaction |
| Duplicate posting has same posting key and financial hash | Original transaction exists | None | Return original transaction |
| Duplicate posting has same key but different financial hash | Original transaction exists | Corrupted retry or code defect | Reject, emit discrepancy, require operator review |
| Payment says capture/refund succeeded but expected journal is absent | This state should be impossible under the shared transaction | Severe invariant breach | Stop affected mutation path, page operator, rebuild evidence, never fabricate history |
| Balance projection differs from reconstructed immutable entries | Entries remain authoritative | Incorrect balance reads | Quarantine affected account, rebuild projection, investigate cause |

For capture and refund, the ledger posting key is derived from the immutable operation ID. A retry never uses a new posting key.

### Settlement

| Crash point | Durable state | Risk | Required recovery |
| --- | --- | --- | --- |
| Before the run is claimed | Nothing claimed | Settlement delayed | Scheduler claims it on the next pass |
| After claim commit, before the posting transaction | Run is `CLAIMED` with a lease; no batch, no membership | Run appears stuck | Lease expiry lets the stale-run sweeper reclaim it; selection restarts from scratch |
| During the posting transaction before commit | Batch, membership, posting, balances, and run outcome all roll back together | Partial batch | None is possible; the next run re-selects under a new batch ID |
| Posting committed, worker dies before acknowledging its schedule | Batch, membership, and clearing-to-payable posting exist; run is `POSTED` | Duplicate run attempt | The next run finds those movements already have membership rows and selects only newer ones |
| Run deferred because net was zero or negative | Run is `DEFERRED`; nothing posted or settled | None | Movements remain eligible; the next run re-evaluates |
| Clearing stays negative across many runs | Every run defers | Merchant value is owed back and never settles | Alert on persistent negative clearing age; resolve as a business matter, never by posting a negative payout |

Settlement has no ambiguity class, because it calls no external system. Every settlement failure is either a rolled-back transaction or a deferred run, and neither can produce a partial financial effect. A crash cannot leave a half-built batch, because selection, membership, posting, and the run outcome share one transaction.

### Message acknowledgement and DLQ

| Crash point | Durable state | Risk | Required recovery |
| --- | --- | --- | --- |
| Subscriber crashes before handler commit | No inbox/effect commit | Redelivery | Process again |
| Handler commits inbox and local effects, crashes before acknowledgement | Durable effect exists | Duplicate delivery | Inbox deduplicates by envelope UUID |
| Subscriber acknowledges before commit | Forbidden implementation | Permanent message loss | Tests and shared subscriber abstraction MUST make this impossible |
| Retryable handler error exhausts delivery policy | Original envelope and failure metadata in DLQ | Work stops progressing | DLQ runbook classifies and replays safely after cause is fixed |
| Execution command enters DLQ while operation is `REQUESTED` | Operation is still accepted work | Payment can remain stuck | Operation sweeper alerts and republishes/requeues after diagnosis |
| Execution command enters DLQ while operation is `PROCESSING` after dispatch | Provider effect may exist | Blind replay could duplicate effect | Move to `UNKNOWN`; use read-only reconciliation and do not replay the provider write in the MVP |

DLQ replay preserves the original envelope UUID. If the transport requires a new broker message, the embedded business envelope remains unchanged.

### Merchant webhook delivery

| Crash point | Durable state | Risk | Required recovery |
| --- | --- | --- | --- |
| Before outbound delivery | Pending delivery row | Delayed notification | Dispatcher retries |
| Endpoint may receive payload but response times out | Delivery outcome unknown | Merchant may receive duplicate | Retry the same delivery ID, event ID, signature scheme, and immutable payload |
| Endpoint returns success; dispatcher crashes before marking delivered | Pending delivery row | Duplicate delivery | Retry; merchant deduplicates by event ID |
| Delivery exhausts retry policy | Failed delivery record | Merchant notification absent | Alert merchant/operator and allow audited replay |

Merchant webhooks are notifications only. Failure to deliver one never reverses or changes a payment or ledger fact.

## Retry classification

| Failure class | Automatic action | Financial-state effect |
| --- | --- | --- |
| Database unavailable before commit | Retry with backoff and jitter | None until commit |
| Pub/Sub publish/delivery uncertainty | Repeat same envelope | Inbox/domain idempotency prevents duplicates |
| Worker failure before `dispatchMarkedAt` | Reclaim same operation after lease | None yet |
| Provider rate limit proven pre-execution | Reschedule same operation/key at `notBefore` | None |
| Provider unavailable before proven transmission | Retry same operation according to adapter policy | None |
| Any failure after possible provider transmission | Reconcile first | Operation becomes `UNKNOWN`; no ledger effect |
| Schema or unsupported-version error | DLQ and alert | No inferred financial outcome |
| Invariant or idempotency-hash conflict | Stop automatic retry; discrepancy/review | Preserve prior committed state |
| Duplicate envelope or provider webhook | Acknowledge after dedupe verification | No additional effect |
| Contradictory provider evidence | Manual review | No silent overwrite |

Default message-processing delays are:

```text
1s, 5s, 30s, 2m, 10m, 30m, 1h, then DLQ
```

Default fast reconciliation for an `UNKNOWN` operation is:

```text
5s, 30s, 2m, 10m, 1h, then REQUIRES_REVIEW
```

Delays include jitter. A provider retry hint is honored within configured safety limits. Scheduled work uses a durable `notBefore`; workers do not sleep while holding a lease or database connection.

## No-blind-retry rule

A provider write is a blind retry when FlowLedger issues it after the previous attempt may have been transmitted without first resolving the provider outcome or obtaining typed proof that the attempt had no effect.

Blind retries are forbidden. See [ADR-0004](adr/0004-read-only-ambiguity-resolution.md).

Before another provider write, the worker MUST prove one of:

1. No request could have been transmitted.
2. The operation has not passed `dispatchMarkedAt`.
3. A normalized `RETRYABLE_NO_EFFECT` result supplies contracted no-effect proof and the guarded transaction has rescheduled the existing operation with its original key.

Otherwise the only provider activity is read-only lookup. The operation stays `UNKNOWN` or becomes `REQUIRES_REVIEW`. Although adapters conformance-test declared `SAME_KEY_REPLAY` behavior, the MVP deliberately exposes no automatic or operator transition from either ambiguous state back to execution.

Creating a new operation, changing the provider key, routing to another provider, or changing request semantics is never a retry. It is a new financial action and is forbidden as automatic recovery.

## DLQ contract

Every DLQ record retains:

```text
original envelope, including its UUID
consumer name and subscription
first and latest failure time
attempt count
failure classification
redacted error code and safe message
operation/payment identifiers when present
correlation and trace identifiers
replay history
```

DLQ handling rules:

- Schema errors and unsupported versions wait for compatible code or an explicit migration.
- Transient infrastructure failures may be replayed after health is restored.
- Invariant conflicts require investigation before replay.
- A provider execution command is never replayed without checking the current operation and attempt state.
- A terminal operation causes an execution-command replay to acknowledge without a provider call.
- `UNKNOWN` or `REQUIRES_REVIEW` causes replay to schedule reconciliation, not execution.
- Replay keeps the original business envelope UUID and is audited.

A periodic detector compares nonterminal operations against active queue/outbox/DLQ records so accepted work cannot disappear silently between systems.

## Manual review contract

`REQUIRES_REVIEW` means automated reconciliation could not prove an outcome. It is unresolved and continues to block conflicting payment commands.

An operator may:

- Inspect redacted attempt and provider evidence.
- Trigger another read-only provider lookup.
- Reprocess a verified webhook.
- Replay a message after its nonfinancial failure is fixed.
- Attach an immutable investigation note or external evidence reference.
- Initiate an explicit compensating business workflow after an externally confirmed discrepancy.

An operator may not:

- Mark an operation `SUCCEEDED`, `REJECTED`, or `FAILED` based only on a guess.
- Change confirmed payment totals directly.
- Insert, update, or delete journal entries.
- Clear `activeExclusiveOperationId` or release a refund reservation merely to unblock a payment.
- Generate a new provider key for the existing operation.
- Route the operation to another provider.
- Delete contradictory evidence.

Every operator command records actor, reason, evidence references, old and new states, time, correlation ID, and resulting events.

## Runbook: stale `REQUESTED` operation

### Detection

- Operation age exceeds the execution-queue SLO.
- No live execution lease exists.
- The operation is not terminal and is not present in an active outbox/queue item.

### Checks

1. Confirm the operation status is `REQUESTED`.
2. Confirm no provider attempt has `dispatchMarkedAt`.
3. Check outbox and execution-command DLQ by operation ID.
4. Check provider/account rate-limit and circuit state.

### Safe action

Repair/replay the original `payment.operation.execute.v1` envelope or create a new command envelope that references the same durable operation according to the sweeper contract. Do not create a new payment operation or provider key.

### Exit criteria

The operation is actively leased, terminal, `UNKNOWN`, or explicitly in a scheduled queue with bounded `notBefore`.

## Runbook: stale `PROCESSING` operation

### Detection

The processing lease expired without a terminal result.

### Checks

1. Inspect the provider attempt's `dispatchMarkedAt`.
2. Confirm whether any normalized response/evidence was durably recorded.
3. Search verified webhook notifications and provider references.

### Safe action

- If `dispatchMarkedAt` is null, reclaim the same operation after the lease expires.
- If `dispatchMarkedAt` exists, transition the original operation to `UNKNOWN`, emit `payment.operation.reconciliation.required.v1`, and schedule `payment.operation.reconcile.v1`.
- If a complete verified result is already durable, apply that result instead of calling the provider.

### Exit criteria

The operation is safely re-leased before dispatch, terminal, `UNKNOWN`, or `REQUIRES_REVIEW`.

## Runbook: `UNKNOWN` operation

### Detection

- Operation status is `UNKNOWN`.
- `payment.operation.reconciliation.required.v1` emitted.
- Unknown-operation age or backlog alert fires.

### Checks

1. Verify provider/account binding and stable provider idempotency key.
2. Check provider operation and payment references.
3. Review verified webhook evidence.
4. Query the provider read-only by operation ID, payment ID, then idempotency key as supported.
5. Compare operation type, amount, currency, and provider status.

### Safe action

- Matching confirmed success: apply the original success transition and original ledger posting key.
- Matching definitive rejection/no-effect result: apply the corresponding `REJECTED` or `FAILED` transition.
- Inconclusive absence: leave `UNKNOWN` and schedule the next lookup.
- Contradiction: emit `payment.discrepancy.detected.v1`.
- Policy exhausted: set `REQUIRES_REVIEW` and emit `payment.operation.review.required.v1`.

### Exit criteria

The original operation is terminal, scheduled for a bounded next lookup, or visible in the operator review queue.

## Runbook: provider outage or rate limiting

### Detection

Provider latency, `5xx`, rate-limit, open-circuit, queue-age, or unknown-outcome alerts.

### Checks

1. Separate failures before dispatch from ambiguous in-flight failures.
2. Inspect affected provider accounts and merchants.
3. Verify that other provider pools remain healthy.
4. Check provider status and authenticated retry hints.

### Safe action

- Stop or reduce new dispatch before the provider call.
- Reschedule proven-not-sent work with durable `notBefore`.
- Reconcile possibly sent work.
- Preserve fair per-merchant scheduling.
- Communicate degraded acceptance/processing without claiming financial failure.

### Exit criteria

Circuit closes gradually, queue age declines, ambiguous operations have reconciliation coverage, and no cross-provider resource starvation remains.

## Runbook: outbox or subscriber backlog

### Detection

Oldest unpublished outbox age, publish error rate, subscription age, or unprocessed durable-work count exceeds SLO.

### Checks

1. Verify database availability and relay leases.
2. Compare outbox rows with broker publication metrics.
3. Check subscription/DLQ health and schema versions.
4. Confirm that durable operations remain discoverable by sweepers.

### Safe action

Resume/restart relays and subscribers, reclaim expired leases, and republish original envelope UUIDs. Scale workers only after checking provider and database capacity.

### Exit criteria

Backlog age and depth return below SLO, no accepted operation is orphaned, and duplicate effects remain zero.

## Runbook: provider execution command in DLQ

### Checks

1. Load the operation and provider attempt by IDs from the envelope.
2. Determine whether it is `REQUESTED`, live `PROCESSING`, stale `PROCESSING`, `UNKNOWN`, `REQUIRES_REVIEW`, or terminal.
3. Determine whether `dispatchMarkedAt` exists.
4. Fix the underlying schema, configuration, or infrastructure defect.

### Safe action

| Current operation state | Action |
| --- | --- |
| `REQUESTED`, never dispatch-marked | Replay original execution command |
| Live `PROCESSING` | Do not replay; let owner finish |
| Stale `PROCESSING`, never dispatch-marked | Reclaim after lease |
| Stale `PROCESSING`, dispatch-marked | Set `UNKNOWN`; reconcile |
| `UNKNOWN` or `REQUIRES_REVIEW` | Schedule read-only reconciliation |
| `SUCCEEDED`, `REJECTED`, or `FAILED` | Mark DLQ item resolved; no provider call |

### Exit criteria

The DLQ item is audibly resolved and the durable operation has a correct active recovery owner.

## Runbook: provider webhook incident

### Detection

Signature-failure spike, delivery gap, unprocessed-notification age, duplicate spike, or uncorrelated-event queue growth.

### Checks

1. Confirm endpoint/account secret version and clock skew.
2. Verify failures against raw bytes in the restricted quarantine.
3. Check unique provider event IDs and notification processing state.
4. Compare provider dashboard/API records with received events.

### Safe action

Correct configuration, request provider redelivery when available, replay verified stored notifications, and use reconciliation lookup to fill gaps. Never disable signature verification to clear a backlog.

### Exit criteria

Signatures verify, notification age recovers, uncorrelated items have owners, and provider/internal comparisons show no unresolved silent gap.

## Runbook: stalled or deferring settlement

### Detection

- Oldest `CLAIMED` settlement run exceeds its lease plus the sweep interval.
- A merchant's unsettled movement age exceeds the settlement objective.
- A merchant defers on consecutive runs while eligible movements exist.
- Merchant clearing holds a negative balance beyond the documented age.

### Checks

1. Confirm whether the run is `CLAIMED` with an expired lease, or repeatedly `DEFERRED`.
2. Count eligible movements and compute the net independently from journal entries.
3. If the net is negative, identify the refunds that caused it and whether their captures settled in an earlier batch.
4. Verify no batch exists for those movements, using the unique member index.
5. Confirm merchant clearing and payable rebuild exactly from entries.

### Safe action

- Expired lease: let the stale-run sweeper reclaim it, or reclaim explicitly. Selection restarts; there is no partial batch to clean up.
- Repeated deferral with a negative net: this is correct behavior, not a fault. Escalate as a business matter. Do not post a negative batch, do not reduce merchant payable, and do not mutate a closed batch.
- Repeated deferral with a positive net: this indicates a selection or eligibility defect. Stop the settlement worker for that merchant and investigate before posting anything.
- Never mark movements settled by hand. Membership exists only as a side effect of a posted batch.

### Exit criteria

Either a batch posts for the eligible movements, or the deferral is explained by a net at or below zero and owned as an operator case. Clearing and payable rebuild exactly from immutable entries in both outcomes.

## Runbook: ledger or payment discrepancy

### Detection

- `payment.discrepancy.detected.v1`.
- Successful capture/refund lacks its expected posting key.
- Ledger posting exists without its expected terminal operation.
- Balance reconstruction differs from the synchronous projection.
- Provider evidence contradicts a terminal operation.

### Checks

1. Freeze new mutations for the affected payment or account scope.
2. Preserve database, provider, outbox, inbox, and evidence records.
3. Reconstruct the timeline using operation ID, posting key, envelope UUID, and correlation ID.
4. Query provider state read-only.
5. Rebuild ledger balances from immutable entries.
6. Identify whether the issue is external-state mismatch, missing internal transition, projection corruption, or contradictory evidence.

### Safe action

- Reapply an idempotent missing transition only when verified provider evidence and the original operation identify it.
- Rebuild a derived balance projection from immutable entries.
- Use a new audited compensating journal transaction for a genuine business correction.
- Keep the original journal immutable.
- Escalate an unexplained atomicity breach as a highest-severity incident.

### Exit criteria

Provider and internal facts are either reconciled or explicitly represented as an owned review case; ledger invariants pass; affected mutation paths are safe to reopen.

## Required failure-injection tests

### API and outbox

- Crash before and after payment-creation commit; same-key retry returns one `pay_` ID.
- Crash before and after provider-command commit; same-key retry returns one `op_` ID.
- Lose every successful API response and prove no duplicate operation.
- Crash outbox relay before publish, during uncertain publish, and after broker acknowledgement; prove one business effect from repeated envelope UUID.

### Worker and provider

- Crash before claim, after claim, before dispatch mark, after dispatch mark, during provider call, after response, during result commit, and after result commit.
- Prove a stale pre-dispatch attempt is safely reclaimed.
- Prove a stale post-dispatch attempt becomes `UNKNOWN`.
- Simulate provider commit followed by timeout; prove no blind retry, eventual reconciliation, and one provider effect.
- Redeliver an execution command in every operation status and prove no duplicate provider action.
- Lose all in-memory provider responses and prove durable reconciliation reaches the same final state.

### Webhooks

- Reject tampered signatures and accept valid signatures.
- Crash before notification insert and after insert before HTTP response.
- Deliver one provider event one hundred times; prove one notification application.
- Deliver success, rejection, and expiry notifications out of order.
- Deliver a valid uncorrelated notification; prove no invented payment.
- Deliver evidence contradicting a terminal operation; prove discrepancy rather than overwrite.

### Ledger

- Inject failure after every statement in capture/refund result transactions and prove all-or-nothing visibility.
- Lose commit acknowledgement and retry the same posting key.
- Race duplicate success signals from API response, webhook, and reconciliation; prove one terminal transition and one journal transaction.
- Reuse a posting key with a changed financial hash; prove conflict and review.
- Rebuild every balance from immutable entries and compare with the synchronous projection, including the striped-bucket sum for every logical platform account.
- Retry a posting whose key already exists and prove it resolves to the same bucket and returns the original transaction.

### Refund reservation

- Crash after a refund acceptance commit and prove the reserved total still equals the sum of unresolved refund rows.
- Crash during a refund terminal transition and prove the reservation is neither double-released nor lost.
- Race several refund confirmations and prove the reserved total never goes negative and `refunded + reserved <= captured` holds at every commit.
- Leave a refund `UNKNOWN`, restart every process, and prove the reservation survives and still bounds new refunds.

### Settlement

- Crash at every point in the settlement transaction and prove no batch, membership, or posting is ever partially visible.
- Crash after the posting commit and prove the next run selects only newer movements.
- Abandon a `CLAIMED` run and prove the sweeper reclaims it and restarts selection without duplicating membership.
- Run two settlement workers concurrently for one merchant and prove at most one batch posts over a given movement set.
- Confirm a refund after its capture settled and prove clearing goes negative, the next run defers, the closed batch is unchanged, and payable does not decrease.
- Settle under concurrent capture and refund traffic and prove clearing and payable rebuild exactly from entries afterward.

### Messaging and DLQ

- Crash consumers before and after inbox/effect commit.
- Prove shared subscriber code cannot acknowledge before commit.
- Exhaust retry policy for schema, infrastructure, and invariant failures; verify correct DLQ metadata.
- Replay DLQ execution commands against all operation statuses.
- Remove or delay broker messages and prove sweepers rediscover accepted operations and verified notifications.

### Load and isolation

- Hold one provider slow while another remains healthy.
- Generate a hot merchant and prove bounded fairness for other merchants.
- Create a retry storm and prove database/provider concurrency limits hold.
- Measure recovery time, unknown backlog, outbox age, queue age, duplicate deliveries, and duplicate financial effects.
- The required duplicate financial-effect count is zero.

## Recovery observability

Minimum metrics:

```text
operations_requested_total
operations_processing
operations_unknown
operations_requires_review
stale_processing_total
provider_attempts_total by normalized outcome
provider_request_latency
provider_rate_limited_total
reconciliation_age and attempts
outbox_oldest_unpublished_age
subscription_oldest_unprocessed_age
dlq_depth by consumer and classification
provider_webhook_unprocessed_age
provider_webhook_signature_failures
ledger_posting_conflicts
ledger_projection_mismatches
ledger_bucket_lock_wait by logical account
settlement_runs_total by outcome
settlement_unsettled_movement_age
settlement_negative_clearing_age
payment_reserved_refund_total
payment_unresolved_refunds
duplicate_envelopes_total
duplicate_provider_notifications_total
duplicate_financial_effects_total
```

`duplicate_financial_effects_total` is the project's headline correctness claim, so it has an explicit definition rather than an implied one. It is **not** a count of journal rows sharing a `payment_operation_id`: the unique index makes that impossible, so such a metric would read zero without proving anything. It is a cross-system comparison against the fake provider's ground truth, computed by the invariant checker defined in `09-TEST_AND_PERFORMANCE_PLAN.md`. A metric that cannot be nonzero is not evidence.

Alerts use bounded-cardinality provider, account tier, operation type, and failure classification labels. Payment, operation, merchant, and customer identifiers belong in correlated logs/traces, not metric labels. Logs and traces follow the redaction contract in `06-PROVIDER_CONTRACT.md`.

## MVP recovery decisions

### Recovery objectives and alerts

These are operational objectives for a healthy system, not permission to change financial state when a timer expires:

| Signal | Objective | Warning | Critical/action |
| --- | --- | --- | --- |
| `REQUESTED` operation claim age | 99% within 5 seconds | oldest > 15 seconds | oldest > 60 seconds; inspect queue/outbox and republish safely |
| Stale `PROCESSING` detection | within 15 seconds after lease expiry | any overdue lease | overdue > 60 seconds; page and fence affected worker |
| First reconciliation of `UNKNOWN` | within 15 seconds | oldest unscheduled > 30 seconds | > 2 minutes; page reconciliation owner |
| Automated unknown resolution | terminal or `REQUIRES_REVIEW` within 75 minutes | age > 15 minutes | age > 75 minutes; require visible review case |
| Outbox publication age | p95 < 2 seconds | oldest > 10 seconds | oldest > 60 seconds |
| Verified webhook processing age | p95 < 5 seconds | oldest > 30 seconds | oldest > 5 minutes |
| Manual-review acknowledgement | within one business day | age > 4 business hours | unowned at one business day |
| Settlement of an eligible movement | within 2 settlement intervals | oldest unsettled > 4 intervals | oldest unsettled > 12 intervals with a positive net; investigate selection |
| Negative merchant clearing | resolved within one business day | age > 4 business hours | age > 2 business days; escalate as a business matter, never settle negative |

Objectives are measured separately by provider and operation type using bounded-cardinality labels. Breaching an objective schedules or escalates the documented recovery action; it never proves success or failure.

### Sweep and claim defaults

| Worker | Interval/loop | Claim size | Lease |
| --- | --- | ---: | ---: |
| Outbox relay | continuous | 500 | 30 seconds |
| `REQUESTED`/stale-`PROCESSING` sweeper | every 15 seconds | 100 | one sweep transaction only |
| Due reconciliation scheduler | every 5 seconds | 100 | 30 seconds before provider lookup |
| Unprocessed provider-webhook sweeper | every 10 seconds | 100 | 30 seconds |
| Settlement scheduler | every 60 seconds | 50 merchants | 120 seconds |
| Stale settlement-run sweeper | every 60 seconds | 50 | one sweep transaction only |
| DLQ/orphan detector | every 60 seconds | 200 | one sweep transaction only |

Claims use `FOR UPDATE SKIP LOCKED`, commit before network work, and honor provider/account rate limits. Values may be tuned after load tests, but batches remain bounded and the safety transitions in this contract do not change.

### Durable provider evidence

Verified normalized provider evidence is appended to a dedicated `provider_evidence` table in a short transaction before a terminal payment transition consumes it. The record includes its source, provider/account binding, operation correlation, normalized outcome/error/no-effect proof, allowlisted provider identifiers, timestamps, immutable evidence digest/reference, and a uniqueness fingerprint. It is append-only.

Applying evidence and marking that evidence as applied occur in the same transaction as the operation/payment transition, any ledger posting, balances, and outbox events. A crash after staging but before application is recovered by scanning unapplied evidence. If evidence staging itself fails after a possible provider write, the operation remains or becomes `UNKNOWN` and lookup reacquires evidence.

### Operator authority

Operator access requires an authenticated named principal, MFA, least-privilege roles, and an immutable audit record. One incident operator may perform read-only lookup, attach evidence, or replay a verified nonfinancial message. A compensating provider action, compensating journal posting, or privileged closed-account reversal requires a second distinct approver. No approval path may directly update payment totals or journal rows.

### Disaster recovery

The single-region MVP targets RPO at most 5 minutes and RTO at most 60 minutes using a highly available PostgreSQL deployment, continuous backups, and point-in-time recovery. On restore:

1. Start with provider-write dispatch fenced off using a new deployment/recovery epoch.
2. Permit signed webhook receipt only into durable evidence storage; defer state application until the database is validated.
3. Verify schema version, journal balance invariants, reconstructed balance projections, idempotency uniqueness, and outbox/inbox integrity.
4. Reconcile every nonterminal operation plus every terminal provider operation whose commit or provider timestamp falls within the RPO uncertainty window.
5. Republish committed unpublished outbox envelopes using their original UUIDs and rebuild derived projections.
6. Re-enable provider writes gradually only after reconciliation coverage is complete and duplicate-financial-effect metrics remain zero.

The restored database never assumes that provider state rolled back with it.
