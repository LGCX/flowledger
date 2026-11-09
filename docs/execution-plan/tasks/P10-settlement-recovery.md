# P10 — Ledger settlement and operational recovery

## Phase overview

**Goal.** Deliver milestone M10 (`docs/10-IMPLEMENTATION_PLAN.md` §M10, lines 445–476): ledger-only settlement that moves confirmed value from each merchant's clearing account to its payable account in immutable, provably correct batches; a settlement worker with scheduler and stale-run sweeper; the payment-timeline `SETTLEMENT` entry; the invariant checker's settlement-membership class; audited operator recovery commands; the two-principal ledger-correction workflow; and every recovery runbook in `docs/08` turned into a reproducible, automated procedure.

**Entry criteria.** `P08-GATE` and `P09-GATE` are green (M10 depends on M8–M9, `docs/10` line 131). That implies P03 (ledger core, private posting routine, `ledger.correction_requests`, `ledger.post_approved_correction`, `flowledger verify`), P04 (timeline endpoint), P05 (outbox/inbox/relay/DLQ core), P07 (`ledger.post_payment_operation`, testkit lifecycle builders), P08 (reconciliation cases, sweepers) and P09 (provider/merchant webhooks, DLQ replay) are merged.

**Exit gate.** `P10-GATE`: settlement invariants, crash points, concurrency, and property tests pass; every runbook test passes; `flowledger verify` reports zero findings in every assertion class (now the complete set, `docs/10` line 476).

**Migration range.** `1000`–`1099`, in steps of 10 in task order (CONVENTIONS §8).

### Interfaces consumed from earlier phases

| Interface | Provided by | Notes |
| --- | --- | --- |
| `withTransaction(pool, ctx, fn)` — `packages/database/src/tx.ts` | P02 | READ COMMITTED, sets `app.merchant_id` / `app.correlation_id`, retries `40001`/`40P01`. |
| `messaging.insert_outbox(envelope jsonb)` | P02 | Only path into `messaging.outbox_messages`; validates registry/semantic rules in SQL. |
| P03 private canonical posting routine `ledger.post_journal_internal(p_transaction_id text, p_posting_key text, p_operation_type text, p_ledger_id text, p_merchant_id text, p_currency text, p_payment_id text, p_payment_operation_id text, p_reversal_of_transaction_id text, p_correction_request_id text, p_correlation_id text, p_causation_id text, p_metadata jsonb, p_lines ledger.posting_line[], p_envelope_id uuid, p_allow_closed_accounts boolean) RETURNS text` | P03 (P03-T06) | Private: EXECUTE granted to no role; only `ledger_function_owner` functions call it, so P10-T03 adds the `ledger_function_owner` wrapper `ledger.post_settlement_journal(...)` that `settlement.post_batch` calls. Receives proposed `ltx_` ID, posting key, operation type, references, correlation/causation, metadata, typed entry array, proposed ledger-event envelope UUID; computes the financial hash; locks balances in ascending account-ID order; inserts journal, entries, balance updates, and one `ledger.transaction.posted.v1`. |
| `ledger.accounts`, `ledger.journal_transactions`, `ledger.journal_entries`, `ledger.account_balances`, `ledger.logical_account_balances` | P03 | Merchant logical codes are P03's fixed names `merchant.clearing` and `merchant.payable` (P03 §Fixed names). |
| `ledger.correction_requests`, `ledger.post_approved_correction(...)` | P03 | Dual-control correction entry point executable only by `fl_correction` (CONVENTIONS §7). |
| `flowledger verify` with class `settlement_membership` reporting "0 rows checked (table absent)" | P03 | `packages/database/src/verify/index.ts` (`runVerify`, `formatHuman`, `formatJson`, `VERIFY_CLASS_ORDER`); class defined in `packages/database/src/verify/classes/recovery.ts` (P03-T13); CLI `apps/cli/src/commands/verify.ts`. |
| `GET /v1/payments/{paymentId}/timeline`: SQL `payments.payment_timeline(p_payment_id text)` (migration `0430`, fixed `kind_rank` table with `SETTLEMENT 10`; later phases append a `UNION ALL` branch via `CREATE OR REPLACE` in their own migration) and `packages/contracts/src/timeline-detail.ts` (`TIMELINE_DETAIL_SCHEMAS`, `validateTimelineDetail`) | P04 | P10-T10 extends both. |
| Relay (`packages/messaging/src/relay.ts`), consumer framework (`startConsumer`, `processDelivery` in `packages/messaging/src/consumer.ts`), `messaging.insert_dead_letter(...)`, DLQ tables, `messaging.dead_letter_replays` | P05 | |
| `ledger.post_payment_operation(operation_id, evidence_id, outbox_envelope)` and testkit builders that commit confirmed captures/refunds | P07 | Settlement tests create movements only through these (never by direct journal insert). |
| Reconciliation cases, sweepers, `UNKNOWN`/`REQUIRES_REVIEW` handling | P08 | |
| DLQ replay (M9 "DLQ records and replay history", `docs/10` lines 429, 443): `messaging.record_dead_letter_replay(p_dead_letter_id bigint, p_actor_id text, p_reason text, p_outcome text, p_broker_message_id text, p_error_class text, p_resolve boolean) RETURNS bigint` (migration `0950`) and the state-table replay logic of `flowledger dlq replay` in `apps/cli/src/commands/dlq.ts` | P09 (P09-T13) | P10-T12 reuses both; it does not re-implement the state table. |
| SQL fault points `public.fault_point(p_name text)` (raises `FAULT_INJECTED` when GUC `flowledger.fault_point` equals the name; migration `0600`) and process crash hooks `crashPoint(name)` in `packages/config/src/crash-points.ts` (armed in-process by `armCrashPoint`/`disarmCrashPoints` from `packages/testkit/src/crash-points.ts`, or per process by `FLOWLEDGER_CRASH_POINTS=<name,…>` → SIGKILL, exit 137; all inert unless `FLOWLEDGER_FAULT_HOOKS=1`) | P06 (P06-T02) / P05 (P05-T08) | |

### Interfaces provided to later phases

