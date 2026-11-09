# P08 — Ambiguous outcomes and reconciliation

## Phase overview

**Goal.** Make every possibly transmitted provider write converge safely: stale work is detected by sweepers, possible-dispatch failures become `UNKNOWN` atomically with a durable reconciliation case, the reconciler resolves the original operation read-only through the same evidence/transition/ledger path as a direct response, exhausted policy becomes visible `REQUIRES_REVIEW`, authorization expiry is tracked by a durable case and applied only from explicit evidence, operators can attach evidence/recheck/escalate without editing state, and a disaster-recovery fence keeps provider writes off until restored-window reconciliation is complete. (docs/10 M8; docs/08; docs/06 §Provider attempts and leases, §Timeout and ambiguous-result policy, §Reconciliation lookup and evidence, §Authorization-expiry lookup; ADR-0004.)

**Entry criteria.** `P07-GATE` green (local vertical slice: create → authorize → capture → refunds → `flowledger verify` zero findings).

**Exit gate (`P08-GATE`).** docs/10 M8 exit: "Unknown/expiry failure suites converge safely" — every M8 acceptance bullet has a passing test, the docs/08 Worker/provider and Refund-reservation failure-injection tests mapped below pass, `flowledger verify --require-ground-truth` reports zero findings after the chaos suite, and `docs/evidence/P08.md` is committed.

### Interfaces consumed from earlier phases

| Interface | Source | Notes |
| --- | --- | --- |
| Tables `payments.payments`, `payments.payment_operations` (incl. `lease_token`, `lease_expires_at`, `not_before`, `resolution_*`), deferred reservation/exclusive trigger | P02 | docs/07 §Payment aggregate |
| `messaging.outbox_messages`, `messaging.inbox_messages`, `messaging.dead_letter_records`, `messaging.insert_outbox(envelope jsonb)` | P02 | |
| `buildEnvelope()` (`packages/contracts/src/envelope.ts`), Ajv validators, semantic validator | P00/P01/P05 | CONVENTIONS §9 |
| Inbox consumer helper and transport (`Transport`, `InMemoryTransport`, `PubSubTransport`), consumer names in `packages/messaging/src/consumers.ts` (`reconciler`, `payment-worker`) | P05 | P05 consumer framework (binding, P05-GATE): `startConsumer(opts)` / `processDelivery(opts, msg)` / `HandlerResult` in `packages/messaging/src/consumer.ts` — validates, inserts the inbox row via `messaging.record_inbox_message(text, jsonb)` and calls `handle(tx, envelope)` in one transaction, acks only after commit, dead-letters via `messaging.insert_dead_letter(...)`. Do not write a second runner. |
| `providers.provider_attempts`, `providers.provider_evidence`, `providers.provider_identity_conflicts`, `providers.provider_notifications`, `providers.provider_event_claims` | P06 | `provider_evidence.reconciliation_case_id` FK deferred to P08 (docs/10 M6) |
| `payments.claim_operation`, `payments.mark_dispatch`, `payments.defer_operation`, `payments.schedule_same_operation_retry`, `payments.enqueue_due_operations` | P06 | docs/07 §Protected payment transition functions |
| Evidence staging function | P06 | P06 provides only the attempt-bound `providers.stage_attempt_evidence(p_attempt_id text, p_lease_token uuid, p_evidence jsonb) RETURNS TABLE (evidence_id text, stage_result text)` (`STAGED`/`DUPLICATE`/`CONFLICT`; `source='API_RESPONSE'` only). Reconciliation-source staging is therefore created here: P08-T08 adds `providers.stage_reconciliation_evidence(p_case_id text, p_lease_token uuid, p_evidence jsonb) RETURNS TABLE (evidence_id text, stage_result text)` with the same claim/read/compare semantics (TS wrapper `stageReconciliationEvidence` in `packages/database/src/functions/providers.ts`). |
| `PaymentProvider` interface (verbatim docs/06) in `packages/providers/src/adapter.ts`; `FakeProviderAdapter`, `UnreliableProviderAdapter` (HTTP clients of `apps/provider-simulator`); adapter registry | P06 | CONVENTIONS §16 |
| `apps/provider-simulator` (Fastify, own DB `flowledger_sim`), `POST /__test/clock` gated by `SIMULATOR_TEST_ENDPOINTS=1` | P06 | |
| Crash hooks: `crashPoint(name)` in `packages/config/src/crash-points.ts` (P05-T08; no-op unless `FLOWLEDGER_FAULT_HOOKS=1`); in-process arming `armCrashPoint`/`disarmCrashPoints` in `packages/testkit/src/crash-points.ts` (throws `CrashPointError`); per-process arming `FLOWLEDGER_CRASH_POINTS=<name,…>` (SIGKILL, exit 137); worker point names from the P06 overview §Crash points | P05/P06 | CONVENTIONS §3 (binding). |
| Testkit: Testcontainers PG fixture (`packages/testkit/src/pg.ts`), seed builders, polling helpers, app spawner for e2e/chaos | P02/P05/P06/P07 | No earlier phase exports an app spawner (P05/P06/P07 gates spawn inline); P08-T16 creates `packages/testkit/src/apps.ts` `startApp(name, env)` (spawns `node apps/<name>/dist/main.js` as a child process; no import from `apps/`). |
| `payments.apply_provider_evidence(evidence_id)` (direct-response path, corroboration), `ledger.post_payment_operation(...)` | P07 | **Coordinator decision:** P07 does **not** implement `payments.record_discrepancy` or emit `payment.discrepancy.detected.v1`; it stages contradictory evidence and leaves it unapplied. P08-T17 creates `record_discrepancy` and routes contradictions to it. P07 applies evidence only from `PROCESSING`; it returns `TABLE (application_kind, operation_status, operation_version, payment_version, ledger_transaction_id)` and leaves contradictions as `UNAPPLIED_CONTRADICTION`/`UNAPPLIED_MISMATCH` branches marked `-- P08-T17`. Envelope convention: TS pre-builds outbox envelopes from a locked read and passes them; the function verifies `aggregateVersion` and correlation and calls `messaging.insert_outbox`. P08 functions use the same convention. |
| Worker execution loop in `apps/payment-worker` | P06/P07 | **[ASSUMPTION A6]** before P08 an `UNKNOWN` adapter result is staged as evidence and the operation is left `PROCESSING` (no `mark_unknown` exists yet). |
| `flowledger` CLI skeleton (`apps/cli`), `flowledger verify` | P02/P03 | |
| Pure helpers: reconciliation-reason vocabulary, backoff calculation (`packages/domain`) | P01 | If P01 has no backoff helper for the reconciliation schedule, P08-T12 adds `packages/domain/src/reconciliation-schedule.ts`. |

**[ASSUMPTION A7] `payments.requeue_stale_pre_dispatch` ownership.** docs/10 M8 owns "Kill the worker before dispatch: the same operation is safely reclaimed", so this file owns the function (P08-T06). If `P06-GATE` already installed it (check `migrations/06*.sql`), P08-T06 skips its step 1 and only adds the stale-`REQUESTED` function.

### Interfaces provided to later phases

| Interface | Kind | Consumers |
| --- | --- | --- |
| `reconciliation.cases`, `reconciliation.case_activity` | tables | P09, P10, P11 |
| `payments.recovery_epochs`, `payments.current_recovery_fence()` | table + SQL function | P09 (notification application gate), P10 runbooks |
| `payments.mark_unknown(p_operation_id text, p_expected_lease_token uuid, p_reason text, p_evidence_id text, p_lookup_not_before timestamptz, p_envelopes jsonb) RETURNS text` (case id) | SQL | P09 (none directly), P10 |
| `payments.requeue_stale_pre_dispatch(p_operation_id text, p_expected_lease_token uuid, p_envelope jsonb) RETURNS void` | SQL | P10 runbooks |
| `payments.republish_stale_requested(p_operation_id text, p_envelope jsonb) RETURNS boolean` | SQL | P10 runbooks |
| `payments.require_operation_review(p_case_id text, p_expected_case_version bigint, p_reason text, p_actor_id text, p_envelopes jsonb) RETURNS void` | SQL | P11 operator |
| `payments.record_authorization_expiry(p_evidence_id text, p_envelopes jsonb) RETURNS text` (`APPLIED`/`DISMISSED`/`DEFERRED`/`DUPLICATE`) | SQL | P09 expiry webhook path |
| `payments.apply_provider_evidence(evidence_id ...)` extended with case resolution, expiry-case creation/dismissal, and contradiction routing | SQL | P09 webhook path |
| `payments.record_discrepancy(p_evidence_id text, p_envelopes jsonb) RETURNS text` (case id or `DUPLICATE`) | SQL | P09 webhook path, P10 |
| `reconciliation.claim_due_cases`, `reconciliation.record_case_observation`, `reconciliation.request_manual_recheck`, `reconciliation.attach_case_note` | SQL | P10/P11 operator |
| `apps/reconciler` (case scheduler + `payment.operation.reconcile.v1` consumer) | app | P10, P12 |
| Stale sweepers in `apps/payment-worker/src/sweepers/` | app | P10, P12 |
| CLI: `flowledger cases list|show|attach-note|recheck|escalate`, `flowledger dr fence|reconcile-window|unfence` | CLI | P10 runbooks, P11 audit wiring |
| Testkit: `packages/testkit/src/simulator.ts` fault/lookup/expiry scripting helpers | testkit | P09, P10, P12 |

### Internal domain error codes introduced (SQLSTATE `P0001`, not HTTP problem codes)

**[ASSUMPTION A8]** docs/05 lists only HTTP problem codes; worker-internal protected-function rejections need stable codes. P08 introduces exactly these MESSAGE values, mapped in `packages/database/src/errors.ts` to `DomainError.code` of the same string: `OPERATION_NOT_AMBIGUITY_ELIGIBLE`, `LEASE_TOKEN_MISMATCH`, `STALE_ENVELOPE_VERSION`, `CASE_LEASE_MISMATCH`, `CASE_VERSION_MISMATCH`, `CASE_NOT_ESCALATABLE`, `RECONCILIATION_POLICY_NOT_EXHAUSTED`, `EVIDENCE_NOT_APPLICABLE`, `DISPATCH_FENCED`, `OPERATOR_IDENTITY_REQUIRED`. If P05–P07 already introduced an equivalent code (for example for envelope version mismatch), reuse that one instead and note it in the commit body.

---

### P08-T01 — Simulator scripting for ambiguity, lookup, and expiry scenarios

**Task ID:** `P08-T01`
**Feature:** Deterministic test control of post-commit faults, lookup outcomes, and provider-side expiry
**Commit:** `test(providers): add simulator scripting for ambiguity and expiry scenarios`
**Priority:** High
**Dependencies:** `P07-GATE`
**Estimated complexity:** M
**Contract references:** docs/06 §Unreliable provider, §Reconciliation lookup and evidence, §Authorization-expiry lookup, §Deterministic fake provider; CONVENTIONS §16
**Files:** create: `packages/testkit/src/simulator.ts` (or modify it if P06 created it), `apps/provider-simulator/src/test-scripts.test.ts`; modify: `apps/provider-simulator/src/test-routes.ts` (or the file P06 registers `/__test/*` routes in), `apps/provider-simulator/src/core.ts`, `apps/provider-simulator/migrations/<next>_test_scripts.sql`; must not touch: `packages/providers/src/adapter.ts`, `migrations/`

**Objective** — Every P08 scenario must be reproducible deterministically across processes: provider commits then the response times out; lookup stays inconclusive N times; conclusive absence after the consistency window; provider-side authorization expiry. The simulator owns provider truth (CONVENTIONS §16), so the scripts live server-side.

**Implementation instructions**
1. Read P06's simulator `/__test/*` routes first. For each control below, if an endpoint with the same effect exists, reuse it and only add the testkit helper; record the mapping in the commit body. Otherwise add it. All routes return `404` unless `SIMULATOR_TEST_ENDPOINTS=1`.
2. `POST /__test/write-faults` body `{ "idempotencyKey": string, "fault": "TIMEOUT_AFTER_COMMIT" | "CONNECTION_LOST_AFTER_COMMIT" | "MALFORMED_SUCCESS" | "PROVIDER_5XX_AFTER_COMMIT" | "TIMEOUT_BEFORE_COMMIT", "remaining": 1 }` — the next `remaining` writes with that key apply the fault. `*_AFTER_COMMIT` and `MALFORMED_SUCCESS` commit the provider effect first, then fail the response; `TIMEOUT_BEFORE_COMMIT` commits nothing. Store in a simulator table `test_write_faults(idempotency_key text PRIMARY KEY, fault text NOT NULL, remaining integer NOT NULL CHECK (remaining >= 0))` in the simulator DB.
3. `POST /__test/lookup-scripts` body `{ "idempotencyKey": string, "outcomes": ["INCONCLUSIVE" | "NOT_FOUND_INCONCLUSIVE" | "CONTRADICT" | "TRUTH"], "retryAfterMs": number | null }` — each lookup for that key pops the next scripted outcome; `TRUTH` (and an empty queue) returns the real simulator state; `CONTRADICT` returns `FOUND` with the opposite terminal outcome of the truth (`SUCCEEDED` ↔ `REJECTED`, the docs/06 "contradictory test evidence" fault) and is recorded in simulator diagnostics. `INCONCLUSIVE` returns category `PROVIDER_UNAVAILABLE`, directive `RECONCILE_FIRST`, `retryAfterMs` from the body.
4. `POST /__test/authorizations/expire` body `{ "providerAuthorizationId": string }` — marks the provider authorization expired at the simulator clock's now; subsequent `lookupAuthorizationStatus` returns `EXPIRED`. `POST /__test/authorization-lookup-scripts` body `{ "providerAuthorizationId": string, "outcomes": ["INCONCLUSIVE" | "TRUTH"] }`.
5. Conclusive absence uses the existing capability `lookup.absenceConclusiveAfterSeconds`; no new control. A write with `TIMEOUT_BEFORE_COMMIT` followed by clock advance past that window must yield `NOT_FOUND` with `absenceIsConclusive: true`.
6. `packages/testkit/src/simulator.ts` exports: `scriptWriteFault(key, fault, remaining = 1)`, `scriptLookups(key, outcomes, retryAfterMs = null)`, `expireAuthorization(providerAuthorizationId)`, `scriptAuthorizationLookups(id, outcomes)`, `advanceClock(ms)` (wraps `POST /__test/clock`), `groundTruthEffects(key): Promise<number>` (reads via `SIMULATOR_DATABASE_URL` with role `fl_simulator_truth`). Base URL from env `SIMULATOR_BASE_URL` (P06 name).

**Expected behavior** — `scriptWriteFault(k,'TIMEOUT_AFTER_COMMIT')` then a capture with key `k`: adapter returns `UNKNOWN` (`TIMEOUT_AFTER_SEND`), `groundTruthEffects(k) === 1`; next lookup returns `FOUND/SUCCEEDED`.

**Acceptance criteria**
- [ ] Each control works only with `SIMULATOR_TEST_ENDPOINTS=1` (else `404`).
- [ ] Scripts are keyed by provider idempotency key / authorization id and survive simulator restart (stored in simulator DB).
- [ ] No FlowLedger package other than `packages/testkit` reads `SIMULATOR_DATABASE_URL`.

**Testing requirements** — `apps/provider-simulator/src/test-scripts.test.ts` (unit, in-memory core): (a) `TIMEOUT_AFTER_COMMIT` commits once and reports timeout; second write same key replays original effect (P=1); (b) lookup script pops in order then returns truth; (c) expire → `EXPIRED`; (d) controls disabled → 404. Command: `pnpm vitest run --project unit apps/provider-simulator/src/test-scripts.test.ts`.

**Non-goals** — No change to the adapter interface or the normalized taxonomy; no FlowLedger DB change.

**Handoff checklist**
- [ ] Reused existing P06 endpoints where equivalent (mapping in commit body).
- [ ] `.env.example`/`docs/CONFIG.md` list `SIMULATOR_BASE_URL` if not already present.

---

### P08-T02 — Reconciliation cases, activity, and evidence case FK

**Task ID:** `P08-T02`
**Feature:** Durable reconciliation work records
**Commit:** `feat(db): add reconciliation cases and activity tables`
**Priority:** Critical
**Dependencies:** `P07-GATE`
**Estimated complexity:** M
**Contract references:** docs/07 §`reconciliation.cases`, §`reconciliation.case_activity`, §`providers.provider_evidence` (source-shape check), §Tenant isolation, §Mutability rules, §Migration order steps 14/16/17; CONVENTIONS §7, §8
**Files:** create: `migrations/0800_reconciliation_cases.sql`, `test/integration/reconciliation/cases-schema.test.ts`; must not touch: earlier migrations

**Objective** — Create the case tables exactly as docs/07 defines them and complete the deferred `provider_evidence.reconciliation_case_id` FK (docs/10 M6), fully locked down: no runtime role gets DML; mutation is only through P08 protected functions.

