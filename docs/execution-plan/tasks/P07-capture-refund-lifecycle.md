# P07 — Capture, refund, and complete local lifecycle

## Phase overview

**Goal.** Complete the local vertical slice (docs/10 "Local vertical slice", M0–M7): confirmed capture and refund evidence is applied atomically with payment totals, operation resolution, the evidence-bound ledger posting into striped platform buckets, balance projections, and the terminal plus ledger outbox events; refund reservations are released on every terminal outcome; the incremental proportional fee reversal is computed inside the confirming transaction; duplicate and corroborating evidence are idempotent and contradictory evidence is retained (staged, never applied) without ever overwriting a terminal operation — discrepancy recording and its event move to P08-T17 by binding coordinator decision (R-07-01); `flowledger verify` turns on reservation integrity, posting cardinality, and duplicate-effect checking; tests get polling helpers; and a `flowledger demo` command runs the whole lifecycle locally.

**Entry criteria.** `P06-GATE` green (simulator, adapters, conformance, worker for AUTHORIZE/CANCEL, attempt/evidence tables, execution functions).

**Exit gate (docs/10 M7).** "Full local financial lifecycle including concurrent refunds passes": `P07-GATE` runs every M7 acceptance bullet end to end, `flowledger verify --require-ground-truth` reports zero findings after every scenario, and a post-scenario balance rebuild equals the projection.

### Interfaces consumed from earlier phases

| From | Interface |
| --- | --- |
| P03 | `ledger.ledgers`, `ledger.accounts` (striping columns), `ledger.journal_transactions`, `ledger.journal_entries`, `ledger.account_balances`, `ledger.bucket_for_payment(p_payment_id text, p_bucket_count integer) RETURNS smallint`, `ledger.logical_account_balances`; the private canonical posting routine `ledger.post_journal_internal(...)` (exact signature in P03-T06) which validates, claims `(ledger_id, posting_key)` with `ON CONFLICT DO NOTHING`, computes the financial hash, locks balance rows in ascending account-ID order, inserts entries, updates balances, and inserts exactly one `ledger.transaction.posted.v1` envelope from a proposed envelope UUID; seeded logical accounts `platform.processor_receivable` and `platform.fee_revenue` (striped, `bucket_count` from seed) and per-merchant `merchant.clearing` (P03 fixed logical code); `flowledger verify` framework `packages/database/src/verify/index.ts` with class modules `packages/database/src/verify/classes/{payments,recovery}.ts` and `packages/database/src/verify/ground-truth.ts`, the duplicate-effect class reading `truth.provider_financial_effects` via `SIMULATOR_DATABASE_URL`, and `--require-ground-truth`; balance rebuild tooling (`flowledger verify` projection-equality class). |
| P05 | `payments.accept_operation` for `CAPTURE` (fee snapshot, `422 CAPTURE_BELOW_MINIMUM`) and `REFUND` (reservation guard, `409 MONETARY_GUARD_FAILED`, `capture_operation_id`, copied fee inputs, null fee effect). |
| P06 | `payments.apply_provider_evidence` (AUTHORIZE/CANCEL version, replaced here), `payments._terminal_event_envelope(...)`, `payments._operation_correlation_id(text)`, `public.new_entity_id(text)`, `public.fault_point(text)`, `providers.stage_attempt_evidence`, worker `EXECUTABLE_OPERATION_TYPES`, staged-evidence sweep, simulator + `test/support/simulator.ts`, `truth.provider_financial_effects`, crash hooks `crashPoint(name)` (`packages/config/src/crash-points.ts`, P05-T08) armed per process with `FLOWLEDGER_CRASH_POINTS` or in-process via `packages/testkit/src/crash-points.ts`. |

### Interfaces provided to later phases

| To | Interface |
| --- | --- |
| P08 | `ledger.post_payment_operation(p_operation_id text, p_evidence_id text, p_outbox_envelope jsonb) RETURNS text`; full `payments.apply_provider_evidence(p_evidence_id text)` — P08 replaces it again to accept `UNKNOWN`/`REQUIRES_REVIEW`, resolve ambiguity cases, create the `AUTHORIZATION_EXPIRY` case on authorization success, dismiss open expiry cases on capture/cancel success, and (P08-T17) replace the two `UNAPPLIED_CONTRADICTION`/`UNAPPLIED_MISMATCH` return branches (marked `-- P08-T17`) with `payments.record_discrepancy`; testkit `forceOperationUnknownForTest`, `insertSecondResponseEvidenceForTest`. |
| P09 | Same transition/posting path for webhook evidence (posting key derived from the operation, so webhook/direct races converge). |
| P10 | Movements = capture/refund journal transactions crediting/debiting `merchant.clearing`. |
| P12/P13 | `flowledger demo`; `packages/testkit/src/poll.ts`, `packages/testkit/src/api-client.ts`. |

```ts
// packages/testkit/src/poll.ts (subpath "@flowledger/testkit/poll"; no Testcontainers import)
export function pollUntil<T>(read: () => Promise<T>, done: (v: T) => boolean,
  opts?: { timeoutMs?: number; intervalMs?: number; describe?: string }): Promise<T>;
// packages/testkit/src/api-client.ts (subpath "@flowledger/testkit/api-client")
export function createApiClient(o: { baseUrl: string; apiKey: string }): ApiClient;
export function waitForOperation(api: ApiClient, operationId: string,
  statuses: readonly OperationStatus[], opts?: { timeoutMs?: number }): Promise<PaymentOperationRepresentation>;
```

### Worked example (normative for tests in this phase)

Fee policy used by every P07 numeric test (created by the test fixture, not read from whatever dev seed exists): `basis_points = 290`, `fixed_amount_minor = 30`, `minimum_capture_amount_minor = 50`, `capture_rounding_mode = 'HALF_UP'`, `refund_fee_mode = 'PROPORTIONAL'` **[ASSUMPTION — matches the docs/00 example of a USD 0.30 fixed fee; if the P02 dev seed defines a different default policy, the demo uses the seed and prints its values]**. `b = ledger.bucket_for_payment(payment_id, bucket_count)`; `NN` is `b` zero-padded to two digits. Entry ordinals are assigned by the posting routine's canonical sort (by account ID, debit before credit), so tests compare entry sets `(account, side, amount)`, not ordinals.

**Capture of 10000 (authorized 10000).** `F = floor((10000 × 290 + 5000) / 10000) + 30 = floor(2905000 / 10000) + 30 = 290 + 30 = 320`. Posting key `payment:{paymentId}:capture:{captureOpId}`, `operation_type = 'CAPTURE'`:

| Account | Side | Amount |
| --- | --- | ---: |
| `platform.processor_receivable.NN` | DEBIT | 10000 |
| `merchant.clearing` (merchant) | CREDIT | 9680 |
| `platform.fee_revenue.NN` | CREDIT | 320 |

Payment after: `authorized 10000, captured 10000, voided 0, refunded 0, reserved 0, unresolved_refund_count 0`; capture op `fee_effect_amount_minor = 320`.

**Refund 1 of 3333.** `R0 = 0, R1 = 3333`; `floor(320 × 3333 / 10000) = floor(1066560 / 10000) = 106`; incremental `= 106 − 0 = 106`. Posting key `payment:{paymentId}:refund:{refund1OpId}`:

| Account | Side | Amount |
| --- | --- | ---: |
| `merchant.clearing` | DEBIT | 3227 |
| `platform.fee_revenue.NN` | DEBIT | 106 |
| `platform.processor_receivable.NN` | CREDIT | 3333 |

**Refund 2 of 3333.** `R0 = 3333, R1 = 6666`; `floor(320 × 6666 / 10000) = floor(2133120 / 10000) = 213`; incremental `= 213 − 106 = 107` → DEBIT clearing 3226, DEBIT fee_revenue 107, CREDIT receivable 3333.

**Final refund of 3334.** `R0 = 6666, R1 = 10000`; `floor(320 × 10000 / 10000) = 320`; incremental `= 320 − 213 = 107` → DEBIT clearing 3227, DEBIT fee_revenue 107, CREDIT receivable 3334.

Normal-side balances (receivable debit-normal; clearing and fee revenue credit-normal), starting from zero for this payment's accounts:

| After | receivable[NN] | merchant.clearing | fee_revenue[NN] | payment refunded / reserved | Σ fee reversed |
| --- | ---: | ---: | ---: | --- | ---: |
| Capture | 10000 | 9680 | 320 | 0 / 0 | 0 |
| Refund 1 | 6667 | 6453 | 214 | 3333 / 0 | 106 |
| Refund 2 | 3334 | 3227 | 107 | 6666 / 0 | 213 |
| Final refund | 0 | 0 | 0 | 10000 / 0 | 320 |

Every journal balances (10000 = 9680 + 320; 3227 + 106 = 3333; 3226 + 107 = 3333; 3227 + 107 = 3334), and the full cumulative refund reverses exactly `F = 320`.

**Order dependence bound (docs/02).** Same capture; two refunds of 1 and 9999 accepted concurrently. Confirm 1 first: `floor(320×1/10000) = 0`, then 9999: `320 − 0 = 320`. Confirm 9999 first: `floor(320×9999/10000) = floor(3199680/10000) = 319`, then 1: `320 − 319 = 1`. Totals are both 320; the 1-unit refund's allocation differs by exactly one minor unit.

**Partial capture of 6000 (authorized 10000).** `F = floor((6000×290+5000)/10000) + 30 = floor(1745000/10000) + 30 = 174 + 30 = 204` → DEBIT receivable 6000, CREDIT clearing 5796, CREDIT fee_revenue 204; payment `captured 6000, voided 4000`; a second capture is rejected at acceptance (`captured = 0` guard).

**Boundary `F == G`.** A policy with `fixed_amount_minor = 50, basis_points = 0, minimum = 50` and capture 50 gives `F = 50`: the merchant-clearing line would be zero and is omitted (two lines: DEBIT receivable 50, CREDIT fee_revenue 50). A zero fee (`basis_points = 0, fixed = 0`) omits the fee line.

---

### P07-T01 — Migration: `ledger.post_payment_operation`

**Task ID:** `P07-T01`
**Feature:** Evidence-bound payment posting entry point
**Commit:** `feat(ledger): add evidence-bound post_payment_operation entry point`
**Priority:** Critical
**Dependencies:** `P06-GATE`
**Estimated complexity:** L
**Contract references:** docs/07 §Protected posting function (all nine steps), §`ledger.journal_transactions`, §Striped platform accounts, §Transaction and lock ownership (canonical lock order); docs/02 §Capture accounting, §Refund accounting, §Idempotent posting, §Concurrency, §Posting invariants, §Minimum capture amount (`0 <= F <= G` protected assertion); docs/04 `ledger.transaction.posted.v1`; schemas/events/ledger-transaction-posted.v1.schema.json; ADR-0007, ADR-0008, ADR-0010.
**Files:** create: `migrations/0700_post_payment_operation.sql`, `test/integration/ledger/post-payment-operation.test.ts`; must not touch: P03 migrations or the private routine's body.

**Objective** — Install the only ordinary financial posting entry point: it derives every posting input from the locked operation and evidence, so no caller can choose tenant, accounts, sides, amounts, or bucket.