| Interface | Kind |
| --- | --- |
| `settlement.runs`, `settlement.batches`, `settlement.batch_members` | Tables (RLS on, DML revoked) |
| `settlement.due_merchants(p_limit integer, p_interval_seconds integer) RETURNS TABLE (merchant_id text)` | SQL, `fl_settlement_worker` |
| `settlement.schedule_run(p_run_id text, p_merchant_id text) RETURNS text` | SQL, `fl_settlement_worker` |
| `settlement.claim_runs(p_limit integer, p_lease_seconds integer) RETURNS TABLE (run_id text, merchant_id text, lease_token uuid)` | SQL, `fl_settlement_worker` |
| `settlement.fail_run(p_run_id text, p_lease_token uuid) RETURNS boolean` | SQL, `fl_settlement_worker` |
| `settlement.fail_stale_runs(p_limit integer) RETURNS integer` | SQL, `fl_settlement_worker` |
| `settlement.post_batch(p_run_id text, p_lease_token uuid, p_outbox_envelope jsonb) RETURNS text` | SQL, `fl_settlement_worker` (see risk R-01 for the added lease parameter) |
| `settlement.merchant_batch_members` | Security-barrier view, `fl_api` |
| `audit.operator_actions` + `audit.record_operator_action(...)` | Table + internal function (see risk R-04) |
| `messaging.operator_republish_outbox`, `messaging.operator_replay_dead_letter` (audited wrapper over P09's `record_dead_letter_replay`), `reconciliation.operator_reschedule_case`, `settlement.operator_request_run`, `providers.operator_evidence` | Operator SQL surface, `fl_operator_command` / `fl_operator_readonly` |
| `ledger.record_correction_audit` (audits the P03-T09 `request_correction`/`decide_correction`/`post_approved_correction` steps) | Operator SQL surface, `fl_correction` |
| TS wrappers in `packages/database/src/functions/settlement.ts`, `.../audit.ts`, `.../operator.ts` | One exported function per SQL function, camelCase |
| `apps/settlement-worker` (scheduler, sweeper, poster) | App |
| `flowledger ops ...` subcommands in `apps/cli/src/commands/ops/` | CLI |
| `docs/runbooks/*.md` (nine runbooks) + `test/e2e/runbooks/*.test.ts` | Docs + tests |

### Settlement invariants restated (apply to every P10 settlement task)

- A **movement** is one `CAPTURE` or `REFUND` journal transaction. It is settled exactly when a `settlement.batch_members` row references it; there is no mutable settled flag (`docs/07` line 960).
- Eligibility = same merchant and currency, `operation_type IN ('CAPTURE','REFUND')`, `recorded_at < cutoff_at`, and no `batch_members` row (anti-join). `cutoff_at` is database time read inside `post_batch` (`docs/02` §Eligible movements).
- `net = sum(merchant-clearing credits) − sum(merchant-clearing debits)` over the selected movements' journal entries. `net > 0` posts; `net <= 0` defers and posts nothing (`docs/02` §Settlement run).
- Batch posting: Debit merchant clearing `net`, Credit merchant payable `net`, posting key `settlement:{batchId}`, operation type `SETTLEMENT`, null payment and payment-operation references.
- Selection, membership, posting, run outcome, and the batch event share one transaction. Settlement never locks a payment/operation row, never calls a provider, and its lock chain is `settlement run → balance rows (ascending account ID) → outbox inserts` (`docs/07` lines 1353–1361).
- Batches and members are insert-only and immutable for every role, enforced by triggers that stay enabled for the table owner.

---

### P10-T01 — Verify and wire the settlement event, ledger `SETTLEMENT` type, and timeline kind contracts

**Task ID:** `P10-T01`
**Feature:** Settlement contracts
**Commit:** `test(contracts): verify settlement event and SETTLEMENT ledger type wiring`
**Priority:** High
**Dependencies:** `P08-GATE`, `P09-GATE`
**Estimated complexity:** S
**Contract references:** `docs/04` §Envelope (settlement rule), §Initial event catalog, §Required contract tests (last two bullets), §MVP messaging decisions ("internal-only"); `schemas/registry.v1.json` lines 32–33; `schemas/events/settlement-batch-posted.v1.schema.json`; `schemas/events/ledger-transaction-posted.v1.schema.json`; `schemas/common/message-envelope.v1.schema.json` (`aggregateType` enum); `openapi/openapi.yaml` `PaymentTimelineEntry.kind` (line 1286); `docs/05` §Retrieve a payment timeline.
**Files:** create: `test/contract/settlement-contracts.test.ts`, `test/contract/fixtures/settlement-batch-posted.valid.json`, `test/contract/fixtures/ledger-transaction-posted.settlement.valid.json`; modify: `packages/contracts/src/semantic.ts` (only if a required rule below is missing), the merchant-webhook projector's event allowlist file under `apps/merchant-webhook-projector/src/` (only if the projector test below fails); must not touch: `schemas/**`, `openapi/**`, `docs/0*.md`.

**Objective** — `docs/10` line 456–458 says to *add* `settlement.batch.posted.v1` to the registry, `SETTLEMENT` to the ledger event schema, and `SETTLEMENT` to the timeline kinds. All three already exist in the machine contracts (registry line 33; ledger schema `operationType` enum and its `SETTLEMENT` conditional; openapi line 1286 / docs/05 line 358). This task records that as a resolved discrepancy (risk R-02) and proves the existing contracts are wired end to end: generated types exist, Ajv accepts/rejects correctly, the semantic validator enforces the settlement identity rules, and the merchant-webhook projector treats `settlement.batch.posted.v1` as internal-only.

**Implementation instructions**
1. Confirm `pnpm contracts:check` is green and that `packages/contracts/src/generated/**` contains a type for `settlement.batch.posted.v1` data (`settlementBatchId`, `settlementRunId`, `currency`, `cutoffAt`, `memberCount`, `netAmountMinor`, `ledgerTransactionId`, `postingKey`, `postedAt`). If generation omits it, stop: `BLOCKED: P10-T01 — generator omits registered schema`.
2. Write the two valid fixtures. Settlement event: `kind=EVENT`, `type=settlement.batch.posted.v1`, `schemaVersion=1`, `source=flowledger.settlement`, `aggregateType=settlement_batch`, `aggregateId=<sbt_ id>`, `aggregateVersion=1`, `orderingKey=<merchantId>`, `data.postingKey = "settlement:" + aggregateId`, `data.netAmountMinor="9700"`, `memberCount=2`. Ledger event: `operationType=SETTLEMENT`, `paymentId=null`, `paymentOperationId=null`, `settlementBatchId=<same sbt_>`, `entryCount=2`, `totalDebitsMinor=totalCreditsMinor="9700"`.
3. In `test/contract/settlement-contracts.test.ts` assert, using the existing Ajv validator and `validateSemantic()` from `packages/contracts/src/semantic.ts`:
   - registry contains exactly one entry `(EVENT, settlement.batch.posted.v1)` pointing at `events/settlement-batch-posted.v1.schema.json`;
   - the openapi `PaymentTimelineEntry.kind` enum contains `SETTLEMENT` (parse with `@apidevtools/swagger-parser`);
   - both fixtures validate (schema + semantic).
4. The semantic validator MUST reject each of these settlement mutations (if any passes, add the missing rule to `semantic.ts` with the error code naming the rule, e.g. `SETTLEMENT_POSTING_KEY_MISMATCH`): `data.settlementBatchId !== aggregateId`; `orderingKey !== merchantId`; `data.postingKey !== 'settlement:' + aggregateId`; `aggregateVersion !== 1` (schema already rejects; assert the rejection exists); a consumer-side contiguity check applied to it — export and assert `isVersionContiguousStream('settlement.batch.posted.v1') === false` from `semantic.ts` (add this exported predicate if absent; it returns `true` only for payment lifecycle events).
5. Ledger event: reject `operationType=SETTLEMENT` with a non-null `paymentId` or missing `settlementBatchId`; reject `operationType=CAPTURE` with non-null `settlementBatchId` (schema conditionals — assert they fire).
6. Projector: feed one valid `settlement.batch.posted.v1` envelope to the merchant-webhook projector handler (the P09 in-memory transport test harness). Assert: handler returns `'ack'`, zero `webhooks.deliveries` rows, zero DLQ rows. If it DLQs, add the type to the projector's explicit "ignored internal events" list (same list that already contains `payment.created.v1`) — that is the only projector change allowed.

**Expected behavior** — Valid settlement and settlement-ledger fixtures pass; each listed mutation fails with a distinct semantic or schema error; the projector acknowledges the settlement event with no delivery.

**Acceptance criteria**
- [ ] Contract test passes and fails if `SETTLEMENT` is removed from the openapi kind enum (verified by local temporary edit, then reverted).
- [ ] All four settlement semantic mutations and three ledger conditional mutations are rejected.
- [ ] Projector produces no delivery and no DLQ record for `settlement.batch.posted.v1`.
- [ ] No file under `schemas/` or `openapi/` changed.

**Testing requirements** — `test/contract/settlement-contracts.test.ts` cases: `registry has settlement.batch.posted.v1 once`, `openapi timeline kind includes SETTLEMENT`, `valid settlement event passes`, `valid settlement ledger event passes`, `rejects batch id/aggregate mismatch`, `rejects ordering key != merchant`, `rejects posting key mismatch`, `rejects aggregateVersion 2`, `settlement stream is not version-contiguous`, `rejects SETTLEMENT ledger event with paymentId`, `rejects CAPTURE ledger event with settlementBatchId`. Projector case in `test/integration/merchant-webhooks/projector-ignores-settlement.test.ts` (create). Commands: `pnpm test:contracts`, `pnpm vitest run --project integration test/integration/merchant-webhooks/projector-ignores-settlement.test.ts`.

**Non-goals** — No schema/registry/openapi edits; no settlement SQL; no producer code.

**Handoff checklist**
- [ ] Risk R-02 text in this file still matches what was found.
- [ ] `pnpm check` green.
- [ ] Commit body contains `Task: P10-T01`.

---

### P10-T02 — Settlement schema: runs, batches, membership, immutability, RLS, grants

**Task ID:** `P10-T02`
**Feature:** Settlement persistence
**Commit:** `feat(settlement): add settlement runs, batches, and immutable membership tables`
**Priority:** Critical
**Dependencies:** `P10-T01`
**Estimated complexity:** L
**Contract references:** `docs/07` §Settlement (lines 956–1050), §Exact idempotency and uniqueness boundaries (settlement rows), §Tenant isolation item 8, §Mutability rules (settlement rows), §Migration order steps 15–17; `docs/02` §Batch invariants; CONVENTIONS §7 roles, §8 incremental ordering rule.
**Files:** create: `migrations/1000_settlement_schema.sql`, `test/integration/settlement/schema.test.ts`; modify: none; must not touch: P03 ledger migrations, `packages/database/src/functions/ledger.ts`.

**Objective** — Create the three settlement tables exactly as `docs/07` specifies, fully locked down (no runtime DML, triggers enforce immutability for every role including the owner), so later tasks can add the protected functions.

**Implementation instructions**
1. Order inside the file (CONVENTIONS §8): tables → constraints/indexes → triggers → RLS → `REVOKE`/`GRANT` last. Schema `settlement` exists from P02 (`docs/07` §Schemas); if absent, `CREATE SCHEMA settlement AUTHORIZATION fl_migration_owner`.
2. `settlement.runs`:
   ```sql
   CREATE TABLE settlement.runs (
     id text COLLATE "C" PRIMARY KEY CHECK (id ~ '^srn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
     merchant_id text COLLATE "C" NOT NULL REFERENCES identity.merchants (id),
     currency text NOT NULL CHECK (currency = 'USD'),
     status text NOT NULL CHECK (status IN ('CLAIMED','POSTED','DEFERRED','FAILED')),
     cutoff_at timestamptz,
     eligible_movement_count integer CHECK (eligible_movement_count >= 0),
     net_amount_minor bigint,
     batch_id text COLLATE "C",
     lease_token uuid,
     lease_expires_at timestamptz,
     started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
     completed_at timestamptz,
     UNIQUE (merchant_id, id),
     CHECK ((status = 'POSTED') = (batch_id IS NOT NULL)),
     CHECK (status <> 'POSTED' OR (net_amount_minor > 0 AND eligible_movement_count > 0 AND cutoff_at IS NOT NULL)),
     CHECK (status <> 'DEFERRED' OR (net_amount_minor <= 0 AND batch_id IS NULL AND cutoff_at IS NOT NULL AND eligible_movement_count IS NOT NULL)),
     CHECK ((status = 'CLAIMED') = (completed_at IS NULL)),
     CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
   );
   CREATE UNIQUE INDEX runs_one_claimed ON settlement.runs (merchant_id, currency) WHERE status = 'CLAIMED';
   CREATE INDEX runs_stale ON settlement.runs (status, lease_expires_at) WHERE status = 'CLAIMED';
   CREATE INDEX runs_merchant_recent ON settlement.runs (merchant_id, currency, completed_at DESC);
   ```
   A `CLAIMED` row with null lease means "scheduled, not yet leased" (risk R-05).
3. `settlement.batches` exactly per `docs/07` lines 991–1014: `id` with `^sbt_…` check; `merchant_id`, `currency='USD'`, `run_id`, `cutoff_at`, `member_count integer CHECK (member_count > 0)`, `net_amount_minor bigint CHECK (net_amount_minor > 0)`, `journal_transaction_id`, `posting_key text COLLATE "C" CHECK (posting_key = 'settlement:' || id)`, `posted_at timestamptz NOT NULL DEFAULT clock_timestamp()`. `PRIMARY KEY (id)`, `UNIQUE (merchant_id, id)`, `UNIQUE (run_id)`, `UNIQUE (journal_transaction_id)`. Composite FKs: `(merchant_id, run_id) → settlement.runs (merchant_id, id)`; `journal_transaction_id → ledger.journal_transactions (id)` plus a check trigger (step 6) that the referenced journal row has `merchant_id = batches.merchant_id` and `operation_type = 'SETTLEMENT'` (P03's journal table may not expose a `(merchant_id, id)` unique key; if it does, use a composite FK instead of the trigger check). Index `(merchant_id, posted_at DESC, id)`.
4. Add `ALTER TABLE settlement.runs ADD CONSTRAINT runs_batch_fk FOREIGN KEY (merchant_id, batch_id) REFERENCES settlement.batches (merchant_id, id) DEFERRABLE INITIALLY DEFERRED;` (circular reference run↔batch; both written in one transaction by `post_batch`).
5. `settlement.batch_members` per `docs/07` lines 1016–1034: `batch_id`, `merchant_id`, `movement_transaction_id`, `movement_kind CHECK (movement_kind IN ('CAPTURE','REFUND'))`, `clearing_delta_minor bigint NOT NULL CHECK (clearing_delta_minor <> 0)`. `PRIMARY KEY (batch_id, movement_transaction_id)`, `UNIQUE (movement_transaction_id)`, FK `(merchant_id, batch_id) → settlement.batches (merchant_id, id)`, FK `movement_transaction_id → ledger.journal_transactions (id)`. Plus `CHECK ((movement_kind = 'CAPTURE') = (clearing_delta_minor > 0))`.
6. Triggers (functions owned by `fl_migration_owner`, `SET search_path = pg_catalog, settlement, ledger`):
   - `settlement.reject_mutation()` — `BEFORE UPDATE OR DELETE ... FOR EACH ROW` and `BEFORE TRUNCATE ... FOR EACH STATEMENT` on `batches` and `batch_members`; raises `P0001` message `SETTLEMENT_IMMUTABLE`.
   - `settlement.check_member()` — `BEFORE INSERT` on `batch_members`: referenced journal row's `merchant_id = NEW.merchant_id` and `operation_type = NEW.movement_kind`; else `SETTLEMENT_MEMBER_MISMATCH`.
   - `settlement.check_batch()` — `BEFORE INSERT` on `batches`: referenced journal row has `merchant_id = NEW.merchant_id`, `operation_type = 'SETTLEMENT'`, `posting_key = NEW.posting_key`; else `SETTLEMENT_BATCH_MISMATCH`.
   - `settlement.guard_run_transition()` — `BEFORE UPDATE` on `runs`: reject change of `id, merchant_id, currency, started_at`; allow only `CLAIMED→CLAIMED` (only when `OLD.lease_token IS NULL` and the update sets the lease — the claim), `CLAIMED→POSTED|DEFERRED|FAILED`; reject any update when `OLD.status <> 'CLAIMED'`; message `SETTLEMENT_RUN_TRANSITION_INVALID`. `BEFORE DELETE` and `BEFORE TRUNCATE` on `runs` reject with `SETTLEMENT_IMMUTABLE`.
7. RLS: `ENABLE ROW LEVEL SECURITY` on all three tables. Policies: `merchant_read FOR SELECT USING (merchant_id = current_setting('app.merchant_id', true))` (no role restriction; a missing setting matches nothing). Policy `settlement_fn_all FOR ALL TO settlement_function_owner USING (true) WITH CHECK (true)`.
8. Grants last: `REVOKE ALL ON settlement.runs, settlement.batches, settlement.batch_members FROM PUBLIC` and from every runtime role in CONVENTIONS §7. `GRANT SELECT, INSERT, UPDATE ON settlement.runs TO settlement_function_owner; GRANT SELECT, INSERT ON settlement.batches, settlement.batch_members TO settlement_function_owner;`. No runtime role gets any table privilege.

**Expected behavior** — Valid rows insert only as migration owner/test harness; any `UPDATE`/`DELETE`/`TRUNCATE` on batches/members fails with `SETTLEMENT_IMMUTABLE` even as `fl_migration_owner`; runtime roles get `42501 permission denied`.

**Acceptance criteria**
- [ ] Migration applies on an empty database and on the P09 populated fixture (`pnpm db:migrate`).
- [ ] Each check, unique, and FK in steps 2–5 rejects an invalid direct write (one negative case each).
- [ ] Second `CLAIMED` run for the same `(merchant_id, currency)` fails on `runs_one_claimed`.
- [ ] `UPDATE`, `DELETE`, `TRUNCATE` on `batches` and `batch_members` fail for every runtime role (`42501`) and for `fl_migration_owner` (`SETTLEMENT_IMMUTABLE`).
- [ ] Run transition trigger rejects `POSTED→CLAIMED`, `DEFERRED→POSTED`, `FAILED→CLAIMED`, re-leasing a leased `CLAIMED` run, and identity-column edits.
- [ ] With `app.merchant_id` unset, `fl_api` (even if granted SELECT in a test transaction) sees zero rows.

**Testing requirements** — `test/integration/settlement/schema.test.ts` using the Testcontainers fixture from `packages/testkit`. Fixture rows are inserted as `fl_migration_owner` with a SETTLEMENT journal transaction created through the P03 migration-owner posting harness (never raw journal INSERT). Cases: `rejects bad srn id`, `rejects non-USD`, `POSTED requires batch and positive net`, `DEFERRED requires net <= 0`, `CLAIMED requires null completed_at`, `one CLAIMED per merchant`, `batch posting_key must equal settlement:id`, `batch rejects non-SETTLEMENT journal`, `member kind must match journal operation_type`, `member delta sign matches kind`, `movement in two batches rejected by unique index`, `batches/members reject UPDATE/DELETE/TRUNCATE per runtime role` (loop over all CONVENTIONS §7 login roles), `owner also rejected by trigger`, `run transition matrix`, `RLS hides rows without app.merchant_id`. Command: `pnpm vitest run --project integration test/integration/settlement/schema.test.ts`.

**Non-goals** — No protected functions, no worker, no views for merchants (P10-T10).

**Handoff checklist**
- [ ] Grants are the last statements in the file.
- [ ] Each invariant test observed failing with its constraint dropped.
- [ ] `pnpm check` and `pnpm test:integration` green; `Task: P10-T02` in body.

---

### P10-T03 — `SETTLEMENT` ledger recipe: hash golden vectors and posting-routine acceptance

**Task ID:** `P10-T03`
**Feature:** Ledger settlement recipe
**Commit:** `feat(ledger): accept SETTLEMENT recipe in canonical posting`
**Priority:** Critical
**Dependencies:** `P10-T02`
**Estimated complexity:** M
**Contract references:** `docs/02` §Idempotent posting (posting key `settlement:{settlementBatchId}`), §Settlement run (example entries), §What settlement does not do; `docs/07` `ledger.journal_transactions` constraints (line 853), §Protected posting function (internal routine), line 887 (hash object); `schemas/events/ledger-transaction-posted.v1.schema.json` (`SETTLEMENT` branch).
**Files:** create: `migrations/1010_ledger_settlement_recipe.sql`, `test/integration/ledger/settlement-recipe.test.ts`; modify: `packages/domain/src/posting-hash.ts` (P01 canonical posting hash, `computePostingHash`) and `packages/domain/golden/posting-hash.v1.json`; must not touch: `migrations/0*`, P07 payment posting wrapper.

**Objective** — Make the shared canonical posting routine accept a `SETTLEMENT` posting (merchant clearing debit, merchant payable credit, no payment references) with the settlement batch as the hashed business reference, and emit a schema-valid `ledger.transaction.posted.v1` with `settlementBatchId`.

**Implementation instructions**
1. Read the current routine with `SELECT pg_get_functiondef('ledger.post_journal_internal(text,text,text,text,text,text,text,text,text,text,text,text,jsonb,ledger.posting_line[],uuid,boolean)'::regprocedure)`. Determine whether it already (a) accepts `operation_type = 'SETTLEMENT'`, (b) includes a settlement-batch reference in the hash object, (c) emits `data.settlementBatchId` and null payment fields for `SETTLEMENT`, and (d) permits `session_user = 'fl_settlement_worker'` in any provenance check. Implement only the missing parts; if all four already hold, the migration contains only step 4's grant and policy statements.
2. Hash (TypeScript and SQL must match): for `SETTLEMENT`, the versioned hash object contains `operationType: "SETTLEMENT"`, `currency`, `ledgerId`, `merchantId`, `settlementBatchId`, `recipeVersion`, and the canonical entries; `paymentId`/`paymentOperationId`/`reversalOfTransactionId` are absent. Add two golden vectors to the P03 golden file: one settlement (net `9700`), one settlement whose input entries are given in reverse order (same hash).
3. Routine changes (via `CREATE OR REPLACE FUNCTION` with the identical signature, copying the P03 body and adding only the needed branch): for `SETTLEMENT`, require `payment_id IS NULL`, `payment_operation_id IS NULL`, posting key matching `^settlement:sbt_[0-7][0-9A-HJKMNP-TV-Z]{25}$`, exactly two canonical entries, both accounts `owner_type = 'MERCHANT'` and owned by the transaction merchant, one with the clearing logical code (side `DEBIT`) and one with the payable logical code (side `CREDIT`), equal amounts. The settlement batch ID is parsed from the posting key and stored in `metadata.settlementBatchId`; the ledger event sets `data.settlementBatchId` to it and `paymentId`/`paymentOperationId` to `null`.
4. Wrapper (the P03 routine stays private — EXECUTE to no role, P03-T06): `ledger.post_settlement_journal(p_transaction_id text, p_settlement_batch_id text, p_merchant_id text, p_net_minor bigint, p_correlation_id text, p_causation_id text, p_metadata jsonb, p_envelope_id uuid) RETURNS text`, `SECURITY DEFINER`, owner `ledger_function_owner`, fixed `search_path`; derives the USD ledger and the merchant's `merchant.clearing`/`merchant.payable` accounts from rows (missing → `LEDGER_ACCOUNT_MISSING`), builds lines `[(clearing, DEBIT, p_net_minor), (payable, CREDIT, p_net_minor)]` and posting key `'settlement:' || p_settlement_batch_id`, and returns `ledger.post_journal_internal(p_transaction_id, <key>, 'SETTLEMENT', <ledger>, p_merchant_id, 'USD', NULL, NULL, NULL, NULL, p_correlation_id, p_causation_id, p_metadata, <lines>, p_envelope_id, false)`. Grants/policies: `REVOKE ALL ON FUNCTION ledger.post_settlement_journal(...) FROM PUBLIC; GRANT EXECUTE ON FUNCTION ledger.post_settlement_journal(...) TO settlement_function_owner;` `GRANT SELECT ON ledger.accounts, ledger.journal_transactions, ledger.journal_entries, ledger.account_balances TO settlement_function_owner;` and, for each of those tables that has RLS enabled, `CREATE POLICY settlement_fn_read ON <table> FOR SELECT TO settlement_function_owner USING (true)`. Do not grant anything to runtime roles.

**Expected behavior** — A SETTLEMENT posting via the migration-owner harness for net 9700 creates one journal transaction with two entries (clearing debit 9700, payable credit 9700), one ledger event with `operationType=SETTLEMENT`, `settlementBatchId` set; a replay with the same key and entries returns the same `ltx_`; changing the amount under the same key raises the P03 idempotency-conflict error.

**Acceptance criteria**
- [ ] TS golden vectors and the SQL routine produce identical hashes for both settlement vectors.
- [ ] SETTLEMENT posting with a payment reference, a platform account, a second merchant's account, three entries, or a posting key not matching `settlement:sbt_…` is rejected.
- [ ] The produced outbox envelope validates with Ajv against `ledger-transaction-posted.v1`.
- [ ] Capture/refund golden vectors are unchanged (existing tests still pass).

**Testing requirements** — Unit: P03's golden-vector test file gains `settlement vector`, `settlement vector order-independent`. Integration `test/integration/ledger/settlement-recipe.test.ts`: `posts balanced clearing→payable`, `replay returns same ltx`, `changed amount same key conflicts`, `rejects payment reference`, `rejects platform account`, `rejects cross-merchant account`, `rejects bad posting key`, `ledger event validates and carries settlementBatchId`, `fl_settlement_worker cannot execute the routine or the wrapper directly` (expects `42501`). Commands: `pnpm test:unit`, `pnpm vitest run --project integration test/integration/ledger/settlement-recipe.test.ts`, then full `pnpm test:integration` (regression of P03/P07 ledger tests).

**Non-goals** — No `settlement.post_batch`; no change to capture/refund recipes.

**Handoff checklist**
- [ ] Function body diff vs P03 version is limited to the SETTLEMENT branch and provenance list.
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P10-T03`.

---

### P10-T04 — Run scheduling, claim, failure, and stale-run sweep functions

**Task ID:** `P10-T04`
**Feature:** Settlement run lifecycle
**Commit:** `feat(settlement): add run scheduling, SKIP LOCKED claim, and stale sweep functions`
**Priority:** Critical
**Dependencies:** `P10-T02`
**Estimated complexity:** M
**Contract references:** `docs/07` `settlement.runs` (lines 962–989), §Transaction and lock ownership "Post settlement batch"; `docs/08` §Settlement crash points, §Sweep and claim defaults (settlement scheduler 60 s / 50 merchants / 120 s lease; stale sweeper 60 s / 50); `docs/02` §MVP implementation decisions "Settlement schedule".
**Files:** create: `migrations/1020_settlement_run_functions.sql`, `packages/database/src/functions/settlement.ts`, `test/integration/settlement/run-lifecycle.test.ts`; modify: `packages/database/src/errors.ts` (add settlement codes); must not touch: `migrations/1000_*`.

**Objective** — Provide the protected functions the worker uses to schedule one run per due merchant, lease scheduled runs with `FOR UPDATE SKIP LOCKED`, fail its own run, and fail runs whose lease expired, so an abandoned claim never blocks a merchant and never leaves financial state.

**Implementation instructions**
1. All functions: `LANGUAGE plpgsql SECURITY DEFINER`, owner `settlement_function_owner`, `SET search_path = pg_catalog, settlement, ledger`, no dynamic SQL, first statement checks `session_user = 'fl_settlement_worker'` (else `RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='FORBIDDEN'`). `REVOKE ALL ... FROM PUBLIC`; `GRANT EXECUTE ... TO fl_settlement_worker` last.
2. `settlement.due_merchants(p_limit integer, p_interval_seconds integer) RETURNS TABLE (merchant_id text)` (`STABLE`): merchants owning a USD merchant-clearing account (P03 clearing logical code) where (a) no `CLAIMED` run exists, (b) no run with `status IN ('POSTED','DEFERRED')` has `completed_at > clock_timestamp() - make_interval(secs => p_interval_seconds)`, and (c) at least one unsettled movement exists (`EXISTS` CAPTURE/REFUND journal row for the merchant with no `batch_members` row). Order by the merchant's latest `completed_at` ascending, nulls first, then `merchant_id`; `LIMIT p_limit`. `FAILED` runs never count as recent (an abandoned run makes the merchant due immediately). Reject `p_limit` outside `1..500` and `p_interval_seconds < 1` with `INVALID_REQUEST`.
3. `settlement.schedule_run(p_run_id text, p_merchant_id text) RETURNS text`: `INSERT INTO settlement.runs (id, merchant_id, currency, status) VALUES (p_run_id, p_merchant_id, 'USD', 'CLAIMED') ON CONFLICT (merchant_id, currency) WHERE status = 'CLAIMED' DO NOTHING RETURNING id`; returns the new ID or `NULL` when a claimed run already exists. The caller supplies `p_run_id` from `newId('srn')` (CONVENTIONS §6).
4. `settlement.claim_runs(p_limit integer, p_lease_seconds integer) RETURNS TABLE (run_id text, merchant_id text, lease_token uuid)`:
   ```sql
   RETURN QUERY
   WITH c AS (
     SELECT r.id FROM settlement.runs r
     WHERE r.status = 'CLAIMED' AND r.lease_token IS NULL
     ORDER BY r.started_at, r.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED)
   UPDATE settlement.runs r
      SET lease_token = gen_random_uuid(),
          lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
     FROM c WHERE r.id = c.id
   RETURNING r.id, r.merchant_id, r.lease_token;
   ```
5. `settlement.fail_run(p_run_id text, p_lease_token uuid) RETURNS boolean`: `UPDATE ... SET status='FAILED', completed_at=clock_timestamp() WHERE id=p_run_id AND status='CLAIMED' AND lease_token=p_lease_token`; return `FOUND`.
6. `settlement.fail_stale_runs(p_limit integer) RETURNS integer`: select `CLAIMED` runs with `lease_expires_at < clock_timestamp()` ordered by `lease_expires_at` `LIMIT p_limit FOR UPDATE SKIP LOCKED`; set `FAILED`, `completed_at`; return the count. A run whose `post_batch` transaction is in progress holds its row lock, so `SKIP LOCKED` never fails it mid-posting.
7. TS wrappers in `packages/database/src/functions/settlement.ts`: `dueMerchants(client, limit, intervalSeconds): Promise<MerchantId[]>`, `scheduleRun(client, runId: SettlementRunId, merchantId: MerchantId): Promise<SettlementRunId | null>`, `claimRuns(client, limit, leaseSeconds): Promise<{ runId; merchantId; leaseToken: string }[]>`, `failRun(client, runId, leaseToken): Promise<boolean>`, `failStaleRuns(client, limit): Promise<number>`.
8. `errors.ts`: map `P0001` messages `SETTLEMENT_RUN_NOT_CLAIMED`, `SETTLEMENT_LEASE_LOST`, `SETTLEMENT_INVALID_TEMPLATE`, `SETTLEMENT_INVARIANT_VIOLATION`, `SETTLEMENT_NET_OUT_OF_RANGE`, `SETTLEMENT_IMMUTABLE`, `SETTLEMENT_RUN_TRANSITION_INVALID` to `DomainError` codes of the same name. These are internal, non-HTTP codes **[ASSUMPTION]** (risk R-09).

**Expected behavior** — Two concurrent `schedule_run` calls for one merchant: one returns the ID, the other `NULL`. Two concurrent `claim_runs(50, 120)` callers lease disjoint runs. A leased run with expired lease is `FAILED` by `fail_stale_runs`; the merchant is returned by the next `due_merchants`.

**Acceptance criteria**
- [ ] `due_merchants` excludes merchants with a `CLAIMED` run, a recent `POSTED`/`DEFERRED` run, or no unsettled movement; includes a merchant whose only recent run is `FAILED`.
- [ ] 20 concurrent `schedule_run` for one merchant create exactly one `CLAIMED` run.
- [ ] Concurrent `claim_runs` never return the same run twice; already-leased runs are never re-leased.
- [ ] `fail_stale_runs` skips a run locked by another transaction (test holds `SELECT ... FOR UPDATE` on it) and fails it after the lock is released.
- [ ] `fail_run` with a wrong token returns `false` and changes nothing.
- [ ] Every function rejects `session_user` other than `fl_settlement_worker` with `FORBIDDEN`; `fl_api` lacks `EXECUTE` (`42501`).

**Testing requirements** — `test/integration/settlement/run-lifecycle.test.ts` cases: `due excludes claimed`, `due excludes recently completed`, `due includes after FAILED`, `due excludes merchant with nothing unsettled`, `concurrent schedule creates one run` (20 parallel connections), `concurrent claims are disjoint` (2 connections × claim 50 over 60 scheduled runs; union = 60, intersection = 0), `stale sweep skips locked run`, `stale sweep fails expired run`, `fail_run wrong token no-op`, `role checks`. Movements are created with the P07 testkit capture builder. Command: `pnpm vitest run --project integration test/integration/settlement/run-lifecycle.test.ts`.

**Non-goals** — No posting, no worker loop, no operator trigger (P10-T13).

**Handoff checklist**
- [ ] Wrapper names match SQL names in camelCase.
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P10-T04`.

---

### P10-T05 — Protected `settlement.post_batch`

**Task ID:** `P10-T05`
**Feature:** Settlement batch posting
**Commit:** `feat(settlement): add protected post_batch with anti-join selection and deferral`
**Priority:** Critical
**Dependencies:** `P10-T03`, `P10-T04`
**Estimated complexity:** L
**Contract references:** `docs/07` §Protected settlement function (lines 1036–1050), §Transaction and lock ownership (settlement chain, lines 1338, 1353–1361); `docs/02` §Settlement accounting (all subsections); `docs/04` §Envelope (settlement rule); `schemas/events/settlement-batch-posted.v1.schema.json`; `docs/08` §Settlement crash points.
**Files:** create: `migrations/1030_settlement_post_batch.sql`, `test/integration/settlement/post-batch.test.ts`, `test/integration/settlement/post-batch-concurrency.test.ts`; modify: `packages/database/src/functions/settlement.ts` (add `postBatch`); must not touch: `migrations/1000_*`–`1020_*`.

**Objective** — Implement the only settlement financial entry point: in one caller-owned transaction, lock the leased run, read the cutoff, select eligible movements by anti-join, compute the net from immutable entries, then either defer (post nothing) or insert batch + membership, post the clearing→payable transaction through the P03 routine, mark the run `POSTED`, and insert one `settlement.batch.posted.v1`.

**Implementation instructions**
1. Signature **(deviation, risk R-01)**: `settlement.post_batch(p_run_id text, p_lease_token uuid, p_outbox_envelope jsonb) RETURNS text` — returns the batch ID, or `NULL` when deferred. `SECURITY DEFINER`, owner `settlement_function_owner`, `SET search_path = pg_catalog, settlement, ledger, messaging`, no dynamic SQL, `session_user = 'fl_settlement_worker'` check. Grant `EXECUTE` to `fl_settlement_worker` only; grant `EXECUTE ON FUNCTION messaging.insert_outbox(jsonb) TO settlement_function_owner` in this file.
2. `p_outbox_envelope` is an envelope **template** built by the worker (risk R-03). It MUST have exactly the keys `id` (uuid string), `source` (`flowledger.settlement`), `correlationId`, `causationId` (equal to `p_run_id`), optional `traceparent`, and `data` with exactly `settlementBatchId` (`sbt_…`) and `ledgerTransactionId` (`ltx_…`). Any other shape → `SETTLEMENT_INVALID_TEMPLATE`. The function fills every other envelope field.
3. Body, in this order (SQL skeleton; fill in exact column lists):
   ```sql
   SELECT * INTO v_run FROM settlement.runs WHERE id = p_run_id FOR UPDATE;            -- 1 lock run
   IF NOT FOUND OR v_run.status <> 'CLAIMED' THEN RAISE ... 'SETTLEMENT_RUN_NOT_CLAIMED';
   IF v_run.lease_token IS DISTINCT FROM p_lease_token OR v_run.lease_expires_at <= clock_timestamp()
     THEN RAISE ... 'SETTLEMENT_LEASE_LOST';
   PERFORM <fault point 'settlement.after_run_lock'>;
   v_cutoff := clock_timestamp();                                                        -- 2 cutoff
   SELECT id INTO v_clearing FROM ledger.accounts WHERE owner_type='MERCHANT' AND owner_id=v_run.merchant_id
     AND logical_code='merchant.clearing' AND currency=v_run.currency;                 -- same for v_payable ('merchant.payable')
   SELECT coalesce(array_agg(jt.id ORDER BY jt.id), '{}') INTO v_ids                      -- 3 select (one statement = one snapshot)
     FROM ledger.journal_transactions jt
    WHERE jt.merchant_id = v_run.merchant_id AND jt.currency = v_run.currency
      AND jt.operation_type IN ('CAPTURE','REFUND') AND jt.recorded_at < v_cutoff
      AND NOT EXISTS (SELECT 1 FROM settlement.batch_members m WHERE m.movement_transaction_id = jt.id);
   PERFORM <fault point 'settlement.after_selection'>;
   SELECT coalesce(sum(CASE e.side WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END), 0)
     INTO v_net FROM ledger.journal_entries e
    WHERE e.transaction_id = ANY (v_ids) AND e.account_id = v_clearing;                  -- 4 net from entries
   IF v_net <= 0 THEN                                                                    -- 5 defer
     UPDATE settlement.runs SET status='DEFERRED', cutoff_at=v_cutoff,
       eligible_movement_count=cardinality(v_ids), net_amount_minor=v_net, completed_at=clock_timestamp()
      WHERE id = p_run_id;
     RETURN NULL;
   END IF;
   IF v_net > 1000000000000 THEN RAISE ... 'SETTLEMENT_NET_OUT_OF_RANGE'; END IF;        -- risk R-08
   -- 6 post: v_ltx_id := ledger.post_settlement_journal(template data.ledgerTransactionId, v_batch_id,
   --   v_run.merchant_id, v_net, template correlationId, p_run_id,
   --   jsonb_build_object('settlementBatchId', v_batch_id, 'settlementRunId', p_run_id), gen_random_uuid())
   --   (P10-T03 wrapper: posting key 'settlement:' || v_batch_id, operation type 'SETTLEMENT', null payment refs,
   --   entries [(v_clearing, DEBIT, v_net), (v_payable, CREDIT, v_net)]).
   PERFORM <fault point 'settlement.after_posting'>;
   INSERT INTO settlement.batches (...) VALUES (v_batch_id, merchant, currency, p_run_id, v_cutoff,
     cardinality(v_ids), v_net, v_ltx_id, 'settlement:' || v_batch_id) RETURNING posted_at INTO v_posted_at;
   INSERT INTO settlement.batch_members (batch_id, merchant_id, movement_transaction_id, movement_kind, clearing_delta_minor)
     SELECT v_batch_id, jt.merchant_id, jt.id, jt.operation_type,
            sum(CASE e.side WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END)
       FROM ledger.journal_transactions jt JOIN ledger.journal_entries e ON e.transaction_id = jt.id AND e.account_id = v_clearing
      WHERE jt.id = ANY (v_ids) GROUP BY jt.merchant_id, jt.id, jt.operation_type;
   PERFORM <fault point 'settlement.after_membership'>;
   UPDATE settlement.runs SET status='POSTED', cutoff_at=v_cutoff, eligible_movement_count=cardinality(v_ids),
     net_amount_minor=v_net, batch_id=v_batch_id, completed_at=clock_timestamp() WHERE id = p_run_id;
   -- 7 assertions (SETTLEMENT_INVARIANT_VIOLATION on any failure):
   --   count(batch_members where batch_id=v_batch_id) = cardinality(v_ids) = member_count;
   --   sum(clearing_delta_minor) = v_net;
   --   recomputed net from members' journal entries = v_net;
   --   the posted journal transaction's clearing DEBIT amount = payable CREDIT amount = v_net.
   PERFORM messaging.insert_outbox(<completed envelope>);                                 -- batch event
   PERFORM <fault point 'settlement.before_return'>;
   RETURN v_batch_id;
   ```
   Insertion order (posting → batch → members) satisfies FKs; the run↔batch FK is deferred. `<fault point 'x'>` is `public.fault_point('x')` (P06-T02 mechanism: raises `FAULT_INJECTED` when `current_setting('flowledger.fault_point', true)` equals the point name).
4. Completed envelope: template plus `kind='EVENT'`, `type='settlement.batch.posted.v1'`, `schemaVersion=1`, `occurredAt=recordedAt=<v_posted_at as UTC RFC 3339 with milliseconds>`, `merchantId`, `aggregateType='settlement_batch'`, `aggregateId=v_batch_id`, `aggregateVersion=1`, `orderingKey=merchantId`, `data` = `{settlementBatchId, settlementRunId, currency:'USD', cutoffAt, memberCount, netAmountMinor (decimal string), ledgerTransactionId, postingKey, postedAt}`.
5. The function never reads or locks `payments.*`. Its only locks are the run row and (inside the P03 routine) the two merchant balance rows in ascending account-ID order.
6. TS wrapper `postBatch(client, runId, leaseToken, template: SettlementEnvelopeTemplate): Promise<SettlementBatchId | null>` with `SettlementEnvelopeTemplate` typed exactly as step 2. Export `buildSettlementTemplate(runId, correlationId, traceparent?)` that fills `id: randomUUID()`, `source`, `causationId: runId`, `data: { settlementBatchId: newId('sbt'), ledgerTransactionId: newId('ltx') }`.

**Expected behavior**
- Merchant with capture movements netting 9700 (capture 10000 / fee 300) → batch `net_amount_minor=9700`, 1 member `clearing_delta_minor=9700`, journal clearing DEBIT 9700 / payable CREDIT 9700, run `POSTED`, outbox has one `settlement.batch.posted.v1` and one `ledger.transaction.posted.v1` (`operationType=SETTLEMENT`).
- Capture 9700 settled; refund confirms debiting clearing 4850 → next run: eligible = {refund}, net −4850 → `DEFERRED`, `net_amount_minor=-4850`, no batch, payable unchanged, clearing −4850.
- Then capture 9700 more → next run net 4850 → batch with 2 members (refund −4850, capture +9700).
- Zero eligible movements → `DEFERRED`, count 0, net 0.

**Acceptance criteria**
- [ ] Every expected-behavior scenario holds, including the late-refund negative carry; the closed batch row and its members are byte-identical before and after.
- [ ] A movement committed after the cutoff (`recorded_at >= cutoff_at`) is not selected and is selected by the next run.
- [ ] Wrong lease token / expired lease / non-`CLAIMED` run raise `SETTLEMENT_LEASE_LOST` / `SETTLEMENT_LEASE_LOST` / `SETTLEMENT_RUN_NOT_CLAIMED` and change nothing.
- [ ] Malformed template (extra key, missing `data.ledgerTransactionId`, wrong source) raises `SETTLEMENT_INVALID_TEMPLATE`.
- [ ] Both outbox envelopes validate with Ajv + `validateSemantic()`.
- [ ] Merchant payable balance after each run ≥ before (non-decreasing).
- [ ] `pg_locks` sampled during a paused `post_batch` (fault point blocked by a held balance lock) shows no lock on any `payments.*` relation.

**Testing requirements**
- `test/integration/settlement/post-batch.test.ts`: `posts positive net batch`, `defers zero movements`, `defers negative net and leaves movements eligible`, `late refund drives clearing negative, closed batch unchanged, payable not reduced`, `next positive run nets refund and capture`, `cutoff excludes later movement`, `lease lost`, `lease expired`, `run not claimed`, `invalid template` (3 variants), `envelopes validate`, `reused ledgerTransactionId is rejected` (template whose `ledgerTransactionId` equals an existing capture transaction ID; expect the P03 routine's error or `SETTLEMENT_INVARIANT_VIOLATION`, and no batch row), `invariant assertion fires` (as the container superuser, create a temporary `BEFORE INSERT` trigger on `settlement.batch_members` that adds 1 to `clearing_delta_minor`; expect `SETTLEMENT_INVARIANT_VIOLATION`; drop the trigger), `no payment locks` (pg_locks check), `fl_api cannot execute` (`42501`).
- `test/integration/settlement/post-batch-concurrency.test.ts`: `concurrent capture confirmations during runs never double-settle` (10 connections confirming captures via P07 builder while 3 sequential runs post; assert each movement in ≤ 1 batch and every movement eventually settled), `settlement and refund resolution contend on clearing without deadlock` (50 iterations, no `40P01` surfaces after `withTransaction` retries), `two workers with stolen lease: second post_batch fails` (claim, then force-expire via fault and `fail_stale_runs`, schedule+claim a new run, assert old token raises and new run posts once).
- Command: `pnpm vitest run --project integration test/integration/settlement/`.

**Non-goals** — No worker loop; no crash-kill tests (P10-T06); no timeline.

**Handoff checklist**
- [ ] Function contains no reference to `payments.` and no dynamic SQL (grep).
- [ ] Each invariant test observed failing when the corresponding guard line is removed.
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P10-T05`.

---

### P10-T06 — Settlement crash-point suite

**Task ID:** `P10-T06`
**Feature:** Settlement recovery
**Commit:** `test(settlement): add settlement crash-point chaos suite`
**Priority:** Critical
**Dependencies:** `P10-T05`
**Estimated complexity:** M
**Contract references:** `docs/08` §Settlement crash-point matrix (lines 135–146), §Required failure-injection tests → Settlement (lines 536–543); `docs/10` M10 acceptance "Crashing at every point…"; `docs/02` §Required property tests → Atomicity.
**Files:** create: `test/chaos/settlement-crash-points.test.ts`; modify: none; must not touch: `migrations/**`.

**Objective** — Prove that a crash at every point in the settlement workflow leaves either nothing or a complete batch, never a partial one, and that abandoned runs are reclaimed and restart selection cleanly.

**Implementation instructions**
1. Use the Testcontainers fixture and the P07 builder to create 3 confirmed captures and 1 refund for merchant A (net > 0).
2. For each fault point `settlement.after_run_lock`, `settlement.after_selection`, `settlement.after_posting`, `settlement.after_membership`, `settlement.before_return`: schedule+claim a run, `SET LOCAL flowledger.fault_point = '<point>'` inside the posting transaction, call `postBatch`, expect `FAULT_INJECTED`. After rollback assert: zero `settlement.batches`, zero `batch_members`, zero `SETTLEMENT` journal transactions, merchant clearing/payable `account_balances.version` unchanged, zero outbox rows with `message_type IN ('settlement.batch.posted.v1')` and zero ledger events for SETTLEMENT, run still `CLAIMED` with the same lease.
3. Real process death: open the worker connection as `fl_settlement_worker`; in a second (superuser) connection hold `SELECT ... FROM ledger.account_balances WHERE account_id = <payable> FOR UPDATE`; start `postBatch` (it blocks on the balance lock inside the P03 routine); call `pg_terminate_backend(<worker pid>)`; release the lock. Assert the same "nothing visible" set.
4. Crash after claim commit, before posting: claim, never call `postBatch`, advance past lease (use a 1-second lease), run `failStaleRuns`, then `dueMerchants` → schedule → claim → post. Assert exactly one batch containing all four movements.
5. Crash after posting commit, before acknowledging (worker exits after commit): post once; add 1 new capture; run again. Assert second batch contains only the new movement and the first batch is unchanged.
6. Each case ends with `flowledger verify` (programmatic entry from P03) reporting zero findings for `journal_balance`, `projection_equality`, `settlement_membership`.

**Expected behavior** — All five injected faults and the killed backend leave no settlement artifacts; reclaim and post-commit restart produce one batch per movement set.

**Acceptance criteria**
- [ ] Six "nothing visible" cases pass.
- [ ] Abandoned-claim and post-commit-restart cases pass.
- [ ] Removing the `FOR UPDATE` from the run lock in a local edit makes the stolen-lease case in P10-T05 or this suite fail (observed, then reverted).

**Testing requirements** — `test/chaos/settlement-crash-points.test.ts` cases named `fault <point> leaves nothing` (×5), `killed backend leaves nothing`, `abandoned claim is failed and merchant re-runs cleanly`, `post-commit restart selects only newer movements`. Command: `FLOWLEDGER_FAULT_HOOKS=1 pnpm vitest run --project chaos test/chaos/settlement-crash-points.test.ts`.

**Non-goals** — No new SQL; no worker-process kill (covered in P10-T07 e2e).

**Handoff checklist**
- [ ] Every case asserts all six artifact counts, not only batches.
- [ ] `pnpm test:chaos` green; `Task: P10-T06`.

---

### P10-T07 — `apps/settlement-worker`: scheduler, poster, stale-run sweeper

**Task ID:** `P10-T07`
**Feature:** Settlement worker
**Commit:** `feat(settlement): implement settlement worker scheduler and stale-run sweeper`
**Priority:** Critical
**Dependencies:** `P10-T05`
**Estimated complexity:** L
**Contract references:** `docs/08` §Sweep and claim defaults, §Recovery owners ("Abandoned settlement run"); `docs/10` §Delivery safety (health, readiness, graceful shutdown, bounded concurrency, lease/owner/stale policy); `docs/09` §End-to-end scenarios 16, 17; CONVENTIONS §7, §11, §12.
**Files:** create: `apps/settlement-worker/src/loop.ts`, `apps/settlement-worker/src/loop.test.ts`, `packages/config/src/settlement-worker.ts`, `test/e2e/settlement-lifecycle.test.ts`; modify: `apps/settlement-worker/src/main.ts` (P00 inert entry point), `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `packages/database/src/functions/settlement.ts` signatures.

**Objective** — Run settlement continuously: every interval, fail stale runs, schedule due merchants, lease scheduled runs, and post each run in its own transaction with bounded concurrency, without ever locking payments or calling a provider.

**Implementation instructions**
1. Config (`packages/config/src/settlement-worker.ts`, frozen object): `DATABASE_URL` (role `fl_settlement_worker`), `DATABASE_POOL_MAX` (default 5), `SETTLEMENT_INTERVAL_SECONDS` (default 60; used for loop period, merchant due interval, and stale sweep), `SETTLEMENT_CLAIM_LIMIT` (default 50; used for due merchants, claims, and stale sweep), `SETTLEMENT_LEASE_SECONDS` (default 120; must be > 0 and ≥ 2 × the observed p99 posting time — validate only `> 0`), `SETTLEMENT_CONCURRENCY` (default 4, range 1–`DATABASE_POOL_MAX`). Add all to `.env.example` and `docs/CONFIG.md`.
2. `loop.ts` exports `async function runTick(deps: { pool: Pool; config: SettlementWorkerConfig; logger: Logger; now?: () => Date }): Promise<TickResult>` where `TickResult = { failedStale: number; scheduled: number; posted: number; deferred: number; failed: number; leaseLost: number }`:
   1. `failStaleRuns(limit)` in its own transaction.
   2. `dueMerchants(limit, interval)` then, per merchant, `scheduleRun(newId('srn'), merchantId)` (one short transaction each).
   3. `claimRuns(limit, leaseSeconds)` in one transaction, committed before any posting; then `crashPoint('settlement.after_claim')` (`packages/config/src/crash-points.ts`).
   4. For each claimed run, at most `SETTLEMENT_CONCURRENCY` at a time: `withTransaction(pool, { correlationId: 'settlement:' + runId }, c => postBatch(c, runId, leaseToken, template))` where `template = buildSettlementTemplate(runId, 'settlement:' + runId, activeTraceparent)` is built **once** outside the callback so retries reuse the same IDs. After each `postBatch` commit call `crashPoint('settlement.after_post_commit')`. Result `null` → deferred, string → posted. `DomainError` `SETTLEMENT_LEASE_LOST` or `SETTLEMENT_RUN_NOT_CLAIMED` → `leaseLost` (log, do nothing). Any other error → `failRun(runId, leaseToken)` in a new transaction, log `{ runId, merchantId, errorClass }` through the redaction allowlist, count `failed`.
3. `main.ts`: start `setInterval`-free loop (`await runTick(); await sleep(interval)` with an `AbortController` for shutdown), wire P00 health (`/healthz` live) and readiness (`/readyz` = pool `SELECT 1` succeeds), graceful shutdown on `SIGTERM`: stop scheduling new ticks, await the in-flight tick, close pool. The worker holds no lease or connection while sleeping.
4. Logs: one structured line per run outcome with `runId`, `merchantId`, `batchId`, `memberCount`, `outcome`, `correlationId`; never journal account IDs or amounts other than `netAmountMinor`.

**Expected behavior** — With two merchants (one positive, one negative net) a single tick returns `{scheduled:2, posted:1, deferred:1}`; a second tick within the interval schedules nothing.

**Acceptance criteria**
- [ ] Unit tests with a fake pool prove order (sweep → schedule → claim → post), concurrency never exceeds the configured bound, template reused across a simulated `40001` retry, lease-lost handling does not call `failRun`, unexpected error calls `failRun` once.
- [ ] e2e scenario 16: create → authorize → capture via API; settlement worker tick posts a batch; merchant payable (via `ledger.logical_account_balances` read as migration owner) increases by the net; `UPDATE settlement.batch_members` as every runtime role fails.
- [ ] e2e scenario 17: capture → settlement → refund confirms after batch closed → clearing negative; next tick defers; closed batch unchanged; payable unchanged.
- [ ] e2e: `SIGKILL` the worker process after its claim transaction commits (spawned with `FLOWLEDGER_FAULT_HOOKS=1 FLOWLEDGER_CRASH_POINTS=settlement.after_claim`, so `crashPoint` SIGKILLs it; exit 137), restart it with a 2-second lease; the run is failed by the sweeper and the merchant settles exactly once.
- [ ] Captured worker logs contain none of the `packages/testkit/src/prohibited-data.ts` fixtures and no `lac_` account IDs.
- [ ] Startup fails naming `SETTLEMENT_CONCURRENCY` when it exceeds `DATABASE_POOL_MAX`.

**Testing requirements** — Unit `apps/settlement-worker/src/loop.test.ts` (cases above). E2E `test/e2e/settlement-lifecycle.test.ts` cases `scenario 16 batch posts and is immutable`, `scenario 17 late refund defers`, `worker killed after claim settles once`, `worker logs are redacted`. Commands: `pnpm test:unit`, `pnpm vitest run --project e2e test/e2e/settlement-lifecycle.test.ts`.

**Non-goals** — No metrics (P11), no operator trigger (P10-T13), no Pub/Sub consumption (settlement is clock-driven).

**Handoff checklist**
- [ ] No `Number(`/`parseInt(` on money in the worker (grep).
- [ ] `.env.example` and `docs/CONFIG.md` updated.
- [ ] `pnpm check`, `pnpm test:integration`, `pnpm test:e2e` green; `Task: P10-T07`.

---

### P10-T08 — Settlement property tests under randomized traffic

**Task ID:** `P10-T08`
**Feature:** Settlement invariants
**Commit:** `test(settlement): add randomized settlement property tests`
**Priority:** High
**Dependencies:** `P10-T05`
**Estimated complexity:** M
**Contract references:** `docs/02` §Required property tests → Settlement (lines 449–457); `docs/09` §Property and model-based tests → Settlement (lines 145–152); `docs/10` M10 acceptance bullets 1, 2, 7.
**Files:** create: `test/integration/settlement/settlement.property.test.ts`; modify: none; must not touch: production code.

**Objective** — Generate random interleavings of captures, refunds (including refunds after settlement), and settlement runs and check every settlement property after each step against an independent model computed from immutable journal entries.

**Implementation instructions**
1. Use `fast-check` with a fixed seed (`seed` read from `FC_SEED`, default `20261108`), `numRuns: 25`, persisting the failing seed and minimal counterexample to `test-results/settlement-property-counterexample.json` on failure (the P01 fast-check reporter helper if present).
2. Command arbitrary over ≤ 3 merchants and ≤ 6 payments each: `capture(paymentIdx, amount)`, `refund(paymentIdx, amount ≤ remaining)`, `settle(merchantIdx)`, `settleConcurrently(merchantIdx)` (two `schedule_run` attempts racing + one post). Captures/refunds go through the P07 testkit builders (real protected functions). Amounts 1–100000.
3. After every command assert, per merchant:
   - P1 each movement ID appears in ≤ 1 `batch_members` row;
   - P2 each batch: `net_amount_minor` = Σ over members of (clearing CREDIT − clearing DEBIT) recomputed by joining `journal_entries` (not `clearing_delta_minor`), and = the batch journal transaction's clearing debit;
   - P3 every `DEFERRED` run has `net_amount_minor <= 0` and no batch;
   - P4 merchant payable normal balance is ≥ its value before the command;
   - P5 clearing + payable normal balances = Σ of clearing deltas of all confirmed capture/refund movements of the merchant (model);
   - P6 rebuilding clearing and payable from entries equals `account_balances`.

**Expected behavior** — All properties hold for 25 runs; a deliberate bug (local edit making `post_batch` skip the `NOT EXISTS` anti-join) is caught by P1 within the seed.

**Acceptance criteria**
- [ ] Six properties asserted after each command.
- [ ] Anti-join removal and `v_net <= 0` → `v_net < 0` mutations each fail the suite (observed, reverted).
- [ ] Counterexample file written on failure.

**Testing requirements** — File above, single `it('settlement properties hold under random interleavings')`. Command: `pnpm vitest run --project integration test/integration/settlement/settlement.property.test.ts`.

**Non-goals** — No load profile (P12 owns "settlement under live traffic").

**Handoff checklist**
- [ ] Seed fixed and logged.
- [ ] `pnpm test:integration` green; `Task: P10-T08`.

---

### P10-T09 — Turn on the invariant checker's settlement-membership class

**Task ID:** `P10-T09`
**Feature:** Invariant checker
**Commit:** `feat(cli): enable settlement-membership class in flowledger verify`
**Priority:** Critical
**Dependencies:** `P10-T05`
**Estimated complexity:** M
**Contract references:** `docs/09` §Continuous invariant checker (class "Settlement membership"), §Stop conditions; `docs/10` M3 bullet (classes turned on per milestone), M10 bullet "Turn on the invariant checker's settlement-membership class", acceptance "a seeded mismatch is caught" and "`flowledger verify` reports zero findings across every assertion class".
**Files:** create: `test/integration/verify/settlement-membership.test.ts`; modify: `packages/database/src/verify/classes/recovery.ts` (the P03-T13 `settlement_membership` `SqlVerifyClass`), `packages/testkit/src/ledger-corruption.ts`; must not touch: other classes' queries, `packages/database/src/verify/index.ts` report format.

**Objective** — P03-T13 already defines `settlement_membership` (rules `DUPLICATE_MEMBERSHIP`, `BATCH_NET_MISMATCH`, `MEMBER_COUNT_MISMATCH`, `BATCH_POSTING_MISMATCH`), skipped as `TABLE_ABSENT` until now; prove it against the real P10 tables and extend its `findingsSql` with the remaining rules (F3 type/key, F5–F8) so the class has real assertions so any double-settled movement or batch/member amount mismatch is reported as a nonzero finding that fails the build.

**Implementation instructions**
1. Run as the role P03's `verify` uses. Findings (each query returns offending rows; `checked` = number of batches + members examined):
   - F1 movement in > 1 batch: `SELECT movement_transaction_id FROM settlement.batch_members GROUP BY 1 HAVING count(*) > 1`.
   - F2 batch net ≠ recomputed net from members' merchant-clearing entries (join members → journal_entries on the batch merchant's clearing account).
   - F3 batch net ≠ amount of the batch journal transaction's clearing DEBIT or payable CREDIT, or that transaction is not `SETTLEMENT`, or its posting key ≠ batch `posting_key`.
   - F4 `member_count` ≠ count of member rows.
   - F5 member `movement_kind` ≠ journal `operation_type`, member merchant ≠ batch merchant, or movement `recorded_at >= batch.cutoff_at`.
   - F6 `clearing_delta_minor` ≠ entry-derived delta for that movement.
   - F7 `SETTLEMENT` journal transaction without exactly one batch.
   - F8 `POSTED` run whose batch is missing, or `DEFERRED` run with `net_amount_minor > 0`.
2. Output: unchanged P03 `ClassResult` (`name: 'settlement_membership'`, `status`, `rowsChecked`, `findings`, samples) — F1, F2, F4 and the amount part of F3 reuse P03's existing rule names; new rules get new `rule` values (`BATCH_POSTING_TYPE_OR_KEY_MISMATCH`, `MEMBER_ATTRIBUTE_MISMATCH`, `MEMBER_DELTA_MISMATCH`, `SETTLEMENT_TRANSACTION_WITHOUT_BATCH`, `RUN_BATCH_MISMATCH`); add `settlement.runs` and `ledger.journal_transactions` to `requiredTables`.

**Expected behavior** — Clean populated database → `findings: 0`, `checked > 0`. Each corrupted fixture → that finding nonzero and `flowledger verify` exits non-zero.

**Acceptance criteria**
- [ ] Clean run after P10-T05 scenarios reports `checked > 0`, `findings = 0`.
- [ ] Corrupted fixtures F1–F8 each produce ≥ 1 finding in this class only (other classes unaffected unless the corruption inherently breaks them, e.g. F3 may also break journal balance — assert the settlement class detects it regardless).
- [ ] CLI exits with the P03 nonzero code on any finding.

**Testing requirements** — `test/integration/verify/settlement-membership.test.ts`: corruption is applied as the container superuser with `SET session_replication_role = replica` (bypasses immutability triggers and FKs) inside the test only. Cases `clean database zero findings`, `F1 duplicate membership` (drop unique index in fixture db first), `F2 batch net tampered`, `F3 batch journal amount mismatch`, `F4 member count tampered`, `F5 member after cutoff`, `F6 delta tampered`, `F7 orphan SETTLEMENT transaction`, `F8 POSTED run without batch`. Command: `pnpm vitest run --project integration test/integration/verify/settlement-membership.test.ts`, then `pnpm verify:ledger` against the integration DB.

**Non-goals** — No metric export (P11).

**Handoff checklist**
- [ ] No class reports "0 rows checked" on a populated database any more (`docs/10` line 476).
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P10-T09`.

---

### P10-T10 — Payment timeline `SETTLEMENT` entry

**Task ID:** `P10-T10`
**Feature:** Payment timeline
**Commit:** `feat(api): add SETTLEMENT entries to the payment timeline`
**Priority:** High
**Dependencies:** `P10-T05`
**Estimated complexity:** M
**Contract references:** `docs/05` §Retrieve a payment timeline (rules, line 358), §Settlement surface (line 685); `openapi/openapi.yaml` `PaymentTimelineEntry` (lines 1260–1306); `docs/07` §Tenant isolation item 8; `docs/00` §Deferred (settlement list endpoint).
**Files:** create: `migrations/1040_settlement_merchant_view.sql`, `test/integration/api/timeline-settlement.test.ts`; modify: `packages/contracts/src/timeline-detail.ts` (add the `SETTLEMENT` entry to `TIMELINE_DETAIL_SCHEMAS`), `packages/contracts/src/timeline-detail.test.ts`; must not touch: `openapi/openapi.yaml`.

**Objective** — Show a merchant, on its own payment's timeline, that a capture/refund movement settled, without exposing ledger accounts, other tenants, or batch totals spanning other payments.

**Implementation instructions**
1. Migration: `CREATE VIEW settlement.merchant_batch_members WITH (security_barrier) AS SELECT m.merchant_id, m.batch_id, m.movement_transaction_id, m.movement_kind, jt.payment_id, jt.payment_operation_id, b.posted_at FROM settlement.batch_members m JOIN settlement.batches b ON b.merchant_id = m.merchant_id AND b.id = m.batch_id JOIN ledger.journal_transactions jt ON jt.id = m.movement_transaction_id WHERE m.merchant_id = current_setting('app.merchant_id', true);` Owner `fl_migration_owner`. If `settlement.batch_members`/`batches`/`ledger.journal_transactions` have `FORCE ROW LEVEL SECURITY` (`pg_class.relforcerowsecurity`), add `FOR SELECT TO fl_migration_owner USING (true)` policies. Same migration: `CREATE OR REPLACE FUNCTION payments.payment_timeline(p_payment_id text)` (identical signature, owner, and every existing branch from the latest prior version) appending one `UNION ALL` branch for `SETTLEMENT` with `kind_rank = 10` (P04 fixed rank table). `REVOKE ALL ... FROM PUBLIC; GRANT SELECT ON settlement.merchant_batch_members TO fl_api, payments_function_owner;` last.
2. Timeline source: one `SETTLEMENT` entry per row of the view whose `payment_id` = the requested payment. `occurredAt = posted_at` (database time); `operationId = payment_operation_id`; `paymentVersion` = the same value the timeline assigns to the `LEDGER_POSTING` entry for that `movement_transaction_id` (settlement does not advance payment version) **[ASSUMPTION]**; ordering tiebreak follows P04's deterministic rule.
3. `detail` closed shape **[ASSUMPTION — docs/05 does not enumerate it, risk R-06]**: `{ "settlementBatchId": "sbt_…", "ledgerTransactionId": "ltx_…" (the movement), "movementKind": "CAPTURE" | "REFUND" }`. No amounts, no account IDs, no run IDs, no batch totals. Add this shape to `TIMELINE_DETAIL_SCHEMAS` in `packages/contracts/src/timeline-detail.ts` with `additionalProperties: false`.
4. Respect the existing 500-entry bound and `truncated` flag.

**Expected behavior** — After capture and settlement, the timeline contains `…, LEDGER_POSTING (CAPTURE), SETTLEMENT {settlementBatchId, ledgerTransactionId, movementKind: CAPTURE}` ordered by `posted_at`. Before settlement there is no SETTLEMENT entry. A late refund that is later settled in a second batch yields a second SETTLEMENT entry with `movementKind: REFUND` and a different batch ID.

**Acceptance criteria**
- [ ] SETTLEMENT entries appear only after a batch closes over the movement.
- [ ] Merchant B requesting merchant A's payment timeline gets `404 RESOURCE_NOT_FOUND`; merchant B's DB session reading the view sees zero of A's rows.
- [ ] `detail` contains exactly the three keys; snapshot scan finds no prohibited fixture, no `lac_` ID, no `netAmountMinor`.
- [ ] Response validates against `PaymentTimeline` in openapi and the semantic probe.

**Testing requirements** — `test/integration/api/timeline-settlement.test.ts` cases: `no SETTLEMENT before batch`, `SETTLEMENT after batch with exact detail`, `late refund settled in second batch has REFUND entry`, `ordering by posted_at`, `cross-tenant 404`, `view returns nothing without app.merchant_id`, `detail redaction scan`. Contract probe update in P04's timeline contract test. Commands: `pnpm test:contracts`, `pnpm vitest run --project integration test/integration/api/timeline-settlement.test.ts`.

**Non-goals** — No merchant settlement list endpoint or settlement webhook (deferred, `docs/00` §Deferred).

**Handoff checklist**
- [ ] Risk R-06 resolution recorded unchanged or updated.
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P10-T10`.

---

### P10-T11 — Append-only operator audit table

**Task ID:** `P10-T11`
**Feature:** Operator audit
**Commit:** `feat(security): add append-only operator action audit table`
**Priority:** Critical
**Dependencies:** `P08-GATE`, `P09-GATE`
**Estimated complexity:** M
**Contract references:** `docs/08` §Recovery axioms 10, §Manual review contract (line 268), §Operator authority (line 639); `docs/10` M11 bullet "Record every privileged operator command with actor, reason, evidence references, before/after state identifiers and versions, database time, correlation ID, and resulting event IDs, in an append-only audit table" (line 492); `docs/07` §Schemas (`audit`), §Mutability rules (append-only), §Retention (lifetime records).
**Files:** create: `migrations/1050_audit_operator_actions.sql`, `packages/database/src/functions/audit.ts`, `test/integration/audit/operator-actions.test.ts`; modify: none; must not touch: P11 files.

**Objective** — P10's recovery commands are the first privileged operator commands, and `docs/08` requires each to be audited, so the audit table lands here rather than in P11 (risk R-04). Every operator command function calls one internal append function; no role can update or delete audit rows.

**Implementation instructions**
1. Table:
   ```sql
   CREATE TABLE audit.operator_actions (
     id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     actor text NOT NULL CHECK (actor ~ '^[A-Za-z0-9._@-]{3,128}$'),
     command text NOT NULL CHECK (command ~ '^[a-z]+(\.[a-z_]+)+$'),
     reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
     evidence_refs text[] NOT NULL DEFAULT '{}',
     subject_type text NOT NULL,
     subject_id text NOT NULL,
     merchant_id text COLLATE "C" REFERENCES identity.merchants (id),
     before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
     after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state) = 'object'),
     outcome text NOT NULL CHECK (outcome IN ('APPLIED','SKIPPED')),
     correlation_id text NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{16,128}$'),
     resulting_event_ids uuid[] NOT NULL DEFAULT '{}',
     recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
   );
   CREATE INDEX operator_actions_subject ON audit.operator_actions (subject_type, subject_id, recorded_at);
   CREATE INDEX operator_actions_actor ON audit.operator_actions (actor, recorded_at);
   ```
   `before_state`/`after_state` hold identifiers, statuses, and versions only (e.g. `{"status":"REQUIRES_REVIEW","caseVersion":4}`), never payloads.
2. Trigger `audit.reject_mutation()` on `UPDATE`, `DELETE` (row) and `TRUNCATE` (statement) → `P0001` `AUDIT_IMMUTABLE`, enabled for the owner too.
3. `audit.record_operator_action(p_actor text, p_command text, p_reason text, p_evidence_refs text[], p_subject_type text, p_subject_id text, p_merchant_id text, p_before jsonb, p_after jsonb, p_outcome text, p_correlation_id text, p_resulting_event_ids uuid[]) RETURNS bigint` — `SECURITY DEFINER`, owner `audit_function_owner`, fixed `search_path`, inserts one row, returns its ID. `EXECUTE` is granted **only** to the function-owner roles that own operator command functions: `payments_function_owner`, `ledger_function_owner`, `settlement_function_owner`, `messaging_function_owner`, `reconciliation_function_owner`, `webhooks_function_owner`. No login role can call it directly, so audit rows exist only as a side effect of an operator command.
4. Grants last: `REVOKE ALL ON audit.operator_actions FROM PUBLIC` and every runtime role; `GRANT INSERT, SELECT ON audit.operator_actions TO audit_function_owner`. Operator read access arrives with P11 views. RLS is not enabled (operator-only table, never granted to merchant roles).
5. TS: `packages/database/src/functions/audit.ts` exports the row type `OperatorAction` and `listOperatorActionsForSubject(client, subjectType, subjectId)` used by tests (runs as migration owner in tests only).

**Expected behavior** — Inserting via a test function owned by `messaging_function_owner` that calls `audit.record_operator_action` succeeds; any direct `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` by any runtime role fails; owner `UPDATE` fails with `AUDIT_IMMUTABLE`.

**Acceptance criteria**
- [ ] All column checks reject invalid values (short reason, bad actor, bad correlation ID, non-object state).
- [ ] Every CONVENTIONS §7 login role: direct DML and `EXECUTE` on `record_operator_action` denied (`42501`).
- [ ] `UPDATE`/`DELETE`/`TRUNCATE` as `fl_migration_owner` fail with `AUDIT_IMMUTABLE`.

**Testing requirements** — `test/integration/audit/operator-actions.test.ts` cases: `append via function-owner path`, `rejects invalid columns` (4 variants), `runtime roles cannot write or execute`, `owner cannot mutate`. Command: `pnpm vitest run --project integration test/integration/audit/operator-actions.test.ts`.

**Non-goals** — No authentication of the actor (P11-T03 binds `actor` to an MFA-verified principal); no operator views.

**Handoff checklist**
- [ ] Grants last in migration.
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P10-T11`.

---

### P10-T12 — Operator commands: republish outbox envelope and replay nonfinancial DLQ message

**Task ID:** `P10-T12`
**Feature:** Operator recovery commands
**Commit:** `feat(cli): add audited outbox republish and DLQ replay operator commands`
**Priority:** High
**Dependencies:** `P10-T11`
**Estimated complexity:** M
**Contract references:** `docs/08` §Transactional outbox crash points, §Message acknowledgement and DLQ, §DLQ contract, §Runbook: outbox or subscriber backlog (safe action), §Runbook: provider execution command in DLQ (state table), §Manual review contract; `docs/07` `messaging.outbox_messages` mutability (line 1086), `messaging.dead_letter_records`, `messaging.dead_letter_replays`; `docs/04` §Transactional outbox; `docs/10` M10 bullet "safe commands" (line 461).
**Files:** create: `migrations/1060_operator_messaging_commands.sql`, `packages/database/src/functions/operator.ts`, `apps/cli/src/commands/ops/outbox-republish.ts`, `apps/cli/src/commands/ops/dlq-replay.ts`, `test/integration/operator/messaging-commands.test.ts`; modify: `apps/cli/src/main.ts` (register `ops` subcommands), `packages/config/src/cli.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: relay code, `messaging.record_dead_letter_replay` body, the P09 state-table logic (import it; refactor only to export it if P09 did not).

**Objective** — Give operators two audited, safe commands: republish an outbox envelope under its original UUID, and replay a dead-lettered message through the P09 state-aware replay path, each leaving one `audit.operator_actions` row.

**Implementation instructions**
1. `messaging.operator_republish_outbox(p_envelope_id uuid, p_actor text, p_reason text, p_evidence_refs text[], p_correlation_id text) RETURNS TABLE (result text, audit_id text, envelope jsonb)` — `SECURITY DEFINER`, owner `messaging_function_owner`, `session_user = 'fl_operator_command'` check. Lock the row `FOR UPDATE`; not found → `RESOURCE_NOT_FOUND`. If the row is unpublished with a live lease (`lease_expires_at > clock_timestamp()`) → return `'SKIPPED_LEASED'`, audit `SKIPPED`. `published_at` is set-once (P02-T12 `outbox_messages_guard`), so it is never cleared. Unpublished row: set `available_at = clock_timestamp(), lease_token = NULL, lease_expires_at = NULL` (mutable fields only) so the relay picks it up; return `'REPUBLISH_SCHEDULED'`. Published row: change nothing and return `'REPUBLISH_DIRECT'`; the CLI then publishes the stored `envelope` unchanged (same UUID) via `Transport.publish(topicForKind(kind), envelope, envelope.orderingKey)` and prints the returned broker message ID. Envelope, `envelope_id`, and hash never change; if `envelope IS NULL` (archived — impossible in MVP) → refusal `OUTBOX_ENVELOPE_ARCHIVED`. Audit (before returning): command `outbox.republish`, subject `outbox_message`/envelope UUID, before `{publishedAt, publicationAttempts}`, after `{availableAt, mode}`, `resulting_event_ids = {p_envelope_id}`. (`envelope` non-null only for `REPUBLISH_DIRECT`.)
2. `messaging.operator_replay_dead_letter(p_dead_letter_id bigint, p_actor text, p_reason text, p_evidence_refs text[], p_correlation_id text, p_outcome text, p_broker_message_id text, p_error_class text, p_resolve boolean) RETURNS text` — same security pattern; an audited wrapper, not a second replay implementation. The CLI first runs P09's state-table/publish logic (exported from `apps/cli/src/commands/dlq.ts`, P09-T13; the `docs/08` execution-command table is applied there only), then records the result by calling this function, which calls `messaging.record_dead_letter_replay(p_dead_letter_id, p_actor, p_reason, p_outcome, p_broker_message_id, p_error_class, p_resolve)` (P09, writes `messaging.dead_letter_replays`) and writes the audit row in the same transaction, returning `p_outcome` (`PUBLISHED`, `SKIPPED_TERMINAL`, `FAILED`). Grant `messaging_function_owner` nothing new (it owns both). Refuse a DLQ record whose `failure_class` is invariant conflict without at least one `p_evidence_refs` entry (`docs/08` "Invariant conflicts require investigation before replay") → `OPERATOR_EVIDENCE_REQUIRED`. Audit command `dlq.replay`, subject `dead_letter`/ID, before `{resolvedAt, attemptCount}`, after `{outcome}`. 
3. Grants last: `EXECUTE` on both to `fl_operator_command` only; `GRANT EXECUTE ON FUNCTION audit.record_operator_action(...)` already covers `messaging_function_owner` (P10-T11).
4. CLI (config `OPERATOR_COMMAND_DATABASE_URL`, role `fl_operator_command`): `flowledger ops outbox republish --envelope <uuid> --actor <principal> --reason <text> [--evidence <ref>]... [--correlation-id <id>]` and `flowledger ops dlq replay --dead-letter <id> --actor ... --reason ... [--evidence ...]`. Missing `--actor`/`--reason` → exit 2 with usage. Correlation ID default `ops:` + `randomUUID()`. Output one JSON line `{ "command", "result", "auditId" }` (plus `brokerMessageId` for `REPUBLISH_DIRECT`). The republish CLI also reads the transport config (`PUBSUB_EMULATOR_HOST`/project) used by the relay. Errors print `DomainError.code` only.
5. TS wrappers `operatorRepublishOutbox(...)`, `operatorReplayDeadLetter(...)` in `packages/database/src/functions/operator.ts`.

**Expected behavior** — Republishing a published `payment.capture.succeeded.v1` row publishes the same envelope UUID again (CLI direct publish; `published_at` unchanged); consumers' inbox rows prevent a second effect. Replaying a DLQ'd `merchant.webhook.deliver.v1` publishes it once; replaying a DLQ'd execution command for a `SUCCEEDED` operation returns `SKIPPED_TERMINAL` with no provider call.

**Acceptance criteria**
- [ ] Republish preserves `envelope_id`, `envelope`, `envelope_hash` byte-for-byte; the same UUID is published again (relay for an unpublished row, CLI direct publish for a published row) and `published_at` is never cleared; consumer effect count stays 1.
- [ ] Live-leased row → `SKIPPED_LEASED`, audit `SKIPPED`.
- [ ] Each successful command writes exactly one audit row with all fields populated; a failed command (exception) writes none.
- [ ] Invariant-conflict DLQ replay without evidence refused.
- [ ] `fl_api`, `fl_operator_readonly`, and every worker role get `42501` on both functions.

**Testing requirements** — `test/integration/operator/messaging-commands.test.ts`: `republish published envelope same uuid (direct publish, published_at unchanged)`, `republish unpublished row scheduled`, `republish leased row skipped`, `republish unknown uuid not found`, `consumer dedupes republished envelope` (in-memory transport + inbox), `dlq replay nonfinancial publishes`, `dlq replay execution command terminal skipped`, `invariant conflict needs evidence`, `audit row per command`, `role denial`. CLI unit test `apps/cli/src/commands/ops/outbox-republish.test.ts` for argument validation. Commands: `pnpm test:unit`, `pnpm vitest run --project integration test/integration/operator/messaging-commands.test.ts`.

**Non-goals** — No operator authentication (P11-T03); no HTTP surface.

**Handoff checklist**
- [ ] `.env.example`/`docs/CONFIG.md` include `OPERATOR_COMMAND_DATABASE_URL`.
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P10-T12`.

---

### P10-T13 — Operator commands: reschedule reconciliation, trigger settlement run, inspect evidence

**Task ID:** `P10-T13`
**Feature:** Operator recovery commands
**Commit:** `feat(cli): add reconciliation reschedule, settlement trigger, and evidence inspection commands`
**Priority:** High
**Dependencies:** `P10-T07`, `P10-T11`
**Estimated complexity:** M
**Contract references:** `docs/08` §Manual review contract (may/may not lists), §Runbook: `UNKNOWN` operation, §Runbook: stalled or deferring settlement; `docs/03` line 354; `docs/07` `reconciliation.cases`/`case_activity`, `providers.provider_evidence`, `settlement.runs`; `docs/02` §MVP decisions "Settlement schedule … may also be triggered by an audited operator command"; `docs/06` §Redaction and retained evidence.
**Files:** create: `migrations/1070_operator_recovery_commands.sql`, `apps/cli/src/commands/ops/reconciliation-reschedule.ts`, `apps/cli/src/commands/ops/settlement-trigger.ts`, `apps/cli/src/commands/ops/evidence-inspect.ts`, `test/integration/operator/recovery-commands.test.ts`; modify: `packages/database/src/functions/operator.ts`, `apps/cli/src/main.ts`, `packages/config/src/cli.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: reconciler code, `settlement.post_batch`.

**Objective** — Let an operator trigger another read-only lookup for a case, request an immediate settlement run for one merchant, and read redacted evidence — all audited (writes) or read-only (inspection) — without any path that changes payment state, totals, journal rows, or reservations.

**Implementation instructions**
1. `reconciliation.operator_reschedule_case(p_case_id text, p_actor text, p_reason text, p_evidence_refs text[], p_correlation_id text) RETURNS text` — owner `reconciliation_function_owner`, `session_user = 'fl_operator_command'`. Lock case `FOR UPDATE`. Status `OPEN`/`SCHEDULED` → set `next_check_at = clock_timestamp()`, `version = version + 1`, `updated_at`. Status `REQUIRES_REVIEW` → set `status = 'SCHEDULED'`, `next_check_at = clock_timestamp()`, `version + 1` (the operation stays `REQUIRES_REVIEW`; only the reconciler's normal evidence path can change it). `IN_PROGRESS` with live lease → `'SKIPPED_IN_PROGRESS'`. `RESOLVED`/`DISMISSED` → `'SKIPPED_TERMINAL'`. Append `reconciliation.case_activity` (`activity_type='SCHEDULED'`, `actor_type='OPERATOR'`, `actor_id=p_actor`, `detail={"reason":…}`). Audit `reconciliation.reschedule`, before/after `{status, version, nextCheckAt}`. The function MUST NOT touch `payments.*`. If P08's phase file already provides an operator reschedule function, wrap it instead of re-implementing steps above, keeping this name and the audit call.
2. `settlement.operator_request_run(p_run_id text, p_merchant_id text, p_actor text, p_reason text, p_correlation_id text) RETURNS text` — owner `settlement_function_owner`, `session_user = 'fl_operator_command'`. Same insert as `settlement.schedule_run` (unleased `CLAIMED`, ignores the interval). Existing `CLAIMED` run → return `'SKIPPED_ALREADY_CLAIMED'`. Audit `settlement.trigger`, subject `merchant`/ID, after `{runId}`. The settlement worker leases and posts it on its next tick; operators can never post, mark settled, or edit membership.
3. `providers.operator_evidence` view (`security_barrier`, owner `fl_migration_owner`): columns from `providers.provider_evidence` restricted to the `docs/06` §Redaction allowlist (evidence ID, merchant ID, operation ID, payment ID, provider name, provider account ID, source, normalized outcome/status/code, opaque provider references, observed/received/recorded timestamps, evidence digest/reference, applied state). Never raw bodies or quarantine references. `GRANT SELECT TO fl_operator_readonly`. (P11-T04 adds the authenticated-principal filter.)
4. CLI: `flowledger ops reconciliation reschedule --case <case_id> --actor --reason [--evidence]...`; `flowledger ops settlement trigger --merchant <mer_id> --actor --reason` (generates `newId('srn')`); `flowledger ops evidence inspect --operation <op_id>` using `OPERATOR_READONLY_DATABASE_URL` (role `fl_operator_readonly`), printing JSON rows passed through the redaction allowlist.
5. Grants last; `EXECUTE` to `fl_operator_command` only.

**Expected behavior** — Rescheduling a `REQUIRES_REVIEW` case makes the reconciler perform one more read-only lookup; with inconclusive evidence the case returns to `REQUIRES_REVIEW` (P08 policy) and the payment/operation versions are unchanged by the command itself. Triggering settlement for a merchant inside its interval produces a batch on the next worker tick.

**Acceptance criteria**
- [ ] Reschedule changes only the case (status/next_check_at/version) and appends activity + audit; `payments.payments.version` and `payment_operations.version` unchanged.
- [ ] Terminal case → `SKIPPED_TERMINAL`, audit `SKIPPED`, no activity row.
- [ ] Trigger inside the interval creates exactly one unleased `CLAIMED` run; second trigger → `SKIPPED_ALREADY_CLAIMED`; next `runTick` posts or defers it.
- [ ] Evidence inspection output contains no prohibited fixture and no column outside the allowlist (assert exact column set).
- [ ] No operator function grants a path to update journal, payment totals, operation status, reservations, or settlement membership (test attempts each via every operator role → `42501`).

**Testing requirements** — `test/integration/operator/recovery-commands.test.ts`: `reschedule scheduled case`, `reschedule review case runs one more lookup and keeps operation in review` (fake provider configured inconclusive), `reschedule terminal skipped`, `reschedule leaves payment and operation versions`, `trigger creates claimed run`, `trigger twice skipped`, `triggered run posts on next tick`, `evidence view exact columns`, `evidence output redacted`, `operator roles cannot mutate financial tables`. Commands: `pnpm test:unit`, `pnpm vitest run --project integration test/integration/operator/recovery-commands.test.ts`.

**Non-goals** — No state-edit command of any kind (`docs/10` §non-goals "custom operator mutation UI"); no lookup executed synchronously by the CLI.

**Handoff checklist**
- [ ] `OPERATOR_READONLY_DATABASE_URL` documented.
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P10-T13`.

---

### P10-T14 — Two-principal compensating ledger correction workflow

**Task ID:** `P10-T14`
**Feature:** Ledger corrections
**Commit:** `feat(ledger): add named two-principal correction request and approval commands`
**Priority:** High
**Dependencies:** `P10-T11`
**Estimated complexity:** M
**Contract references:** `docs/07` §`ledger.correction_requests` (lines 911–932), §Protected posting function (line 938); `docs/02` §Reversals and adjustments, §MVP implementation decisions "Closed-account corrections"; `docs/08` §Operator authority (line 639), §Runbook: ledger or payment discrepancy; `docs/10` line 462 vs line 501 (risk R-07).
**Files:** create: `migrations/1080_ledger_correction_audit.sql`, `apps/cli/src/commands/ops/correction.ts`, `test/integration/ledger/correction-workflow.test.ts`; modify: `packages/database/src/functions/ledger.ts` (add wrappers), `apps/cli/src/main.ts`, `packages/config/src/cli.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `ledger.post_approved_correction` body.

**Objective** — Implement the operator workflow that drives the existing correction table: one named operator requests a full reversal or adjustment, a **different** named operator approves or rejects it, and the `fl_correction` role executes it through `ledger.post_approved_correction`. This follows the recommended resolution of risk R-07: the database-enforced distinct-principal rule is kept, and what remains deferred is approver-tier separation, approval expiry, and notification.

**Implementation instructions**
1. Do not redefine the P03-T09 functions (same names with other signatures would create overloads). Reuse them exactly, all executable only by `fl_correction` via `CORRECTION_DATABASE_URL`: `ledger.request_correction(p_request_id text, p_merchant_id text, p_canonical_request jsonb, p_reason text, p_requested_by text) RETURNS bytea`, `ledger.decide_correction(p_request_id text, p_decision text, p_decided_by text, p_expected_request_hash bytea) RETURNS text` (rejects `p_decided_by = requested_by` with `LEDGER_CORRECTION_REJECTED` rule `SAME_PRINCIPAL`), and `ledger.post_approved_correction(...)`. The CLI builds `p_canonical_request` (`FULL_REVERSAL` with target, or `ADJUSTMENT` entries) and passes the operator identity as `p_requested_by`/`p_decided_by`.
2. Migration `1080`: `ledger.record_correction_audit(p_request_id text, p_step text, p_actor text, p_correlation_id text) RETURNS bigint` — owner `ledger_function_owner`, `SECURITY DEFINER`, EXECUTE `fl_correction` only. `p_step IN ('REQUEST','DECIDE','EXECUTE')`; requires the request row to be in the state that step produces (`PENDING`; `APPROVED`/`REJECTED`; `EXECUTED`) and `p_actor` to equal `requested_by` (REQUEST), `approved_by` (DECIDE), or be non-empty (EXECUTE); writes one audit row via `audit.record_operator_action` with command `ledger.correction_request` / `ledger.correction_decide` / `ledger.correction_execute`; for EXECUTE `resulting_event_ids` = the ledger event UUID of `executed_transaction_id`.
3. The CLI calls each P03 function and `record_correction_audit` inside one `withTransaction` on `CORRECTION_DATABASE_URL`, so each step and its audit row commit together.
4. Wrappers: add `recordCorrectionAudit` to `packages/database/src/functions/ledger.ts` (P03 already provides `requestCorrection`, `decideCorrection`, `postApprovedCorrection`).
5. CLI: `flowledger ops correction request --type FULL_REVERSAL --target <ltx> --merchant <mer> --reason ... --actor ...`; `... correction approve|reject --request <lcr> --actor ... --reason ...`; `... correction execute --request <lcr> --actor ...`. The `lcr_` prefix must exist in `schemas/common/entity-ids.v1.schema.json`; it is absent today (risk R-10) — use P03's resolution (P03 owns the prefix); if P03 left it unresolved, stop with `BLOCKED: P10-T14 — lcr_ prefix missing from entity-ids registry`.

**Expected behavior** — alice requests reversal of `ltx_X`; alice approving → `LEDGER_CORRECTION_REJECTED` (rule `SAME_PRINCIPAL`); bob approves; `execute` posts one reversal (original + reversal net to zero per account), request `EXECUTED`, three audit rows (request, decide, execute). A second request for `ltx_X` is rejected.

**Acceptance criteria**
- [ ] Same-principal approval rejected by the function and by the table check.
- [ ] Execution of a `PENDING` or `REJECTED` request fails inside `post_approved_correction`.
- [ ] Executed reversal nets to zero per account (`flowledger verify` zero findings).
- [ ] Each step writes exactly one audit row; execution and its audit row commit atomically (fault injected between them leaves neither).
- [ ] Concurrent approvals by two different principals: exactly one succeeds.

**Testing requirements** — `test/integration/ledger/correction-workflow.test.ts`: `request full reversal`, `same principal cannot approve`, `table check rejects same principal`, `different principal approves`, `execute posts reversal netting to zero`, `cannot execute pending or rejected`, `duplicate live request for target rejected`, `concurrent approvals one wins`, `execution and audit are atomic`, `fl_operator_command cannot call post_approved_correction` (`42501`). Command: `pnpm vitest run --project integration test/integration/ledger/correction-workflow.test.ts`.

**Non-goals** — No approver role tier, approval expiry, or notifications (documented in P11 `docs/KNOWN_LIMITS.md`); no platform-only corrections (`docs/07` line 918).

**Handoff checklist**
- [ ] Risk R-07 resolution text matches the implementation.
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P10-T14`.

---

### P10-T15 — Runbooks: stalled/deferring settlement and ledger/payment discrepancy

**Task ID:** `P10-T15`
**Feature:** Recovery runbooks
**Commit:** `docs(runbooks): add executable settlement and discrepancy runbooks`
**Priority:** High
**Dependencies:** `P10-T09`, `P10-T13`, `P10-T14`
**Estimated complexity:** M
**Contract references:** `docs/08` §Runbook: stalled or deferring settlement (lines 434–460), §Runbook: ledger or payment discrepancy (lines 462–491), §Recovery observability, §Recovery objectives and alerts (settlement and negative-clearing rows); `docs/10` M10 acceptance "Each runbook has a reproducible setup, expected queries/metrics, safe action, and exit check".
**Files:** create: `docs/runbooks/README.md`, `docs/runbooks/stalled-or-deferring-settlement.md`, `docs/runbooks/ledger-or-payment-discrepancy.md`, `test/e2e/runbooks/runbook-sql.ts`, `test/e2e/runbooks/stalled-or-deferring-settlement.test.ts`, `test/e2e/runbooks/ledger-or-payment-discrepancy.test.ts`; modify: none; must not touch: `docs/08`.

**Objective** — Turn the two ledger-side runbooks into documents whose SQL is executed verbatim by automated tests, so each runbook is proven to detect, diagnose, act safely, and exit.

**Implementation instructions**
1. Runbook document template (`docs/runbooks/README.md` defines it; every runbook uses it): `## Signals` (the `docs/08` metric names that will alert — implemented in P11 — and the alert threshold row), `## Reproduce` (exact commands/fixtures to create the condition locally), `## Detect` (SQL blocks), `## Check` (numbered SQL blocks mirroring `docs/08` §Checks), `## Safe action` (exact CLI command(s) or "no action — sweeper owns it"), `## Forbidden actions` (from `docs/08` §Manual review contract), `## Exit check` (SQL blocks that must return the stated result), `## Automated test` (test file path). Every SQL block starts with a line comment `-- id: <kebab-name>` and is read-only.
2. `test/e2e/runbooks/runbook-sql.ts` exports `loadRunbookSql(file: string): Map<string, string>` — parses fenced `sql` blocks and keys them by `-- id:`; throws on duplicate or missing IDs. Tests use only SQL loaded from the markdown (guarantees doc/test parity).
3. Settlement runbook scenarios (three tests): (a) stale claim — worker killed after claim; detect `-- id: stale-claimed-runs` (`CLAIMED` with `lease_expires_at < now() - interval`), safe action = wait for sweeper or `flowledger ops settlement trigger` after sweep, exit `-- id: batch-posted-for-eligible` returns ≥1 row and `-- id: clearing-payable-rebuild` returns zero mismatches; (b) negative net deferral — late refund after settlement; checks `-- id: eligible-net-independent` (net recomputed from entries), `-- id: refunds-causing-negative` (refund movements whose capture has membership), `-- id: no-batch-for-eligible`; safe action = none / escalate; exit: runs `DEFERRED` with `net <= 0` and rebuild matches; (c) unsettled positive net — a `DEFERRED` run with positive net is impossible by the run check, so the runbook's "repeated deferral with a positive net" signal is detected as eligible movements older than 4 intervals whose independent net is positive: query `-- id: stale-positive-eligible-net` returns zero rows while the worker runs and returns the merchant after the worker is stopped for > 4 intervals (`SETTLEMENT_INTERVAL_SECONDS=1`); safe action documented as "stop the worker for that merchant and investigate selection before posting"; exit = worker restarted, batch posted, query returns zero rows.
4. Discrepancy runbook scenarios (two tests): (a) projection corruption — superuser replica-mode edit of one `account_balances` row; detect via `flowledger verify` projection class and `-- id: projection-vs-rebuild`; safe action = the P03 balance rebuild tooling command (from P03 interfaces); exit = verify zero findings; (b) genuine business correction — a deliberately wrong-but-balanced adjustment fixture posted via the correction path; safe action = `flowledger ops correction request/approve/execute` with two principals; exit = verify zero findings and original transaction unchanged (`-- id: original-unchanged` compares stored hash).
5. Tests run against the e2e stack (API + workers + settlement worker + fake provider).

**Expected behavior** — Each test reproduces the condition, runs the runbook's detect/check queries with expected results, performs the safe action, and passes the exit check.

**Acceptance criteria**
- [ ] Both runbooks contain every section of the template and cite their `docs/08` section.
- [ ] Every SQL block in both files is executed by a test (test asserts the set of executed IDs equals the set parsed).
- [ ] Five scenarios pass; none uses a direct DML outside the documented reproduction step.

**Testing requirements** — Files above; cases named after scenarios. Command: `pnpm vitest run --project e2e test/e2e/runbooks/stalled-or-deferring-settlement.test.ts test/e2e/runbooks/ledger-or-payment-discrepancy.test.ts`.

**Non-goals** — No alert wiring (P11-T13 links alerts to these files).

**Handoff checklist**
- [ ] `loadRunbookSql` unit-tested in `test/e2e/runbooks/runbook-sql.test.ts` (duplicate/missing ID).
- [ ] `pnpm test:e2e` green; `Task: P10-T15`.

---

### P10-T16 — Runbooks: stale `REQUESTED`, stale `PROCESSING`, `UNKNOWN` operation

**Task ID:** `P10-T16`
**Feature:** Recovery runbooks
**Commit:** `docs(runbooks): add executable operation-recovery runbooks`
**Priority:** High
**Dependencies:** `P10-T15`, `P10-T12`, `P10-T13`
**Estimated complexity:** L
**Contract references:** `docs/08` §Runbook: stale `REQUESTED` operation, §Runbook: stale `PROCESSING` operation, §Runbook: `UNKNOWN` operation, §Worker claim and provider dispatch crash points, §No-blind-retry rule, §Recovery objectives and alerts rows 1–4.
**Files:** create: `docs/runbooks/stale-requested-operation.md`, `docs/runbooks/stale-processing-operation.md`, `docs/runbooks/unknown-operation.md`, `test/e2e/runbooks/stale-requested-operation.test.ts`, `test/e2e/runbooks/stale-processing-operation.test.ts`, `test/e2e/runbooks/unknown-operation.test.ts`; modify: none; must not touch: worker code.

**Objective** — Execute the three operation-recovery runbooks against the deterministic fake and the unreliable simulator, proving the documented checks find the condition and the safe actions converge without a blind retry or replacement operation.

**Implementation instructions**
1. Use the P10-T15 template and `loadRunbookSql`.
2. Stale `REQUESTED`: reproduce by accepting a capture with the relay stopped (outbox row unpublished); checks `-- id: requested-no-lease`, `-- id: no-dispatch-mark`, `-- id: outbox-and-dlq-by-operation`; safe action `flowledger ops outbox republish --envelope <execute envelope id>`; exit `-- id: operation-progressed` (status in `PROCESSING`/terminal/`UNKNOWN` or bounded `not_before`). Assert operation count and provider idempotency key unchanged.
3. Stale `PROCESSING`: two variants with the unreliable simulator and P06/P08 crash hooks — (a) killed before `dispatchMarkedAt` → sweeper reclaims same operation (exit: same `op_`, same provider key, attempt `ABANDONED` + new attempt); (b) killed after dispatch mark → sweeper moves to `UNKNOWN` and a case exists (exit: `-- id: unknown-has-case`). Safe action: none (sweeper owns it); document the manual check queries.
4. `UNKNOWN`: provider commit followed by timeout on the unreliable simulator; checks `-- id: binding-and-key`, `-- id: verified-webhook-evidence`, `-- id: case-schedule`; safe action `flowledger ops reconciliation reschedule --case …`; exit: operation terminal with exactly one journal transaction for the operation (`-- id: one-posting`) and fake-provider ground truth effect count 1. Variant: inconclusive lookups exhaust → `REQUIRES_REVIEW` visible in `-- id: review-queue`.
5. Every test ends with `flowledger verify` zero findings (including the duplicate-effect class).

**Expected behavior** — All five scenarios converge to the runbook exit criteria; no new `op_` or provider key appears.

**Acceptance criteria**
- [ ] Three runbooks follow the template; all SQL blocks executed.
- [ ] Each test asserts operation-count and provider-key stability.
- [ ] `duplicate_financial_effects` class zero after each test.

**Testing requirements** — Files above. Command: `pnpm vitest run --project e2e test/e2e/runbooks/stale-requested-operation.test.ts test/e2e/runbooks/stale-processing-operation.test.ts test/e2e/runbooks/unknown-operation.test.ts`.

**Non-goals** — No new sweeper behavior; if a runbook step cannot be performed with existing commands, stop with `BLOCKED`.

**Handoff checklist**
- [ ] `pnpm test:e2e` green; `Task: P10-T16`.

---

### P10-T17 — Runbooks: provider outage/rate limiting and provider webhook incident

**Task ID:** `P10-T17`
**Feature:** Recovery runbooks
**Commit:** `docs(runbooks): add executable provider outage and webhook incident runbooks`
**Priority:** Medium
**Dependencies:** `P10-T15`, `P10-T13`
**Estimated complexity:** M
**Contract references:** `docs/08` §Runbook: provider outage or rate limiting, §Runbook: provider webhook incident, §Provider webhook ingestion crash points; `docs/06` webhook verification steps; `docs/09` §Workload profiles → Provider degradation.
**Files:** create: `docs/runbooks/provider-outage-or-rate-limiting.md`, `docs/runbooks/provider-webhook-incident.md`, `test/e2e/runbooks/provider-outage-or-rate-limiting.test.ts`, `test/e2e/runbooks/provider-webhook-incident.test.ts`; modify: none; must not touch: provider adapters.

**Objective** — Prove the provider-side runbooks with the unreliable simulator: degradation is contained per provider account and ambiguous work gets reconciliation coverage; webhook signature failures never bypass verification and gaps are filled by stored-notification replay or reconciliation.

**Implementation instructions**
1. Outage: configure the unreliable simulator for account A with rate limits and 5xx; account B healthy. Checks `-- id: pre-dispatch-vs-ambiguous` (counts of `REQUESTED` with `not_before` vs `UNKNOWN`), `-- id: affected-accounts`, `-- id: ambiguous-have-cases`. Safe action: restore simulator config (no operator write); exit: account A queue drains (`-- id: requested-age-by-account` below threshold), every `UNKNOWN` has an open case, account B throughput unaffected (completed count ≥ baseline).
2. Webhook incident: send provider webhooks signed with a rotated-out secret (signature failures, no notification rows), then fix configuration by activating the correct secret version through the P09 seed/config path; provider redelivery simulated by re-sending the same events; checks `-- id: notification-processing-state`, `-- id: unique-event-ids`; safe action: redelivery + reconciliation reschedule for operations still unresolved; exit: notifications applied once each (`-- id: applied-once`), no unresolved operation lacking a case.
3. Assert signature verification was never disabled (receiver config unchanged except secret version).

**Expected behavior** — Both scenarios meet their exit checks with zero duplicate financial effects.

**Acceptance criteria**
- [ ] Two runbooks follow the template; all SQL blocks executed.
- [ ] Healthy account B unaffected during A's outage.
- [ ] Tampered/old-secret deliveries create no notification row.

**Testing requirements** — Files above. Command: `pnpm vitest run --project e2e test/e2e/runbooks/provider-outage-or-rate-limiting.test.ts test/e2e/runbooks/provider-webhook-incident.test.ts`.

**Non-goals** — No circuit-breaker changes.

**Handoff checklist**
- [ ] `pnpm test:e2e` green; `Task: P10-T17`.

---

### P10-T18 — Runbooks: outbox/subscriber backlog and provider execution command in DLQ

**Task ID:** `P10-T18`
**Feature:** Recovery runbooks
**Commit:** `docs(runbooks): add executable messaging backlog and DLQ runbooks`
**Priority:** High
**Dependencies:** `P10-T15`, `P10-T12`
**Estimated complexity:** M
**Contract references:** `docs/08` §Runbook: outbox or subscriber backlog, §Runbook: provider execution command in DLQ (state table), §DLQ contract, §Message acknowledgement and DLQ crash points; `docs/04` §Retry and dead-letter policy.
**Files:** create: `docs/runbooks/outbox-or-subscriber-backlog.md`, `docs/runbooks/provider-execution-command-in-dlq.md`, `test/e2e/runbooks/outbox-or-subscriber-backlog.test.ts`, `test/e2e/runbooks/provider-execution-command-in-dlq.test.ts`; modify: none; must not touch: relay/consumer code.

**Objective** — Prove the messaging runbooks: a stopped relay/subscriber backlog recovers with original envelope UUIDs and no orphaned operation; a DLQ'd execution command is resolved correctly for every operation state in the `docs/08` table.

**Implementation instructions**
1. Backlog: stop the relay, accept 50 commands, verify `-- id: oldest-unpublished-age` grows and `-- id: relay-leases`; restart relay (safe action) and also republish one envelope via the CLI; exit: `-- id: oldest-unpublished-age` < 10 s, `-- id: orphaned-operations` (nonterminal operation with no outbox row, lease, DLQ record, or case) zero, verify duplicate-effect class zero.
2. DLQ: parametrized over the six rows of the `docs/08` table (`REQUESTED` never dispatch-marked; live `PROCESSING`; stale `PROCESSING` not marked; stale `PROCESSING` marked; `UNKNOWN`/`REQUIRES_REVIEW`; `SUCCEEDED`/`REJECTED`/`FAILED`). Produce each DLQ record by forcing schema-unsupported delivery then fixing (P05/P09 harness). Checks `-- id: dlq-record`, `-- id: operation-and-attempt-state`; safe action per row (`flowledger ops dlq replay`, or "do not replay", or reconciliation reschedule); exit: `-- id: dlq-resolved-with-owner` (DLQ resolved and operation has a correct recovery owner) and fake-provider effect count ≤ 1 for every operation.

**Expected behavior** — Backlog drains with the same UUIDs; each DLQ row's action matches the table and never issues a second provider write.

**Acceptance criteria**
- [ ] Two runbooks follow the template; all SQL blocks executed.
- [ ] Six DLQ state rows each tested.
- [ ] Zero orphaned operations and zero duplicate effects at exit.

**Testing requirements** — Files above. Command: `pnpm vitest run --project e2e test/e2e/runbooks/outbox-or-subscriber-backlog.test.ts test/e2e/runbooks/provider-execution-command-in-dlq.test.ts`.

**Non-goals** — No change to DLQ replay semantics.

**Handoff checklist**
- [ ] `pnpm test:e2e` green; `Task: P10-T18`.

---

### P10-GATE — M10 milestone verification

**Task ID:** `P10-GATE`
**Feature:** Milestone gate
**Commit:** `test(settlement): add M10 gate verification and evidence note`
**Priority:** Critical
**Dependencies:** `P10-T01` … `P10-T18`
**Estimated complexity:** M
**Contract references:** `docs/10` §M10 Test and acceptance criteria (lines 464–476); `docs/09` §End-to-end scenarios 16–19, §Quality gates "Ledger-ready"; `docs/08` §Required failure-injection tests → Settlement.
**Files:** create: `test/e2e/m10-gate.test.ts`, `docs/evidence/P10.md`; modify: none; must not touch: production code.

**Objective** — Prove M10's exit gate end to end, not just that tasks merged.

**Implementation instructions**
1. `test/e2e/m10-gate.test.ts`:
   - Scenario 18: unreliable simulator times out a capture after committing → `UNKNOWN` → reconciliation confirms → settlement worker tick → timeline shows the ambiguous attempt, the reconciliation evidence, exactly one `LEDGER_POSTING`, and one `SETTLEMENT` entry.
   - Settlement under concurrent traffic (small local profile: 20 merchants, 200 captures, 60 refunds of which ≥ 10 confirm after their capture settled, worker running at `SETTLEMENT_INTERVAL_SECONDS=1`): afterwards no movement in two batches, every batch net equals recomputed members' net, payable sampled every tick is non-decreasing per merchant, clearing + payable = net of all confirmed movements per merchant.
   - Settlement process termination (scenario 19 settlement part): `SIGKILL` the settlement worker at each crash point (`FLOWLEDGER_CRASH_POINTS=settlement.after_claim` / `settlement.after_post_commit`, and mid-posting via the `public.fault_point` SQL fault points) and restart; convergence as above.
   - Settlement never locks payments: during the traffic run, a sampler records `pg_locks` held by `fl_settlement_worker` backends; none on `payments.*`. Settlement worker makes no outbound HTTP (assert the provider simulator's request log has no request with settlement correlation IDs).
   - Redaction: scan captured logs, traces (in-memory exporter), outbox envelopes, and evidence rows produced during the run for every fixture in `packages/testkit/src/prohibited-data.ts`; zero hits.
   - `flowledger verify` reports `findings = 0` and `checked > 0` for every class, including `settlement_membership` and the duplicate-effect class.
2. `docs/evidence/P10.md`: commit SHA, commands run, per-class verify output, counts from the traffic run, list of runbook tests with pass status, and links to the risks still open below.

**Expected behavior** — All gate checks pass from a clean clone with `pnpm db:up` and Docker only.

**Acceptance criteria**
- [ ] Every `docs/10` M10 acceptance bullet maps to a passing test (see traceability table).
- [ ] All nine runbook test files pass.
- [ ] Verify: zero findings, every class `checked > 0`.
- [ ] Evidence note committed.

**Testing requirements** — `pnpm check`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:chaos`, `pnpm verify:ledger`.

**Non-goals** — No feature code; no performance claim (P12/P13).

**Handoff checklist**
- [ ] Evidence note lists exact command output.
- [ ] `Task: P10-GATE` in commit body.

---

## Parallelization

| Wave | Tasks that may run concurrently | Notes |
| --- | --- | --- |
| 1 | `P10-T01` | Contract verification only. |
| 2 | `P10-T02` | Owns `migrations/1000_*`. |
| 3 | `P10-T03`, `P10-T04` | Different migrations (`1010`, `1020`); T04 creates `packages/database/src/functions/settlement.ts`, T03 does not touch it. |
| 4 | `P10-T05` | Depends on both. |
| 5 | `P10-T06`, `P10-T07`, `P10-T08`, `P10-T09`, `P10-T10`, `P10-T11`, then `P10-T12`, `P10-T14` | T06/T08 are test-only; T07 owns `apps/settlement-worker`; T09 owns `packages/database/src/verify/classes/recovery.ts`; T10 owns `packages/contracts/src/timeline-detail.ts` + `1040`; T12 and T14 both modify `apps/cli/src/main.ts`, `packages/config/src/cli.ts`, `.env.example`, `docs/CONFIG.md` — **serialize T12 before T14** or rebase carefully. |
| 6 | `P10-T13` (after T07, T11) | Shares `apps/cli/src/main.ts`, `packages/database/src/functions/operator.ts` with T12 — run after T12. |
| 7 | `P10-T15` → then `P10-T16`, `P10-T17`, `P10-T18` concurrently | T15 creates `test/e2e/runbooks/runbook-sql.ts` and `docs/runbooks/README.md`, which the others only read. |
| 8 | `P10-GATE` | |

Migration numbers are fixed per task (1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080) so parallel branches never collide on filenames. **Merge migrations in numeric order**: a lower-numbered file merged after a higher one would be applied out of order on already-migrated databases. T10 (`1040`) must merge before T11 (`1050`).

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| docs/10 M10: settlement schema (runs lifecycle, immutable batches, membership) | P10-T02, P10-T04 | test/integration/settlement/schema.test.ts :: run transition matrix; batches/members reject UPDATE/DELETE/TRUNCATE per runtime role |
| docs/10 M10: protected `settlement.post_batch` single transaction | P10-T05 | test/integration/settlement/post-batch.test.ts :: posts positive net batch; test/chaos/settlement-crash-points.test.ts :: fault <point> leaves nothing |
| docs/10 M10: anti-join eligibility with DB-read cutoff, no mutable flag | P10-T05 | post-batch.test.ts :: cutoff excludes later movement; settlement.property.test.ts :: P1 |
| docs/10 M10: deferral when net ≤ 0 | P10-T05 | post-batch.test.ts :: defers zero movements; defers negative net and leaves movements eligible |
| docs/10 M10: scheduler + stale-run sweeper with SKIP LOCKED, bounded batches | P10-T04, P10-T07 | run-lifecycle.test.ts :: concurrent claims are disjoint; stale sweep skips locked run; loop.test.ts :: concurrency bound |
| docs/10 M10: add `settlement.batch.posted.v1` to registry/catalog | P10-T01 | settlement-contracts.test.ts :: registry has settlement.batch.posted.v1 once (resolved discrepancy R-02) |
| docs/10 M10: `SETTLEMENT` op type in recipes and ledger event schema | P10-T01, P10-T03 | settlement-contracts.test.ts :: valid settlement ledger event passes; settlement-recipe.test.ts :: posts balanced clearing→payable |
| docs/10 M10: timeline `SETTLEMENT` kind | P10-T10 | timeline-settlement.test.ts :: SETTLEMENT after batch with exact detail |
| docs/10 M10: settlement-membership verify class | P10-T09 | settlement-membership.test.ts :: F1–F8, clean database zero findings |
| docs/10 M10: execute every runbook incl. settlement | P10-T15–T18 | test/e2e/runbooks/*.test.ts (9 files) |
| docs/10 M10: safe commands (republish, reschedule, replay, trigger, inspect) | P10-T12, P10-T13 | messaging-commands.test.ts :: republish published envelope same uuid; dlq replay nonfinancial publishes; recovery-commands.test.ts :: reschedule review case…; trigger creates claimed run; evidence output redacted |
| docs/10 M10: named operator identity + dual approval for corrections | P10-T14 (+P11-T03 authenticates) | correction-workflow.test.ts :: same principal cannot approve; different principal approves |
| docs/10 M10 acc: batch amount = recomputed net; seeded mismatch caught | P10-T05, P10-T08, P10-T09 | settlement.property.test.ts :: P2; settlement-membership.test.ts :: F2 batch net tampered |
| docs/10 M10 acc: no movement in two batches; concurrent runs ≤ 1 batch | P10-T04, P10-T05, P10-T08 | run-lifecycle.test.ts :: concurrent schedule creates one run; post-batch-concurrency.test.ts :: concurrent capture confirmations during runs never double-settle |
| docs/10 M10 acc: zero/negative net posts nothing, records DEFERRED | P10-T05 | post-batch.test.ts :: defers negative net… |
| docs/10 M10 acc: late refund → clearing negative, defers, closed batch unchanged, payable not reduced | P10-T05, P10-T07 | post-batch.test.ts :: late refund drives clearing negative…; settlement-lifecycle.test.ts :: scenario 17 |
| docs/10 M10 acc: batch/membership reject UPDATE/DELETE/TRUNCATE for every runtime role | P10-T02 | schema.test.ts :: batches/members reject … per runtime role |
| docs/10 M10 acc: crash at every point leaves nothing; abandoned CLAIMED reclaimed | P10-T06, P10-T07 | settlement-crash-points.test.ts :: all cases; settlement-lifecycle.test.ts :: worker killed after claim settles once |
| docs/10 M10 acc: payable non-decreasing; clearing+payable = net of confirmed movements | P10-T08, P10-GATE | settlement.property.test.ts :: P4, P5; m10-gate.test.ts :: concurrent traffic |
| docs/10 M10 acc: never locks payment, never calls provider | P10-T05, P10-GATE | post-batch.test.ts :: no payment locks; m10-gate.test.ts :: pg_locks sampler, provider request log |
| docs/10 M10 acc: no credential/token/PAN/raw payload in logs/traces/messages/evidence | P10-T07, P10-T10, P10-GATE | settlement-lifecycle.test.ts :: worker logs are redacted; m10-gate.test.ts :: redaction scan |
| docs/10 M10 acc: each runbook reproducible setup/queries/action/exit | P10-T15 | runbook tests assert executed SQL IDs = parsed IDs |
| docs/10 M10 acc: verify zero findings across every class | P10-T09, P10-GATE | m10-gate.test.ts :: verify all classes |
| docs/02 §Batch invariants 1–6 | P10-T02, P10-T05, P10-T09 | schema.test.ts :: POSTED requires batch and positive net; post-batch.test.ts :: invariant assertion fires |
| docs/02 §Settlement run steps 1–6, same transaction | P10-T05, P10-T06 | settlement-crash-points.test.ts |
| docs/02 §What settlement does not do (no fee, no receivable, no provider) | P10-T03, P10-T05 | settlement-recipe.test.ts :: rejects platform account |
| docs/02 §Idempotent posting `settlement:{batchId}` | P10-T03 | settlement-recipe.test.ts :: replay returns same ltx; changed amount same key conflicts |
| docs/07 settlement constraints and uniqueness boundaries | P10-T02 | schema.test.ts :: one CLAIMED per merchant; movement in two batches rejected |
| docs/07 §Protected settlement function steps 1–7 | P10-T05 | post-batch.test.ts (all) |
| docs/07 lock order: settlement chain disjoint from payment chain | P10-T05 | post-batch-concurrency.test.ts :: settlement and refund resolution contend on clearing without deadlock |
| docs/07 §Tenant isolation item 8 (settlement via tenant-scoped views) | P10-T02, P10-T10 | schema.test.ts :: RLS hides rows; timeline-settlement.test.ts :: view returns nothing without app.merchant_id |
| docs/07 §ledger.correction_requests distinct principals | P10-T14 | correction-workflow.test.ts :: table check rejects same principal |
| docs/08 §Settlement crash-point matrix (6 rows) | P10-T06 | settlement-crash-points.test.ts :: all cases |
| docs/08 failure-injection → Settlement (6 bullets) | P10-T06, P10-T05, P10-T08, P10-GATE | crash suite; post-batch-concurrency.test.ts; m10-gate.test.ts |
| docs/08 §DLQ contract / execution-command state table | P10-T12, P10-T18 | provider-execution-command-in-dlq.test.ts :: six rows |
| docs/08 §Manual review contract (operator may/may not; audit fields) | P10-T11, P10-T13 | recovery-commands.test.ts :: operator roles cannot mutate financial tables; operator-actions.test.ts |
| docs/08 §Operator authority (second approver for compensating posting) | P10-T14 | correction-workflow.test.ts :: same principal cannot approve |
| docs/08 nine runbooks | P10-T15–T18 | test/e2e/runbooks/*.test.ts |
| docs/09 settlement property tests (4) | P10-T08 | settlement.property.test.ts |
| docs/09 integration: settlement concurrency, immutability, deferral | P10-T02, P10-T05 | schema.test.ts; post-batch.test.ts |
| docs/09 e2e scenarios 16, 17, 18, 19 (settlement) | P10-T07, P10-GATE | settlement-lifecycle.test.ts; m10-gate.test.ts |
| docs/04 required contract tests (settlement event, SETTLEMENT ledger type) | P10-T01 | settlement-contracts.test.ts |
| docs/05 timeline SETTLEMENT entry, cross-tenant 404, redaction | P10-T10 | timeline-settlement.test.ts |

## Phase risks / open questions

| ID | Risk / conflict | Impact | Severity | Recommended resolution | Blocked tasks |
| --- | --- | --- | --- | --- | --- |
| R-01 | `docs/07` line 1038 gives `settlement.post_batch(run_id, outbox_envelope)` but line 1040 requires verifying the run's lease token, which the two-argument signature cannot receive. | Without the token the function cannot fence a stale worker. | High | Add `p_lease_token uuid` as the second parameter (P10-T05); update `docs/07` line 1038 in a separate contract commit before or with P10-T05. | P10-T05 |
| R-02 | `docs/10` lines 456–458 say to *add* `settlement.batch.posted.v1`, the ledger `SETTLEMENT` type, and the timeline `SETTLEMENT` kind, but all exist (`schemas/registry.v1.json` line 33; `schemas/events/ledger-transaction-posted.v1.schema.json` `operationType` enum and `SETTLEMENT` branch; `openapi/openapi.yaml` line 1286; `docs/05` line 358). | None if treated as verify-and-wire. | Low | Resolved: P10-T01 verifies and wires; no schema edits. Optionally reword `docs/10` lines 456–458 to "verify". | — |
| R-03 | CONVENTIONS §9 (line 210) requires every envelope to be built by `buildEnvelope()` and Ajv-validated in TS before insertion, but `post_batch` must complete the settlement envelope in SQL (batch ID, cutoff, counts, net only exist inside the transaction), as P03's routine already does for the ledger event (`docs/07` line 940). | TS-side Ajv validation cannot run before insertion. | Medium | Worker passes a typed template; SQL completes it and `messaging.insert_outbox` enforces registry/semantic rules; P10-T05 tests Ajv-validate every produced row. Amend CONVENTIONS §9 to allow SQL-completed envelopes for protected functions. | P10-T05 |
| R-04 | `docs/10` line 492 places the append-only audit table in M11, but M10's safe commands (line 461) and corrections (line 462) must be audited under `docs/08` lines 23 (axiom 10) and 268. | M10 commands would ship unaudited. | Medium | Create `audit.operator_actions` in P10-T11; P11 adds authentication binding (P11-T03) and read views. CONVENTIONS §7 line 171 labels `audit_function_owner` "(P11)" — informational only, the role exists from P02. | P10-T11–T14 |
| R-05 | `docs/07` does not say how a run is created before it is claimed with `SKIP LOCKED` (line 1338), nor what "reclaimed" means for a stale run (line 989). | Ambiguous worker/sweeper design. | Medium | **[ASSUMPTION]** A scheduled run is a `CLAIMED` row with null lease; `claim_runs` leases them with `FOR UPDATE SKIP LOCKED`; the sweeper marks stale leased runs `FAILED` and the merchant becomes due immediately, so selection restarts under a new run and batch ID (matches `docs/02` line 351 and the "advance once" rule in `docs/07` line 1395). | P10-T04 |
| R-06 | `docs/05` §timeline and `openapi.yaml` line 1303 say per-kind `detail` shapes are "enumerated in docs/05", but no `SETTLEMENT` shape is enumerated. | Agents could invent differing shapes. | Medium | **[ASSUMPTION]** `{settlementBatchId, ledgerTransactionId, movementKind}`; add it to `docs/05` in a contract commit. | P10-T10 |
| R-07 | `docs/10` line 462 (M10) requires dual approval for compensating corrections; line 501 (M11) defers "second-approver enforcement" while saying the distinct-principal check exists; `docs/07` line 932, `docs/08` line 639, and `docs/02` line 470 require a distinct second approver. A single-principal workflow cannot satisfy the existing check, so corrections could never execute. | Contradiction; either unenforced corrections or none at all. | High | Implement the cheap two-principal CLI flow (P10-T14) keeping the DB check; interpret the M11 deferral as approver-tier separation, approval expiry, and notifications, documented in `docs/KNOWN_LIMITS.md` (P11-T18). Update `docs/10` line 501 and README "Deliberate limits" wording. | P10-T14, P11-T18 |
| R-08 | `docs/02` line 331 selects *every* eligible movement, but journal amounts are capped at `1000000000000` (`docs/07` line 874) and the event pattern caps `netAmountMinor`. A huge backlog could exceed it. | Run fails instead of posting. | Low | Raise `SETTLEMENT_NET_OUT_OF_RANGE` and mark the run `FAILED` (alerted via stale settlement age); revisit bounded selection in P12 if measured. | P10-T05 |
| R-09 | Settlement/operator errors (`SETTLEMENT_LEASE_LOST`, `OPERATOR_EVIDENCE_REQUIRED`, `CORRECTION_SAME_PRINCIPAL`, …) have no `docs/05` problem code; CONVENTIONS §7 says DomainError codes equal docs/05 codes. | Naming drift. | Low | **[ASSUMPTION]** Treat them as internal non-HTTP codes in `packages/database/src/errors.ts`; never surfaced through the merchant API. | P10-T04, T12–T14 |
| R-10 | `docs/07` line 917 uses the `lcr_` prefix but `schemas/common/entity-ids.v1.schema.json` has no `lcr_` (nor `led_`, `lac_`). | CONVENTIONS §6 forbids inventing prefixes. | Medium | P03 owns the fix (add prefixes to the registry in a contract commit); P10-T14 blocks if unresolved. | P10-T14 |
| R-11 | Interfaces from P03/P04/P06/P09 (private posting routine, timeline function, DLQ replay function, fault-point helper, merchant account logical codes) are not named in the contracts. | Agents must look them up. | Low | Resolved: names fixed in §Interfaces consumed from the providers' declarations (`ledger.post_journal_internal`, `payments.payment_timeline`, `messaging.record_dead_letter_replay`, `public.fault_point`, `merchant.clearing`/`merchant.payable`). | P10-T03, T05, T10, T12–T14 |
| R-12 | Eligibility anti-join scans a merchant's whole journal history each run; a lower bound at the previous cutoff is unsafe because a movement can commit after a selection with `recorded_at` before its cutoff. | Settlement cost grows with history (5,000 movements/s target, `docs/09`). | Low | Accept for MVP; measure in P12; if needed, add an unpartitioned "unsettled movements" registry fed by the posting transaction (requires a contract change). | — |
| R-13 | `docs/04` line 359 names topics `flowledger-commands-v1`/`flowledger-events-v1`; CONVENTIONS §9 line 223 uses names without `-v1`. | Topology mismatch with Terraform (P13). | Low | Align CONVENTIONS to the contract names. | — |