**Implementation instructions**
1. Stop and report `BLOCKED` (CONVENTIONS §14) if `reconciliation.cases` already exists in an earlier migration.
2. In `0800_reconciliation_cases.sql`, in order: tables → constraints/indexes → triggers → RLS → REVOKE/GRANT.
   ```sql
   CREATE TABLE reconciliation.cases (
     id text COLLATE "C" PRIMARY KEY CHECK (id ~ '^case_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
     merchant_id text COLLATE "C" NOT NULL,
     payment_id text COLLATE "C" NOT NULL,
     operation_id text COLLATE "C" NOT NULL,
     case_type text NOT NULL CHECK (case_type IN ('AMBIGUOUS_OUTCOME','AUTHORIZATION_EXPIRY','CONTRADICTORY_EVIDENCE','STALE_PROCESSING','LEDGER_MISMATCH')),
     status text NOT NULL CHECK (status IN ('OPEN','SCHEDULED','IN_PROGRESS','REQUIRES_REVIEW','RESOLVED','DISMISSED')),
     reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
     expected_snapshot jsonb NOT NULL CHECK (jsonb_typeof(expected_snapshot) = 'object'),
     observed_snapshot jsonb CHECK (observed_snapshot IS NULL OR jsonb_typeof(observed_snapshot) = 'object'),
     attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
     next_check_at timestamptz,
     lease_token uuid,
     lease_expires_at timestamptz,
     version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
     created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
     updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
     resolved_at timestamptz,
     resolution_code text,
     UNIQUE (merchant_id, id),
     UNIQUE (merchant_id, operation_id, id),
     FOREIGN KEY (merchant_id, payment_id) REFERENCES payments.payments (merchant_id, id),
     FOREIGN KEY (merchant_id, payment_id, operation_id) REFERENCES payments.payment_operations (merchant_id, payment_id, id),
     CHECK ((status IN ('RESOLVED','DISMISSED')) = (resolved_at IS NOT NULL)),
     CHECK ((status IN ('RESOLVED','DISMISSED')) = (resolution_code IS NOT NULL)),
     CHECK ((status = 'IN_PROGRESS') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
     CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
     CHECK (status NOT IN ('OPEN','SCHEDULED') OR next_check_at IS NOT NULL)
   );
   CREATE UNIQUE INDEX reconciliation_one_open_case ON reconciliation.cases (operation_id, case_type)
     WHERE status IN ('OPEN','SCHEDULED','IN_PROGRESS','REQUIRES_REVIEW');
   CREATE INDEX reconciliation_cases_due ON reconciliation.cases (next_check_at, created_at, id) WHERE status IN ('OPEN','SCHEDULED');
   CREATE INDEX reconciliation_cases_review ON reconciliation.cases (merchant_id, updated_at, id) WHERE status = 'REQUIRES_REVIEW';
   CREATE INDEX reconciliation_cases_lease ON reconciliation.cases (lease_expires_at) WHERE status = 'IN_PROGRESS';
   CREATE INDEX reconciliation_cases_payment ON reconciliation.cases (merchant_id, payment_id);
   ```
   `case_activity`: `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`, `case_id text COLLATE "C" NOT NULL REFERENCES reconciliation.cases(id)`, `activity_type text NOT NULL CHECK (activity_type IN ('SCHEDULED','LOOKUP','EVIDENCE_LINKED','ESCALATED','RESOLVED','DISMISSED','NOTE'))`, `provider_evidence_id text COLLATE "C"`, `actor_type text NOT NULL CHECK (actor_type IN ('SYSTEM','OPERATOR'))`, `actor_id text CHECK (actor_id IS NULL OR length(actor_id) <= 128)`, `detail jsonb NOT NULL CHECK (jsonb_typeof(detail)='object')`, `recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()`, `CHECK (actor_type <> 'OPERATOR' OR actor_id IS NOT NULL)`; index `(case_id, recorded_at, id)`; index `(provider_evidence_id) WHERE provider_evidence_id IS NOT NULL`. **[ASSUMPTION A9]** docs/07 describes `activity_type` as "Scheduled, lookup, evidence linked, escalated, or resolved"; `DISMISSED` and `NOTE` are added for dismissal and operator investigation notes (docs/08 §Manual review "attach an immutable investigation note"). Recorded as risk R3.
   `case_activity.provider_evidence_id` FK: add composite FK is not possible (no merchant column); add plain `FOREIGN KEY (provider_evidence_id) REFERENCES providers.provider_evidence(id)`.
3. Evidence FK: `ALTER TABLE providers.provider_evidence ADD CONSTRAINT provider_evidence_case_fk FOREIGN KEY (merchant_id, operation_id, reconciliation_case_id) REFERENCES reconciliation.cases (merchant_id, operation_id, id) DEFERRABLE INITIALLY DEFERRED;` This proves RECONCILIATION evidence belongs to a case for the same tenant and operation. Add index `provider_evidence (reconciliation_case_id) WHERE reconciliation_case_id IS NOT NULL`.
4. Triggers (owned by `reconciliation_function_owner`): `reconciliation.cases_guard` BEFORE UPDATE rejects changes to `id, merchant_id, payment_id, operation_id, case_type, expected_snapshot, created_at`, rejects any update from `RESOLVED`/`DISMISSED` (terminal case is one-way), requires `NEW.version = OLD.version + 1` and `NEW.updated_at >= OLD.updated_at`; BEFORE DELETE/TRUNCATE rejects. `case_activity` rejects UPDATE/DELETE/TRUNCATE.
5. RLS: enable on both tables; policy on `cases` `USING (merchant_id = current_setting('app.merchant_id', true))` for merchant-scoped reads (no merchant role is granted the table in MVP; this is defense in depth). `case_activity` gets no merchant policy (pure internal child).
6. Grants last: `REVOKE ALL ... FROM PUBLIC`; owner `fl_migration_owner`; `SELECT` on both tables to `fl_reconciler`, `fl_payment_worker`, `fl_webhook_worker`, `fl_operator_readonly`, `fl_operator_command`; no INSERT/UPDATE/DELETE to any runtime role. `reconciliation_function_owner` receives SELECT/INSERT/UPDATE on both tables plus SELECT on `payments.payments`, `payments.payment_operations`, `providers.provider_evidence`. `payments_function_owner` receives SELECT/INSERT/UPDATE on both tables (it creates/resolves cases inside payment transitions).

**Expected behavior** — inserting a second unresolved `AMBIGUOUS_OUTCOME` case for one operation as `fl_migration_owner` fails with `23505` on `reconciliation_one_open_case`; a `RESOLVED` case cannot be updated.

**Acceptance criteria**
- [ ] DDL column names/types/checks match docs/07 exactly (plus the documented assumption A9).
- [ ] Every runtime role fails INSERT/UPDATE/DELETE on both tables.
- [ ] RECONCILIATION evidence referencing a case of another operation fails at commit.

**Testing requirements** — `test/integration/reconciliation/cases-schema.test.ts` (fixture inserts as migration owner via the testkit fixture-helper convention): positive insert; ID regex; second open case same `(operation_id, case_type)` → `23505` from `reconciliation_one_open_case` (assert constraint name); different `case_type` allowed; resolved without `resolved_at` → `23514`; update after `RESOLVED` rejected by trigger; activity UPDATE/DELETE rejected; each runtime role (`fl_api`, `fl_payment_worker`, `fl_reconciler`, `fl_webhook_worker`, `fl_operator_command`) DML → `42501`; evidence with mismatched case/operation fails at COMMIT (deferred FK); cross-tenant case reference fails. Command: `pnpm vitest run --project integration test/integration/reconciliation/cases-schema.test.ts`.

**Non-goals** — No protected functions (T04+); no app code.

**Handoff checklist**
- [ ] Grants are the last statements in the file.
- [ ] Migration test from P07 populated fixture passes.

---

### P08-T03 — Recovery epoch fence for provider dispatch

**Task ID:** `P08-T03`
**Feature:** DR fencing epoch and worker dispatch fence
**Commit:** `feat(db): add recovery epoch fence for provider dispatch`
**Priority:** High
**Dependencies:** `P08-T02`
**Estimated complexity:** S
**Contract references:** docs/08 §Disaster recovery steps 1, 2, 6; docs/06 §Provider attempts and leases (lease fencing); docs/10 M8 "worker fencing", "disaster-recovery fencing epoch"
**Files:** create: `migrations/0810_recovery_epoch_fence.sql`, `test/integration/reconciliation/recovery-fence.test.ts`; modify: `packages/database/src/functions/payments.ts`, `packages/database/src/errors.ts`; must not touch: `migrations/06*`

**Objective** — Restore must start with provider writes fenced off under a new epoch (docs/08 §Disaster recovery). The contracts name no table for this; **[ASSUMPTION A10]** P08 adds append-only `payments.recovery_epochs` (risk R4). Worker lease fencing already exists (lease-token compare in `mark_dispatch`); this task adds the epoch fence on top.

**Implementation instructions**
1. Table:
   ```sql
   CREATE TABLE payments.recovery_epochs (
     id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     epoch bigint NOT NULL CHECK (epoch >= 1),
     provider_dispatch_enabled boolean NOT NULL,
     notification_application_enabled boolean NOT NULL,
     actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
     reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
     recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
   );
   INSERT INTO payments.recovery_epochs (epoch, provider_dispatch_enabled, notification_application_enabled, actor_id, reason)
   VALUES (1, true, true, 'migration', 'initial epoch');
   ```
   Trigger rejects UPDATE/DELETE/TRUNCATE. Current fence = row with max `id`.
2. `payments.current_recovery_fence() RETURNS payments.recovery_epochs` — `STABLE SECURITY DEFINER SET search_path = pg_catalog, payments`, returns the max-id row. EXECUTE to every runtime role.
3. `payments.begin_recovery_epoch(p_actor_id text, p_reason text) RETURNS bigint` — inserts `epoch = current.epoch + 1` with both flags `false`; returns the new epoch. `payments.set_recovery_flags(p_epoch bigint, p_dispatch boolean, p_application boolean, p_actor_id text, p_reason text) RETURNS void` — requires `p_epoch = current.epoch` (else raise `DISPATCH_FENCED` with DETAIL `{"currentEpoch":<n>}`), inserts a new row with the same epoch and given flags. Both functions: `SECURITY DEFINER`, owner `payments_function_owner`, EXECUTE only to `fl_operator_command`.
4. Fence enforcement: re-create `payments.claim_operation` and `payments.mark_dispatch` with their existing P06 signatures and bodies (copy verbatim from the highest-numbered migration defining each), adding as the first statement after argument validation: `IF NOT (payments.current_recovery_fence()).provider_dispatch_enabled THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DISPATCH_FENCED'; END IF;`. Do not change any other behavior.
5. TS wrappers in `packages/database/src/functions/payments.ts`: `currentRecoveryFence(client)`, `beginRecoveryEpoch(client, actorId, reason)`, `setRecoveryFlags(client, epoch, dispatch, application, actorId, reason)`. Add `DISPATCH_FENCED` to `errors.ts`.
6. Payment-worker handling of `DISPATCH_FENCED` from `claimOperation`: acknowledge the execute command with no effect (operation stays `REQUESTED`; the stale-`REQUESTED` sweeper rediscovers it after unfence). From `markDispatch`: the attempt is `RESERVED` with no dispatch mark — do not call the provider; leave it for lease expiry and `requeue_stale_pre_dispatch`. Implement in `apps/payment-worker` in P08-T05 (this task only provides the SQL and wrappers).

**Expected behavior** — after `begin_recovery_epoch`, `claim_operation` raises `DISPATCH_FENCED` and nothing changes; after `set_recovery_flags(epoch, true, true, …)` claims succeed.

**Acceptance criteria**
- [ ] `claim_operation` and `mark_dispatch` refuse with `DISPATCH_FENCED` while fenced, creating no attempt and no version change.
- [ ] Fence rows are append-only; only `fl_operator_command` can change flags.
- [ ] Bodies of `claim_operation`/`mark_dispatch` otherwise unchanged (P06 integration tests still green).

**Testing requirements** — `test/integration/reconciliation/recovery-fence.test.ts`: initial fence enabled; begin epoch → epoch 2, both false; claim refused (assert error code and that operation version and attempt count are unchanged — would fail if the fence check were missing); mark_dispatch refused with lease intact; stale epoch in `set_recovery_flags` rejected; `fl_payment_worker` cannot call `begin_recovery_epoch` (`42501`); update/delete of fence rows rejected. Re-run P06 claim/dispatch suites. Commands: `pnpm vitest run --project integration test/integration/reconciliation/recovery-fence.test.ts` and `pnpm test:integration`.

**Non-goals** — No CLI (T15); no notification gating (P09 reads the flag).

**Handoff checklist**
- [ ] Copied P06 function bodies verbatim apart from the fence check.
- [ ] `errors.ts` mapping added.

---

### P08-T04 — `payments.mark_unknown` with atomic case creation

**Task ID:** `P08-T04`
**Feature:** Ambiguous outcome transition
**Commit:** `feat(db): add mark_unknown with atomic reconciliation case`
**Priority:** Critical
**Dependencies:** `P08-T02`
**Estimated complexity:** L
**Contract references:** docs/07 §Protected payment transition functions (`mark_unknown`), §`reconciliation.cases`, §Transaction and lock ownership; docs/03 §Ambiguous outcomes, §Aggregate and operation version rules; docs/06 §Timeout and ambiguous-result policy; docs/08 §Provider result resolution (para after table); docs/04 §Reconciliation messages; schemas `events/payment-operation-reconciliation-required.v1.schema.json`, `commands/payment-operation-reconcile.v1.schema.json`
**Files:** create: `migrations/0820_mark_unknown.sql`, `test/integration/reconciliation/mark-unknown.test.ts`, `packages/database/src/envelopes/reconciliation.ts`; modify: `packages/database/src/functions/payments.ts`, `packages/database/src/errors.ts`; must not touch: `schemas/**`

**Objective** — One protected transaction moves a possibly dispatched nonterminal operation to `UNKNOWN`, clears its lease, increments payment and operation versions, keeps the exclusive pointer or refund reservation, creates exactly one open `AMBIGUOUS_OUTCOME` or `STALE_PROCESSING` case plus a `SCHEDULED` activity, and writes `payment.operation.reconciliation.required.v1` and `payment.operation.reconcile.v1`. Replay returns the existing case.

**Implementation instructions**
1. Signature: `payments.mark_unknown(p_operation_id text, p_expected_lease_token uuid, p_reason text, p_evidence_id text, p_lookup_not_before timestamptz, p_envelopes jsonb) RETURNS text` (case id). `SECURITY DEFINER`, `SET search_path = pg_catalog, payments, providers, reconciliation, messaging`, owner `payments_function_owner`, EXECUTE to `fl_payment_worker` only.
2. `p_reason` ∈ the closed vocabulary `TIMEOUT_AFTER_SEND`, `CONNECTION_LOST_AFTER_SEND`, `PROVIDER_5XX_AMBIGUOUS`, `SDK_EXCEPTION_AFTER_SEND`, `MALFORMED_PROVIDER_RESPONSE`, `MISSING_PROVIDER_CORRELATION`, `WORKER_CRASH_AFTER_SEND`, `STALE_PROCESSING`, `ADAPTER_DEFECT`; anything else → `OPERATION_NOT_AMBIGUITY_ELIGIBLE`.
3. Lock order (docs/07 §Canonical lock order): read the operation's `payment_id` without lock; `SELECT … FROM payments.payments WHERE id = … FOR UPDATE`; `SELECT … FROM payments.payment_operations WHERE id = … FOR UPDATE`; then the current attempt (`provider_attempts` with greatest `attempt_number`) `FOR UPDATE`.
4. Idempotent replay: if the operation is already `UNKNOWN` or `REQUIRES_REVIEW`, return the id of its unresolved `AMBIGUOUS_OUTCOME`/`STALE_PROCESSING` case without any write. If terminal or `REQUESTED` → `OPERATION_NOT_AMBIGUITY_ELIGIBLE`.
5. Eligibility for `PROCESSING`: the current attempt has nonnull `dispatch_marked_at` (possible transmission). `p_reason='STALE_PROCESSING'` additionally requires `lease_expires_at <= clock_timestamp()`; every other reason requires `lease_token = p_expected_lease_token` (else `LEASE_TOKEN_MISMATCH`). No dispatch mark → `OPERATION_NOT_AMBIGUITY_ELIGIBLE` (pre-dispatch work is requeued, never made `UNKNOWN`).
6. Evidence: when `p_evidence_id` is nonnull it must be an unapplied row for this operation with `observed_outcome = 'UNKNOWN'`, or a terminal outcome rejected by the boundary as `ADAPTER_DEFECT` (`FAILED` without proof cannot exist in DB, so in practice `UNKNOWN`). Mark it `applied_at = clock_timestamp(), application_kind = 'CASE_OBSERVATION'` (docs/07: `CASE_OBSERVATION` records neither version). Null evidence is allowed only for `STALE_PROCESSING` and `WORKER_CRASH_AFTER_SEND`.
7. Writes, in this order, in the same transaction:
   - Attempt: if state is `DISPATCH_MARKED` or `RESPONSE_RECEIVED`, set `state='COMPLETED', outcome_class='AMBIGUOUS', completed_at=clock_timestamp()` (the attempt trigger forbids `ABANDONED` after a dispatch mark).
   - Operation: `status='UNKNOWN', lease_token=NULL, lease_expires_at=NULL, version=version+1, updated_at=clock_timestamp()`. Do not touch `active_exclusive_operation_id`, reservation fields, totals, or `resolved_at`.
   - Payment: `version = version + 1, updated_at = clock_timestamp()` only.
   - Case: `case_type = CASE WHEN p_reason='STALE_PROCESSING' THEN 'STALE_PROCESSING' ELSE 'AMBIGUOUS_OUTCOME' END`, `status='SCHEDULED'`, `reason_code=p_reason`, `next_check_at = greatest(clock_timestamp() + interval '5 seconds', least(coalesce(p_lookup_not_before, clock_timestamp()), clock_timestamp() + interval '1 hour'))`, `expected_snapshot = jsonb_build_object('operationType',type,'amountMinor',amount_minor::text,'currency',currency,'providerAccountId',provider_account_id,'providerIdempotencyKey',provider_idempotency_key,'providerOperationId',provider_operation_id,'providerPaymentId',payments.provider_payment_id)`, id generated by the existing SQL ULID helper with prefix `case` (P02 helper; if none exists, the TS caller passes no id — **use the P02 helper**). Insert with `ON CONFLICT ON CONSTRAINT`-free logic: because the operation is locked and the replay branch already returned, a conflict here is an invariant error; let `23505` propagate.
   - Activity: `('SCHEDULED', p_evidence_id, 'SYSTEM', 'payment-worker', jsonb_build_object('reason',p_reason,'nextCheckAt',next_check_at))`.
   - Outbox: `p_envelopes` is a JSON array of exactly two envelopes built in TS: the event `payment.operation.reconciliation.required.v1` (`aggregateVersion` = new payment version; `data.reason = p_reason`, `data.unknownSince` = transition time, `data.nextAttemptAt` = case `next_check_at`, `data.providerAttemptId` = current attempt id, `data.redactedEvidenceRef` = evidence `redacted_evidence_reference` or `'attempt:' || attempt_id` when no evidence) and the command `payment.operation.reconcile.v1` (`aggregateVersion` = new payment version, `data.reason = CASE p_reason WHEN 'STALE_PROCESSING' THEN 'STALE_PROCESSING' ELSE 'AMBIGUOUS_RESPONSE' END`, `data.notBefore` = case `next_check_at`, `data.reconciliationAttempt = 1`). The function verifies each envelope's `type`, `aggregateId = payment_id`, `aggregateVersion = new version`, `data.operationId`, `data.reason`, `data.nextAttemptAt`/`data.notBefore` equal the computed values (TS computes `next_check_at` from the same formula with `database_now()` read inside the same transaction via `SELECT clock_timestamp()` before calling; on mismatch raise `STALE_ENVELOPE_VERSION` and the TS caller re-reads and retries). Then `PERFORM messaging.insert_outbox(e)` for each.
   **[ASSUMPTION A11]** To make the timestamp equality deterministic, TS passes the case `next_check_at` it computed in `p_envelopes` and the function uses `(p_envelopes->1->'data'->>'notBefore')::timestamptz` as `next_check_at` after verifying it lies within `[clock_timestamp()+5s−1s, clock_timestamp()+1h+1s]`. Prefer this over recomputation.