**Implementation instructions**
1. Signature: `ledger.post_payment_operation(p_operation_id text, p_evidence_id text, p_outbox_envelope jsonb) RETURNS text` — `LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ledger, payments, providers, messaging, public`, owner `ledger_function_owner`, no dynamic SQL. `p_outbox_envelope` is the envelope seed `{ "id": <uuid>, "correlationId": <string>, "causationId": <string> }` (exactly these keys; else raise `INVALID_ENVELOPE_SEED`); the routine builds the full `ledger.transaction.posted.v1` envelope from it.
2. Provenance: `REVOKE ALL ON FUNCTION … FROM PUBLIC; GRANT EXECUTE … TO payments_function_owner` (only the protected payment-transition role, which runs `apply_provider_evidence`). Inside, require `session_user IN ('fl_payment_worker')` (P08/P09 widen to `fl_reconciler`, `fl_webhook_worker`) else raise `FORBIDDEN_ROLE`.
3. Locks (re-acquiring the caller's locks is a no-op): payment `FOR UPDATE`, then operation `FOR UPDATE`. Require `op.type IN ('CAPTURE','REFUND')`, `op.status = 'SUCCEEDED'`, `op.resolution_evidence_id = p_evidence_id`; evidence row with `id = p_evidence_id`, `operation_id = op.id`, `merchant_id = op.merchant_id`, `observed_outcome = 'SUCCEEDED'`, `observed_amount_minor = op.amount_minor`. Any failure → raise `POSTING_PRECONDITION_FAILED`.
4. Derivation:
   - `ledger_id` = the single `ledger.ledgers` row with `currency = 'USD'` (zero or more than one → raise `LEDGER_NOT_CONFIGURED`).
   - `bucket_count` = `bucket_count` of the `platform.processor_receivable` account with `bucket_index = 0` in that ledger (read from rows, never a setting); `b = ledger.bucket_for_payment(pay.id, bucket_count)`.
   - Accounts: receivable = `platform.processor_receivable` bucket `b`; fee = `platform.fee_revenue` bucket `b`; clearing = the `MERCHANT` account with `owner_id = op.merchant_id` and logical code `merchant.clearing`. Missing → raise `LEDGER_ACCOUNT_MISSING`.
   - CAPTURE: `G = op.amount_minor`, `F = op.fee_effect_amount_minor`; assert `0 <= F <= G` else raise `FEE_INVARIANT_BREACH` (internal invariant, never capped). Lines: DEBIT receivable `G`; CREDIT clearing `G − F` (omit if 0); CREDIT fee `F` (omit if 0).
   - REFUND: `A = op.amount_minor`, `I = op.fee_effect_amount_minor` (already written by the caller in this transaction; null → raise `POSTING_PRECONDITION_FAILED`); assert `0 <= I <= A`. Lines: DEBIT clearing `A − I` (omit if 0); DEBIT fee `I` (omit if 0); CREDIT receivable `A`.
   - `posting_key = 'payment:' || pay.id || ':' || lower(op.type) || ':' || op.id`; `operation_type = op.type`; `payment_id`, `payment_operation_id = op.id`; `correlation_id`/`causation_id` from the seed; `metadata = jsonb_build_object('recipeVersion', 1)`; proposed transaction ID `public.new_entity_id('ltx')`.
5. `PERFORM public.fault_point('post.before_routine')`, then `RETURN ledger.post_journal_internal(...)` (P03 routine) passing the proposed ID, key, type, references, correlation/causation, metadata, the typed entry array, and the seed `id` as the proposed ledger-event envelope UUID. The routine owns: `ON CONFLICT (ledger_id, posting_key) DO NOTHING` claim; same-hash replay returns the original ID with no entries/balances/event; different hash raises the idempotency conflict; payment-operation unique boundary; ascending account-ID balance locks; protected balance policy; entries and balance updates; exactly one `ledger.transaction.posted.v1` envelope (`aggregateType 'ledger_transaction'`, `data.operationType`, `paymentId`, `paymentOperationId`, `settlementBatchId: null`, `postingKey`, `entryCount`, totals, `recordedAt`). If the P03 routine lacks fault points, none are added inside it in this task.

**Expected behavior** — For the worked-example capture, returns an `ltx_…` ID; the journal has three entries equal to the table above; one ledger event exists. Calling again in a new transaction with the same operation/evidence returns the same ID and writes nothing.

**Acceptance criteria**
- [ ] `fl_payment_worker`, `fl_api`, `fl_reconciler` calling the function directly get `42501` (no EXECUTE).
- [ ] Capture and every refund in the worked example produce exactly the listed entry sets and balances.
- [ ] `F == G` and `F == 0` boundaries omit the zero line and still balance.
- [ ] A retry for an existing posting key resolves to the same bucket and returns the original transaction; a forged changed amount under the same key (migration-owner fixture altering the operation's fee snapshot via `session_replication_role=replica`) raises the idempotency conflict.
- [ ] 100 concurrent identical postings (via 100 concurrent `apply_provider_evidence` calls after P07-T02, or via a migration-owner harness now) → one journal transaction, one entry set, one balance effect, one ledger event.
- [ ] Postings for two payments in different buckets commit concurrently (neither waits: measured with `pg_locks` / two sessions); same bucket serialize without deadlock under 50 interleaved capture/refund confirmations.

**Testing requirements** — `test/integration/ledger/post-payment-operation.test.ts`: role denial; precondition failures (non-succeeded op, wrong evidence, evidence of another operation, AUTHORIZE op); worked-example entry sets; boundaries; replay; hash conflict; bucket stability across two sessions; concurrent identical; cross-bucket concurrency; same-bucket no-deadlock stress (seeded, `LEDGER_BUCKET_COUNT=1` and `32` databases); ledger event validated by Ajv. Command: `pnpm vitest run --project integration test/integration/ledger/post-payment-operation.test.ts`.

**Non-goals** — Settlement and correction postings; changing the P03 routine.

**Handoff checklist**
- [ ] No caller-supplied account, side, amount, or merchant reaches the routine (reviewed).
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P07-T02 — Migration: capture resolution in `apply_provider_evidence`

**Task ID:** `P07-T02`
**Feature:** Atomic capture confirmation with ledger posting and partial-capture remainder release
**Commit:** `feat(db): apply capture evidence with ledger posting and remainder release`
**Priority:** Critical
**Dependencies:** `P07-T01`
**Estimated complexity:** M
**Contract references:** docs/07 §Protected payment transition functions (`apply_provider_evidence` incl. class-specific hold release), §`payment_operations` fee bullets, §`payments.payments` checks; docs/03 §Capture outcomes, §Monetary invariants, §Aggregate and operation version rules; docs/02 §Capture accounting; ADR-0008; docs/04 terminal events (`feeAmountMinor`, `ledgerTransactionId`); docs/06 line 336 (mismatched success); schemas/events/payment-operation-terminal.v1.schema.json.
**Files:** create: `migrations/0710_apply_capture.sql`, `test/integration/payments/apply-capture.test.ts`; must not touch: earlier migrations.

**Objective** — Replace `payments.apply_provider_evidence` (P06 version) with a version that keeps AUTHORIZE/CANCEL behavior and adds CAPTURE outcomes that commit totals, operation, journal, balances, and events in one transaction, releasing the uncaptured remainder of a partial capture. REFUND is added by P07-T03.

**Implementation instructions**
1. `CREATE OR REPLACE FUNCTION payments.apply_provider_evidence(p_evidence_id text) RETURNS TABLE (application_kind text, operation_status text, operation_version bigint, payment_version bigint, ledger_transaction_id text)` — same owner, `search_path`, role check, and steps 1–12 as P06-T14, with these changes (keep every P06 fault point):
   - Step 5: allow `op.type IN ('AUTHORIZE','CANCEL','CAPTURE')` (REFUND still raises `OPERATION_TYPE_NOT_SUPPORTED` until P07-T03).
   - Step 6 (SUCCEEDED checks) adds: CAPTURE requires `observed_amount_minor = op.amount_minor`, currency `USD`, and if `payment.provider_payment_id` and `evidence.provider_payment_id` are both non-null they are equal; CAPTURE with non-null `payment.provider_capture_id` differing from `evidence.provider_capture_id` is a mismatch.
   - Contradiction and mismatch handling (binding coordinator decision, R-07-01): the P06 branches that raised `DISCREPANCY_NOT_SUPPORTED` (terminal operation + non-agreeing evidence) and `EVIDENCE_MISMATCH` (success whose amount/currency/references disagree) no longer raise; they return `('UNAPPLIED_CONTRADICTION' | 'UNAPPLIED_MISMATCH', op.status, op.version, pay.version, NULL)` and change nothing: evidence `applied_at` stays null, operation and payment rows (including versions, totals, pointer, reservation) untouched, no outbox row, no journal. Each branch carries the comment `-- P08-T17: record_discrepancy`. Agreeing evidence on a terminal operation stays `CORROBORATION` (no version change); an already-applied evidence row returns its recorded application (duplicate no-op).
   - Payment update (single `UPDATE`, `version + 1`, `updated_at`):
     - CAPTURE SUCCEEDED: `captured_amount_minor = op.amount_minor`, `voided_amount_minor = authorized_amount_minor − op.amount_minor` (partial-capture remainder released), `provider_capture_id = COALESCE(provider_capture_id, evidence.provider_capture_id)`, `active_exclusive_operation_id = NULL`.
     - CAPTURE REJECTED/FAILED: `active_exclusive_operation_id = NULL` only.
   - After the payment update and evidence marking, for CAPTURE SUCCEEDED: `v_ltx := ledger.post_payment_operation(op.id, ev.id, jsonb_build_object('id', gen_random_uuid(), 'correlationId', payments._operation_correlation_id(op.id), 'causationId', ev.id))`; `PERFORM public.fault_point('apply.after_ledger_post')`.
   - Expiry-case dismissal on capture/cancel success is not implemented here: `reconciliation.cases` does not exist until P08, and no expiry case can exist before P08 creates them (P08 adds the dismissal when it replaces this function).
   - Terminal event: `payments._terminal_event_envelope(op, pay, ev, v_ltx, <F for capture success>, NULL)`; capture success carries `feeAmountMinor = op.fee_effect_amount_minor::text` and a non-null `ledgerTransactionId`.
   - Return `ledger_transaction_id = v_ltx`.
2. Grants: unchanged (`EXECUTE` to `fl_payment_worker`), restated last in the file.

**Expected behavior** — Worked example: capture evidence → payment captured 10000, capture event with `feeAmountMinor "320"` and an `ltx_` ID; partial capture 6000 → `voided 4000`, journal 6000/5796/204.

**Acceptance criteria**
- [ ] One transaction contains operation transition, totals, journal, balances, terminal event, ledger event; each `apply.*` and `post.*` fault point leaves none of them visible.
- [ ] Partial capture sets `voided = authorized − captured`; a later capture command is rejected at acceptance.
- [ ] Rejected/failed capture: pointer cleared, no journal, capture can be re-requested.
- [ ] 100 concurrent applications of one capture evidence → one transition, one journal transaction, one terminal event, one ledger event.
- [ ] Contradictory evidence on a terminal capture/authorization (second evidence via `insertSecondResponseEvidenceForTest`) returns `UNAPPLIED_CONTRADICTION`: operation status/version, payment version/totals, journal count, and outbox count all unchanged; evidence row present with `applied_at` null.
- [ ] Amount-mismatched success on a `PROCESSING` capture returns `UNAPPLIED_MISMATCH`; no posting.
- [ ] Corroborating evidence → `CORROBORATION`, no version change; re-applying any evidence is a no-op.

**Testing requirements** — `test/integration/payments/apply-capture.test.ts` (as `fl_payment_worker`; setup via API acceptance functions + `claim_operation` + `mark_dispatch` + `stage_attempt_evidence`): worked-example capture end to end with exact entries/balances; partial capture; boundaries `F == G`, `F == 0`; capture rejected/failed then re-capture; fault-point sweep (`apply.after_operation_update`, `apply.after_attempt_update`, `apply.after_payment_update`, `apply.after_evidence_update`, `post.before_routine`, `apply.after_ledger_post`) asserting full rollback of payment, operation, attempt, evidence, journal, balances, outbox; 100× concurrent duplicate apply; contradiction/mismatch/corroboration cases above (assert no `payment.discrepancy.detected.v1` row exists); envelopes validated by Ajv. Command: `pnpm vitest run --project integration test/integration/payments/apply-capture.test.ts`.

**Non-goals** — REFUND resolution (P07-T03); discrepancy recording, cases, and the discrepancy event (P08-T17); `UNKNOWN`/`REQUIRES_REVIEW` sources, expiry case creation and dismissal (P08).

**Handoff checklist**
- [ ] P06 AUTHORIZE/CANCEL tests (`test/integration/db/resolution-functions.test.ts`) still pass except the superseded cases this commit updates: `OPERATION_TYPE_NOT_SUPPORTED` capture cases now expect success, and `DISCREPANCY_NOT_SUPPORTED`/`EVIDENCE_MISMATCH` cases now expect the `UNAPPLIED_*` return with no state change.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P07-T03 — Migration: refund resolution with fee reversal and reservation release

**Task ID:** `P07-T03`
**Feature:** Atomic refund confirmation with incremental fee reversal and reservation release
**Commit:** `feat(db): apply refund evidence with fee reversal and reservation release`
**Priority:** Critical
**Dependencies:** `P07-T02`
**Estimated complexity:** M
**Contract references:** docs/07 §Protected payment transition functions (`apply_provider_evidence` incl. class-specific hold release and refund fee computation), §`payment_operations` fee bullets, §`payments.payments` checks; docs/03 §Refund outcomes, §Monetary invariants; docs/02 §Refund accounting; ADR-0008; docs/04 terminal events (`feeReversalAmountMinor`, `ledgerTransactionId`); schemas/events/payment-operation-terminal.v1.schema.json.
**Files:** create: `migrations/0720_apply_refund.sql`, `test/integration/payments/apply-refund.test.ts`; must not touch: earlier migrations.

**Objective** — Extend `payments.apply_provider_evidence` (P07-T02 version) with REFUND outcomes: the incremental proportional fee reversal is computed inside the confirming transaction with a `numeric` intermediate, and the refund reservation is released on every terminal outcome.

**Implementation instructions**
1. `CREATE OR REPLACE FUNCTION payments.apply_provider_evidence(p_evidence_id text)` with the identical return type and every P07-T02 branch and fault point unchanged, plus:
   - Step 5: allow `op.type IN ('AUTHORIZE','CANCEL','CAPTURE','REFUND')`.
   - Step 6 (SUCCEEDED checks): REFUND requires `observed_amount_minor = op.amount_minor`, currency `USD`, and matching non-null `provider_payment_id`; a disagreement returns `UNAPPLIED_MISMATCH` exactly as in P07-T02 (reservation kept, no posting).
   - REFUND SUCCEEDED, computed after the operation and payment are locked and before any update:
     ```sql
     SELECT c.amount_minor, c.fee_effect_amount_minor INTO v_g, v_f
       FROM payments.payment_operations c
      WHERE c.id = op.capture_operation_id AND c.merchant_id = op.merchant_id
        AND c.type = 'CAPTURE' AND c.status = 'SUCCEEDED';
     v_r0  := pay.refunded_amount_minor;
     v_r1  := v_r0 + op.amount_minor;
     v_inc := (floor(v_f::numeric * v_r1 / v_g) - floor(v_f::numeric * v_r0 / v_g))::bigint; -- numeric: no bigint overflow
     SELECT COALESCE(sum(fee_effect_amount_minor), 0) INTO v_reversed
       FROM payments.payment_operations
      WHERE payment_id = pay.id AND type = 'REFUND' AND status = 'SUCCEEDED';
     IF v_inc < 0 OR v_reversed + v_inc > v_f THEN RAISE ... MESSAGE = 'FEE_INVARIANT_BREACH'; END IF;
     ```
     Operation transition also sets `fee_effect_amount_minor = v_inc`.
   - Payment update (single `UPDATE`, `version + 1`, `updated_at`):
     - REFUND SUCCEEDED: `refunded_amount_minor = refunded_amount_minor + A, reserved_refund_amount_minor = reserved_refund_amount_minor − A, unresolved_refund_count = unresolved_refund_count − 1` in the same statement, so `refunded + reserved` never rises and the row check cannot transiently fail.
     - REFUND REJECTED/FAILED: `reserved_refund_amount_minor − A`, `unresolved_refund_count − 1`; `fee_effect_amount_minor` stays null.
   - REFUND SUCCEEDED posts via `ledger.post_payment_operation` exactly as capture does in P07-T02 (same seed, same `apply.after_ledger_post` fault point).
   - Terminal event: refund success carries `feeReversalAmountMinor = v_inc::text` and a non-null `ledgerTransactionId`; rejected/failed refunds carry neither.
2. Grants: unchanged (`EXECUTE` to `fl_payment_worker`), restated last in the file.

**Expected behavior** — Worked example: after capture 10000, refund evidences 3333, 3333, 3334 → `feeReversalAmountMinor` 106, 107, 107; final `refunded 10000, reserved 0, unresolved 0`.

**Acceptance criteria**
- [ ] Rejected/failed refund: reservation released, count decremented, `fee_effect_amount_minor` null, no journal, amount refundable again (a new refund for the same amount is accepted).
- [ ] Fee reversal written to the operation equals the incremental formula; Σ over full refund = `F`.
- [ ] Boundary `F = G = R = 10^12` computes without overflow (numeric intermediate) and posts exactly.
- [ ] Each `apply.*` and `post.*` fault point during a refund confirmation leaves totals, reservation, journal, and events unchanged.
- [ ] Contradictory evidence on a terminal refund returns `UNAPPLIED_CONTRADICTION` with no state change; amount-mismatched refund success returns `UNAPPLIED_MISMATCH` and keeps its reservation.

**Testing requirements** — `test/integration/payments/apply-refund.test.ts` (as `fl_payment_worker`, same setup as P07-T02): worked-example refunds with exact entries/balances; refund rejected/failed then re-refund; fault-point sweep over the same six points for a refund; 100× concurrent duplicate refund apply; contradiction/mismatch on refunds (no `payment.discrepancy.detected.v1` row); fast-check property (seeded, counterexample persisted): random captures `G ∈ [50, 10^6]`, random partitions into ≤ 8 refunds, random confirmation order → Σ inc = F, each inc ≥ 0, prefix sums ≤ F, and two orderings differ per refund by ≤ 1; maximum-magnitude boundary (binding note: `F × R` reaches 10^24, beyond bigint, so the intermediate MUST be `numeric` and only the result cast to `bigint`): policy `basis_points = 10000, fixed = 0, minimum = 1`, authorize/capture `G = 1000000000000` → `F = 1000000000000`; refund `R = 1000000000000` → `fee_effect_amount_minor = 1000000000000`, refund journal is DEBIT fee_revenue 10^12 / CREDIT receivable 10^12 (zero clearing line omitted), no overflow error; a variant with the intermediate computed in `bigint` (temporary local edit) must fail with SQLSTATE `22003`; the TS fee helper (`@flowledger/domain`, bigint) agrees with the SQL value; envelopes validated by Ajv. Command: `pnpm vitest run --project integration test/integration/payments/apply-refund.test.ts`.

**Non-goals** — Discrepancy recording (P08-T17); `UNKNOWN` refunds (P08).

**Handoff checklist**
- [ ] `apply-capture.test.ts` and the P06 resolution tests still pass (the P06 `OPERATION_TYPE_NOT_SUPPORTED` refund case now expects success).
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P07-T04 — Worker executes capture and refund; event contract checks

**Task ID:** `P07-T04`
**Feature:** Capture/refund execution path
**Commit:** `feat(worker): execute capture and refund operations`
**Priority:** Critical
**Dependencies:** `P07-T03`
**Estimated complexity:** S
**Contract references:** docs/06 `paymentMethodReference` (null for capture/refund), `ProviderOperationCommand` (`providerPaymentId`, `providerAuthorizationId`, `providerCaptureId`); docs/04 §Required contract tests ("Validate every produced envelope…"); docs/10 M7 first bullet.
**Files:** modify: `apps/payment-worker/src/execute-handler.ts`, `apps/payment-worker/src/scheduler.ts`, `packages/database/src/functions/payments.ts`, `test/integration/worker/execute-handler.test.ts`; create: `test/integration/worker/capture-refund.test.ts`; must not touch: `migrations/**`.

**Objective** — Let the P06 worker run CAPTURE and REFUND through the same claim/dispatch/stage/apply path.

**Implementation instructions**
1. `EXECUTABLE_OPERATION_TYPES = ['AUTHORIZE','CANCEL','CAPTURE','REFUND'] as const`; remove the "not yet executable" branch and its test.
2. Command for CAPTURE/REFUND/CANCEL uses `providerPaymentId`, `providerAuthorizationId`, `providerCaptureId` from the claim row and `paymentMethodReference: null`; decryption is not called.
3. `applyProviderEvidence` may now return `applicationKind` `UNAPPLIED_CONTRADICTION` or `UNAPPLIED_MISMATCH` (P07-T02/T03): extend the wrapper's return type, and in both the execute handler and the staged-evidence sweep (P06-T18) treat them as "retained, not applied": log `provider_evidence_unapplied` at warn once per evidence id per process (fields: evidence id, operation id, kind) and ack/skip — never retry the provider. Add a test that the sweep recovers a staged capture success and skips an `UNAPPLIED_MISMATCH` evidence without looping errors.
4. In `capture-refund.test.ts`, after each scenario select every outbox row for the payment and validate it with the `@flowledger/contracts` Ajv validator plus the semantic correlation validator.

**Expected behavior** — Accepted capture executes and posts; accepted refund executes and posts with the fee reversal.

**Acceptance criteria**
- [ ] Capture and refund commands never carry a payment method reference (adapter spy).
- [ ] Every outbox envelope produced in the suite validates (schema + semantic).
- [ ] Crash at `worker.after_evidence_staged` for a capture success → sweep applies it; exactly one journal transaction.

**Testing requirements** — `test/integration/worker/capture-refund.test.ts` (PG + simulator + `InMemoryTransport`): capture success/declined (forced outcome)/not applied; refund success/declined/not applied; staged-evidence recovery; envelope validation. Command: `pnpm vitest run --project integration test/integration/worker/capture-refund.test.ts`.

**Non-goals** — Ambiguity handling (P08).

**Handoff checklist**
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P07-T05 — `flowledger verify`: reservation integrity, posting cardinality, duplicate effects

**Task ID:** `P07-T05`
**Feature:** Invariant checker classes turned on for M7
**Commit:** `feat(cli): enable reservation, posting cardinality, and duplicate-effect verify classes`
**Priority:** Critical
**Dependencies:** `P07-T04`
**Estimated complexity:** M
**Contract references:** docs/09 §Continuous invariant checker (class table), §Defining `duplicate_financial_effects_total` (full condition table and exclusions); docs/08 §Recovery observability (`duplicate_financial_effects_total` definition); CONVENTIONS §16 (ground truth, `--require-ground-truth`); docs/10 M7 bullet "Turn on … reservation-integrity, posting-cardinality, and duplicate-effect classes".
**Files:** modify: the P03 verify class modules `packages/database/src/verify/classes/payments.ts` (`reservation_integrity`, `posting_cardinality`), `packages/database/src/verify/ground-truth.ts` (`duplicate_financial_effects`), and `packages/database/src/verify/index.ts` if registration changes; create: `test/integration/verify/p07-classes.test.ts`; must not touch: other verify classes, `migrations/**`.

**Objective** — Make these three classes check real, populated data and prove each one catches a deliberately corrupted fixture.

**Implementation instructions**
1. Reservation integrity (`checked` = number of payments):
   ```sql
   SELECT p.id FROM payments.payments p
   LEFT JOIN LATERAL (SELECT COALESCE(sum(o.amount_minor),0) AS s, count(*) AS c
                        FROM payments.payment_operations o
                       WHERE o.payment_id = p.id AND o.type = 'REFUND'
                         AND o.status IN ('REQUESTED','PROCESSING','UNKNOWN','REQUIRES_REVIEW')) r ON true
   WHERE p.reserved_refund_amount_minor <> r.s OR p.unresolved_refund_count <> r.c
      OR p.refunded_amount_minor + p.reserved_refund_amount_minor > p.captured_amount_minor;
   ```
2. Posting cardinality (`checked` = number of CAPTURE/REFUND operations plus journal transactions with a payment operation): findings = succeeded CAPTURE/REFUND operations whose count of `ledger.journal_transactions` with `payment_operation_id = op.id` ≠ 1; plus journal transactions whose operation is not `SUCCEEDED` or not CAPTURE/REFUND; plus succeeded REFUND operations with null `fee_effect_amount_minor` or non-succeeded refunds with non-null fee effect.
3. Duplicate financial effects (if P03 already implements the docs/09 table against `truth.provider_financial_effects`, only verify it against the cases below; otherwise implement): for every operation with at least one provider attempt (paged, 1,000 per query), `P = COALESCE(truth.provider_financial_effects.effect_count, 0)` for its `provider_idempotency_key` (read through `SIMULATOR_DATABASE_URL` with `= ANY($1)`), `L = count(journal_transactions WHERE payment_operation_id = op.id OR posting_key = 'payment:'||payment_id||':'||lower(type)||':'||op.id)`, `S = op.status`. Count a finding when `P > 1`, or `L > 1`, or (`P = 1 ∧ L = 0 ∧ S = 'SUCCEEDED'` for CAPTURE/REFUND), or (`P = 0 ∧ L = 1`), or (`P = 1 ∧ S ∈ {REJECTED, FAILED}`), or (`P = 0 ∧ S = 'SUCCEEDED'`). Report separately (never as findings) the gauges `unresolved_ambiguity_with_effect` (`P = 1 ∧ L = 0 ∧ S ∈ {UNKNOWN, REQUIRES_REVIEW, PROCESSING}`). For AUTHORIZE/CANCEL, the `L` conditions do not apply (no postings by design); `P`/`S` conditions do. Keep P03-T14's per-payment substituted-key check (truth rows grouped by `payment_ref`, `operation_type`: more than one successful AUTHORIZE, CAPTURE, or CANCEL effect, or more REFUND effects than REFUND operations for the payment) and confirm it against real P07 capture/refund data.
4. Ground truth absent: `0 rows checked (ground truth unavailable)`; non-zero exit only with `--require-ground-truth` (CONVENTIONS §16).

**Expected behavior** — After the worked example: three classes report non-zero `checked` counts and zero findings.

**Acceptance criteria**
- [ ] Each class reports its `checked` count and zero findings on valid lifecycle data.
- [ ] Corrupted fixtures (superuser with `SET session_replication_role = replica`): reservation drift → reservation class only; extra journal transaction for a succeeded refund under a forged key → posting cardinality (and duplicate effects `L > 1`); refund marked `SUCCEEDED` with no journal → posting cardinality; extra `sim.effects` row for one key (as `fl_simulator`) → duplicate effects `P > 1`; forged `SUCCEEDED` authorize with no simulator effect → `P = 0 ∧ S = SUCCEEDED`.
- [ ] `--require-ground-truth` without `SIMULATOR_DATABASE_URL` exits non-zero; without the flag exits zero with the "unavailable" note.

**Testing requirements** — `test/integration/verify/p07-classes.test.ts`: valid data zero findings; each corrupted fixture detected by the named class (assert class name and count = 1); ground-truth flag behavior. Command: `pnpm vitest run --project integration test/integration/verify/p07-classes.test.ts`.

**Non-goals** — Settlement membership (P10); orphan detection changes.

**Handoff checklist**
- [ ] Each fixture test observed failing with its class disabled.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P07-T06 — Testkit polling helpers, API client, and lifecycle fixtures

**Task ID:** `P07-T06`
**Feature:** End-to-end polling helpers
**Commit:** `feat(testkit): add polling helpers, api client, and lifecycle fixtures`
**Priority:** High
**Dependencies:** `P06-GATE`
**Estimated complexity:** S
**Contract references:** docs/10 M7 ("Add end-to-end polling helpers"), §Engineering rules ("Direct table mutation in tests is limited to … clearly named fixture helpers"); docs/05 endpoints for payments, commands, operations, timeline.
**Files:** create: `packages/testkit/src/poll.ts`, `packages/testkit/src/poll.test.ts`, `packages/testkit/src/api-client.ts`, `packages/testkit/src/lifecycle-fixtures.ts`; modify: `packages/testkit/package.json` (subpath exports `./poll`, `./api-client`); must not touch: app code. If P04/P05 already created an API client in testkit, extend that file instead of creating `api-client.ts` and keep the export names below as aliases.

**Objective** — Give e2e tests, the demo, and P12 one way to wait for asynchronous outcomes and one set of named fixtures for states P07 cannot yet reach through production paths.

**Implementation instructions**
1. `pollUntil(read, done, { timeoutMs = 15000, intervalMs = 50, describe })`: calls `read` until `done(value)`; on timeout throws `PollTimeoutError` including `describe` and the last value (stringified with bigint support). No `setInterval`; sequential awaits.
2. `createApiClient({ baseUrl, apiKey })` methods: `createPayment(body, idemKey)`, `authorize(paymentId, idemKey)`, `capture(paymentId, amountMinor, idemKey)`, `cancel(paymentId, idemKey)`, `refund(paymentId, amountMinor, idemKey)`, `getPayment(id)`, `getOperation(id)`, `getTimeline(paymentId)`; returns `{ status, headers, body }`; amounts are strings. `waitForOperation(api, id, statuses)` polls `getOperation`.
3. `lifecycle-fixtures.ts` (superuser pool only; every function name ends in `ForTest`):
   - `forceOperationUnknownForTest(admin, operationId)`: in one transaction — complete the current non-completed attempt (`COMPLETED`, `outcome_class 'AMBIGUOUS'`), set the operation `UNKNOWN`, clear lease fields, `version + 1`, and payment `version + 1`; reservation/pointer untouched (deferred trigger must still pass). Used only until P08's `mark_unknown` exists (R-07-03).
   - `insertSecondResponseEvidenceForTest(admin, { operationId, observedOutcome, amountMinor, providerOperationId, errorCode?, proofKind? })`: in one transaction inserts a `COMPLETED` provider attempt `n+1` for the operation (same key, credential version, `outcome_class` matching the outcome, `dispatch_marked_at`/`response_received_at`/`completed_at` set) and an `API_RESPONSE` evidence row for it with the correct source shape and a computed `evidence_hash`, returning the evidence id. Used to model a second, independent observation (late or contradictory) before P08/P09 add reconciliation and webhook sources; it never touches `payments.*` rows.

**Expected behavior** — `waitForOperation(api, opId, ['SUCCEEDED','REJECTED','FAILED'])` returns once terminal or throws with the last observed status.

**Acceptance criteria**
- [ ] `poll.ts` and `api-client.ts` import no Testcontainers code.
- [ ] Timeout error message contains `describe` and last value.

**Testing requirements** — `packages/testkit/src/poll.test.ts`: resolves, times out, bigint-safe message. Fixtures are exercised by P07-T02, P07-T03, and P07-GATE. Command: `pnpm vitest run --project unit packages/testkit/src/poll.test.ts`.

**Non-goals** — Production use of fixtures.

**Handoff checklist**
- [ ] `pnpm check` green.

---

### P07-T07 — Timeline entries for ledger postings

**Task ID:** `P07-T07`
**Feature:** Payment timeline (M7 entry kinds)
**Commit:** `feat(api): add ledger posting timeline entries`
**Priority:** Medium
**Dependencies:** `P07-T03`
**Estimated complexity:** S
**Contract references:** docs/05 §Retrieve a payment timeline (`LEDGER_POSTING` exposes transaction ID, recipe type, resolution source only), openapi `PaymentTimelineEntry`.
**Files:** create: `migrations/0730_timeline_ledger_posting.sql`, `test/integration/api/timeline-ledger-entries.test.ts`; modify: `packages/contracts/src/timeline-detail.ts`, `packages/contracts/src/timeline-detail.test.ts`; must not touch: `migrations/0430_payment_timeline.sql`, `openapi/openapi.yaml`.

**Objective** — Show exactly one posting per confirmed capture/refund on the merchant timeline.

**Implementation instructions**
1. `migrations/0730_timeline_ledger_posting.sql`: `CREATE OR REPLACE FUNCTION payments.payment_timeline(p_payment_id text)` (P04 signature and `kind_rank` table unchanged; same pattern as P05-T12) adding the `LEDGER_POSTING` source (rank 6); add its detail schema to `TIMELINE_DETAIL_SCHEMAS`. One `LEDGER_POSTING` per journal transaction with `payment_id` = the payment, time `recorded_at`, `operationId = payment_operation_id`, detail `{ ledgerTransactionId, operationType, resolutionSource }` (resolution source from the operation) — no accounts, amounts, or buckets (docs/05).

**Expected behavior** — Worked-example timeline has four `LEDGER_POSTING` entries.

**Acceptance criteria**
- [ ] No account ID, bucket, or entry amount in any detail.
- [ ] Cross-tenant 404 preserved.

**Testing requirements** — `test/integration/api/timeline-ledger-entries.test.ts`: worked example (4 postings), cancel/rejected flows (0 postings), prohibited-field scan. Command: `pnpm vitest run --project integration test/integration/api/timeline-ledger-entries.test.ts`.

**Non-goals** — `SETTLEMENT` (P10), `RECONCILIATION_ACTIVITY` and `DISCREPANCY` (P08).

**Handoff checklist**
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P07-T08 — `flowledger demo` local lifecycle command

**Task ID:** `P07-T08`
**Feature:** Local demo CLI
**Commit:** `feat(cli): add flowledger demo lifecycle command`
**Priority:** High
**Dependencies:** `P07-T06`, `P07-T07`
**Estimated complexity:** M
**Contract references:** docs/10 M7 ("local demo CLI"), §Demo and portfolio acceptance (items 2–4, offline from a clean clone); README §1 delivery levels (local vertical slice).
**Files:** create: `apps/cli/src/commands/demo.ts`, `apps/cli/src/commands/demo.test.ts`; modify: `apps/cli/src/main.ts` (register command), `packages/config/src/cli.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: other commands.

**Objective** — One command that shows a reviewer the local slice working: idempotent capture, exact journal, concurrent refunds bounded by the guard, and verify.

**Implementation instructions**
1. `flowledger demo [--api-url <url>] [--api-key <key>] [--verify]`; defaults from `FLOWLEDGER_DEMO_API_URL` (default `http://localhost:3000`) and `FLOWLEDGER_DEMO_API_KEY` (the synthetic dev-seed merchant key from P02, documented in `.env.example`).
2. Steps (each prints one line; failure exits 1 with the step name):
   1. `createPayment` 10000 USD, token `pm_fake_approveDemo`, provider `fake-provider`.
   2. `authorize`; wait for `SUCCEEDED`.
   3. `capture 10000` with idempotency key K; send the same request 5 times; assert all return the same operation ID; wait for `SUCCEEDED`.
   4. `refund 3333` and wait; then `refund 3333` and `refund 3334` concurrently, wait for both; then `refund 1` → expect `409 MONETARY_GUARD_FAILED`.
   5. `getPayment` → print totals; `getTimeline` → print `kind`/`operationId` per entry and the count of `LEDGER_POSTING` (expect 4).
   6. With `--verify` (requires `DATABASE_URL` for a verify-capable role and `SIMULATOR_DATABASE_URL`), run the verify classes in-process with `--require-ground-truth` and print per-class counts.
3. Output only IDs, statuses, amounts, and counts; never the API key.

**Expected behavior** — Against the local stack (compose + api + relay + payment-worker + provider-simulator, all from `.env.example`), prints totals `captured 10000, refunded 10000`, 4 postings, and (with `--verify`) zero findings.

**Acceptance criteria**
- [ ] Exit code 0 on the happy path; non-zero naming the failed step otherwise.
- [ ] The repeated capture produces one operation and one journal transaction.
- [ ] No secret printed (unit test captures stdout).

**Testing requirements** — `apps/cli/src/commands/demo.test.ts` (unit, stub API client): step sequencing, 409 expectation, failure step naming, stdout redaction. Full run is exercised in P07-GATE e2e. Command: `pnpm vitest run --project unit apps/cli/src/commands/demo.test.ts`.

**Non-goals** — Settlement, ambiguity demo (P13).

**Handoff checklist**
- [ ] `docs/CONFIG.md` documents demo variables and how to start the stack.
- [ ] `pnpm check` green.

---

### P07-GATE — Local vertical slice verification

**Task ID:** `P07-GATE`
**Feature:** M7 exit gate (local financial lifecycle)
**Commit:** `test(e2e): add P07 local lifecycle gate scenarios and evidence`
**Priority:** Critical
**Dependencies:** `P07-T01` … `P07-T08`
**Estimated complexity:** L
**Contract references:** docs/10 M7 (all test bullets); docs/09 §End-to-end scenarios 1–10, §Property tests (fee allocation, refund reservation); docs/00 §Scope acceptance examples (duplicate authorize, key reuse, refund races, UNKNOWN refund, capture below minimum); docs/08 §Required failure-injection tests "Ledger", "Refund reservation"; docs/03 §Required model tests (refund rows).
**Files:** create: `test/e2e/p07-lifecycle.test.ts`, `test/integration/payments/p07-refund-concurrency.test.ts`, `test/chaos/p07-result-transaction.test.ts`, `docs/evidence/P07.md`; must not touch: any non-test source file.

**Objective** — Prove the M7 exit gate with real processes and the exact numbers in §Worked example.

**Implementation instructions**
1. `test/e2e/p07-lifecycle.test.ts` (spawned api, relay, payment-worker, provider-simulator; Pub/Sub emulator; testkit API client and `waitForOperation`), each scenario followed by `flowledger verify --require-ground-truth` (zero findings) and a balance rebuild equality check:
   - S1 create → authorize → full capture 10000: exact capture journal and balances from §Worked example, posted once.
   - S2 partial capture 6000: journal (6000/5796/204), `voided 4000`, summary `CAPTURED`, second capture rejected.
   - S3 create → authorize → cancel: zero journal transactions for the payment.
   - S4 capture 10000 → refunds 3333, 3333, 3334 sequentially: entries and balance table from §Worked example; Σ fee reversed 320; final balances 0.
   - S5 capture → two concurrent refunds that fit (3333 + 3334 after a confirmed 3333) → both `202`, both confirm, Σ reversal = 320.
   - S6 capture → two concurrent refunds of 6000 each → exactly one `202`, the other `409 MONETARY_GUARD_FAILED` (assert problem `code`, and that no idempotency/operation row exists for the loser).
   - S7 capture amount 10 under the §Worked example policy → `422 CAPTURE_BELOW_MINIMUM`, no operation/idempotency/outbox row.
   - S8 decline (`pm_fake_decline`) → second authorization accepted and approved; a `pm_fake_invalid` FAILED authorization also permits a retry; a fourth authorization after three non-success attempts → rejected (P05 rule).
   - S9 identical capture request sent before, during, and after completion → one operation, replayed `202`.
   - S10 repeated capture with same key 100 times → one operation, one journal.
2. `test/integration/payments/p07-refund-concurrency.test.ts` (PG + simulator, direct function calls for determinism):
   - Direct response duplicated 100 times: 100 concurrent `stage_attempt_evidence` (same attempt, same hash → `DUPLICATE`) and 100 concurrent `apply_provider_evidence` → one terminal transition, one journal transaction, one terminal event.
   - Order independence: refunds {1, 9999} confirmed in both orders on two identical payments → assert exact allocations `1→0, 9999→320` (1 first) and `9999→319, 1→1` (9999 first); totals 320 in both.
   - Several concurrent refunds that fit (8 × 1250 on 10000) → all accepted, reserved drains to 0 as they confirm in random order, `refunded = 10000`, Σ reversal = 320.
   - Rejected/failed refund (forced outcome) → reservation released, `fee_effect_amount_minor` null, a new refund of the same amount accepted.
   - `UNKNOWN` refund keeps its reservation across restart: accept refund A (4000), claim/dispatch, `forceOperationUnknownForTest(A)`; restart worker processes (new pools); accept refund B (6000) → accepted; refund C (1) → `409 MONETARY_GUARD_FAILED`; B confirms; A still reserved (`reserved = 4000`).
   - `UNKNOWN`/review authorization blocks a replacement authorization (`409 ACTIVE_OPERATION_EXISTS`).
   - Contradictory evidence (via `insertSecondResponseEvidenceForTest`) against a terminal capture and a terminal refund: `apply_provider_evidence` returns `UNAPPLIED_CONTRADICTION`; the terminal operation is not overwritten; payment and operation versions, totals, journal, and outbox are unchanged; no `payment.discrepancy.detected.v1` row exists; the evidence row is retained with `applied_at` null. Corroborating and duplicate evidence change neither version.
   - fast-check (seeded, counterexample persisted): random interleavings of refund accept/confirm/reject over 5–20 operations; after every commit `refunded + reserved <= captured`, reserved = Σ unresolved refund amounts, count matches, prefix fee reversal ≤ F.
3. `test/chaos/p07-result-transaction.test.ts` (`FLOWLEDGER_FAULT_HOOKS=1`): for each SQL fault point in the capture and refund result transactions (`apply.after_operation_update`, `apply.after_attempt_update`, `apply.after_payment_update`, `apply.after_evidence_update`, `post.before_routine`, `apply.after_ledger_post`) set `flowledger.fault_point` for the worker's sessions (worker spawned with `PGOPTIONS='-c flowledger.fault_point=<name>'`), confirm nothing partial is visible (no journal, totals unchanged, reservation unchanged, no events), then restart the worker without the option and assert the staged-evidence sweep converges to exactly one posting (`P = 1, L = 1`). Plus the "lose commit acknowledgement" case: kill the worker at `worker.after_result_commit`, redeliver, assert no second posting.
4. `docs/evidence/P07.md`: commands, seeds, worked-example output (journal lines and balances as printed by the test), per-class verify counts, mapping of each M7 bullet to its test, and the demo invocation with captured output.

**Expected behavior** — All files green; evidence note committed.

**Acceptance criteria**
- [ ] Every docs/10 M7 test bullet maps to a passing case in `docs/evidence/P07.md`.
- [ ] `flowledger verify --require-ground-truth` zero findings after every e2e scenario; rebuild equals projection.
- [ ] `pnpm check && pnpm test:integration && pnpm test:e2e && pnpm test:chaos` green.

**Testing requirements** — Commands: `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:chaos`.

**Non-goals** — Feature code.

**Handoff checklist**
- [ ] Seeds recorded; no skipped tests.

---

## Parallelization

| Group | Tasks | Notes / conflicts |
| --- | --- | --- |
| A | T01 → T02 → T03 | Serial: single-owner `migrations/07xx` and the `post_payment_operation`/`apply_provider_evidence` bodies (README §5.4). |
| B | T06 | Independent; can start at phase entry. T02's and T03's tests need `insertSecondResponseEvidenceForTest` — land T06 first or let T02 add that one fixture function in `lifecycle-fixtures.ts` (T06 then adds the rest). |
| C | T04 | After T03 (worker, wrapper, sweep). |
| D | T05, T07 | After T04 / T03 respectively; disjoint files; parallel. |
| E | T08 | After T06 and T07. |
| Gate | P07-GATE | Last. |

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| M7: confirmed capture applied atomically with totals, operation, posting, balances, terminal/ledger events | T01, T02 | `apply-capture.test.ts` :: worked example, fault-point sweep |
| M7: install `ledger.post_payment_operation(operation_id, evidence_id, outbox_envelope)`, payment-transition role only, derives inputs | T01 | `post-payment-operation.test.ts` :: role denial, preconditions, worked example |
| M7: full and partial single capture; release remainder | T02 | `apply-capture.test.ts` :: partial capture; `p07-lifecycle.test.ts` :: S2 |
| M7: refund fee reversal computed inside confirming transaction from confirmed cumulative refunds and capture F, G | T03 | `apply-refund.test.ts` :: fee property; `p07-refund-concurrency.test.ts` :: order independence |
| M7: reservation released on every terminal outcome; success converts in one statement | T03 | `apply-refund.test.ts` :: refund rejected/failed; property `refunded + reserved` |
| M7: confirmed + reserved never exceed captured | T03, GATE | `p07-refund-concurrency.test.ts` :: fast-check interleavings |
| M7: verify classes reservation integrity, posting cardinality, duplicate effect | T05 | `p07-classes.test.ts` :: corrupted fixtures |
| M7: rejections/definitive failures without ledger effects | T02, T03 | `apply-capture.test.ts`, `apply-refund.test.ts` :: capture/refund rejected/failed |
| M7: duplicate/late evidence idempotent | T02, T03 | `apply-capture.test.ts`, `apply-refund.test.ts` :: 100× duplicate, corroboration |
| M7: contradictory evidence creates a discrepancy instead of overwriting history | T02, T03 (no overwrite only), **P08-T17** (discrepancy) | `apply-capture.test.ts`, `apply-refund.test.ts` :: `UNAPPLIED_CONTRADICTION` no overwrite — **deviation R-07-01** |
| M7: polling helpers and local demo CLI | T06, T08 | `poll.test.ts`; `demo.test.ts`; `p07-lifecycle.test.ts` |
| Test: create → authorize → full capture exact journal once | T02, GATE | `p07-lifecycle.test.ts` :: S1 |
| Test: declined and no-effect-failed authorization retry up to three; ambiguous/review blocking | GATE | `p07-lifecycle.test.ts` :: S8; `p07-refund-concurrency.test.ts` :: UNKNOWN authorization blocks |
| Test: partial capture releases remainder, cannot capture again | GATE | `p07-lifecycle.test.ts` :: S2 |
| Test: create → authorize → cancel no journal | GATE | `p07-lifecycle.test.ts` :: S3 |
| Test: partial refunds then full cumulative refund reverse principal and fee exactly | T03, GATE | `p07-lifecycle.test.ts` :: S4 |
| Test: same refund set different orders → same total, ≤ 1 unit per allocation | T03, GATE | `p07-refund-concurrency.test.ts` :: {1, 9999} orders; fee property |
| Test: two refunds racing for final amount; loser fails on monetary guard | GATE | `p07-lifecycle.test.ts` :: S6 |
| Test: several concurrent fitting refunds confirm independently; reserve drains | GATE | `p07-refund-concurrency.test.ts` :: 8 × 1250 |
| Test: rejected/failed refund releases reservation, null fee effect, refundable again | T03, GATE | `apply-refund.test.ts`; `p07-refund-concurrency.test.ts` |
| Test: UNKNOWN refund keeps reservation across restarts; later refunds succeed | GATE (fixture T06) | `p07-refund-concurrency.test.ts` :: UNKNOWN refund across restart |
| Test: direct response duplicated 100× → one transition, one journal | GATE | `p07-refund-concurrency.test.ts` :: 100× duplicate |
| Test: verify zero findings after every scenario | T05, GATE | `p07-lifecycle.test.ts` :: post-scenario verify |
| Test: each new contradiction increments payment version + one discrepancy event | **P08-T17** (deviation R-07-01) | P07 asserts the inverse for now: `p07-refund-concurrency.test.ts` :: contradiction → no version change, no discrepancy event |
| Test: duplicate/corroborating evidence changes neither payment nor operation version | T02, T03, GATE | `apply-capture.test.ts`, `apply-refund.test.ts` :: corroboration; `p07-refund-concurrency.test.ts` |
| Test: post-scenario balance rebuild matches projection | GATE | `p07-lifecycle.test.ts` :: rebuild equality |
| docs/02: capture recipe (receivable/clearing/fee, bucket b) | T01 | `post-payment-operation.test.ts` :: worked example |
| docs/02: refund recipe (clearing debit = amount − reversal) | T01 | `post-payment-operation.test.ts` :: refunds |
| docs/02: `0 <= F <= G` protected assertion, never capped | T01 | `post-payment-operation.test.ts` :: boundaries, invariant-breach fixture |
| docs/02: idempotent posting (same key + hash → original; changed hash → conflict; concurrent identical → one) | T01 | `post-payment-operation.test.ts` :: replay, hash conflict, concurrent |
| docs/02: canonical lock order; different buckets concurrent; same bucket no deadlock | T01 | `post-payment-operation.test.ts` :: cross-bucket, same-bucket stress |
| docs/02/ADR-0010: retry under existing key reaches same bucket | T01 | `post-payment-operation.test.ts` :: bucket stability |
| docs/07: refund fee null until terminal, non-null only on success, immutable | T03 | `apply-refund.test.ts` :: refund outcomes |
| docs/07: capture/cancel success dismiss open expiry case atomically | P08 (no cases exist before P08) | — |
| docs/06 line 336: mismatched success does not change totals, operation, or ledger | T02, T03 | `apply-capture.test.ts`, `apply-refund.test.ts` :: `UNAPPLIED_MISMATCH` |
| docs/08 ledger: failure after every statement in capture/refund result tx → all-or-nothing | T02, T03, GATE | `apply-capture.test.ts`, `apply-refund.test.ts` :: fault sweep; `p07-result-transaction.test.ts` |
| docs/08 ledger: lose commit ack and retry same posting key | GATE | `p07-result-transaction.test.ts` :: after_result_commit |
| docs/08 ledger: reuse posting key with changed hash → conflict | T01 | `post-payment-operation.test.ts` :: hash conflict |
| docs/08 refund reservation: crash during refund terminal transition → neither double-released nor lost | GATE | `p07-result-transaction.test.ts` :: refund fault points |
| docs/08 refund reservation: race confirmations; reserved never negative | GATE | `p07-refund-concurrency.test.ts` :: 8 × 1250, fast-check |
| docs/08 refund reservation: UNKNOWN refund survives restart and bounds new refunds | GATE | `p07-refund-concurrency.test.ts` :: UNKNOWN refund |
| docs/09 e2e scenarios 1–6, 8–10 | GATE | `p07-lifecycle.test.ts` :: S1–S10 |
| docs/09 e2e scenario 7 (UNKNOWN refund) | GATE | `p07-refund-concurrency.test.ts` (fixture; real-timeout e2e in P08) |
| docs/09 fee-allocation and refund-reservation properties | T03, GATE | fee property; reservation fast-check |
| docs/09 duplicate-effect detector definition | T05 | `p07-classes.test.ts` :: P > 1, P = 0 ∧ SUCCEEDED |
| docs/00 acceptance: refund races / both fit / UNKNOWN refund / capture below minimum | GATE | S6, S5, UNKNOWN refund, S7 |
| docs/04: every produced envelope validates | T04 | `capture-refund.test.ts` :: envelope validation |
| docs/05 timeline LEDGER_POSTING exactly once per posting | T07 | `timeline-ledger-entries.test.ts` |

## Phase risks / open questions

| ID | Risk / question | Impact | Severity | Recommended resolution | Blocked tasks |
| --- | --- | --- | --- | --- | --- |
| R-07-01 | **Deviation from docs/10 M7** (`docs/10-IMPLEMENTATION_PLAN.md:367` "contradictory evidence create a discrepancy" and `:384` "Each distinct newly deduplicated contradictory evidence row increments payment version and emits exactly one discrepancy event"). `payment.discrepancy.detected.v1` requires `caseId` (`schemas/events/payment-discrepancy-detected.v1.schema.json`, `required`) and cases are created in P08. Binding coordinator decision: `payments.record_discrepancy` and the discrepancy event move to P08-T17; P07 only guarantees contradictory evidence is retained, never applied, never overwrites the terminal operation, and changes no version. | Between P07 and P08, a contradiction is invisible except as an unapplied evidence row (no event, no case, no alert). The local vertical slice therefore does not demonstrate discrepancy handling. | Medium | Accept per coordinator; P08-T17 replaces the `-- P08-T17` branches and owns the M7 bullet's verification. Record in `docs/evidence/P07.md`. | T02, T03, GATE |
| R-07-02 | The P03 private posting routine's name/signature and the merchant clearing logical code are not fixed by the contracts (docs/07 names only `platform.processor_receivable`, `platform.fee_revenue`). Resolved by P03's declarations: `ledger.post_journal_internal` (P03-T06 signature) and `merchant.clearing` (P03 fixed names, P03 risk R-05). | Integration mismatch if P03 changes them. | Low | Use P03-T06's signature; `BLOCKED` if the routine cannot accept a proposed envelope UUID. | T01 |
| R-07-03 | M7 tests need an `UNKNOWN` refund/authorization, but `mark_unknown` is P08. | Tests would otherwise wait for P08. | Low | Use the clearly named superuser fixture `forceOperationUnknownForTest` (docs/10 engineering rules allow named fixture helpers); P08 replaces fixture use with real timeouts in its own gate. | T06, GATE |
| R-07-04 | `ledger.transaction.posted.v1` and terminal events are built inside SQL (they depend on IDs, totals, and `recordedAt` known only under lock), while CONVENTIONS §9 says envelopes are built by `buildEnvelope()` in TS and Ajv-validated before insertion. | SQL-built envelopes bypass TS Ajv validation at write time. | Medium | `messaging.insert_outbox` enforces registry/semantic correlation in SQL; P07-T04 validates every produced envelope with Ajv in tests. Recommend a CONVENTIONS §9 note that protected functions may build envelopes in SQL. | T01, T02 |
| R-07-05 | Fee policy values in seed data are owned by P02 and not visible here. | Worked example might not match the dev seed. | Low | Tests create the §Worked example policy explicitly; the demo prints whatever policy the seed bound. | GATE, T08 |
| R-07-06 | Expiry-case dismissal on capture/cancel success (docs/07 `apply_provider_evidence`) cannot be written before `reconciliation.cases` exists. | None in practice: no expiry case can exist before P08 creates them. | Low | P08 adds dismissal when it replaces `apply_provider_evidence`. | — |
| R-07-07 | A second independent observation for a terminal operation can only come from webhooks (P09) or reconciliation (P08); P07 models it with a fixture attempt `n+1`. | Fixture shape could drift from real sources. | Low | `insertSecondResponseEvidenceForTest` inserts rows through all real constraints (only bypassing the function boundary); P08/P09 retest with real sources. | T02, T06 |