8. Envelope builders in `packages/database/src/envelopes/reconciliation.ts`: `buildReconciliationRequired(...)`, `buildReconcileCommand(...)` using `buildEnvelope()`; `source='flowledger.payment'`, `causationId` = triggering execute-command envelope id or `'sweeper:stale-processing'`.
9. TS wrapper `markUnknown(client, args)` returns `caseId`. Reason mapping helper `reconcileCommandReason(reason)` exported.

**Expected behavior** — PROCESSING capture, dispatch-marked, `TIMEOUT_AFTER_SEND` evidence → operation `UNKNOWN` (op v+1), payment v+1, pointer unchanged, one `SCHEDULED AMBIGUOUS_OUTCOME` case, two outbox rows; calling again returns the same case id with no new rows. A PROCESSING refund keeps `reserved_refund_amount_minor` and `unresolved_refund_count`.

**Acceptance criteria**
- [ ] Payment version +1, operation version +1, exactly one case, one activity, two outbox rows per first call; zero changes on replay.
- [ ] No change to confirmed totals, `authorization_outcome`, `active_exclusive_operation_id`, reservation fields, journal.
- [ ] Refused for no dispatch mark, terminal, `REQUESTED`, wrong lease token, live lease with `STALE_PROCESSING`.
- [ ] Both envelopes validate against their schemas (via `insert_outbox`).

**Testing requirements** — `test/integration/reconciliation/mark-unknown.test.ts`: (1) capture happy path (assert every field above); (2) refund keeps reservation and deferred trigger passes at commit; (3) replay idempotent — second call returns same id, `count(outbox)` unchanged; (4) 20 concurrent calls → one case, one pair of envelopes, payment version +1 exactly once; (5) no dispatch mark → `OPERATION_NOT_AMBIGUITY_ELIGIBLE`; (6) `STALE_PROCESSING` with live lease rejected; (7) wrong token rejected; (8) terminal op rejected; (9) envelope with wrong `aggregateVersion` → `STALE_ENVELOPE_VERSION` and full rollback (no case row); (10) evidence marked `CASE_OBSERVATION` with null applied versions; (11) `next_check_at` bounds: hint 2h ahead → clamped to 1h; null hint → now+5s. Command: `pnpm vitest run --project integration test/integration/reconciliation/mark-unknown.test.ts`.

**Non-goals** — No worker wiring (T05); no review transition (T10).

**Handoff checklist**
- [ ] Lock order payment → operation → attempt → case → outbox.
- [ ] Error codes added to `errors.ts`.

---

### P08-T05 — Worker routes ambiguity to `mark_unknown`; redelivery by status

**Task ID:** `P08-T05`
**Feature:** No-blind-retry worker behavior
**Commit:** `feat(worker): route ambiguous results to mark_unknown and fence dispatch`
**Priority:** Critical
**Dependencies:** `P08-T03`, `P08-T04`
**Estimated complexity:** M
**Contract references:** docs/06 §Provider attempts and leases (worker claim rules 1–10), §Timeout and ambiguous-result policy, §Error taxonomy; docs/08 §Worker claim and provider dispatch, §Provider result resolution row 1, §No-blind-retry rule; docs/04 §Inbox consumption; ADR-0004
**Files:** create: `apps/payment-worker/src/ambiguity.ts`, `apps/payment-worker/src/ambiguity.test.ts`, `test/integration/worker/redelivery-by-status.test.ts`; modify: `apps/payment-worker/src/execute-handler.ts` (or the P06 file that handles `payment.operation.execute.v1`); must not touch: `packages/providers/src/adapter.ts`

**Objective** — After this task the worker never leaves an ambiguous attempt in `PROCESSING` and never issues a second write for an `UNKNOWN`/`REQUIRES_REVIEW` operation, even if the adapter declares `SAME_KEY_REPLAY`.

**Implementation instructions**
1. `apps/payment-worker/src/ambiguity.ts` exports `classifyForPersistence(result: ProviderWriteResult): { kind: 'TERMINAL' | 'RETRYABLE_NO_EFFECT' | 'AMBIGUOUS'; reason?: ReconciliationReason }`. `UNKNOWN` → `AMBIGUOUS` with reason from `error.category`/code: `TRANSPORT_AMBIGUOUS`+timeout code → `TIMEOUT_AFTER_SEND`; connection loss → `CONNECTION_LOST_AFTER_SEND`; `PROVIDER_UNAVAILABLE` (5xx) → `PROVIDER_5XX_AMBIGUOUS`; `MALFORMED_RESPONSE` → `MALFORMED_PROVIDER_RESPONSE`; missing identity → `MISSING_PROVIDER_CORRELATION`; SDK exception → `SDK_EXCEPTION_AFTER_SEND`; `ADAPTER_DEFECT` → `ADAPTER_DEFECT`. Use the P06/P01 mapping table if one exists rather than duplicating it. Boundary validation: a `FAILED` without `noEffectProof`, a `RETRYABLE_NO_EFFECT` without proof/`RETRY_SAME_OPERATION`/future bounded `retryNotBefore`, or a `SUCCEEDED` missing `providerOperationId` is reclassified `AMBIGUOUS` with reason `ADAPTER_DEFECT` and logs `adapter_defect` at error level (redacted) (docs/08 §Provider result resolution row 1).
2. In the execute handler after the provider call: stage evidence (existing P06 path; an `ADAPTER_DEFECT` result is staged as `observed_outcome='UNKNOWN'` with category `ADAPTER_DEFECT`, directive `RECONCILE_FIRST`), then for `AMBIGUOUS` call `markUnknown(client, { operationId, expectedLeaseToken, reason, evidenceId, lookupNotBefore: result.lookupHint?.lookupNotBefore ?? null, envelopes })`. If staging itself throws after a possible write, call `markUnknown` with `evidenceId = null` and reason `WORKER_CRASH_AFTER_SEND`; if that also fails, return without ack-blocking (the stale sweeper owns it).
3. Redelivery rules at handler entry (reload operation, no provider call unless claim succeeds): terminal → ack; `UNKNOWN`/`REQUIRES_REVIEW` → ack (the case created atomically by `mark_unknown` is the recovery owner; log `execute_redelivered_ambiguous`); live `PROCESSING` → ack; stale `PROCESSING` → ack (sweeper owns); `REQUESTED` with `not_before` → ack; ready `REQUESTED` → claim. `DISPATCH_FENCED` from claim → ack; from `markDispatch` → return without calling provider.
4. Remove any code path, if present from P06/P07, that re-calls the provider for an operation not in a freshly claimed `RESERVED` attempt.
5. Add `crashPoint(...)` calls (from `packages/config/src/crash-points.ts`; names used by T16): `worker.before_claim`, `worker.after_claim_commit`, `worker.before_dispatch_mark`, `worker.after_dispatch_mark`, `worker.during_provider_call` (after request sent, before await resolves), `worker.after_provider_response`, `worker.during_result_commit` (inside the result transaction before COMMIT), `worker.after_result_commit`. Names P06 already added (`worker.before_claim`, `worker.after_claim_commit`, `worker.after_dispatch_mark`, `worker.during_provider_call`, `worker.after_provider_response`, `worker.after_result_commit`) are reused; only `worker.before_dispatch_mark` and `worker.during_result_commit` are new.

**Expected behavior** — simulator `TIMEOUT_AFTER_COMMIT` on a capture → operation `UNKNOWN`, one case, zero journal rows, `groundTruthEffects = 1`; redelivering the execute command 5 times creates no attempt and no provider request (simulator request count unchanged).

**Acceptance criteria**
- [ ] Every `UNKNOWN` adapter result commits `UNKNOWN` + case in the result transaction.
- [ ] No provider write for an operation in `UNKNOWN`/`REQUIRES_REVIEW`, including with an adapter declaring `SAME_KEY_REPLAY` for all types.
- [ ] Contract-violating adapter results become `UNKNOWN`/`ADAPTER_DEFECT`, never terminal.

**Testing requirements** — Unit `apps/payment-worker/src/ambiguity.test.ts`: each category → reason; FAILED-without-proof (constructed by casting, simulating a broken adapter) → `ADAPTER_DEFECT`; RETRYABLE_NO_EFFECT with past `retryNotBefore` → `ADAPTER_DEFECT`. Integration `test/integration/worker/redelivery-by-status.test.ts` (worker handler + simulator): redeliver execute for `REQUESTED`, live `PROCESSING`, stale `PROCESSING` pre- and post-dispatch, `UNKNOWN`, `REQUIRES_REVIEW` (fixture), `SUCCEEDED`, `REJECTED`, `FAILED`; assert simulator write count increments only for `REQUESTED`; repeat `UNKNOWN` case with adapter capabilities patched to `SAME_KEY_REPLAY` for every type → still zero writes; fenced claim → ack, no attempt. Commands: `pnpm vitest run --project unit apps/payment-worker/src/ambiguity.test.ts`, `pnpm vitest run --project integration test/integration/worker/redelivery-by-status.test.ts`.

**Non-goals** — No sweepers (T07); no reconciliation (T12).

**Handoff checklist**
- [ ] No provider call while a DB transaction is open (review the diff).
- [ ] Logs pass through the redaction allowlist; negative test with `packages/testkit/src/prohibited-data.ts` fixtures in the unit test.

---

### P08-T06 — Stale pre-dispatch requeue and stale-`REQUESTED` republish functions

**Task ID:** `P08-T06`
**Feature:** Protected sweeper transitions
**Commit:** `feat(db): add stale pre-dispatch requeue and stale requested republish`
**Priority:** Critical
**Dependencies:** `P08-T03`
**Estimated complexity:** M
**Contract references:** docs/07 §Protected payment transition functions (`requeue_stale_pre_dispatch`), §`providers.provider_attempts` (ABANDONED rule), §Schema acceptance tests (expired pre-dispatch lease bullet); docs/08 §Runbook: stale `REQUESTED` operation, §Runbook: stale `PROCESSING` operation; docs/03 §Aggregate and operation version rules
**Files:** create: `migrations/0830_stale_operation_functions.sql`, `test/integration/reconciliation/stale-functions.test.ts`; modify: `packages/database/src/functions/payments.ts`; must not touch: `migrations/06*`

**Objective** — Provide the two protected mutations sweepers need: reclaim an expired never-dispatched lease (same operation, same key, fresh execute command) and republish an execute command for a ready `REQUESTED` operation that has no recent command.

**Implementation instructions**
1. (Skip if P06 already installed it — assumption A7.) `payments.requeue_stale_pre_dispatch(p_operation_id text, p_expected_lease_token uuid, p_envelope jsonb) RETURNS void`: lock payment → operation → current attempt; require operation `PROCESSING`, `lease_token = p_expected_lease_token`, `lease_expires_at <= clock_timestamp()`, attempt `state='RESERVED'` and `dispatch_marked_at IS NULL` — otherwise raise `OPERATION_NOT_AMBIGUITY_ELIGIBLE` (a dispatch mark must route to `mark_unknown`). Then attempt → `ABANDONED`, `completed_at = clock_timestamp()`; operation → `REQUESTED`, lease fields null, `not_before` null, `version+1`; verify `p_envelope.type='payment.operation.execute.v1'`, `data.operationId`, `aggregateVersion = payments.version` (unchanged payment version; execute commands carry the observed version) and insert via `messaging.insert_outbox`. Payment row unchanged.
2. `payments.republish_stale_requested(p_operation_id text, p_envelope jsonb) RETURNS boolean`: lock payment → operation; return `false` without writes unless operation is `REQUESTED`, `not_before IS NULL`, `updated_at <= clock_timestamp() - interval '15 seconds'`, no unresolved `messaging.dead_letter_records` row with `operation_id = p_operation_id`, and no outbox row with `aggregate_id = payment_id AND message_type = 'payment.operation.execute.v1' AND recorded_at > clock_timestamp() - interval '60 seconds' AND envelope->'data'->>'operationId' = p_operation_id`. Otherwise insert `p_envelope` (same validation as step 1) and return `true`. No operation/payment version change (docs/03: appending work without changing the operation row does not increment). The 15 s threshold is the docs/08 "oldest > 15 seconds" warning; the 60 s window bounds republish to once per minute per operation.
3. Supporting index: `CREATE INDEX outbox_messages_aggregate_type_recorded ON messaging.outbox_messages (aggregate_id, message_type, recorded_at);` **[ASSUMPTION A12]** additive index on a P02 table; recorded as risk R5.
4. Both functions `SECURITY DEFINER`, owner `payments_function_owner`, EXECUTE to `fl_payment_worker` and `fl_operator_command`. TS wrappers `requeueStalePreDispatch`, `republishStaleRequested`.

**Expected behavior** — expired RESERVED attempt → attempt `ABANDONED`, op `REQUESTED` (op v+1), one execute envelope with the same `providerIdempotencyKey`-bound operation; DISPATCH_MARKED attempt → refused.

**Acceptance criteria**
- [ ] Requeue is exactly-once under concurrency and fails closed on any dispatch mark.
- [ ] Republish never changes versions, skips DLQ-blocked and recently enqueued operations.

**Testing requirements** — `test/integration/reconciliation/stale-functions.test.ts`: requeue happy path (attempt ABANDONED, op v+1, payment v unchanged, one outbox row, op key unchanged); 10 concurrent requeues → one success, others `OPERATION_NOT_AMBIGUITY_ELIGIBLE`/no-op; dispatch-marked → refused and no row changes; live lease → refused; republish: fresh op (<15 s) → false; stale op → true then immediately false (60 s window); DLQ-blocked → false; deferred `not_before` → false; payment/op versions unchanged. Command: `pnpm vitest run --project integration test/integration/reconciliation/stale-functions.test.ts`.

**Non-goals** — No sweeper loop (T07).

**Handoff checklist**
- [ ] Grants last in file.

---

### P08-T07 — Stale `REQUESTED`/`PROCESSING` and staged-evidence sweepers

**Task ID:** `P08-T07`
**Feature:** Recovery sweepers in the payment worker
**Commit:** `feat(worker): add stale operation and staged evidence sweepers`
**Priority:** Critical
**Dependencies:** `P08-T05`, `P08-T06`, `P08-T09`
**Estimated complexity:** M
**Contract references:** docs/08 §Sweep and claim defaults, §Runbook: stale `REQUESTED`, §Runbook: stale `PROCESSING`, §Durable provider evidence, §Recovery objectives and alerts, §Recovery observability (`stale_processing_total`); docs/06 §Provider attempts and leases
**Files:** create: `apps/payment-worker/src/sweepers/stale-operations.ts`, `apps/payment-worker/src/sweepers/staged-evidence.ts`, `test/integration/worker/stale-sweepers.test.ts`; modify: `apps/payment-worker/src/main.ts`, `packages/config/src/payment-worker.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/`

**Objective** — Sweepers are the durable backup when messages are lost: they rediscover stale `REQUESTED` work, reclaim pre-dispatch leases, move post-dispatch stale leases to `UNKNOWN`, and apply complete evidence that was staged but never applied.

**Implementation instructions**
1. Config (env, parsed in `packages/config/src/payment-worker.ts`): `STALE_SWEEP_INTERVAL_MS` default `15000`, `STALE_SWEEP_CLAIM_SIZE` default `100` (docs/08 §Sweep and claim defaults). Tests lower the interval.
2. Each sweep, outside any open transaction, select candidate ids (no locks): 
   - `REQUESTED` ready: `status='REQUESTED' AND not_before IS NULL AND updated_at <= now()-15s ORDER BY updated_at LIMIT n`.
   - stale `PROCESSING`: `status='PROCESSING' AND lease_expires_at <= now() ORDER BY lease_expires_at LIMIT n` (uses the docs/07 `(status, lease_expires_at)` index).
   Then handle each candidate in its own short transaction (one sweep transaction per row, no network I/O). Rows locked by others are skipped: the protected functions lock with `FOR UPDATE`; wrap each call with `SET LOCAL lock_timeout = '100ms'` and treat `55P03` as skip.
3. `REQUESTED` → `republishStaleRequested(opId, buildExecuteEnvelope(op))`.
4. Stale `PROCESSING` decision per current attempt:
   - `RESERVED` and no dispatch mark → `requeueStalePreDispatch`.
   - Dispatch marked and an unapplied terminal evidence row (`SUCCEEDED`/`REJECTED`/`FAILED`) exists from this attempt (`provider_attempt_id`) → `applyProviderEvidence(evidenceId)` (docs/08: "If a complete verified result is already durable, apply that result instead of calling the provider").
   - Dispatch marked and unapplied `RETRYABLE_NO_EFFECT` evidence from this attempt → `scheduleSameOperationRetry(evidenceId, retryNotBefore)`.
   - Otherwise → `markUnknown({ reason: 'STALE_PROCESSING', expectedLeaseToken: op.lease_token, evidenceId: <unapplied UNKNOWN evidence from this attempt or null>, lookupNotBefore: null })`; increment counter `stale_processing_total` (labels: provider, operation type only).
5. Staged-evidence sweeper (`staged-evidence.ts`, same interval): select `provider_evidence WHERE applied_at IS NULL AND received_at <= now() - interval '30 seconds' ORDER BY received_at LIMIT n` (docs/07 partial index). For each: if its operation is `PROCESSING` the stale sweeper owns it (skip); if operation is `UNKNOWN`/`REQUIRES_REVIEW` and outcome terminal → `applyProviderEvidence`; if the operation is terminal → `applyProviderEvidence` (P07 routes to `CORROBORATION`/`DISCREPANCY`); `UNKNOWN`/authorization-observation evidence for reconciliation sources is owned by the reconciler (skip). **[ASSUMPTION A13]** P07 does not already run an unapplied-evidence recovery loop; if it does, extend it instead of adding this file (risk R6).
6. Register both sweepers in `apps/payment-worker/src/main.ts` with graceful shutdown (stop timers, await in-flight sweep).

**Expected behavior** — kill the worker after dispatch mark; after lease expiry (+ ≤ one interval) the operation is `UNKNOWN` with a `STALE_PROCESSING` case; kill before dispatch mark → operation reclaimed and executed once.

**Acceptance criteria**
- [ ] Bounded batches (≤ claim size) and no network I/O inside any transaction.
- [ ] Each stale-`PROCESSING` branch routes exactly as step 4; no branch issues a provider write.
- [ ] `stale_processing_total` uses only bounded labels.

**Testing requirements** — `test/integration/worker/stale-sweepers.test.ts` (sweeper functions invoked directly with a fake clock offset by DB fixture timestamps): (1) stale REQUESTED republished once per 60 s; (2) RESERVED expired → requeued; (3) DISPATCH_MARKED expired, no evidence → `UNKNOWN`/`STALE_PROCESSING` case; (4) dispatch-marked with unapplied SUCCEEDED capture evidence → applied, exactly one journal row, no case; (5) dispatch-marked with unapplied RETRYABLE_NO_EFFECT → rescheduled `REQUESTED` with `not_before`; (6) staged terminal evidence for `UNKNOWN` op older than 30 s → applied and case resolved (requires T09, hence the dependency); (7) two sweepers concurrently over 200 stale rows → each row transitions once (count versions). Command: `pnpm vitest run --project integration test/integration/worker/stale-sweepers.test.ts`.

**Non-goals** — No reconciliation lookups.

**Handoff checklist**
- [ ] New env vars in `.env.example` and `docs/CONFIG.md`.

---

### P08-T08 — Case claim, observation, recheck, and note functions

**Task ID:** `P08-T08`
**Feature:** Reconciliation case workflow (protected)
**Commit:** `feat(db): add reconciliation case claim and observation functions`
**Priority:** Critical
**Dependencies:** `P08-T04`
**Estimated complexity:** M
**Contract references:** docs/07 §`reconciliation.cases` (claim bullet, expiry bullet), §`providers.provider_evidence` (CASE_OBSERVATION, next_check_not_before, conclusive/nonconclusive absence shapes), §Transaction and lock ownership (Reconcile unknown outcome, Check authorization expiry); docs/06 §Reconciliation lookup and evidence (retryAfterMs persistence); docs/08 §Sweep and claim defaults (due reconciliation scheduler: 5 s, 100, 30 s lease), §Manual review contract
**Files:** create: `migrations/0840_reconciliation_case_functions.sql`, `packages/database/src/functions/reconciliation.ts`, `test/integration/reconciliation/case-functions.test.ts`; modify: `packages/database/src/errors.ts`, `packages/database/src/functions/providers.ts` (add `stageReconciliationEvidence`); must not touch: `migrations/07*`

**Objective** — Give the reconciler crash-safe, lease-fenced case work: claim due cases (`SKIP LOCKED`, attempt number committed before provider I/O), record inconclusive/active observations by rescheduling from the persisted evidence time, let operators request a recheck and attach notes without any state edit.

**Implementation instructions** — all functions `SECURITY DEFINER`, `SET search_path = pg_catalog, reconciliation, payments, providers`, owner `reconciliation_function_owner`.
1. `reconciliation.claim_due_cases(p_batch_size integer, p_lease_ms integer) RETURNS TABLE (case_id text, case_type text, operation_id text, payment_id text, merchant_id text, attempt_number integer, lease_token uuid, case_version bigint)`. Select `status IN ('OPEN','SCHEDULED') AND next_check_at <= clock_timestamp()` **or** `status = 'IN_PROGRESS' AND lease_expires_at <= clock_timestamp()` (stale lease recovery), `ORDER BY next_check_at NULLS FIRST, created_at, id LIMIT least(p_batch_size,100) FOR UPDATE SKIP LOCKED`; update each: `status='IN_PROGRESS', attempt_count=attempt_count+1, lease_token=gen_random_uuid(), lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_ms/1000.0), version=version+1`; insert activity `('LOOKUP','SYSTEM','reconciler',{attemptNumber})`. `p_lease_ms` must be between 5000 and 300000. EXECUTE: `fl_reconciler`.
2. `reconciliation.record_case_observation(p_case_id text, p_lease_token uuid, p_evidence_id text) RETURNS text` (new status). Lock order: payment → operation → case (`FOR UPDATE`); require case `IN_PROGRESS` with matching `lease_token` (else `CASE_LEASE_MISMATCH`). Evidence must be unapplied, `source='RECONCILIATION'`, `reconciliation_case_id = p_case_id`, `reconciliation_attempt_number = case.attempt_count`, and `observed_outcome IN ('UNKNOWN','AUTHORIZATION_ACTIVE','AUTHORIZATION_INCONCLUSIVE')` with nonnull future `next_check_not_before` (else `EVIDENCE_NOT_APPLICABLE`). Writes: evidence `applied_at, application_kind='CASE_OBSERVATION'`; case `status = CASE WHEN op.status='REQUIRES_REVIEW' THEN 'REQUIRES_REVIEW' ELSE 'SCHEDULED' END`, `next_check_at = CASE … 'REQUIRES_REVIEW' THEN NULL ELSE evidence.next_check_not_before END`, lease null, `observed_snapshot` = `{lastOutcome, lastErrorCode, consecutiveInconclusive}` where `consecutiveInconclusive` = previous value + 1 for `UNKNOWN`/`AUTHORIZATION_INCONCLUSIVE` and 0 for `AUTHORIZATION_ACTIVE`, `version+1`; activity `('EVIDENCE_LINKED', evidence id)`. Payment and operation rows unchanged (docs/03: changing only case scheduling does not change payment version). EXECUTE: `fl_reconciler`.
3. `reconciliation.release_case_lease(p_case_id text, p_lease_token uuid, p_next_check_at timestamptz) RETURNS void` — for a lookup that could not even stage evidence (adapter threw/shutdown): `IN_PROGRESS` + token match → `SCHEDULED`, `next_check_at = greatest(p_next_check_at, clock_timestamp()+5s)`, lease null, version+1, activity `('SCHEDULED',…{reason:'LOOKUP_ABORTED'})`. EXECUTE: `fl_reconciler`.
4. `reconciliation.escalate_expiry_case(p_case_id text) RETURNS void` — called by the reconciler in the same transaction right after `record_case_observation`; only `AUTHORIZATION_EXPIRY` cases in `SCHEDULED` with no lease whose `observed_snapshot.consecutiveInconclusive >= 5` (else `CASE_NOT_ESCALATABLE`): → `REQUIRES_REVIEW`, `next_check_at` null, lease null, version+1, activity `ESCALATED`. No payment/operation change and no event (the review event requires an `UNKNOWN` operation; **[ASSUMPTION A14]**, risk R7). EXECUTE: `fl_reconciler`.
5. `reconciliation.request_manual_recheck(p_case_id text, p_actor_id text, p_reason text) RETURNS bigint` (new case version): case must be `SCHEDULED`, `OPEN`, or `REQUIRES_REVIEW` (else `CASE_NOT_ESCALATABLE`); → `status='SCHEDULED', next_check_at=clock_timestamp()`, version+1; activity `('SCHEDULED','OPERATOR',p_actor_id,{reason:p_reason, manualRecheck:true})`. `p_actor_id`/`p_reason` nonempty (else `OPERATOR_IDENTITY_REQUIRED`). Read-only lookup only — no operation change. EXECUTE: `fl_operator_command`.
6. `reconciliation.attach_case_note(p_case_id text, p_actor_id text, p_reason text, p_evidence_reference text) RETURNS bigint` (activity id): appends `('NOTE','OPERATOR',p_actor_id,{reason, externalEvidenceReference})`; `p_evidence_reference` ≤ 500 chars and must not contain a PAN-like digit run `[0-9]{13,19}` (else `EVIDENCE_NOT_APPLICABLE`). Does not change case version or status. EXECUTE: `fl_operator_command`.
7. `providers.stage_reconciliation_evidence(p_case_id text, p_lease_token uuid, p_evidence jsonb) RETURNS TABLE (evidence_id text, stage_result text)` (owner and grant pattern identical to P06's `providers.stage_attempt_evidence`; EXECUTE `fl_reconciler`): lock the case `FOR UPDATE`, require `IN_PROGRESS` with matching `lease_token` (else `CASE_LEASE_MISMATCH`); insert `providers.provider_evidence` with `source='RECONCILIATION'`, `source_reference = p_case_id || ':' || case.attempt_count`, `reconciliation_case_id = p_case_id`, `reconciliation_attempt_number = case.attempt_count`, operation/merchant/account from the case's operation (never from `p_evidence`), `received_at = clock_timestamp()`, `ON CONFLICT (provider_account_id, source, source_reference) DO NOTHING`; then read/compare exactly as `stage_attempt_evidence`: same `evidence_hash` → `DUPLICATE` with the existing id; different hash → insert `provider_identity_conflicts` and return `CONFLICT`; new row → `STAGED`.
8. TS wrappers in `packages/database/src/functions/reconciliation.ts`, one per function, camelCase; `stageReconciliationEvidence` in `packages/database/src/functions/providers.ts`.

**Expected behavior** — claim on a due case returns `attempt_number = 1` and commits `IN_PROGRESS`; a second claimer gets nothing; after lease expiry it is reclaimable with `attempt_number = 2`.

**Acceptance criteria**
- [ ] Claimed attempt number is committed before any lookup, and evidence identity uses it (`caseId:attemptNumber`).
- [ ] Observations never change payment or operation version.
- [ ] Operator functions require actor and reason, append activity, and cannot change operation/payment state.

**Testing requirements** — `test/integration/reconciliation/case-functions.test.ts`: claim respects `next_check_at`; 10 concurrent claimers over 50 due cases → each claimed once (SKIP LOCKED); expired lease reclaimed with incremented attempt; observation with wrong token → `CASE_LEASE_MISMATCH`; observation with evidence from previous attempt number → `EVIDENCE_NOT_APPLICABLE`; observation reschedules at evidence `next_check_not_before` exactly; payment/op versions unchanged (assert before/after); REQUIRES_REVIEW op → case returns to `REQUIRES_REVIEW`; manual recheck on resolved case rejected; note appends without version change; `fl_reconciler` cannot call operator functions (`42501`); `stage_reconciliation_evidence` — wrong lease token → `CASE_LEASE_MISMATCH`, restage same case:attempt same hash → `DUPLICATE` same id, changed hash → `CONFLICT` + conflict row. Command: `pnpm vitest run --project integration test/integration/reconciliation/case-functions.test.ts`.

**Non-goals** — Terminal resolution (T09), review transition (T10), expiry application (T11).

**Handoff checklist**
- [ ] Grants last; wrappers exported.

---

### P08-T09 — Case resolution, expiry-case lifecycle, and discrepancy cases in the evidence path

**Task ID:** `P08-T09`
**Feature:** Resolve ambiguity through the same transition/ledger path
**Commit:** `feat(db): resolve reconciliation cases in apply_provider_evidence`
**Priority:** Critical
**Dependencies:** `P08-T08`
**Estimated complexity:** L
**Contract references:** docs/07 §Protected payment transition functions (`apply_provider_evidence`), §`reconciliation.cases` (expiry bullet, AMBIGUOUS/STALE bullet); docs/03 §Ambiguous outcomes items 6–8, §Racing resolution signals, §Authorization-expiry workflow; docs/06 §Normalized write results (authorization success shape), §Authorization-expiry lookup; docs/08 §Provider result resolution (paragraph after table)
**Files:** create: `migrations/0850_evidence_case_resolution.sql`, `test/integration/reconciliation/evidence-case-resolution.test.ts`; modify: `packages/database/src/functions/payments.ts` (signature unchanged unless P07's differs); must not touch: `migrations/07*` (new migration replaces the functions)

**Objective** — Extend the single-owner `payments.apply_provider_evidence` (README §5.4 item 4) so that: (a) it accepts `UNKNOWN`/`REQUIRES_REVIEW` operations and resolves their open ambiguity/stale case atomically, (b) authorization success creates the one `AUTHORIZATION_EXPIRY` case, (c) capture/cancel success dismisses an open expiry case. Contradictory evidence is handled in P08-T17, not here.

**Implementation instructions**
1. Copy the current `CREATE FUNCTION payments.apply_provider_evidence` definition verbatim from the highest-numbered migration that defines it, into `0850_evidence_case_resolution.sql`, as `CREATE OR REPLACE` with identical signatures. Make only the changes below.
2. `apply_provider_evidence`:
   - Allowed source states for a terminal transition become `PROCESSING`, `UNKNOWN`, `REQUIRES_REVIEW` (docs/03 Authorize diagram). `REQUESTED` stays rejected.
   - Lock order: payment → operation → (new) `SELECT … FROM reconciliation.cases WHERE operation_id = op AND case_type IN ('AMBIGUOUS_OUTCOME','STALE_PROCESSING') AND status IN ('OPEN','SCHEDULED','IN_PROGRESS','REQUIRES_REVIEW') FOR UPDATE` → (if authorization payment) expiry case `FOR UPDATE` → ledger (via `ledger.post_payment_operation`) → outbox.
   - Accept evidence of any source (`API_RESPONSE`, `PROVIDER_WEBHOOK`, `RECONCILIATION`). For `RECONCILIATION`, require the evidence's `reconciliation_case_id` equals the locked case id when the operation is nonterminal. A lease held by the reconciler on that case does not block resolution by another source (a webhook may win); the resolution clears the lease.
   - When the operation was `UNKNOWN`/`REQUIRES_REVIEW` and the transition is terminal: in the same transaction set the case `status='RESOLVED', resolved_at=clock_timestamp(), resolution_code = 'RESOLVED_' || new_status` (`RESOLVED_SUCCEEDED`/`RESOLVED_REJECTED`/`RESOLVED_FAILED`), `next_check_at=NULL`, lease null, version+1; activity `('RESOLVED', evidence_id, 'SYSTEM', <source>)`. Assert (raise invariant) that an `UNKNOWN`/`REQUIRES_REVIEW` operation has exactly one such case.
   - Terminal event `resolutionSource` = evidence `source` (already P07 behavior; verify).
   - Authorization `SUCCEEDED`: reject (keep existing P07 error) unless evidence has nonnull `provider_payment_id`, `provider_operation_id`, `provider_authorization_id`. Insert `AUTHORIZATION_EXPIRY` case: `status='SCHEDULED'`, `reason_code='AUTHORIZATION_EXPIRY'`, `operation_id` = the authorization operation, `next_check_at = coalesce(evidence.authorization_expires_at, clock_timestamp() + make_interval(secs => (account_version.configuration->'authorizationExpiry'->>'initialCheckAfterSeconds')::int))` read from `providers.provider_account_versions` for the payment's bound `(provider_account_id, provider_account_version)`; `expected_snapshot = {providerAccountId, providerPaymentId, providerAuthorizationId, expectedAmountMinor, currency}`; activity `SCHEDULED`. **[ASSUMPTION A15]** the immutable account configuration stores the capability field `authorizationExpiry.initialCheckAfterSeconds`; if P02/P06 stored it under another JSON path, read that path (risk R8).
   - Capture `SUCCEEDED` or cancel `SUCCEEDED`: set any open `AUTHORIZATION_EXPIRY` case for the payment's successful authorization operation to `DISMISSED`, `resolution_code = 'DISMISSED_BY_CAPTURE'|'DISMISSED_BY_CANCEL'`, `resolved_at`, lease/next null, version+1; activity `DISMISSED`.
   - Operation-version/payment-version behavior otherwise unchanged.
3. Grants: preserve P07's EXECUTE grants; additionally `GRANT EXECUTE` on `apply_provider_evidence` to `fl_reconciler` and `fl_webhook_worker` (P09 uses it).

**Expected behavior** — `UNKNOWN` capture + RECONCILIATION SUCCEEDED evidence → op `SUCCEEDED` (`resolution_source='RECONCILIATION'`), one journal transaction with the original posting key, case `RESOLVED`, pointer cleared, terminal event with `resolutionSource=RECONCILIATION`. Authorization success creates exactly one `SCHEDULED` expiry case; later capture success dismisses it.

**Acceptance criteria**
- [ ] No terminal operation leaves an `OPEN/SCHEDULED/IN_PROGRESS/REQUIRES_REVIEW` ambiguity/stale case.
- [ ] Authorization success without the three provider references cannot commit.
- [ ] Exactly one expiry case per successful authorization; dismissed atomically by capture/cancel success.
- [ ] All P07 integration tests still pass unchanged.

**Testing requirements** — `test/integration/reconciliation/evidence-case-resolution.test.ts`: (1) UNKNOWN capture resolved by RECONCILIATION SUCCEEDED → one journal row, case RESOLVED, posting key = original; (2) UNKNOWN refund resolved REJECTED → reservation released, `fee_effect_amount_minor` null, case RESOLVED; (3) REQUIRES_REVIEW resolved by webhook-source evidence fixture; (4) resolution while reconciler holds case lease → succeeds and clears lease; (5) re-applying the same evidence → no-op (versions unchanged); (6) second terminal evidence agreeing → `CORROBORATION`, no version change; contradicting evidence stays unapplied here (routing added by T17); (7) authorization success creates one expiry case with `next_check_at` = provider expiry hint; without hint = now + configured seconds; (8) authorization success missing `provider_authorization_id` → rejected, no case, no transition; (9) capture success dismisses expiry case; cancel success dismisses; (10) rollback: inject failure (fixture-raised exception via a test-only trigger installed in the test transaction) after case update → nothing visible. Re-run `pnpm test:integration`. Command: `pnpm vitest run --project integration test/integration/reconciliation/evidence-case-resolution.test.ts`.

**Non-goals** — Expiry application (T11).

**Handoff checklist**
- [ ] Diff vs P07 function body reviewed line by line; only the listed changes.
- [ ] `flowledger verify` zero findings after the test DB run.

---

### P08-T10 — `payments.require_operation_review`

**Task ID:** `P08-T10`
**Feature:** Exhaustion and audited escalation to review
**Commit:** `feat(db): add require_operation_review transition`
**Priority:** Critical
**Dependencies:** `P08-T09`
**Estimated complexity:** M
**Contract references:** docs/07 §Protected payment transition functions (`require_operation_review`), §Schema acceptance tests (exhausted reconciliation bullet); docs/03 §Ambiguous outcomes, §Aggregate and operation version rules; docs/08 §Manual review contract, §Operator authority; schema `events/payment-operation-review-required.v1.schema.json`
**Files:** create: `migrations/0860_require_operation_review.sql`, `test/integration/reconciliation/require-review.test.ts`; modify: `packages/database/src/functions/payments.ts`, `packages/database/src/envelopes/reconciliation.ts`; must not touch: `schemas/**`

**Objective** — Move the same `UNKNOWN` operation to `REQUIRES_REVIEW` when automated policy is exhausted (or on audited operator escalation), keeping all holds, advancing payment and operation versions once, and emitting `payment.operation.review.required.v1` — without accepting any outcome data.

**Implementation instructions**
1. Signature: `payments.require_operation_review(p_case_id text, p_expected_case_version bigint, p_reason text, p_actor_id text, p_envelopes jsonb) RETURNS void`. **[ASSUMPTION A16]** docs/07 names `(case_id, expected_case_version)`; the review event's `reason` enum includes `OPERATOR_ESCALATION` and `PROVIDER_LOOKUP_UNAVAILABLE`, so `p_reason` and `p_actor_id` are added (risk R2). `p_reason` ∈ `AUTOMATED_RECONCILIATION_EXHAUSTED`, `PROVIDER_LOOKUP_UNAVAILABLE`, `OPERATOR_ESCALATION`.
2. Lock payment → operation → case. Require: case type `AMBIGUOUS_OUTCOME` or `STALE_PROCESSING`, case `version = p_expected_case_version` (else `CASE_VERSION_MISMATCH`), operation `UNKNOWN` (else `CASE_NOT_ESCALATABLE`).
   - `AUTOMATED_RECONCILIATION_EXHAUSTED`/`PROVIDER_LOOKUP_UNAVAILABLE`: caller must be `fl_reconciler` (`session_user`), case `SCHEDULED` or `IN_PROGRESS` and `attempt_count >= 5` (else `RECONCILIATION_POLICY_NOT_EXHAUSTED`); the reconciler calls it right after `record_case_observation` in the same transaction (P08-T12 step 5e); `p_actor_id` ignored (activity actor `SYSTEM`/`reconciler`).
   - `OPERATOR_ESCALATION`: caller must be `fl_operator_command`, `p_actor_id` nonempty (else `OPERATOR_IDENTITY_REQUIRED`); case may be `OPEN`/`SCHEDULED` (not `IN_PROGRESS` — the reconciler owns a leased case; retry after it completes).
3. Writes: operation `status='REQUIRES_REVIEW'`, lease null, version+1; payment version+1; case `status='REQUIRES_REVIEW'`, `next_check_at=NULL`, lease null, version+1; activity `('ESCALATED', NULL, actor_type, actor_id, {reason, automatedAttempts: attempt_count})`. Exclusive pointer and refund reservation untouched.
4. `p_envelopes` = one `payment.operation.review.required.v1` envelope: `aggregateVersion` = new payment version, `data.caseId = p_case_id`, `data.reason = p_reason`, `data.automatedAttempts = greatest(case.attempt_count,1)`, `data.evidenceRefs` = distinct `redacted_evidence_reference` of evidence linked to this case (at least one; when none exists use `'case:' || p_case_id`), `data.providerAttemptId` = latest attempt id. Verify and insert via `messaging.insert_outbox`.
5. There is no parameter for outcome, amount, status, or provider key; the function signature itself is the guard (docs/07 "cannot accept operator-supplied financial outcome data").
6. EXECUTE to `fl_reconciler` and `fl_operator_command`. TS wrapper `requireOperationReview`; builder `buildReviewRequired`.

**Expected behavior** — exhausted UNKNOWN refund → `REQUIRES_REVIEW`, reservation unchanged, payment v+1, op v+1, one review event; a later verified SUCCEEDED evidence resolves it through T09.

**Acceptance criteria**
- [ ] Holds retained; versions +1 each exactly once; one event.
- [ ] Rejected before exhaustion for automated reasons; operator escalation requires identity and role.
- [ ] Conflicting commands remain blocked (`ACTIVE_OPERATION_EXISTS` on capture/cancel acceptance for an exclusive op in review).

**Testing requirements** — `test/integration/reconciliation/require-review.test.ts`: exhausted path; `attempt_count = 4` → `RECONCILIATION_POLICY_NOT_EXHAUSTED`; stale case version → `CASE_VERSION_MISMATCH`; terminal op → `CASE_NOT_ESCALATABLE`; operator escalation without actor → `OPERATOR_IDENTITY_REQUIRED`; `fl_reconciler` cannot use `OPERATOR_ESCALATION`; reservation and pointer unchanged (deferred trigger passes); API capture acceptance on payment with REQUIRES_REVIEW authorization → `409 ACTIVE_OPERATION_EXISTS` (via `payments.accept_operation`); refund acceptance while an exclusive op is in review → rejected; second call → `CASE_NOT_ESCALATABLE`; envelope validates. Command: `pnpm vitest run --project integration test/integration/reconciliation/require-review.test.ts`.

**Non-goals** — No CLI (T14).

**Handoff checklist**
- [ ] Grants last; errors mapped.

---

### P08-T11 — `payments.record_authorization_expiry`

**Task ID:** `P08-T11`
**Feature:** Guarded authorization expiry
**Commit:** `feat(db): add guarded authorization expiry transition`
**Priority:** Critical
**Dependencies:** `P08-T09`, `P08-T07`
**Estimated complexity:** M
**Contract references:** docs/07 §Protected payment transition functions (`record_authorization_expiry`), §`providers.provider_evidence` (AUTHORIZATION_* shapes); docs/03 §Authorization-expiry workflow, §MVP policy decisions (authorization expiry); docs/06 §Authorization-expiry lookup; schema `events/payment-authorization-expired.v1.schema.json`
**Files:** create: `migrations/0870_record_authorization_expiry.sql`, `test/integration/reconciliation/authorization-expiry.test.ts`; modify: `packages/database/src/functions/payments.ts`, `packages/database/src/envelopes/reconciliation.ts`, `apps/payment-worker/src/sweepers/staged-evidence.ts`; must not touch: `migrations/07*`

**Objective** — Apply expiry only from explicit `AUTHORIZATION_EXPIRED` evidence (webhook or lookup), under the payment lock, only when the authorization is still unused; otherwise dismiss or defer — never infer from time or absence, never mutate the authorization operation.

**Implementation instructions**
1. Signature: `payments.record_authorization_expiry(p_evidence_id text, p_envelopes jsonb) RETURNS text` returning `'APPLIED' | 'DISMISSED' | 'DEFERRED' | 'DUPLICATE'`.
2. Load evidence; require `observed_outcome='AUTHORIZATION_EXPIRED'`, source `RECONCILIATION` or `PROVIDER_WEBHOOK`, subject operation is the payment's `SUCCEEDED` `AUTHORIZE` operation (else `EVIDENCE_NOT_APPLICABLE`). If `applied_at IS NOT NULL` → return `'DUPLICATE'` (no writes).
3. Lock payment → authorization operation (`FOR UPDATE`, read only) → open `AUTHORIZATION_EXPIRY` case (`FOR UPDATE`).
4. Reference match: evidence `provider_account_id`, `provider_payment_id`, `provider_authorization_id` equal the payment's binding/append-once references (else `EVIDENCE_NOT_APPLICABLE` — mismatched references are a discrepancy concern for the caller to route to `record_discrepancy`).
5. Branches:
   - Capture or cancel already succeeded (`captured_amount_minor > 0` or `authorization_outcome='CANCELED'`): mark evidence `applied_at, application_kind='CORROBORATION'` (nonapplicable evidence retained, docs/03), dismiss any still-open expiry case (`DISMISSED_LATE_EXPIRY`), return `'DISMISSED'`. No payment change.
   - `authorization_outcome='EXPIRED'` already: evidence → `CORROBORATION`; return `'DUPLICATE'`.
   - `active_exclusive_operation_id IS NOT NULL OR unresolved_refund_count > 0`: leave evidence unapplied, return `'DEFERRED'` (the staged-evidence sweeper / next lookup reapplies after the operation resolves). No writes.
   - Guard holds (`authorization_outcome='AUTHORIZED'`, captured/refunded/voided all zero, pointer null, unresolved refunds zero): payment `authorization_outcome='EXPIRED'`, `voided_amount_minor = authorized_amount_minor`, version+1, `updated_at`; evidence `applied_at, application_kind='AUTHORIZATION_EXPIRY', applied_payment_version = new version`; case `RESOLVED`, `resolution_code='EXPIRED'`, lease/next null, version+1; activity `RESOLVED`; insert the one `payment.authorization.expired.v1` envelope from `p_envelopes` after verifying `aggregateVersion`, `data.operationId` = authorization op, `data.resolutionSource` = evidence source, `data.totalsAfter.voidedAmountMinor = authorized`. Return `'APPLIED'`. The authorization operation row and version are not touched.
6. EXECUTE to `fl_reconciler`, `fl_webhook_worker`, `fl_payment_worker`. Wrapper `recordAuthorizationExpiry`; builder `buildAuthorizationExpired`. Extend the T07 staged-evidence sweeper to call `recordAuthorizationExpiry` for unapplied `AUTHORIZATION_EXPIRED` evidence older than 30 s (re-attempts `DEFERRED` evidence after the blocking operation resolves).

**Expected behavior** — AUTHORIZED payment + expired evidence → `EXPIRED`, voided = authorized, payment v+1, auth op version unchanged, one event; repeated → `DUPLICATE`.

**Acceptance criteria**
- [ ] Only `AUTHORIZATION_EXPIRED` evidence can expire a payment.
- [ ] Authorization operation version and status never change.
- [ ] Expiry vs capture/cancel acceptance serializes on the payment lock with exactly one valid ordering.

**Testing requirements** — `test/integration/reconciliation/authorization-expiry.test.ts`: (1) apply happy path; (2) duplicate → `DUPLICATE`, versions unchanged; (3) `AUTHORIZATION_ACTIVE`/`AUTHORIZATION_INCONCLUSIVE`/`UNKNOWN NOT_FOUND` evidence → `EVIDENCE_NOT_APPLICABLE` and payment unchanged; (4) mismatched provider authorization id → rejected; (5) race: 50 iterations of concurrent `accept_operation(CAPTURE)` vs `record_authorization_expiry` — assert exactly one of {capture accepted, expiry applied}, and when capture accepted first the expiry returns `DEFERRED`; when expiry first the capture gets `409 INVALID_PAYMENT_STATE`; (6) same race with cancel; (7) capture succeeded then expiry evidence → `DISMISSED`, case dismissed, payment unchanged; (8) auth op version identical before/after in every case. Command: `pnpm vitest run --project integration test/integration/reconciliation/authorization-expiry.test.ts`.

**Non-goals** — Expiry lookups (T13); expiry webhooks (P09).

**Handoff checklist**
- [ ] staged-evidence routing updated.

---

### P08-T12 — Reconciler app: ambiguity cases

**Task ID:** `P08-T12`
**Feature:** Read-only reconciliation of `UNKNOWN` operations
**Commit:** `feat(reconciler): resolve unknown operations by read-only lookup`
**Priority:** Critical
**Dependencies:** `P08-T10`, `P08-T01`
**Estimated complexity:** L
**Contract references:** docs/06 §Reconciliation lookup and evidence (search order, NOT_FOUND mapping, INCONCLUSIVE mapping, evidence strength), §Rate limits; docs/08 §Retry classification (fast reconciliation schedule), §Runbook: `UNKNOWN` operation, §Sweep and claim defaults; docs/04 §Reconciliation messages; docs/07 §Transaction and lock ownership (Reconcile unknown outcome); ADR-0004
**Files:** create: `apps/reconciler/src/main.ts` (replace the P00 inert entry), `apps/reconciler/src/scheduler.ts`, `apps/reconciler/src/ambiguity-case.ts`, `apps/reconciler/src/reconcile-consumer.ts`, `apps/reconciler/src/evidence-mapping.ts`, `apps/reconciler/src/evidence-mapping.test.ts`, `packages/domain/src/reconciliation-schedule.ts`, `packages/domain/src/reconciliation-schedule.test.ts`, `packages/config/src/reconciler.ts`, `test/integration/reconciler/ambiguity.test.ts`; modify: `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `packages/providers/src/adapter.ts`, `migrations/`

**Objective** — Claim due cases, perform the provider read outside any transaction, stage normalized evidence, then either resolve the original operation through `apply_provider_evidence`, reschedule via `record_case_observation`, or escalate via `require_operation_review` after the fifth inconclusive lookup.

**Implementation instructions**
1. Config (`packages/config/src/reconciler.ts`): `RECONCILER_POLL_INTERVAL_MS` = `5000`, `RECONCILER_CLAIM_SIZE` = `100`, `RECONCILER_LEASE_MS` = `30000`, `RECONCILER_MAX_CONCURRENT_LOOKUPS` = `20`, `SIMULATOR_BASE_URL` (P06 name). DB role `fl_reconciler`.
2. `packages/domain/src/reconciliation-schedule.ts`: `export const UNKNOWN_SCHEDULE_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000] as const;` `nextUnknownCheck(attemptNumber: number, now: Date, hintMs: number | null, jitter01: number): Date | 'EXHAUSTED'` — attempt n (1-based, the lookup just completed): if `n >= 5` → `'EXHAUSTED'`; base = `UNKNOWN_SCHEDULE_MS[n]`; hint bounded to `≤ 3_600_000`; delay = `max(base, hint ?? 0)`; add jitter `floor(delay * 0.1 * jitter01)`; return `now + delay`. `jitter01` in `[0,1)` injected (tests pass fixed values). Total worst case ≈ 1h12m40s + jitter ≤ 75 min objective (docs/08 §Recovery objectives) — assert in unit test with jitter 0.999.
3. Scheduler loop (`scheduler.ts`): every poll interval, `claimDueCases(claimSize, leaseMs)` (commits), dispatch each claimed case to `ambiguity-case.ts` (or T13's expiry handler by `case_type`) with a bounded concurrency semaphore. Also run once immediately when a reconcile command arrives.
4. Reconcile consumer (`reconcile-consumer.ts`): consumer name `reconciler`, subscribes to `payment.operation.reconcile.v1` via P05 `startConsumer` (`handle(tx, envelope)` returns `{ kind: 'APPLIED' }`; the framework validates and inserts the inbox row in the same transaction) and triggers one scheduler pass after commit. The command never bypasses the case: work is always claimed from `reconciliation.cases`.
5. `ambiguity-case.ts` for `AMBIGUOUS_OUTCOME`/`STALE_PROCESSING` (`CONTRADICTORY_EVIDENCE`, `LEDGER_MISMATCH` cases are never claimable — they are created `REQUIRES_REVIEW`):
   a. Load operation + payment read-only. A claimed ambiguity case never has a terminal operation (terminal resolution sets the case `RESOLVED` in the same transaction); if one is observed, log `invariant_terminal_op_with_open_case` at error level and skip without writes.
   b. Build `ProviderLookup` from the operation: `operationId`, `operationType`, `providerAccountId`, `providerOperationId` (op or latest evidence), `providerPaymentId` (payment), `idempotencyKey` = operation's stable key, `expectedAmount`. Never a new key. Call `adapter.lookup(query, AbortSignal.timeout(requestTimeoutMs))` with no DB connection checked out.
   c. Map with `evidence-mapping.ts` → evidence JSON for `stageReconciliationEvidence(caseId, leaseToken, evidence)` with `source='RECONCILIATION'`, `source_reference = caseId + ':' + attemptNumber`, `reconciliation_case_id`, `reconciliation_attempt_number`:
      - `FOUND` + terminal result → observed outcome = result outcome with its fields/proof/error.
      - `NOT_FOUND` conclusive → `FAILED`, category `NOT_FOUND`, code `PROVIDER_OPERATION_NOT_FOUND_CONCLUSIVE`, directive `DO_NOT_RETRY`, proof `CONCLUSIVE_PROVIDER_LOOKUP_ABSENCE {observedAt: checkedAt}`.
      - `NOT_FOUND` nonconclusive → `UNKNOWN`, `NOT_FOUND`/`PROVIDER_OPERATION_NOT_FOUND_INCONCLUSIVE`/`RECONCILE_FIRST`, `next_check_not_before` = bounded schedule using the adapter's `nextCheckNotBefore` as hint.
      - `INCONCLUSIVE` → `UNKNOWN` with its exact normalized error; `normalized_retry_after_ms = error.retryAfterMs`; `next_check_not_before` from `nextUnknownCheck(attempt, dbNow, retryAfterMs, jitter)`. If `'EXHAUSTED'`, `next_check_not_before` = `dbNow + 1h` (still required by the evidence check) and escalate in step e.
      `dbNow` is read with `SELECT clock_timestamp()` in the staging transaction.
   d. Stage evidence (short transaction). On a changed-hash identity conflict, stop (alert logged) and `releaseCaseLease` with +30 s.
   e. Apply (new transaction, lock order enforced inside functions):
      - terminal evidence → `applyProviderEvidence(evidenceId)` (T09 path resolves the case; contradictions go to discrepancy).
      - nonterminal and not exhausted → `recordCaseObservation(caseId, leaseToken, evidenceId)`.
      - nonterminal and exhausted (attempt 5) → in **one transaction**: `recordCaseObservation` (consumes the evidence as `CASE_OBSERVATION`, case → `SCHEDULED`, version+1), re-read the case version, then `requireOperationReview(caseId, caseVersion, 'AUTOMATED_RECONCILIATION_EXHAUSTED', null, envelopes)` (T10 accepts `SCHEDULED` with `attempt_count >= 5` for this caller).
   f. Adapter throws (programmer error/shutdown) → `releaseCaseLease(caseId, token, now+5s)`.
   g. Crash points: `reconciler.after_claim`, `reconciler.after_lookup`, `reconciler.after_evidence_stage`, `reconciler.during_apply_commit`, `reconciler.after_apply_commit`.
6. Health/readiness and graceful shutdown: stop polling, abort in-flight lookups via AbortController, release leases of unfinished cases.
7. Rate limits: lookups go through the same per-`(provider, providerAccountId)` limiter P06 built; a limiter rejection before sending is `release` with `now + 5s` (no evidence).

**Expected behavior** — capture `TIMEOUT_AFTER_COMMIT` → `UNKNOWN`; within ~5–10 s the reconciler finds `SUCCEEDED`, the operation becomes `SUCCEEDED` with `resolution_source='RECONCILIATION'`, exactly one journal transaction; ground truth `P=1, L=1`.

**Acceptance criteria**
- [ ] Lookups are read-only (`lookup` only; no write method called — asserted by simulator write counter).
- [ ] Original operation id, provider key, and posting key reused.
- [ ] Inconclusive lookups follow 5 s/30 s/2 m/10 m/1 h then `REQUIRES_REVIEW`; adapter hints honored up to 1 h.
- [ ] No DB connection held during provider I/O.

**Testing requirements** — Unit: `packages/domain/src/reconciliation-schedule.test.ts` (each attempt's base delay, hint larger/smaller/over 1 h, exhaustion at 5, worst-case total < 75 min); `apps/reconciler/src/evidence-mapping.test.ts` (each lookup variant → exact evidence shape incl. conclusive/nonconclusive absence codes). Integration `test/integration/reconciler/ambiguity.test.ts` (reconciler services in-process + simulator, clock advanced with `advanceClock` and case `next_check_at` fixture edits as migration owner): (1) timeout→lookup success posts once; (2) timeout before commit + clock past absence window → conclusive `FAILED`, no posting, reservation released for refund; (3) lookup scripted `INCONCLUSIVE ×5` → `REQUIRES_REVIEW`, review event, pointer retained, capture acceptance `409`; (4) nonconclusive NOT_FOUND reschedules with adapter time; (5) crash at `reconciler.after_lookup` (simulate by throwing in-process) → case reclaimed after lease, attempt 2 evidence identity distinct; (6) restage same evidence (same case:attempt) → idempotent duplicate; (7) adapter with `SAME_KEY_REPLAY` → still zero writes; (8) reconcile command delivered 10× → one inbox row per envelope, one case claim per due time. Commands: `pnpm vitest run --project unit packages/domain/src/reconciliation-schedule.test.ts apps/reconciler/src/evidence-mapping.test.ts`, `pnpm vitest run --project integration test/integration/reconciler/ambiguity.test.ts`.

**Non-goals** — Expiry cases (T13); operator commands (T14).

**Handoff checklist**
- [ ] Env vars documented.
- [ ] Redaction negative test on reconciler logs with prohibited-data fixtures.

---

### P08-T13 — Reconciler: authorization-expiry cases

**Task ID:** `P08-T13`
**Feature:** `ACTIVE`/`EXPIRED`/`INCONCLUSIVE` authorization lookups
**Commit:** `feat(reconciler): check authorization expiry cases`
**Priority:** High
**Dependencies:** `P08-T11`, `P08-T12`
**Estimated complexity:** M
**Contract references:** docs/06 §Authorization-expiry lookup, §Reconciliation lookup and evidence (authorization inconclusive mapping); docs/03 §Authorization-expiry workflow; docs/07 §`reconciliation.cases` (expiry bullet), §`providers.provider_evidence` (AUTHORIZATION_* shapes), §Transaction and lock ownership (Check authorization expiry)
**Files:** create: `apps/reconciler/src/expiry-case.ts`, `apps/reconciler/src/expiry-mapping.test.ts`, `test/integration/reconciler/authorization-expiry.test.ts`; modify: `apps/reconciler/src/scheduler.ts`, `apps/reconciler/src/evidence-mapping.ts`; must not touch: `migrations/`

**Objective** — For a claimed `AUTHORIZATION_EXPIRY` case: call `lookupAuthorizationStatus`, stage evidence via `stageReconciliationEvidence` (T08), and reschedule (`ACTIVE`), back off/escalate (`INCONCLUSIVE`), or apply guarded expiry (`EXPIRED`).

**Implementation instructions**
1. Build `ProviderAuthorizationLookup` from the case `expected_snapshot` and payment binding (`paymentId`, `authorizationOperationId`, `providerAccountId`, `providerAccountVersion`, `providerPaymentId`, `providerAuthorizationId`, `expectedAmount`). Call without DB connection held.
2. Mapping (`source='RECONCILIATION'`, `source_reference = caseId:attempt`):
   - `ACTIVE` → `AUTHORIZATION_ACTIVE`, provider ids, `authorization_expires_at`, `next_check_not_before = clamp(result.nextCheckNotBefore, dbNow+5s, dbNow+7d)` **[ASSUMPTION A17]** 7-day upper bound (risk R9).
   - `INCONCLUSIVE` → `AUTHORIZATION_INCONCLUSIVE`, its error, `next_check_not_before = nextUnknownCheck(min(consecutiveInconclusive+1,4), dbNow, retryAfterMs, jitter)` (reuse the 5 s…1 h ladder; never `'EXHAUSTED'` here).
   - `EXPIRED` → `AUTHORIZATION_EXPIRED`, provider ids, `provider_observed_at = expiredAt`, `next_check_not_before` null.
3. Apply: `ACTIVE`/`INCONCLUSIVE` → `recordCaseObservation`; then, in the same transaction, if `INCONCLUSIVE` and the case's `observed_snapshot.consecutiveInconclusive >= 5` → `escalateExpiryCase(caseId)` (T08 step 4: accepts `SCHEDULED`, no lease). `EXPIRED` → `recordAuthorizationExpiry(evidenceId, envelopes)`; on `'DEFERRED'` → `releaseCaseLease(case, token, now+30s)`; on `'DISMISSED'`/`'APPLIED'`/`'DUPLICATE'` the case is already closed by the function.
4. Neither `ACTIVE` nor `INCONCLUSIVE` may change payment version (asserted).

**Expected behavior** — after `expireAuthorization(id)` and the case due, the payment becomes `EXPIRED` once; with `ACTIVE`, case `next_check_at` moves to the provider's next-check time and payment version is unchanged.

**Acceptance criteria**
- [ ] `ACTIVE` reschedules; `INCONCLUSIVE` backs off and escalates after 5 consecutive; only `EXPIRED` changes the payment.
- [ ] Local due time alone never changes the payment.

**Testing requirements** — Unit `apps/reconciler/src/expiry-mapping.test.ts` (each outcome → evidence shape; clamp bounds). Integration `test/integration/reconciler/authorization-expiry.test.ts`: (1) case due, provider ACTIVE → rescheduled, payment v unchanged; (2) provider expired → payment `EXPIRED`, voided = authorized, event `resolutionSource=RECONCILIATION`, auth op version unchanged; (3) INCONCLUSIVE ×5 → case `REQUIRES_REVIEW`, payment unchanged; (4) due time passes with provider ACTIVE (clock advanced past `authorizationExpiresAt`) → still not expired (time never proves expiry); (5) capture accepted (unresolved) when EXPIRED observed → `DEFERRED`, case rescheduled; capture then succeeds → case dismissed, later expiry lookup cannot mutate. Commands: `pnpm vitest run --project unit apps/reconciler/src/expiry-mapping.test.ts`, `pnpm vitest run --project integration test/integration/reconciler/authorization-expiry.test.ts`.

**Non-goals** — Expiry webhooks (P09).

**Handoff checklist**
- [ ] T08 `escalate_expiry_case` precondition matches this task (SCHEDULED).

---

### P08-T14 — Operator CLI: cases, evidence notes, recheck, escalation

**Task ID:** `P08-T14`
**Feature:** Audited operator escalation without state edits
**Commit:** `feat(cli): add reconciliation case operator commands`
**Priority:** High
**Dependencies:** `P08-T10`, `P08-T08`
**Estimated complexity:** M
**Contract references:** docs/08 §Manual review contract, §Operator authority; docs/10 M8 "evidence attachment and audited operator escalation; do not implement arbitrary state-edit endpoints"; docs/07 §`reconciliation.case_activity`
**Files:** create: `apps/cli/src/commands/cases.ts`, `test/integration/cli/cases-commands.test.ts`; modify: `apps/cli/src/main.ts` (register), `docs/CONFIG.md`; must not touch: `migrations/`

**Objective** — Operators can inspect redacted cases/evidence, attach an immutable note or external evidence reference, trigger a read-only recheck, and escalate an `UNKNOWN` operation to review. No command accepts an outcome, amount, status, or provider key.

**Implementation instructions**
1. Commands (actor via required `--actor <id>` and `--reason <text>` on every mutating command; P11 replaces `--actor` with the authenticated principal):
   - `flowledger cases list [--status REQUIRES_REVIEW|SCHEDULED|...] [--type …] [--limit 50]` — role `fl_operator_readonly`; prints id, type, status, operation id, attempt_count, next_check_at, updated_at.
   - `flowledger cases show <case_id>` — case, activity, linked evidence (allowlisted columns only: outcome, normalized error code/category, provider references, timestamps, evidence hash hex, redacted reference). Never prints `raw_quarantine_*`.
   - `flowledger cases attach-note <case_id> --evidence-ref <ref>` → `reconciliation.attach_case_note`.
   - `flowledger cases recheck <case_id>` → `reconciliation.request_manual_recheck`.
   - `flowledger cases escalate <case_id>` → reads case version, builds review envelope, calls `payments.require_operation_review(..., 'OPERATOR_ESCALATION', actor, envelopes)` as `fl_operator_command`.
2. DB URL env `OPERATOR_COMMAND_DATABASE_URL` / `OPERATOR_READONLY_DATABASE_URL`.
3. Output JSON with `--json`; plain table otherwise. Exit code 0 success, 2 domain rejection (print error code), 1 unexpected.
4. Do not implement `resolve`, `set-status`, `release`, `retry`, or any command that writes outcome data.

**Expected behavior** — `flowledger cases escalate case_… --actor ops.alice --reason "provider outage"` on an UNKNOWN case → operation `REQUIRES_REVIEW`, activity row with actor `ops.alice`, one review event with `reason=OPERATOR_ESCALATION`.

**Acceptance criteria**
- [ ] Every mutating command records actor + reason in `case_activity`.
- [ ] No command can change totals, outcome, pointer, reservation, or provider key (source review + test that the command set is exactly the five above).

**Testing requirements** — `test/integration/cli/cases-commands.test.ts` (invoke the command functions in-process against Testcontainers DB): list/show redaction (no `raw_quarantine` keys, prohibited-data fixture absent); attach-note appends; recheck sets `next_check_at≈now`; escalate happy path and missing `--actor` → exit 2 `OPERATOR_IDENTITY_REQUIRED`; escalate on terminal → exit 2; assert the registered `cases` subcommands equal `['list','show','attach-note','recheck','escalate']`. Command: `pnpm vitest run --project integration test/integration/cli/cases-commands.test.ts`.

**Non-goals** — Authentication/MFA (P11) and `audit.operator_actions` rows (table created P10-T11; operator audit wiring P10/P11); DLQ replay (P09).

**Handoff checklist**
- [ ] Env vars documented.

---

### P08-T15 — DR fence CLI and restored-window reconciliation tooling

**Task ID:** `P08-T15`
**Feature:** Disaster-recovery restore procedure tooling
**Commit:** `feat(cli): add disaster recovery fence and restored-window reconciliation`
**Priority:** Medium
**Dependencies:** `P08-T03`, `P08-T12`
**Estimated complexity:** M
**Contract references:** docs/08 §Disaster recovery (steps 1–6); docs/10 M8 "disaster-recovery fencing epoch and restored-window reconciliation tooling"
**Files:** create: `apps/cli/src/commands/dr.ts`, `test/integration/cli/dr-commands.test.ts`; modify: `apps/cli/src/main.ts`; must not touch: `migrations/`

**Objective** — Provide the restore runbook's commands: fence provider writes under a new epoch, drive reconciliation coverage for the RPO uncertainty window, and unfence only when coverage is complete.

**Implementation instructions**
1. `flowledger dr fence --actor --reason` → `beginRecoveryEpoch`; prints new epoch. Dispatch and notification application are off; webhook receipt continues (P09 receiver does not check the fence).
2. `flowledger dr reconcile-window --since <ISO timestamp> --actor --reason [--json]`:
   a. Nonterminal operations: `REQUESTED` need nothing (republished after unfence by the stale sweeper); stale `PROCESSING` is handled by the sweeper (which keeps running while fenced — `mark_unknown`/requeue do not dispatch); `UNKNOWN`/`REQUIRES_REVIEW` → `request_manual_recheck` on their open case (reason `DR_RESTORED_WINDOW`), so every ambiguous operation gets a fresh read-only lookup.
   b. Terminal provider operations with `resolved_at >= since` or whose evidence `provider_observed_at >= since`: perform `adapter.lookup` read-only from the CLI process and compare outcome/amount/currency/provider ids with the stored terminal state. **[ASSUMPTION A18]** docs/07 has no case type for a verification of an already terminal operation, so mismatches are reported (not staged as evidence): output a JSON report `{checked, matched, mismatched:[{operationId, internal, provider}], unresolvedAmbiguous}` and exit non-zero when `mismatched` is nonempty (risk R10). The operator then investigates via the discrepancy runbook.
   c. Exit 0 only when mismatched = 0; print `unresolvedAmbiguous` count (operations still `UNKNOWN` with a case scheduled).
3. Every `reconcile-window` run records its result by calling `setRecoveryFlags(epoch, false, false, actor, 'reconcile-window:' || ('clean'|'mismatch') || ':' || <sha256 hex of the JSON report>)` (a new fence row, flags unchanged). `flowledger dr unfence --epoch <n> --actor --reason` refuses (exit 2) unless the latest row of the current epoch whose `reason` starts with `reconcile-window:` is a `reconcile-window:clean:` row, and `flowledger verify` (run in-process) reports zero findings. Then `setRecoveryFlags(epoch, true, true, …)`. Gradual re-enable is operational (scale workers up gradually); the flag is binary.
4. Readonly lookups use `fl_reconciler`-equivalent provider credentials only (no write method is ever invoked; assert by wrapping the adapter in a proxy that throws on `authorize/capture/cancel/refund`).

**Expected behavior** — fence → workers stop claiming; reconcile-window where the provider reports a different outcome for one terminal operation in the window reports one mismatch and exits 1; after investigation and a clean report, unfence succeeds.

**Acceptance criteria**
- [ ] No provider write method is reachable from `dr` commands.
- [ ] Unfence is refused without a clean window report and green verify.

**Testing requirements** — `test/integration/cli/dr-commands.test.ts`: fence blocks `claim_operation`; reconcile-window rechecks every UNKNOWN case (assert `next_check_at` updated) and reports a seeded terminal mismatch (`scriptLookups(key, ['CONTRADICT'])` for one `SUCCEEDED` capture inside the window) → exit 1, report lists that operation; clean run → exit 0; unfence without report → exit 2; with report → flags true; adapter write methods throw if called (proxy). Command: `pnpm vitest run --project integration test/integration/cli/dr-commands.test.ts`.

**Non-goals** — Backup/PITR infrastructure (P13); outbox republish is already automatic (relay).

**Handoff checklist**
- [ ] Runbook usage appended to `docs/CONFIG.md` command reference section for `dr`.

---

### P08-T16 — Worker/provider and refund-reservation chaos suite

**Task ID:** `P08-T16`
**Feature:** docs/08 required failure-injection tests (M8 scope)
**Commit:** `test(chaos): add worker crash-point and ambiguity convergence suite`
**Priority:** Critical
**Dependencies:** `P08-T07`, `P08-T12`, `P08-T13`
**Estimated complexity:** L
**Contract references:** docs/08 §Required failure-injection tests (Worker and provider; Refund reservation; Messaging "remove or delay broker messages … accepted operations"), §Recovery objectives and alerts; docs/09 §Duplicate financial effects, §End-to-end scenarios 11–13, §Crash and redelivery
**Files:** create: `test/chaos/worker-crash-points.test.ts`, `test/chaos/ambiguity-convergence.test.ts`, `test/chaos/refund-reservation-recovery.test.ts`, `test/chaos/recovery-timing.test.ts`; `packages/testkit/src/apps.ts`; must not touch: application source

**Objective** — Prove with real processes (payment-worker, reconciler, relay, simulator) and armed crash points that every crash converges to one provider effect and one ledger effect or explicit review.

**Implementation instructions**
1. Each test: start PG (Testcontainers), simulator (own DB), relay, payment-worker, reconciler with `FLOWLEDGER_FAULT_HOOKS=1`, test-tuned intervals (`STALE_SWEEP_INTERVAL_MS=1000`, `RECONCILER_POLL_INTERVAL_MS=500`) except in `recovery-timing.test.ts` which uses defaults. Arm one crash point in the worker via `FLOWLEDGER_CRASH_POINTS=<name>` (spawned with `startApp`), let it die (exit 137), restart it unarmed, poll until terminal or `REQUIRES_REVIEW` (timeout 120 s).
2. After each scenario run `flowledger verify --require-ground-truth` (in-process) and assert zero findings, plus `groundTruthEffects(key) <= 1` and journal count per operation ≤ 1.
3. `worker-crash-points.test.ts` — one case per crash point (`worker.before_claim`, `worker.after_claim_commit`, `worker.before_dispatch_mark`, `worker.after_dispatch_mark`, `worker.during_provider_call`, `worker.after_provider_response`, `worker.during_result_commit`, `worker.after_result_commit`) for a CAPTURE: expected end states — pre-dispatch crashes → same operation reclaimed (attempt 1 `ABANDONED`, attempt 2 completes), `SUCCEEDED`; post-dispatch crashes → `UNKNOWN` → reconciled `SUCCEEDED` with `resolution_source='RECONCILIATION'` (or `API_RESPONSE` for `after-result-commit`); in every case P=1, L=1, one terminal event. Plus: "redeliver an execution command in every operation status" (republish the original envelope UUID via the relay fixture for each status) → no extra provider writes.
4. `ambiguity-convergence.test.ts` — (a) provider commit followed by timeout → no blind retry (simulator write count for key = 1), eventual reconciliation, one effect; (b) lose all in-memory provider responses: script `CONNECTION_LOST_AFTER_COMMIT` for 20 operations of mixed types, kill/restart worker mid-run → all converge to the same final state as ground truth; (c) direct response vs reconciliation race: script `TIMEOUT_AFTER_COMMIT` but delay the stale/mark path so a reconciliation lookup and a late staged direct-response evidence race → one transition, one journal row, the other evidence `CORROBORATION`; (d) inconclusive lookups exhaust → `REQUIRES_REVIEW` → `scriptLookups(...,'TRUTH')` + `cases recheck` → resolves; (e) drop every `payment.operation.execute.v1` and `payment.operation.reconcile.v1` message at the transport (InMemory/PubSub emulator fixture filter) → sweepers and the case scheduler still converge every operation.
5. `refund-reservation-recovery.test.ts` — (a) leave a refund `UNKNOWN` (lookup scripted INCONCLUSIVE ×5), restart every process, assert `reserved_refund_amount_minor`/`unresolved_refund_count` unchanged and a new refund within the remaining amount is accepted (`202`) while one exceeding it gets `409 MONETARY_GUARD_FAILED`; (b) crash at `reconciler.during_apply_commit` while resolving an UNKNOWN refund → reservation neither double-released nor lost (`refunded + reserved` equals pre-crash value until the retry commits, then reserved decreases by exactly the amount); (c) crash after refund acceptance commit (API) is P05/P07-owned — reference their test file in the traceability table, do not duplicate.
6. `recovery-timing.test.ts` (default intervals, fake adapter lease 15 s): stale `PROCESSING` detected ≤ 15 s + 2 s slack after `lease_expires_at`; first reconciliation lookup ≤ 15 s after `UNKNOWN`; stale `REQUESTED` (execute message dropped) claimed ≤ 60 s (docs/08 critical threshold; objective 99% ≤ 5 s is a load property measured in P12).

**Expected behavior** — all scenarios converge; `verify` zero findings.

**Acceptance criteria**
- [ ] Every docs/08 Worker/provider bullet and the two M8-owned Refund-reservation bullets have a passing test here.
- [ ] Each test fails if its invariant is broken: demonstrate by temporarily making the stale sweeper call `requeue` for dispatch-marked attempts (blind retry) and observing P=2 failure; record in the commit body.

**Testing requirements** — Command: `pnpm test:chaos` (runs these files with `FLOWLEDGER_FAULT_HOOKS=1`). Individual: `pnpm vitest run --project chaos test/chaos/worker-crash-points.test.ts`.

**Non-goals** — Webhook races (P09); load-level chaos (P12).

**Handoff checklist**
- [ ] Deliberate-break observation noted in commit body.

---

### P08-T17 — `payments.record_discrepancy` and contradiction routing

**Task ID:** `P08-T17`
**Feature:** Contradictory evidence becomes a discrepancy, never an overwrite
**Commit:** `feat(db): add record_discrepancy and route contradictory evidence`
**Priority:** Critical
**Dependencies:** `P08-T09`, `P08-T11`
**Estimated complexity:** L
**Contract references:** docs/07 §Protected payment transition functions (`record_discrepancy`, `apply_provider_evidence`), §`providers.provider_evidence` (`DISCREPANCY` application shape), §`reconciliation.cases` (`CONTRADICTORY_EVIDENCE`), §Transaction and lock ownership (Record contradictory evidence); docs/03 §Racing resolution signals, §Aggregate and operation version rules; docs/06 §Normalized write results (mismatch paragraph), §Stable provider idempotency (`CONFLICT`); docs/08 §Provider webhook ingestion row "Late webhook contradicts terminal state"; docs/10 M7 AC "Each distinct newly deduplicated contradictory evidence row …"; schema `events/payment-discrepancy-detected.v1.schema.json`
**Files:** create: `migrations/0880_record_discrepancy.sql`, `test/integration/reconciliation/record-discrepancy.test.ts`; modify: `packages/database/src/functions/payments.ts`, `packages/database/src/envelopes/reconciliation.ts`, `apps/payment-worker/src/sweepers/staged-evidence.ts`; must not touch: `migrations/07*`, `schemas/**`

**Objective** — P07 stages contradictory evidence without applying it (coordinator decision). This task **creates** `payments.record_discrepancy` (it does not exist before P08) and makes `apply_provider_evidence` route every newly deduplicated contradiction to it, so each one advances payment version once, emits exactly one `payment.discrepancy.detected.v1`, and opens or updates the operation's `CONTRADICTORY_EVIDENCE` case. Confirmed money, `authorization_outcome`, the subject operation and its version, and the journal never change.

**Implementation instructions**
1. Signature: `payments.record_discrepancy(p_evidence_id text, p_envelopes jsonb) RETURNS text` — returns the case id, or `'DUPLICATE'` when the evidence was already applied. docs/07 names only `(evidence_id)`; `p_envelopes` follows the P07/P08 envelope-parameter convention (assumption A5). `SECURITY DEFINER`, `SET search_path = pg_catalog, payments, providers, reconciliation, messaging`, owner `payments_function_owner`. EXECUTE: `fl_payment_worker`, `fl_reconciler`, `fl_webhook_worker`.
2. Lock order: payment → subject operation → the operation's unresolved `CONTRADICTORY_EVIDENCE` case (`FOR UPDATE`, if one exists) → outbox. Load the evidence `FOR UPDATE`. If `applied_at IS NOT NULL`, return `'DUPLICATE'` with no writes (replaying the same evidence is a no-op).
3. Contradiction classification (evidence vs the locked operation/payment). Pick the first that applies and use it as the event `classification`:
   - `observed_amount_minor` ≠ operation `amount_minor` → `AMOUNT_MISMATCH`.
   - `currency` ≠ `'USD'` or ≠ operation currency → `CURRENCY_MISMATCH`.
   - provider reference mismatch against an append-once payment/operation reference → `CONTRADICTORY_PROVIDER_EVIDENCE`.
   - terminal operation `SUCCEEDED` with evidence `REJECTED`/`FAILED`, or the reverse → `STATUS_MISMATCH`.
   - evidence carrying normalized category `CONFLICT` (same key, changed semantics; docs/06 §Stable provider idempotency) → `CONTRADICTORY_PROVIDER_EVIDENCE`.
   No rule matches → raise `EVIDENCE_NOT_APPLICABLE` (the caller should have applied it as a transition or corroboration).
4. Writes, in one transaction:
   - Payment: `version = version + 1, updated_at = clock_timestamp()` only.
   - Case: if no unresolved `CONTRADICTORY_EVIDENCE` case exists for the operation, insert one with `status='REQUIRES_REVIEW'`, `reason_code` = classification, `expected_snapshot` = operation expectation (type, amount, currency, provider account, key, provider operation id, status), `observed_snapshot` = redacted evidence summary, `next_check_at = NULL`. Otherwise update `observed_snapshot`, `version + 1`. Activity `('EVIDENCE_LINKED', p_evidence_id, 'SYSTEM', <source>, {classification})`.
   - Evidence: `applied_at = clock_timestamp()`, `application_kind = 'DISCREPANCY'`, `applied_payment_version` = new payment version (docs/07: `DISCREPANCY` records payment version only).
   - Outbox: exactly one `payment.discrepancy.detected.v1` from `p_envelopes`. Verify `aggregateVersion` = new payment version; `data.caseId` = the case id; `data.classification`; `data.operationId`; `data.providerAccountId`; `data.providerOperationId` = operation reference or null; `data.internalStatus` = operation status; `data.providerStatus` = evidence `observed_outcome`; `data.internalEvidenceRef` = the operation's `resolution_evidence_id` reference, or `'operation:' || op.id` when nonterminal; `data.providerEvidenceRef` = evidence `redacted_evidence_reference`. Then `messaging.insert_outbox`. On mismatch raise `STALE_ENVELOPE_VERSION`; the caller re-reads and retries.
   - The operation row, `active_exclusive_operation_id`, reservation fields, totals, `authorization_outcome` and ledger are not touched.
5. Routing in `apply_provider_evidence`: re-create it with `CREATE OR REPLACE`, copying the P08-T09 body (migration `0850`) verbatim with one change. Where P07 leaves contradictory evidence unapplied, the function now returns a distinct result `'DISCREPANCY_REQUIRED'` without writing. Contradictory means: terminal operation with an opposite outcome, or a type/amount/currency/identity mismatch on a success (docs/06 mismatch paragraph). A database function cannot build the TS envelope, so the TS wrapper `applyProviderEvidence` sees that result and, in the **same transaction**, builds the discrepancy envelope and calls `recordDiscrepancy`. Callers (worker, staged-evidence sweeper, reconciler, P09 notification worker) keep calling `applyProviderEvidence` only. Agreeing late evidence stays `CORROBORATION`.
6. `record_authorization_expiry` reference mismatch (P08-T11 step 4): the TS wrapper `recordAuthorizationExpiry` catches `EVIDENCE_NOT_APPLICABLE` caused by a reference mismatch (DETAIL `{"reason":"REFERENCE_MISMATCH"}`; add that DETAIL to T11's raise in this migration by re-creating the function with only that change) and calls `recordDiscrepancy` in the same transaction.
7. The staged-evidence sweeper (T07) needs no new branch. It already calls `applyProviderEvidence`, which now routes contradictions; drop its skip for terminal-operation contradictory evidence if T07 added one.

**Expected behavior** — capture `SUCCEEDED` (API response), then a `REJECTED` webhook-source evidence row → payment v+1, one discrepancy event (`STATUS_MISMATCH`), one `CONTRADICTORY_EVIDENCE` case `REQUIRES_REVIEW`; operation status/version, totals and journal unchanged. Applying the same evidence again → no change. A second, distinct contradicting row → payment v+1 again and a second event, with the same case updated.

**Acceptance criteria**
- [ ] Each newly deduplicated contradiction: payment version +1 exactly once, one discrepancy event, evidence `DISCREPANCY` with only `applied_payment_version` set.
- [ ] Duplicate or corroborating evidence changes neither payment nor operation version.
- [ ] Subject operation status/version, confirmed totals, `authorization_outcome`, pointer/reservation and journal unchanged.
- [ ] Discrepancy event validates and its `caseId` references a real `CONTRADICTORY_EVIDENCE` case.

**Testing requirements** — `test/integration/reconciliation/record-discrepancy.test.ts`: (1) `STATUS_MISMATCH` after `SUCCEEDED` capture (assert every invariant above, journal count 1); (2) duplicate application → `DUPLICATE`, versions unchanged; (3) two distinct contradictions → two events at contiguous versions, one case updated (version +1); (4) `AMOUNT_MISMATCH` on a success for a `PROCESSING` operation → discrepancy, operation stays `PROCESSING`, no transition, no journal; (5) `CURRENCY_MISMATCH`; (6) idempotency `CONFLICT` evidence → `CONTRADICTORY_PROVIDER_EVIDENCE`; (7) agreeing evidence → `CORROBORATION`, no event; (8) expiry evidence with a mismatched authorization reference → discrepancy through the T11 wrapper path; (9) wrong envelope version → `STALE_ENVELOPE_VERSION`, full rollback; (10) 20 concurrent applications of one contradicting evidence row → one event, payment version +1 once; (11) refund contradiction keeps the reservation (deferred trigger passes). Re-run `pnpm test:integration`. Command: `pnpm vitest run --project integration test/integration/reconciliation/record-discrepancy.test.ts`.

**Non-goals** — Operator resolution of discrepancy cases (audited compensating workflows are P10/P11); webhook ingestion (P09).

**Handoff checklist**
- [ ] `apply_provider_evidence` diff vs `0850` is only the routing result.
- [ ] Grants last; wrapper and envelope builder `buildDiscrepancyDetected` exported.

---

### P08-GATE — Milestone M8 verification

**Task ID:** `P08-GATE`
**Feature:** M8 exit gate
**Commit:** `test(reconciler): verify M8 ambiguity and reconciliation gate`
**Priority:** Critical
**Dependencies:** `P08-T01`…`P08-T17`
**Estimated complexity:** M
**Contract references:** docs/10 M8 §Test and acceptance criteria; docs/09 §End-to-end scenarios 11, 12, 13, 18; docs/05 §Retrieval tests (ambiguous-then-reconciled timeline)
**Files:** create: `test/e2e/m8-ambiguity.test.ts`, `docs/evidence/P08.md`; modify: `packages/testkit/src/simulator.ts` (add `stageContradictingEvidence`); create: `test/fixtures/db/p08-populated.sql` (populated fixture for P09 migration-forward test, produced by the P02 fixture-dump script); must not touch: feature code

**Objective** — Prove the M8 exit gate end to end through the public API with all apps running.

**Implementation instructions**
1. `test/e2e/m8-ambiguity.test.ts` (API + relay + worker + reconciler + simulator over PubSub emulator):
   - E2E-11: create → authorize → capture with `TIMEOUT_AFTER_COMMIT` → `GET /v1/payments/{id}` shows `OUTCOME_UNKNOWN` and zero captured → reconciliation → `CAPTURED`, one ledger posting.
   - E2E-12: timeout before commit → conclusive absence → capture `FAILED`, no posting, new capture accepted with new key.
   - E2E-13: exhaustion → `REQUIRES_REVIEW` → later verified lookup evidence resolves the original operation.
   - E2E-18 (partial, settlement entry comes in P10): `GET /v1/payments/{id}/timeline` after ambiguous-then-reconciled capture shows the ambiguous attempt, reconciliation evidence, exactly one `LEDGER_POSTING`.
   - `SAME_KEY_REPLAY` adapter configuration cannot move `UNKNOWN`/`REQUIRES_REVIEW` back to execution (simulator write count).
   - Authorization `ACTIVE` lookup leaves payment version unchanged; explicit expiry → `EXPIRED` via API representation; expiry vs capture acceptance race through the API (20 iterations) → one ordering, duplicate expiry no-op, case dismissed after capture success.
   - Restaging/reapplying the same evidence is idempotent.
   - docs/10 M7 contradictory-evidence bullet (owned here by coordinator decision, because P07 does not implement discrepancies): capture a payment through the API (direct response `SUCCEEDED`). Then the e2e test calls the testkit fixture helper `stageContradictingEvidence(operationId)`, which stages two `API_RESPONSE`-source evidence rows with different attempt references through the P06 staging function as `fl_payment_worker`. The staged-evidence sweeper then applies them. Assert that each distinct row increments payment version once and emits one `payment.discrepancy.detected.v1`, the terminal operation and journal are unchanged, and that re-staging a duplicate or an agreeing row changes neither payment nor operation version.
2. Run and record in `docs/evidence/P08.md`: `pnpm check`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:chaos`, `pnpm verify:ledger -- --require-ground-truth`; commit SHA; per-class verify counts; recovery timing numbers from `recovery-timing.test.ts`.
3. Produce `test/fixtures/db/p08-populated.sql` with UNKNOWN, REQUIRES_REVIEW, resolved, and expiry cases present.

**Expected behavior** — all green; evidence note committed.

**Acceptance criteria**
- [ ] Every row of the traceability table below has a passing test.
- [ ] `verify` zero findings in every class including duplicate-effect with ground truth.
- [ ] Evidence note lists commands, outputs, and SHA.

**Testing requirements** — `pnpm test:e2e test/e2e/m8-ambiguity.test.ts` plus the full lanes listed.

**Non-goals** — Webhook races (P09).

**Handoff checklist**
- [ ] Fixture committed for P09.

---

## Parallelization

| Can run concurrently | Notes |
| --- | --- |
| `P08-T01` ‖ `P08-T02` | Disjoint files (simulator vs migrations). |
| `P08-T14` ‖ `P08-T15` ‖ `P08-T13` (after their deps) | All touch `apps/cli/src/main.ts` (T14, T15) — merge-order conflict only in the registration line; T13 is reconciler-only. |
| `P08-T05` ‖ `P08-T06` | T05 is app code, T06 is migration `0830`. |

Strictly sequential (single-owner surfaces, README §5.4): all migrations `0800 → 0810 → 0820 → 0830 → 0840 → 0850 → 0860 → 0870 → 0880` (T02, T03, T04, T06, T08, T09, T10, T11, T17) — one agent at a time on `migrations/` and SECURITY DEFINER bodies; `P08-T09` then `P08-T17` (in that order) are the only P08 tasks editing `apply_provider_evidence`; `P08-T17` creates `record_discrepancy`. `P08-T07` test case (6) needs `P08-T09`; schedule T07 after T09. Shared files that conflict: `packages/database/src/functions/payments.ts` (T03, T04, T06, T09, T10, T11, T17), `packages/database/src/errors.ts` (T03, T04, T08), `packages/database/src/envelopes/reconciliation.ts` (T04, T10, T11), `apps/reconciler/src/scheduler.ts` (T12, T13), `apps/payment-worker/src/sweepers/staged-evidence.ts` (T07, T11, T17), `packages/database/src/envelopes/reconciliation.ts` (also T17).

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| docs/10 M8: processing leases, worker fencing | T03, T05, T06 | `recovery-fence.test.ts` :: claim refused while fenced; `stale-functions.test.ts` :: wrong token / live lease refused |
| docs/10 M8: stale `REQUESTED` and stale `PROCESSING` sweepers | T06, T07 | `stale-sweepers.test.ts` :: (1)–(5),(7) |
| docs/10 M8: possible-dispatch crashes and ambiguous results → `UNKNOWN`, no replacement op | T04, T05, T07 | `mark-unknown.test.ts` :: (1); `redelivery-by-status.test.ts`; `worker-crash-points.test.ts` :: post-dispatch cases |
| docs/10 M8: reconciliation-required event + command in same transaction | T04 | `mark-unknown.test.ts` :: (1),(9) |
| docs/10 M8: cases, scheduling/backoff, activity, lookup by op id or key, evidence staging | T02, T08, T12 | `case-functions.test.ts`; `reconciliation-schedule.test.ts`; `ambiguity.test.ts` :: (1),(4),(6) |
| docs/10 M8: apply lookup evidence through same transition/ledger path | T09, T12 | `evidence-case-resolution.test.ts` :: (1); `ambiguity.test.ts` :: (1) |
| docs/10 M8: exhausted lookups → `REQUIRES_REVIEW` without releasing payment | T10, T12 | `require-review.test.ts`; `ambiguity.test.ts` :: (3) |
| docs/10 M8: authorization success creates `AUTHORIZATION_EXPIRY` case scheduled from hint/policy | T09 | `evidence-case-resolution.test.ts` :: (7),(8) |
| docs/10 M8: `ACTIVE`/`EXPIRED`/`INCONCLUSIVE` lookup handling | T13 | `reconciler/authorization-expiry.test.ts` :: (1)–(4) |
| docs/10 M8: expiry guard, `EXPIRED`, void, close case, version, event, auth op untouched | T11 | `reconciliation/authorization-expiry.test.ts` :: (1),(8) |
| docs/10 M8: evidence attachment and audited escalation; no state edit | T08, T14 | `case-functions.test.ts` :: note/recheck; `cases-commands.test.ts` :: command set |
| docs/10 M8: DR fencing epoch and restored-window tooling | T03, T15 | `recovery-fence.test.ts`; `dr-commands.test.ts` |
| docs/10 M8 AC: kill before dispatch → same op reclaimed | T06, T07, T16 | `worker-crash-points.test.ts` :: before_dispatch_mark |
| docs/10 M8 AC: kill after dispatch marker → `UNKNOWN`, no blind retry | T07, T16 | `worker-crash-points.test.ts` :: after_dispatch_mark, during_provider_call |
| docs/10 M8 AC: `SAME_KEY_REPLAY` cannot move UNKNOWN/REVIEW to execution | T05, T12 | `redelivery-by-status.test.ts` :: SAME_KEY_REPLAY; `ambiguity.test.ts` :: (7); `m8-ambiguity.test.ts` |
| docs/10 M8 AC: timeout → lookup success posts exactly once | T12 | `ambiguity.test.ts` :: (1); `m8-ambiguity.test.ts` :: E2E-11 |
| docs/10 M8 AC: timeout → conclusive no-effect → failure, no posting | T12 | `ambiguity.test.ts` :: (2); E2E-12 |
| docs/10 M8 AC: inconclusive exhausts → visible review, conflicting commands blocked | T10, T12 | `require-review.test.ts` :: ACTIVE_OPERATION_EXISTS; `ambiguity.test.ts` :: (3) |
| docs/10 M8 AC: direct response vs reconciliation race converges | T09, T16 | `ambiguity-convergence.test.ts` :: (c) |
| docs/10 M8 AC: auth lookup ACTIVE no version change; INCONCLUSIVE backs off/escalates; only EXPIRED changes payment | T13 | `reconciler/authorization-expiry.test.ts` :: (1),(3),(4) |
| docs/10 M8 AC: expiry vs capture/cancel race; duplicate no-op; case dismissed | T09, T11 | `reconciliation/authorization-expiry.test.ts` :: (5)–(7); `evidence-case-resolution.test.ts` :: (9) |
| docs/10 M8 AC: restage/reapply same evidence idempotent | T09, T12 | `evidence-case-resolution.test.ts` :: (5); `ambiguity.test.ts` :: (6) |
| docs/10 M8 AC: recovery sweeps meet timing objectives | T16 | `recovery-timing.test.ts` |
| docs/07 `mark_unknown` MUSTs (lease cleared, holds kept, case + activity before envelopes, replay returns case) | T04 | `mark-unknown.test.ts` :: (1)–(4) |
| docs/07 `require_operation_review` MUSTs (lock order, exhaustion, no outcome input) | T10 | `require-review.test.ts` |
| docs/07 `apply_provider_evidence` case MUSTs (resolve case same tx, no claimable work left; expiry case on auth success; dismissal) | T09 | `evidence-case-resolution.test.ts` :: (1)–(4),(7)–(9) |
| docs/07 `record_authorization_expiry` MUSTs | T11 | `reconciliation/authorization-expiry.test.ts` |
| docs/07 `record_discrepancy` (create; case create/update; one event per new contradiction; duplicate no-op) | T17 | `record-discrepancy.test.ts` :: (1)–(3),(10) |
| docs/10 M7 AC: each distinct newly deduplicated contradiction increments payment version and emits one discrepancy event without rewriting the terminal operation; duplicate/corroborating evidence changes neither version (moved to P08 by coordinator decision) | T17, GATE | `record-discrepancy.test.ts` :: (1)–(3),(7); `m8-ambiguity.test.ts` :: M7 contradiction scenario |
| docs/06 mismatch of type/amount/currency/identity → discrepancy, no confirmed effect | T17 | `record-discrepancy.test.ts` :: (4)–(6) |
| docs/07 cases: one unresolved case per (operation, type); claim SKIP LOCKED with committed attempt number; lookup evidence identity `caseId:attempt` | T02, T08, T12 | `cases-schema.test.ts`; `case-functions.test.ts`; `ambiguity.test.ts` :: (5) |
| docs/07 Schema acceptance: every UNKNOWN op has exactly one claimable case; terminal evidence resolves it | T04, T09 | `mark-unknown.test.ts` :: (4); `evidence-case-resolution.test.ts` :: (1) |
| docs/07 Schema acceptance: expired pre-dispatch lease reclaimed exactly once; dispatch mark fails closed | T06 | `stale-functions.test.ts` |
| docs/07 Schema acceptance: exhausted reconciliation → REQUIRES_REVIEW retains holds, rejects outcome data | T10 | `require-review.test.ts` |
| docs/07 Schema acceptance: duplicate reconciliation scheduling → one effect | T12 | `ambiguity.test.ts` :: (8) |
| docs/06 lookup read-only; search order; NOT_FOUND conclusive only after window; INCONCLUSIVE retryAfterMs persisted before reschedule | T12 | `evidence-mapping.test.ts`; `ambiguity.test.ts` :: (2),(4) |
| docs/06 ambiguity reasons closed vocabulary, most specific | T05 | `ambiguity.test.ts` (unit) |
| docs/06 lease expiry after dispatch → UNKNOWN never new-key write | T07, T16 | `stale-sweepers.test.ts` :: (3) |
| docs/08 Provider result resolution: FAILED without proof → UNKNOWN + ADAPTER_DEFECT | T05 | `apps/payment-worker/src/ambiguity.test.ts` |
| docs/08 Stale PROCESSING runbook: durable complete result applied instead of provider call | T07 | `stale-sweepers.test.ts` :: (4) |
| docs/08 Durable provider evidence: unapplied evidence recovered by scan | T07 | `stale-sweepers.test.ts` :: (6) |
| docs/08 Manual review: operator may/may-not lists; actor/reason recorded | T08, T10, T14 | `cases-commands.test.ts` |
| docs/08 Disaster recovery steps 1, 2 (flag), 4, 6 | T03, T15 | `dr-commands.test.ts` |
| docs/08 FI Worker: crash before claim … after result commit | T16 | `worker-crash-points.test.ts` :: 8 cases |
| docs/08 FI Worker: stale pre-dispatch reclaimed | T16 | `worker-crash-points.test.ts` :: before_dispatch_mark |
| docs/08 FI Worker: stale post-dispatch → UNKNOWN | T16 | `worker-crash-points.test.ts` :: after_dispatch_mark |
| docs/08 FI Worker: provider commit then timeout → no blind retry, eventual reconciliation, one effect | T16 | `ambiguity-convergence.test.ts` :: (a) |
| docs/08 FI Worker: redeliver execute command in every status | T05, T16 | `redelivery-by-status.test.ts`; `worker-crash-points.test.ts` :: redelivery |
| docs/08 FI Worker: lose all in-memory responses → same final state | T16 | `ambiguity-convergence.test.ts` :: (b) |
| docs/08 FI Refund: crash after refund acceptance commit | P05/P07 (owned there) | P07 refund recovery test (reference only) |
| docs/08 FI Refund: crash during refund terminal transition | T16 | `refund-reservation-recovery.test.ts` :: (b) |
| docs/08 FI Refund: race several refund confirmations | P07 (owned there) | P07 concurrent refund test (reference only) |
| docs/08 FI Refund: UNKNOWN refund survives restart and bounds new refunds | T16 | `refund-reservation-recovery.test.ts` :: (a) |
| docs/08 FI Messaging: remove/delay broker messages → sweepers rediscover accepted operations | T16 | `ambiguity-convergence.test.ts` :: (e) |
| docs/09 E2E 11, 12, 13, 18 (partial) | GATE | `m8-ambiguity.test.ts` |
| docs/09 Messaging: redeliver execution commands for every status | T05 | `redelivery-by-status.test.ts` |
| docs/09 duplicate financial effects = 0 against ground truth | T16, GATE | `verify --require-ground-truth` after each chaos scenario |
| docs/08 metrics `stale_processing_total`, `reconciliation_age and attempts`, `operations_unknown`, `operations_requires_review` | T07 (stale), P11 (rest) | `stale-sweepers.test.ts` :: metric increment; others in P11 |

## Phase risks / open questions

| ID | Risk / question | Impact | Severity | Recommended resolution | Blocked tasks |
| --- | --- | --- | --- | --- | --- |
| R1 | Envelope-parameter convention (A5) is a P07 decision; P06 stages only `API_RESPONSE` evidence, so reconciliation staging is P08-owned (`providers.stage_reconciliation_evidence`, T08). | Wrong function names → integration failure | Low | Names reconciled against P06/P07 "Interfaces provided"; semantics fixed by docs/07. | T04, T08, T09, T12 |
| R2 | `require_operation_review` signature: docs/07:525 names `(case_id, expected_case_version)` and says it requires exhausted policy, but the review event schema (`schemas/events/payment-operation-review-required.v1.schema.json` `reason` enum) includes `OPERATOR_ESCALATION`/`PROVIDER_LOOKUP_UNAVAILABLE`, and docs/10 M8 requires audited operator escalation. | Contract text vs schema | Medium | Add `p_reason`, `p_actor_id`, `p_envelopes`; exhaustion required only for automated reasons (A16). Update docs/07 in a contract commit. | T10, T14 |
| R3 | `case_activity.activity_type` values are prose in docs/07 ("Scheduled, lookup, evidence linked, escalated, or resolved"); dismissal and operator notes need values. | Name drift | Low | Use `SCHEDULED, LOOKUP, EVIDENCE_LINKED, ESCALATED, RESOLVED, DISMISSED, NOTE` (A9); record in docs/07. | T02 |
| R4 | No contract names the DR fencing-epoch storage (docs/08 §Disaster recovery step 1). | Invented table | Medium | `payments.recovery_epochs` append-only (A10); confirm with owner. | T03, T15 |
| R5 | Stale-`REQUESTED` detection needs to know whether an execute command was recently enqueued; outbox has no operation column. | Query cost / extra index on P02 table | Low | Additive index `(aggregate_id, message_type, recorded_at)` (A12). | T06 |
| R6 | Unapplied-evidence recovery scan (docs/08 §Durable provider evidence) may already exist from P07. | Duplicate loops | Low | Extend P07's loop if present (A13). | T07 |
| R7 | `AUTHORIZATION_EXPIRY` escalation has no review event (review event requires an `UNKNOWN` operation and the auth op is terminal). | Escalation visible only in case queue | Low | Case `REQUIRES_REVIEW` + activity `ESCALATED`, no event (A14). | T08, T13 |
| R8 | JSON path of `initialCheckAfterSeconds` inside `provider_account_versions.configuration` is P02/P06's choice. | Wrong first-check time | Low | Read the path P06 stores; assert in test (A15). | T09 |
| R9 | No upper bound is specified for `ACTIVE` `nextCheckNotBefore`. | Unbounded reschedule | Low | Clamp to [now+5 s, now+7 d] (A17). | T13 |
| R10 | docs/08 DR step 4 requires reconciling terminal operations in the RPO window, but docs/07 `case_type` has no value for verifying a terminal operation and evidence requires a case for `RECONCILIATION` source. | Mismatches cannot be staged as evidence | Medium | Report-and-block unfence (A18); propose `RESTORE_VERIFICATION` case type in a contract change. | T15 |
| R11 | Reconcile command `reason` enum (`AMBIGUOUS_RESPONSE`, `STALE_PROCESSING`, `PROVIDER_NOTIFICATION_GAP`, `MANUAL_RECHECK`) differs from the event reason vocabulary. | Mapping ambiguity | Low | Map adapter ambiguity → `AMBIGUOUS_RESPONSE`, stale → `STALE_PROCESSING`; manual rechecks do not emit commands (scheduler polls). | T04 |
| R12 | `payment.discrepancy.detected.v1` requires `caseId`, but reconciliation cases exist only from M8, so docs/10 M7's contradictory-evidence bullet cannot be met in M7. | Discrepancy handling missing until P08 | Medium | **Resolved by coordinator:** P07 stages contradictory evidence unapplied; P08-T17 creates `record_discrepancy` and the routing; P08-GATE owns the M7 bullet. Until P08-T17 merges, contradictory evidence stays unapplied (visible through the staged-evidence partial index). docs/10 M7 should be updated in a contract commit. | T17 |
| R13 | Worker-internal domain error codes are not in docs/05 (A8). | Name drift | Low | List them once (this file); add to docs/05 appendix or `errors.ts` doc comment. | T03–T11 |
