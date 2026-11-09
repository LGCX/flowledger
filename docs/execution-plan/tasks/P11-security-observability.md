# P11 — Security, observability, and operator visibility

## Phase overview

**Goal.** Deliver milestone M11 (`docs/10-IMPLEMENTATION_PLAN.md` §M11, lines 478–511): a focused threat model; correlation/causation propagation through logs and traces; every minimum recovery metric (`docs/08` §Recovery observability) and every required metric (`docs/09` §Required metrics); dashboards and alerts with the contracted thresholds; authenticated, MFA-bound operator identity; read-only operator views; append-only audit of every privileged command bound to that identity; dependency/container/IaC/secret scans; and the known-limits document.

**Entry criteria.** `P10-GATE` green (M11 depends on M8–M10, `docs/10` line 132).

**Exit gate.** `P11-GATE`: redaction, RLS/cross-tenant, traces, metrics, alerts, operator authentication, and audit immutability verified end to end; known-limits document complete.

**Migration range.** `1100`–`1199`, steps of 10 in task order.

### Interfaces consumed from earlier phases

| Interface | Provided by |
| --- | --- |
| Logger, redaction allowlist (`packages/observability/src/redaction.ts`), OTel bootstrap, metrics registry module | P00 (CONVENTIONS §3, §12) |
| `packages/testkit/src/prohibited-data.ts` | P00 |
| `buildEnvelope()` (`packages/contracts/src/envelope.ts`) with optional `traceparent` | P01/P02 |
| `withTransaction` (`packages/database/src/tx.ts`) | P02 |
| Relay, inbox consumer, transport (`packages/messaging`) | P05 |
| Provider adapters, worker claim/dispatch, sweepers | P06/P08 |
| `ledger.post_payment_operation`, P03 private posting routine `ledger.post_journal_internal(...)` (16-argument signature in P03-T06; P10-T03 may have replaced its body), `ledger.post_settlement_journal(...)` | P03/P07/P10 |
| Provider webhook receiver/worker, merchant webhook projector/dispatcher | P09 |
| Settlement tables/functions, settlement worker, `settlement.merchant_batch_members` | P10-T02–T10 |
| `audit.operator_actions`, `audit.record_operator_action(...)` (12-argument signature) | P10-T11 |
| Operator SQL functions (`messaging.operator_republish_outbox`, `messaging.operator_replay_dead_letter`, `reconciliation.operator_reschedule_case`, `settlement.operator_request_run`, `ledger.request_correction`, `ledger.decide_correction`, `ledger.record_correction_audit`), `providers.operator_evidence`, `flowledger ops …` CLI | P10-T12–T14 |
| `docs/runbooks/*.md` (nine) and `test/e2e/runbooks/runbook-sql.ts` | P10-T15–T18 |
| `flowledger verify` (all classes, duplicate-effect detector) | P03/P07/P10-T09 |

### Interfaces provided to later phases

| Interface | Kind |
| --- | --- |
| `audit.authenticate_operator(p_token text) RETURNS text`, `audit.current_operator() RETURNS text` | SQL |
| `infra/docker/operator-idp/issue-token.mjs` (dev IdP stub) | Script |
| `<schema>.operator_*` security-barrier views (list in P11-T04/T05) | SQL, `fl_operator_readonly` |
| `packages/observability/src/context.ts` (`runWithContext`, `currentContext`) | TS |
| `packages/observability/src/metrics.ts` — `METRICS` registry with exact names, label allowlist | TS |
| `packages/observability/src/db-snapshot.ts` — `registerDbSnapshot(pool, functionName)` | TS |
| `<schema>.metrics_snapshot() RETURNS TABLE (metric text, labels jsonb, value double precision)` for `messaging`, `payments`, `reconciliation`, `webhooks`, `providers`, `settlement` | SQL |
| `infra/docker/otel-collector.yaml`, `infra/docker/prometheus/{prometheus.yml,alerts.yml,alerts.test.yml}`, `infra/docker/grafana/**` | Config as code (P13 ports to Cloud Monitoring) |
| `flowledger verify --watch <seconds>` exporting invariant metrics | CLI |
| `docs/security/THREAT_MODEL.md`, `docs/KNOWN_LIMITS.md` | Docs |
| `.github/workflows/security.yml` | CI |

### Metric inventory (exact names; implemented across P11-T07–T11)

Names from `docs/08` §Recovery observability are copied verbatim. `docs/09` §Required metrics gives descriptions, not names; names for those are **[ASSUMPTION]** (risk R-02) and follow the same unprefixed snake_case style. Ages and durations are in seconds. Label keys are restricted to the allowlist in P11-T07; no merchant, payment, operation, customer, envelope, or batch ID is ever a label (`docs/08` line 595).

| Metric | Type | Labels | Source | Task |
| --- | --- | --- | --- | --- |
| `operations_requested_total` | counter | `operation_type` | docs/08 | T10 |
| `operations_processing` | gauge | `operation_type` | docs/08 | T10 |
| `operations_unknown` | gauge | `operation_type` | docs/08 | T10 |
| `operations_requires_review` | gauge | `operation_type` | docs/08 | T10 |
| `stale_processing_total` | counter | `operation_type`, `result` (`reclaimed`\|`unknown`) | docs/08 | T10 |
| `provider_attempts_total` | counter | `provider`, `operation_type`, `outcome` | docs/08 ("by normalized outcome") | T08 |
| `provider_request_latency` | histogram | `provider`, `operation_type` | docs/08 | T08 |
| `provider_rate_limited_total` | counter | `provider` | docs/08 | T08 |
| `reconciliation_age` | gauge | `phase` (`unscheduled`\|`unresolved`) | docs/08 ("reconciliation_age and attempts") | T10 |
| `reconciliation_attempts` | counter | `case_type`, `result` | docs/08 (second half of the same line) **[ASSUMPTION]** | T10 |
| `outbox_oldest_unpublished_age` | gauge | — | docs/08 | T08 |
| `subscription_oldest_unprocessed_age` | gauge | `consumer` | docs/08 | T08 |
| `dlq_depth` | gauge | `consumer`, `classification` | docs/08 | T08 |
| `provider_webhook_unprocessed_age` | gauge | — | docs/08 | T08 |
| `provider_webhook_signature_failures` | counter | `provider` | docs/08 | T08 |
| `ledger_posting_conflicts` | counter | `operation_type` | docs/08 | T09 |
| `ledger_projection_mismatches` | gauge | — | docs/08 | T11 |
| `ledger_bucket_lock_wait` | histogram | `logical_account`, `bucket` | docs/08 ("by logical account"); docs/09 adds per bucket | T09 |
| `settlement_runs_total` | counter | `outcome` (`POSTED`\|`DEFERRED`\|`FAILED`\|`LEASE_LOST`) | docs/08 | T11 |
| `settlement_unsettled_movement_age` | gauge | `net` (`positive`\|`nonpositive`) | docs/08 | T11 |
| `settlement_negative_clearing_age` | gauge | — | docs/08 | T11 |
| `payment_reserved_refund_total` | gauge | — | docs/08 | T10 |
| `payment_unresolved_refunds` | gauge | — | docs/08 | T10 |
| `duplicate_envelopes_total` | counter | `consumer` | docs/08 | T08 |
| `duplicate_provider_notifications_total` | counter | `provider` | docs/08 | T08 |
| `duplicate_financial_effects_total` | gauge (checker count) | — | docs/08, docs/09 §Defining | T11 |
| `http_server_request_duration` | histogram | `route`, `method`, `status_class` | docs/09 API | T07 |
| `http_server_requests_total` | counter | `route`, `method`, `status_class`, `code` | docs/09 API ("by endpoint/outcome") | T07 |
| `idempotency_requests_total` | counter | `result` (`new`\|`replay`\|`conflict`\|`in_progress`\|`expired`) | docs/09 API | T07 |
| `db_commit_latency` | histogram | — | docs/09 DB | T07 |
| `db_transaction_retries_total` | counter | `sqlstate` (`40001`\|`40P01`) | docs/09 DB | T07 |
| `db_pool_wait` | histogram | — | docs/09 DB | T07 |
| `db_pool_active_connections` | gauge | — | docs/09 DB | T07 |
| PostgreSQL server metrics (`pg_stat_database_deadlocks`, `pg_locks_count`, `pg_stat_activity_count`, `pg_stat_wal_*`) | exporter | exporter labels | docs/09 DB (lock wait, WAL, connections) via `postgres-exporter` | T07 |
| `payment_oldest_unresolved_exclusive_age` | gauge | — | docs/09 API/DB | T10 |
| `payment_oldest_unresolved_refund_age` | gauge | — | docs/09 API/DB | T10 |
| `operations_requested_oldest_age` | gauge | — | docs/08 alert row 1 **[ASSUMPTION]** | T10 |
| `operations_processing_overdue_lease_age` | gauge | — | docs/08 alert row 2 **[ASSUMPTION]** | T10 |
| `operations_unknown_oldest_age` | gauge | — | docs/08 alert row 4; docs/09 ledger/recovery | T10 |
| `operations_requires_review_oldest_age` | gauge | — | docs/08 alert row 7; docs/09 | T10 |
| `outbox_rows_created_total` | counter | — | docs/09 messaging | T08 |
| `outbox_rows_published_total` | counter | — | docs/09 messaging | T08 |
| `outbox_publish_retries_total` | counter | — | docs/09 messaging | T08 |
| `message_delivery_attempts_total` | counter | `consumer`, `result` (`ack`\|`nack`\|`dlq`) | docs/09 messaging | T08 |
| `worker_lease_acquisitions_total` | counter | `worker`, `result` (`acquired`\|`contended`\|`reclaimed`) | docs/09 workers | T08 |
| `provider_in_flight` | gauge | `provider` | docs/09 workers | T08 |
| `provider_circuit_state` | gauge (0 closed, 1 half-open, 2 open) | `provider` | docs/09 workers ("rate-limit state") | T08 |
| `merchant_webhook_oldest_pending_age` | gauge | — | docs/10 feature matrix "Backlog/delivery lag" | T08 |
| `ledger_postings_total` | counter | `operation_type`, `result` (`created`\|`replayed`) | docs/09 ledger | T09 |
| `ledger_posting_latency` | histogram | `operation_type` | docs/09 ledger | T09 |
| `refund_reservation_guard_rejections_total` | counter | — | docs/09 ledger/recovery | T10 |
| `reconciliation_resolutions_total` | counter | `source` (`API_RESPONSE`\|`PROVIDER_WEBHOOK`\|`RECONCILIATION`) | docs/09 ("resolution source") | T10 |
| `payment_discrepancies_total` | counter | — | docs/09 ("discrepancies") | T10 |
| `settlement_movements_settled_total` | counter | — | docs/09 | T11 |
| `settlement_batch_size` | histogram (members) | — | docs/09 ("batch size distribution") | T11 |
| `settlement_batch_commit_latency` | histogram | — | docs/09 §Settlement throughput boundary | T11 |
| `invariant_findings` | gauge | `class` | docs/09 §Continuous invariant checker | T11 |
| `unresolved_ambiguity_operations` | gauge | `status` (`UNKNOWN`\|`REQUIRES_REVIEW`) | docs/09 line 76 ("unresolved-ambiguity gauges") | T11 |

---

### P11-T01 — Focused threat model

**Task ID:** `P11-T01`
**Feature:** Security documentation
**Commit:** `docs(security): add focused threat model`
**Priority:** High
**Dependencies:** `P10-GATE`
**Estimated complexity:** M
**Contract references:** `docs/10` M11 bullet 1 (line 486); `docs/01` §Failure-containment rules, line 54 (operator surface); `docs/05` §Authentication (line 34, line 49), §Request and correlation identifiers; `docs/06` §Webhook verification steps (lines 501–507), §Redaction and retained evidence; `docs/07` §Tenant isolation; `docs/04` §Sensitive data; `docs/08` §Manual review contract, §Operator authority; ADR-0004, ADR-0007.
**Files:** create: `docs/security/THREAT_MODEL.md`, `test/contract/threat-model.test.ts`; modify: none; must not touch: contracts.

**Objective** — One reviewable document that, for each of the seven threats named in `docs/10` line 486, states the asset, entry points, attack, the mitigations already built (with contract section and the test that proves it), and residual risk, so a reviewer can trace each claim to evidence.

**Implementation instructions**
1. Sections, in this order, each with the same five sub-headings (`Assets`, `Entry points`, `Threats`, `Mitigations and evidence`, `Residual risk`): `Tenant escape`, `Credential theft`, `Webhook forgery and replay`, `Provider ambiguity`, `Message tampering`, `Unsafe operator actions`, `Sensitive-data leakage`. Preface with a data-flow diagram (Mermaid) of trust boundaries: merchant → API; provider → webhook receiver; workers → provider; operator → CLI → PostgreSQL; Pub/Sub; telemetry pipeline.
2. Every mitigation row is a table row `| Mitigation | Contract § | Evidence (test file :: case) |`. Evidence paths must be real files from earlier phases (e.g. P02 RLS tests, P04 credential tests, P09 signature golden vectors, P10 settlement immutability tests) or P11 tasks listed as "planned (P11-Tnn)".
3. Residual risks must include at least: shared-secret HMAC operator token (stub IdP, not a real IdP); operator with database superuser access bypasses everything (out of scope); single-region; no PCI claim; local-only Grafana auth.
4. `test/contract/threat-model.test.ts`: parse the markdown; assert the seven section headings exist; for each evidence cell, the referenced file path exists in the repository (paths marked `planned (P11-Tnn)` are allowed only until `P11-GATE`, which removes that allowance); every contract § reference names an existing heading in the cited doc (match against `^#+ ` lines).

**Expected behavior** — Document renders; contract test passes; removing a heading or referencing a nonexistent test file fails the test.

**Acceptance criteria**
- [ ] Seven sections with five sub-headings each.
- [ ] Every mitigation has a contract § and an evidence reference.
- [ ] Contract test fails on a broken file path or missing heading (observed, reverted).

**Testing requirements** — `test/contract/threat-model.test.ts` cases `has seven threat sections`, `every evidence file exists`, `every contract reference resolves`. Command: `pnpm test:contracts`.

**Non-goals** — No new controls; no compliance claims.

**Handoff checklist**
- [ ] `pnpm check` green; `Task: P11-T01`.

---

### P11-T02 — Operator identity: dev IdP stub, signed MFA token, session binding

**Task ID:** `P11-T02`
**Feature:** Operator authentication
**Commit:** `feat(security): add MFA-bound operator token verification and session binding`
**Priority:** Critical
**Dependencies:** `P10-GATE`
**Estimated complexity:** L
**Contract references:** `docs/10` M11 bullet 6 (line 491); `docs/08` §Operator authority (line 639); `docs/01` line 54; `docs/00` §Deferred (no operator HTTP API); `docs/05` line 49 (no tenant override); CONVENTIONS §2 (`node:crypto` only), §7 roles, §11.
**Files:** create: `migrations/1100_operator_authentication.sql`, `infra/docker/operator-idp/issue-token.mjs`, `infra/docker/operator-idp/operators.json`, `packages/testkit/src/operator-token.ts`, `packages/testkit/src/operator-token.test.ts`, `test/integration/security/operator-authentication.test.ts`; modify: `apps/cli/src/commands/seed.ts` (register dev signing key), `infra/docker/.env.example`, `docs/CONFIG.md`, `.gitleaks.toml` (allowlist the synthetic TOTP secrets file); must not touch: P10 operator functions.

**Objective** — Make operator identity locally verifiable without a cloud IdP **[DECIDED D-03, 2026-11-08; risk R-01]**: a dev IdP stub issues a short-lived HS256-signed token with a named principal and an `amr` claim containing `mfa` only after verifying a TOTP code; PostgreSQL verifies the token and binds the principal to the current database session in a table no operator role can write.

**Implementation instructions**
1. Token format: compact JWS `base64url(header).base64url(payload).base64url(signature)`. Header exactly `{"alg":"HS256","kid":"<keyId>","typ":"JWT"}`. Payload: `iss="flowledger-dev-idp"`, `aud="flowledger-operator"`, `sub` (principal, `^[A-Za-z0-9._@-]{3,128}$`, same as the audit `actor` check), `amr` (array; must contain `"otp"` and `"mfa"`), `roles` (non-empty subset of `operator.read`, `operator.command`, `operator.correction`), `iat`, `exp` (`exp - iat <= 900`), `jti` (UUID v4).
2. IdP stub `infra/docker/operator-idp/issue-token.mjs` (plain Node ESM, stdlib only): `node infra/docker/operator-idp/issue-token.mjs --principal <sub> --otp <6 digits> --roles operator.command[,operator.read]`. Loads `operators.json` (`{ "<principal>": { "totpSecretBase32": "<synthetic>", "roles": [...] } }`, two synthetic operators `alice@operators.flowledger.test` and `bob@operators.flowledger.test`), verifies TOTP per RFC 6238 (HMAC-SHA1, 30-second step, 6 digits, ±1 step window, `timingSafeEqual`), rejects roles not granted to the principal, signs with `OPERATOR_TOKEN_SIGNING_KEY` (base64, ≥ 32 bytes) and `OPERATOR_TOKEN_KEY_ID`, prints the token to stdout only. Exports `totp(secretBase32, unixSeconds)` and `issueToken(opts)` for tests.
3. Migration (order: tables → functions → grants):
   - `audit.operator_token_keys (key_id text PRIMARY KEY CHECK (key_id ~ '^[a-z0-9-]{1,32}$'), secret bytea NOT NULL CHECK (octet_length(secret) >= 32), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), retired_at timestamptz)`.
   - `audit.operator_sessions (backend_pid integer, backend_start timestamptz, principal text NOT NULL, token_id uuid NOT NULL, session_role name NOT NULL, roles text[] NOT NULL, expires_at timestamptz NOT NULL, authenticated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (backend_pid, backend_start))`.
   - `audit.register_token_key(p_key_id text, p_secret bytea) RETURNS void` — executable by `fl_migration_owner` only (used by `flowledger seed --profile dev`).
   - `audit.authenticate_operator(p_token text) RETURNS text` — `SECURITY DEFINER`, owner `audit_function_owner`, `SET search_path = pg_catalog, audit, public` (pgcrypto in `public` per P02; adjust to P02's extension schema). Steps: split into exactly 3 parts else `OPERATOR_TOKEN_INVALID`; decode base64url (translate `-_`→`+/`, pad); header must equal the step-1 shape; load non-retired key by `kid`; `expected := base64url(hmac(part1 || '.' || part2, secret, 'sha256'))`; compare `digest(expected,'sha256') = digest(part3,'sha256')` (avoids early-exit timing on the raw signature) else `OPERATOR_TOKEN_INVALID`; validate `iss`, `aud`, `sub` regex, `jti` UUID; `exp > clock_timestamp()` else `OPERATOR_TOKEN_EXPIRED`; `iat <= now + 30 s` and `exp - iat <= 900` else `OPERATOR_TOKEN_INVALID`; `amr` contains `mfa` and `otp` else `OPERATOR_MFA_REQUIRED`; required role by `session_user`: `fl_operator_readonly`→`operator.read`, `fl_operator_command`→`operator.command`, `fl_correction`→`operator.correction`, any other session user → `FORBIDDEN`; missing role → `OPERATOR_ROLE_NOT_GRANTED`. Then delete expired sessions, upsert `(pg_backend_pid(), (SELECT backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()))` with principal, `jti`, `session_user`, roles, `exp`. Return principal.
   - `audit.current_operator() RETURNS text` — `STABLE SECURITY DEFINER`; principal for the current backend key where `expires_at > clock_timestamp()` and `session_role = session_user`, else `NULL`.
   - `audit.current_operator_token_id() RETURNS uuid` — same lookup, returns `token_id`.
   - Grants last: no role but `audit_function_owner` has any privilege on the two tables; `EXECUTE` on `authenticate_operator` to `fl_operator_readonly`, `fl_operator_command`, `fl_correction`; `EXECUTE` on `current_operator`/`current_operator_token_id` to those three plus every `*_function_owner` role (so operator functions and views can call them).
4. `packages/testkit/src/operator-token.ts`: `mintOperatorToken({ principal, roles, ttlSeconds?, amr?, key? })` (imports `issueToken` from the stub) and `authenticateOperator(client, token)`.
5. Config: `OPERATOR_TOKEN_SIGNING_KEY` (synthetic base64), `OPERATOR_TOKEN_KEY_ID=dev-1` in `.env.example` and `docs/CONFIG.md`; `flowledger seed --profile dev` calls `audit.register_token_key`.

**Expected behavior** — Valid token for alice with `operator.command` used on a `fl_operator_command` connection → returns `alice@operators.flowledger.test`; `current_operator()` returns it until `exp`; on another connection `current_operator()` is `NULL`.

**Acceptance criteria**
- [ ] Stub refuses a wrong OTP and a role not in `operators.json`.
- [ ] DB rejects: tampered payload, wrong key, `alg:none`, expired, `exp - iat > 900`, missing `mfa`, wrong role for session user, a merchant credential string `fl_test_<locator>_<secret>`, 2-part and 4-part strings — each with its exact code.
- [ ] Session binding is per backend: a second connection is unauthenticated; a reconnected backend is unauthenticated.
- [ ] No login role can `SELECT`/`INSERT`/`UPDATE`/`DELETE` `audit.operator_sessions` or `audit.operator_token_keys` (`42501`).

**Testing requirements** — Stub unit tests live in `packages/testkit/src/operator-token.test.ts` (the `infra/` directory is outside the Vitest globs; add this file to **Files** create): `RFC 6238 test vector` (SHA1 vector `59 → 94287082` truncated to 6 digits `287082`), `rejects wrong otp`, `rejects ungranted role`. Integration `test/integration/security/operator-authentication.test.ts`: one case per rejection above, `valid token binds session`, `binding not visible to other connection`, `expired session returns null`, `tables not accessible`. Commands: `pnpm test:unit`, `pnpm vitest run --project integration test/integration/security/operator-authentication.test.ts`.

**Non-goals** — No real IdP, no WebAuthn, no operator HTTP API.

**Handoff checklist**
- [ ] Token never printed by anything except the stub (grep the CLI and logs).
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P11-T02`.

---

### P11-T03 — Bind every audited operator command to the authenticated principal

**Task ID:** `P11-T03`
**Feature:** Operator authorization and audit
**Commit:** `feat(security): require authenticated operator principal for audited commands`
**Priority:** Critical
**Dependencies:** `P11-T02`
**Estimated complexity:** M
**Contract references:** `docs/10` M11 bullets 6–7 (lines 491–492), acceptance "Operator actions are authenticated, authorized, immutable in audit history, and unable to mutate journal, payment, or settlement tables directly" (line 510); `docs/08` §Manual review contract (line 268), §Operator authority.
**Files:** create: `migrations/1110_audit_require_operator.sql`, `apps/cli/src/operator-auth.ts`, `test/integration/security/operator-audit-binding.test.ts`; modify: `apps/cli/src/commands/ops/*.ts` (replace `--actor` with token), `packages/database/src/functions/audit.ts`, P10 operator tests that call operator functions (`test/integration/operator/messaging-commands.test.ts`, `test/integration/operator/recovery-commands.test.ts`, `test/integration/ledger/correction-workflow.test.ts`, `test/integration/audit/operator-actions.test.ts`, `test/e2e/runbooks/*.test.ts` CLI invocations) to authenticate first via `packages/testkit/src/operator-token.ts`, `packages/testkit/src/prohibited-data.ts` (add a synthetic operator token fixture); must not touch: P10 operator function bodies.

**Objective** — Enforce at one choke point that every audited operator command runs under an MFA-authenticated named principal and that the recorded `actor` is that principal, so audit history cannot be forged by someone holding only operator database credentials.

**Implementation instructions**
1. Migration: `ALTER TABLE audit.operator_actions ADD COLUMN token_id uuid;` then `CREATE OR REPLACE FUNCTION audit.record_operator_action(...)` with the **identical 12-argument signature** from P10-T11. New body: `v_principal := audit.current_operator(); IF v_principal IS NULL THEN RAISE ... 'OPERATOR_NOT_AUTHENTICATED'; IF p_actor IS DISTINCT FROM v_principal THEN RAISE ... 'OPERATOR_ACTOR_MISMATCH';` then insert with `token_id = audit.current_operator_token_id()`. The function always writes a non-null `token_id`; no table constraint is added because development databases may hold P10-era rows without one (risk R-10). Because every P10 operator function calls this function, all of them now require authentication without changing their bodies.
2. `apps/cli/src/operator-auth.ts`: `resolveOperatorToken(argv, env): string` reads `--token` or `FLOWLEDGER_OPERATOR_TOKEN`; rejects any value starting with `fl_test_` with exit 2 and message `merchant credentials are not operator credentials` before any DB call; decodes (without trusting) the payload to obtain `sub`; `connectAsOperator(url, token)` opens a single connection and runs `SELECT audit.authenticate_operator($1)` before any command. The returned principal is passed as `p_actor`. Remove `--actor` from every `flowledger ops` command; reject unknown flags (so no `--merchant-override`/tenant header path exists).
3. Read-only commands (`ops evidence inspect` and P11-T04/T05 views) also authenticate with `operator.read` on `OPERATOR_READONLY_DATABASE_URL`.
4. Never log or echo the token; the CLI's logger binding list excludes it; add the synthetic token to prohibited fixtures so redaction scans cover it.
5. Update P10 tests: every call to an operator function first mints a token for alice (or bob for second-principal steps) and calls `authenticateOperator(client, token)` on the same connection; runbook e2e tests pass `--token`.

**Expected behavior** — Unauthenticated `flowledger ops outbox republish` fails with `OPERATOR_NOT_AUTHENTICATED` and writes nothing; with alice's token it succeeds and the audit row has `actor=alice@…` and `token_id=<jti>`; calling the SQL function directly with `p_actor='bob@…'` while authenticated as alice fails with `OPERATOR_ACTOR_MISMATCH`.

**Acceptance criteria**
- [ ] Every P10 operator function, called without authentication, raises `OPERATOR_NOT_AUTHENTICATED` (one case per function).
- [ ] Actor spoofing raises `OPERATOR_ACTOR_MISMATCH`.
- [ ] Correction approval by bob after alice's request still works; alice approving her own still fails.
- [ ] Every operator role (`fl_operator_readonly`, `fl_operator_command`, `fl_correction`) gets `42501` on direct `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` against `payments.payments`, `payments.payment_operations`, `ledger.journal_transactions`, `ledger.journal_entries`, `ledger.account_balances`, `settlement.runs`, `settlement.batches`, `settlement.batch_members`, `audit.operator_actions`.
- [ ] Audit rows remain immutable for the owner (`AUDIT_IMMUTABLE`).
- [ ] CLI rejects `fl_test_…` before connecting (asserted with a pool spy).
- [ ] All P10 tests pass after the update.

**Testing requirements** — `test/integration/security/operator-audit-binding.test.ts` cases: `unauthenticated <function> rejected` (×7), `actor mismatch rejected`, `audit row carries token_id`, `two-principal correction still works`, `operator roles cannot mutate financial tables` (matrix), `audit immutable`. Unit `apps/cli/src/operator-auth.test.ts`: `rejects merchant credential`, `reads env token`, `rejects unknown flag`. Commands: `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`.

**Non-goals** — No approver-tier roles (deferred, `docs/KNOWN_LIMITS.md`).

**Handoff checklist**
- [ ] `grep -r -- '--actor' apps/cli` returns nothing.
- [ ] `pnpm check`, `pnpm test:integration`, `pnpm test:e2e` green; `Task: P11-T03`.

---

### P11-T04 — Operator views: payments, attempts, evidence, journal postings, bucket balances

**Task ID:** `P11-T04`
**Feature:** Operator visibility
**Commit:** `feat(security): add authenticated read-only operator views for payments and ledger`
**Priority:** High
**Dependencies:** `P11-T03`
**Estimated complexity:** M
**Contract references:** `docs/10` M11 bullet 5 (line 490); `docs/07` §Tenant isolation items 2 and 7 (logical-balance view is operator-only), `providers.provider_attempts`, `providers.provider_evidence`, `ledger.*`; `docs/06` §Redaction and retained evidence (allowlist); `docs/05` §Retrieve a payment timeline (entry kinds and ordering rule).
**Files:** create: `migrations/1120_operator_views_payments_ledger.sql`, `apps/cli/src/commands/ops/view.ts`, `apps/cli/src/commands/ops/timeline.ts`, `test/integration/security/operator-views-payments.test.ts`; modify: `apps/cli/src/main.ts`; must not touch: merchant-facing views.

**Objective** — Give an authenticated operator cross-tenant, read-only visibility into payment and ledger state through security-barrier views that return rows only to an MFA-authenticated principal and expose only allowlisted columns.

**Implementation instructions**
1. Every view: `WITH (security_barrier)`, owner `fl_migration_owner`, predicate `WHERE audit.current_operator() IS NOT NULL`, `GRANT SELECT` to `fl_operator_readonly` only (grants last). If a base table has `FORCE ROW LEVEL SECURITY`, add `FOR SELECT TO fl_migration_owner USING (true)` in the same migration.
2. Views (columns are the allowlist; nothing else):
   - `payments.operator_payments`: id, merchant_id, status, version, requested/authorized/captured/refunded/reserved amounts, unresolved_refund_count, active_exclusive_operation_id, provider, provider_account_id, created_at, updated_at. **Excludes** payment-method ciphertext/reference.
   - `payments.operator_operations`: id, merchant_id, payment_id, type, status, version, amount, provider_idempotency_key, fee snapshot fields, fee_effect_amount_minor, resolution_evidence_id, not_before, lease_expires_at, created_at, resolved_at.
   - `providers.operator_attempts`: id, merchant_id, operation_id, attempt_number, status, dispatch_marked_at, outcome class, normalized code, HTTP status, duration, started/completed timestamps. No bodies.
   - `providers.operator_evidence`: `CREATE OR REPLACE VIEW` of the P10-T13 view with the same columns plus the authentication predicate.
   - `ledger.operator_journal_postings`: journal header columns (id, merchant_id, posting_key, operation_type, payment_id, payment_operation_id, reversal_of_transaction_id, correlation_id, causation_id, recorded_at) joined with entries (entry_ordinal, account code, logical_code, bucket_index, side, amount_minor). Excludes `metadata`.
   - `ledger.operator_account_balances`: account id, owner_type, owner_id, logical_code, bucket_index, code, normal_side, debit/credit totals, normal balance, version, updated_at.
   - `ledger.operator_logical_balances`: `SELECT * FROM ledger.logical_account_balances WHERE audit.current_operator() IS NOT NULL`.
3. CLI: `flowledger ops view <name> [--merchant <mer_id>] [--payment <pay_id>] [--limit 100]` where `<name>` is the view name without schema/prefix (`payments`, `operations`, `attempts`, `evidence`, `journal`, `balances`, `logical-balances`); `--merchant` is a filter on rows already visible to the operator, not a tenant switch. `flowledger ops timeline --payment <pay_id>`: composes entries from the views (operations, attempts, evidence, journal, settlement members, webhook deliveries, case activity — the latter three available after P11-T05; until then those sources are omitted and the task's test does not assert them), ordered by database-recorded time with deterministic tiebreak, same `kind` values as `docs/05`. Output JSON lines passed through the redaction allowlist.

**Expected behavior** — Authenticated operator sees both merchants' payments; unauthenticated `fl_operator_readonly` session sees zero rows in every view; `fl_api` gets `42501`.

**Acceptance criteria**
- [ ] Each view returns rows only after `authenticate_operator`; zero rows otherwise.
- [ ] Exact column set per view asserted from `information_schema.columns`.
- [ ] No view exposes payment-method references, metadata, raw bodies, secrets (redaction scan of full view dumps with prohibited fixtures seeded where inputs allow).
- [ ] Merchant roles and worker roles get `42501` on every operator view.
- [ ] `fl_operator_readonly` cannot execute any operator command function (`42501`).

**Testing requirements** — `test/integration/security/operator-views-payments.test.ts` cases: `<view> empty without authentication` (×7), `<view> exact columns` (×7), `cross-tenant rows visible to authenticated operator`, `merchant roles denied`, `view dump redaction scan`, `readonly cannot execute commands`. CLI unit test `apps/cli/src/commands/ops/view.test.ts` for argument parsing. Commands: `pnpm test:unit`, `pnpm vitest run --project integration test/integration/security/operator-views-payments.test.ts`.

**Non-goals** — No write path; no web UI.

**Handoff checklist**
- [ ] Grants last.
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P11-T04`.

---

### P11-T05 — Operator views: outbox/inbox, DLQ, webhooks, settlement, reconciliation, audit

**Task ID:** `P11-T05`
**Feature:** Operator visibility
**Commit:** `feat(security): add authenticated operator views for messaging, webhooks, settlement, and reconciliation`
**Priority:** High
**Dependencies:** `P11-T04`
**Estimated complexity:** M
**Contract references:** `docs/10` M11 bullet 5; `docs/07` `messaging.*`, `webhooks.*`, `settlement.*`, `reconciliation.*`; `docs/07` §Tenant isolation item 8; `docs/04` §Sensitive data; `docs/08` §DLQ contract (retained fields).
**Files:** create: `migrations/1130_operator_views_operations.sql`, `test/integration/security/operator-views-operations.test.ts`; modify: `apps/cli/src/commands/ops/view.ts`, `apps/cli/src/commands/ops/timeline.ts` (add the three deferred sources); must not touch: P11-T04 migration.

**Objective** — Complete operator visibility over messaging, webhook, settlement, reconciliation, and audit state with the same authentication predicate and column allowlisting.

**Implementation instructions**
1. Same view rules as P11-T04 step 1.
2. Views:
   - `messaging.operator_outbox`: envelope_id, kind, message_type, merchant_id, aggregate_type, aggregate_id, aggregate_version, ordering_key, correlation_id, causation_id, occurred_at, recorded_at, available_at, lease_expires_at, publication_attempts, published_at, last_error_class, envelope (validated, already redacted by contract).
   - `messaging.operator_inbox`: consumer_name, envelope_id, message_type, merchant_id, received_at, processed_at, result_reference.
   - `messaging.operator_dead_letters`: every `dead_letter_records` column (the stored envelope is already redacted at insert) plus aggregated replay history (`jsonb_agg` of `dead_letter_replays` rows: actor_id, reason, replayed_at, outcome, error_class).
   - `webhooks.operator_deliveries`: delivery id, endpoint id, merchant id, domain event id, event type, payload hash, state, attempt count, next attempt time, created/completed times. **Excludes** `body_bytes`, signing secret references.
   - `webhooks.operator_delivery_attempts`: delivery id, attempt number, HTTP status, classification, duration, started/completed times. **Excludes** response bodies/headers.
   - `settlement.operator_runs`: all `settlement.runs` columns except `lease_token`.
   - `settlement.operator_batches`: all `settlement.batches` columns plus `members jsonb` (`movement_transaction_id`, `movement_kind`, `clearing_delta_minor`).
   - `reconciliation.operator_cases`: all `reconciliation.cases` columns except `lease_token`, plus `activity jsonb` (ordered `case_activity` rows).
   - `audit.operator_actions_view`: all `audit.operator_actions` columns.
3. CLI `ops view` gains `outbox`, `inbox`, `dead-letters`, `deliveries`, `delivery-attempts`, `settlement-runs`, `settlement-batches`, `cases`, `audit`; `ops timeline` adds settlement, webhook-delivery, and case-activity entries.

**Expected behavior** — As P11-T04, for these surfaces.

**Acceptance criteria**
- [ ] Each of the nine views: empty without authentication, exact columns, denied to merchant/worker roles.
- [ ] No `lease_token`, `body_bytes`, response body, or secret reference appears in any view.
- [ ] `ops timeline` for a settled, webhook-notified, once-reconciled payment includes `SETTLEMENT`, `WEBHOOK_DELIVERY`, and `RECONCILIATION_ACTIVITY` entries in database-time order.

**Testing requirements** — `test/integration/security/operator-views-operations.test.ts` with the same case families as P11-T04 (×9) plus `operator timeline complete`. Command: `pnpm vitest run --project integration test/integration/security/operator-views-operations.test.ts`.

**Non-goals** — No mutation; no archival.

**Handoff checklist**
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P11-T05`.

---

### P11-T06 — Correlation and causation propagation through logs and traces

**Task ID:** `P11-T06`
**Feature:** Telemetry propagation
**Commit:** `feat(obs): propagate correlation, causation, and trace context end to end`
**Priority:** Critical
**Dependencies:** `P10-GATE`
**Estimated complexity:** L
**Contract references:** `docs/10` M11 bullet 2 (line 487), acceptance "One end-to-end trace links HTTP acceptance, outbox publication, worker execution, provider evidence, ledger posting, settlement, and merchant delivery" (line 507); `docs/05` §Request and correlation identifiers (lines 489–503); `docs/04` §Envelope (`correlationId`, `causationId`, `traceparent`); `docs/01` §Initial deployment (OpenTelemetry); `docs/08` line 595 (IDs in logs/traces, not metric labels).
**Files:** create: `packages/observability/src/context.ts`, `packages/observability/src/context.test.ts`, `migrations/1140_settlement_member_traceparents.sql`, `test/e2e/trace-propagation.test.ts`; modify: `packages/observability/src/logger.ts`, `packages/contracts/src/envelope.ts` (default `traceparent` from active span), `packages/messaging/src/relay.ts`, `packages/messaging/src/consumer.ts`, the provider-call module in `apps/payment-worker/src/`, `apps/reconciler/src/` lookup module, `apps/merchant-webhook-dispatcher/src/` delivery module, `apps/settlement-worker/src/loop.ts`, `apps/api/src/` request hook, `packages/database/src/tx.ts` (span per transaction); must not touch: SQL functions other than the new one.

**Objective** — Every log line and span for a workflow carries the same correlation ID and the right causation/envelope/payment/operation identifiers, and one trace connects HTTP acceptance through merchant delivery, with settlement linked to the movements it closed over.

**Implementation instructions**
1. `context.ts`: `type TelemetryContext = { requestId?; correlationId; causationId?; envelopeId?; paymentId?; operationId?; settlementRunId?; settlementBatchId?; deliveryId?; caseId? }` stored in `AsyncLocalStorage`; `runWithContext(ctx, fn)`, `currentContext()`, `withContextFields(partial, fn)`.
2. Logger: pino `mixin()` returns `currentContext()` fields; these keys are added to the redaction allowlist as identifiers (they contain no secrets). Never add amounts or provider payloads.
3. Spans (OTel API): API request span (server) with attributes `flowledger.correlation_id`, `flowledger.request_id`; `withTransaction` child span `db.transaction`; `buildEnvelope()` sets `traceparent` from the active span when the caller did not pass one; relay publish span (kind `PRODUCER`) whose parent is extracted from the envelope `traceparent`; consumer span (kind `CONSUMER`) parent = envelope `traceparent`, attributes `messaging.message.id = envelope.id`, `flowledger.causation_id`; provider call span (kind `CLIENT`) with `flowledger.operation_id`, provider name; ledger post span around `postPaymentOperation`; merchant webhook delivery span parent = deliver-command envelope `traceparent`. SQL-built envelopes (ledger event, settlement event) receive `traceparent` from the caller: the ledger routine copies the transaction's `current_setting('flowledger.traceparent', true)` if P03 supports it; otherwise those envelopes carry the template's `traceparent` (settlement) or none (ledger), and the e2e test asserts linkage through the payment command/event envelopes instead (risk R-03).
4. Settlement links: migration adds `settlement.batch_member_traceparents(p_batch_id text) RETURNS SETOF text` (`SECURITY DEFINER`, owner `settlement_function_owner`, `fl_settlement_worker` only, `LIMIT 128`) returning `traceparent` of the `payment.capture.succeeded.v1`/`payment.refund.succeeded.v1` outbox envelopes whose payload `operationId` equals each member movement's `payment_operation_id`. After a batch commits, the worker starts span `settlement.batch` with `links` built from those traceparents (≤ 128; note truncation as span attribute `flowledger.links_truncated=true`). Grant `SELECT ON messaging.outbox_messages TO settlement_function_owner` with an RLS policy if RLS is enabled.
5. Correlation ID: API uses client `X-Correlation-Id` or generates one; the first committed command's correlation ID flows into operation, attempts, journal, outbox, traces, deliveries (`docs/05` line 499). Settlement uses `settlement:<srn_id>`.

**Expected behavior** — For one capture, an in-memory span exporter shows a single trace containing: API server span → db.transaction → relay PRODUCER → payment-worker CONSUMER → provider CLIENT → ledger post → relay PRODUCER (capture.succeeded) → projector CONSUMER → dispatcher delivery span; the settlement trace's `settlement.batch` span has a link to that trace ID. Every log line of that workflow has the same `correlationId`.

**Acceptance criteria**
- [ ] e2e: one trace ID spans HTTP acceptance, outbox publication, worker execution, provider call/evidence, ledger posting, merchant delivery; the settlement span links to it.
- [ ] Every captured log line for the workflow carries the same `correlationId`; consumer logs carry `envelopeId` and `causationId`.
- [ ] Replayed API request (same idempotency key, different `X-Correlation-Id`) keeps the original correlation ID in later telemetry.
- [ ] No metric instrument receives any of the context ID keys as a label (guard from P11-T07 throws in tests).

**Testing requirements** — Unit `packages/observability/src/context.test.ts`: `context survives await`, `nested override restores`, `logger mixin includes fields`. E2E `test/e2e/trace-propagation.test.ts` (InMemorySpanExporter + captured pino stream): `single trace from API to merchant delivery`, `settlement span links capture trace`, `logs share correlation id`, `replay keeps original correlation`. Commands: `pnpm test:unit`, `pnpm vitest run --project e2e test/e2e/trace-propagation.test.ts`.

**Non-goals** — No sampling policy tuning (P12/P13).

**Handoff checklist**
- [ ] `pnpm check`, `pnpm test:integration`, `pnpm test:e2e` green; `Task: P11-T06`.

---

### P11-T07 — Metrics pipeline, registry, label guard, API and database metrics

**Task ID:** `P11-T07`
**Feature:** Metrics
**Commit:** `feat(obs): add metrics registry, collector pipeline, and API/database metrics`
**Priority:** Critical
**Dependencies:** `P10-GATE`
**Estimated complexity:** L
**Contract references:** `docs/08` §Recovery observability (lines 561–595); `docs/09` §Required metrics → API and database (lines 404–409); CONVENTIONS §12 (exact names, no IDs as labels).
**Files:** create: `packages/observability/src/metrics.test.ts`, `packages/observability/src/db-snapshot.ts`, `infra/docker/otel-collector.yaml` (or modify if P00 created it), `infra/docker/prometheus/prometheus.yml`, `test/integration/observability/metrics-pipeline.test.ts`; modify: `packages/observability/src/metrics.ts`, P00 OTel bootstrap in `packages/observability/src/`, `packages/database/src/tx.ts`, `packages/database/src/pool.ts`, `apps/api/src/` (request hook and idempotency handler), `infra/docker/compose.yaml`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: app business logic.

**Objective** — Establish one metrics registry whose names are exactly the contracted ones, export them through OTLP to a local collector and Prometheus without name mangling, forbid unbounded labels, and implement the API/database metrics.

**Implementation instructions**
1. `metrics.ts` exports `METRICS` — a frozen record keyed by the exact metric name (every row of the phase-overview inventory), each `{ type: 'counter'|'gauge'|'histogram', labels: readonly string[], description, source: 'docs/08'|'docs/09'|'docs/10' }`, plus `getCounter(name)`, `getHistogram(name)`, `getGauge(name)` returning OTel instruments created with **no unit suffix in the name** and `unit` metadata only. `LABEL_ALLOWLIST = ['route','method','status_class','code','result','sqlstate','operation_type','outcome','provider','account_tier','classification','consumer','worker','logical_account','bucket','phase','case_type','source','status','net','class']`. Recording helpers throw `MetricLabelError` (in `NODE_ENV=test`) or drop the label and increment an internal `metric_label_violations` counter (otherwise) when a label key is not in the metric's declared `labels`.
2. `metrics.test.ts` parses the fenced code block under `## Recovery observability` in `docs/08-FAILURE_AND_RECOVERY.md` and asserts each listed base name (first token; for `reconciliation_age and attempts` both `reconciliation_age` and `reconciliation_attempts`) exists in `METRICS`; asserts no declared label is in `['merchant_id','payment_id','operation_id','envelope_id','customer','correlation_id','batch_id','run_id']`.
3. `db-snapshot.ts`: `registerDbSnapshot(pool: Pool, functionName: string, intervalMs: number)` — periodically (not per scrape) calls `SELECT metric, labels, value FROM <functionName>()` (function name validated against `^[a-z_]+\.metrics_snapshot$`), caches the rows, and serves them through OTel observable gauges registered for every `METRICS` gauge whose name appears; rows with unknown metric names or labels are dropped and counted in `metric_label_violations`.
4. Pipeline: apps export OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`). Compose services (pinned image tags recorded in `docs/VERSIONS.md`): `otel-collector` (contrib image) with `infra/docker/otel-collector.yaml` — receivers `otlp`; exporters `prometheus` on `:8889` with `add_metric_suffixes: false` and `resource_to_telemetry_conversion: { enabled: false }` so names match the registry verbatim **[ASSUMPTION, risk R-04]**; traces exporter `debug`. `prometheus` scraping `otel-collector:8889` and `postgres-exporter:9187`, `evaluation_interval: 15s`, `rule_files: [alerts.yml]` (file created in P11-T13; until then an empty `groups: []` file is committed here). `postgres-exporter` against the compose PostgreSQL using a dedicated read-only monitoring login **[ASSUMPTION]**: create it in `infra/docker/postgres-init/` only if P00 has that hook; otherwise use `fl_operator_readonly` credentials with `pg_monitor` granted by a migration — prefer the former.
5. API/DB metrics: Fastify `onResponse` hook records `http_server_request_duration` and `http_server_requests_total` with `route` = route template (never raw URL), `status_class` (`2xx`…), `code` = problem code or `none`; idempotency handler increments `idempotency_requests_total{result}`; `withTransaction` records `db_commit_latency` (COMMIT round-trip) and `db_transaction_retries_total{sqlstate}`; pool wrapper records `db_pool_wait` (acquire time) and observable `db_pool_active_connections`.

**Expected behavior** — With compose up and the API exercised, `curl localhost:8889/metrics` lists `http_server_request_duration_bucket{route="/v1/payments",...}` and `idempotency_requests_total{result="replay"}` with names unchanged; Prometheus target health is `up` for collector and postgres-exporter.

**Acceptance criteria**
- [ ] Registry contains every inventory row; docs/08 parity test passes and fails if a name is removed.
- [ ] Recording a forbidden label throws in tests.
- [ ] Collector output names equal registry names (no `_total`/unit suffix added): integration test scrapes `:8889` and checks the API/DB metric names.
- [ ] `route` label uses templates (`/v1/payments/{paymentId}`), never IDs.
- [ ] postgres-exporter metrics `pg_stat_database_deadlocks` and `pg_locks_count` visible in Prometheus.

**Testing requirements** — Unit `packages/observability/src/metrics.test.ts` (`docs/08 parity`, `no ID labels`, `forbidden label throws`), `packages/observability/src/db-snapshot.test.ts` (`unknown metric dropped`, `function name validated`). Integration `test/integration/observability/metrics-pipeline.test.ts` using Testcontainers `GenericContainer` for the collector and Prometheus with the checked-in configs: `api metrics exported with exact names`, `db retry counter increments on forced 40001`, `postgres exporter scraped`. Commands: `pnpm test:unit`, `pnpm vitest run --project integration test/integration/observability/metrics-pipeline.test.ts`.

**Non-goals** — Cloud Monitoring export (P13); host CPU/memory/IOPS/storage-latency metrics, which come from Cloud SQL in P13 (risk R-05).

**Handoff checklist**
- [ ] Image tags pinned and recorded.
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P11-T07`.

---

### P11-T08 — Messaging, worker, provider, and webhook metrics

**Task ID:** `P11-T08`
**Feature:** Metrics
**Commit:** `feat(obs): add messaging, provider, worker, and webhook metrics`
**Priority:** High
**Dependencies:** `P11-T07`
**Estimated complexity:** L
**Contract references:** `docs/08` §Recovery observability; `docs/09` §Required metrics → Messaging and workers; `docs/08` §Recovery objectives and alerts (outbox, webhook rows).
**Files:** create: `migrations/1150_messaging_webhook_metrics_snapshots.sql`, `test/integration/observability/messaging-metrics.test.ts`; modify: `packages/messaging/src/relay.ts`, `packages/messaging/src/consumer.ts`, `packages/providers/src/` instrumentation wrapper (one file wrapping adapter calls), `apps/payment-worker/src/` (claim/lease and DLQ/orphan detector), `apps/provider-webhook-receiver/src/` (signature failure, duplicate), `apps/provider-webhook-worker/src/main.ts`, `apps/merchant-webhook-dispatcher/src/main.ts`, `apps/outbox-relay/src/main.ts`; must not touch: business transitions.

**Objective** — Emit every messaging/provider/webhook metric in the inventory from its owning process, with database-derived gauges computed by protected aggregate-only snapshot functions.

**Implementation instructions**
1. Migration — each `SECURITY DEFINER STABLE`, fixed `search_path`, returns `TABLE (metric text, labels jsonb, value double precision)`, no IDs in output:
   - `messaging.metrics_snapshot()` (owner `messaging_function_owner`; `EXECUTE` to `fl_relay`, `fl_payment_worker`): `outbox_oldest_unpublished_age` = `extract(epoch from clock_timestamp() - min(recorded_at))` over unpublished rows (0 when none); `dlq_depth` per `(consumer_name, failure_class)` over unresolved DLQ records with labels `{"consumer":…, "classification":…}`.
   - `providers.metrics_snapshot()` (owner `payments_function_owner` or the providers owner P02 assigned; `EXECUTE` to `fl_webhook_worker`): `provider_webhook_unprocessed_age` over verified, unprocessed notifications.
   - `webhooks.metrics_snapshot()` (owner `webhooks_function_owner`; `EXECUTE` to `fl_webhook_dispatcher`): `merchant_webhook_oldest_pending_age`.
   Grants last; add `FOR SELECT TO <owner> USING (true)` policies where RLS is enabled on the read tables.
2. Relay: `outbox_rows_published_total`, `outbox_publish_retries_total`; observable counter `outbox_rows_created_total` from `SELECT n_tup_ins FROM pg_stat_user_tables WHERE schemaname='messaging' AND relname='outbox_messages'` (monotonic, no table scan); `registerDbSnapshot(pool, 'messaging.metrics_snapshot', 5000)` (outbox gauge only exported by relay; DLQ gauge only by payment-worker — filter by metric name per process).
3. Consumer: `message_delivery_attempts_total{consumer,result}`, `duplicate_envelopes_total{consumer}` on inbox hit, `subscription_oldest_unprocessed_age{consumer}` = max over the last 15 s of `now − envelope.recordedAt` at receipt (local approximation; Pub/Sub backlog metrics replace it in P13 — risk R-05).
4. Provider wrapper: `provider_attempts_total{provider,operation_type,outcome}` (normalized outcome only), `provider_request_latency{provider,operation_type}`, `provider_rate_limited_total{provider}`, `provider_in_flight{provider}`, `provider_circuit_state{provider}`.
5. Payment worker: `worker_lease_acquisitions_total{worker="payment-worker",result}`; reconciler and settlement worker add the same counter with their `worker` value (settlement in P11-T11).
6. Webhook receiver: `provider_webhook_signature_failures{provider}`, `duplicate_provider_notifications_total{provider}`.

**Expected behavior** — Stopping the relay for 20 s makes `outbox_oldest_unpublished_age` ≥ 20; a tampered webhook increments `provider_webhook_signature_failures`; a redelivered envelope increments `duplicate_envelopes_total`.

**Acceptance criteria**
- [ ] Each metric in this task's inventory rows appears in the collector output with exact name and declared labels only.
- [ ] Snapshot functions return no column/label containing an ID (assert label keys).
- [ ] Snapshot functions are not executable by `fl_api` or operator roles.
- [ ] Each metric changes in the expected direction under its trigger (one case per metric).

**Testing requirements** — `test/integration/observability/messaging-metrics.test.ts` (in-process apps with in-memory metric reader): `outbox age grows when relay stopped`, `dlq depth by consumer and classification`, `duplicate envelope counted`, `delivery attempts by result`, `provider outcome counters`, `rate limit counter`, `circuit state gauge`, `signature failure counter`, `duplicate notification counter`, `webhook unprocessed age`, `merchant webhook pending age`, `outbox rows created monotonic`, `snapshot labels contain no ids`, `snapshot role denial`. Command: `pnpm vitest run --project integration test/integration/observability/messaging-metrics.test.ts`.

**Non-goals** — No dashboards/alerts (T12/T13).

**Handoff checklist**
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P11-T08`.

---

### P11-T09 — Ledger posting and per-bucket lock-wait metrics

**Task ID:** `P11-T09`
**Feature:** Metrics
**Commit:** `feat(obs): add ledger posting and bucket lock-wait metrics`
**Priority:** High
**Dependencies:** `P11-T07`
**Estimated complexity:** M
**Contract references:** `docs/08` §Recovery observability (`ledger_posting_conflicts`, `ledger_bucket_lock_wait by logical account`); `docs/09` §Required metrics → Ledger and recovery ("Balance lock wait per logical account and per bucket"), §Ledger contention; `docs/02` §Concurrency; ADR-0010.
**Files:** create: `migrations/1160_ledger_lock_wait_instrumentation.sql`, `packages/database/src/ledger-metrics.ts`, `test/integration/observability/ledger-metrics.test.ts`; modify: `packages/database/src/functions/payments.ts` (`applyProviderEvidence` wrapper — payment postings happen inside SQL via `ledger.post_payment_operation`, P07), `packages/database/src/functions/settlement.ts` (`postBatch` wrapper); must not touch: posting validation logic.

**Objective** — Measure balance-row lock wait inside the posting routine per logical account and bucket, plus posting counts/latency/conflicts, without adding writes to the hot path.

**Implementation instructions**
1. Migration: `CREATE OR REPLACE FUNCTION ledger.post_journal_internal(...)` (P03 private posting routine) with the identical 16-argument signature (copy the current body from `pg_get_functiondef`), adding only: `v_t0 := clock_timestamp()` immediately before the ordered balance-row `FOR UPDATE`, `v_wait := clock_timestamp() - v_t0` after it, and `PERFORM set_config('flowledger.ledger_lock_wait', <json>, true)` where `<json>` is an array of `{"logicalCode": text, "bucket": smallint|null, "waitMicros": bigint}` — one element per logical account touched, all sharing the measured wait (one lock statement locks all rows). Also `set_config('flowledger.ledger_posting_result', 'created'|'replayed', true)`. No table writes. Diff vs previous body must contain only these lines (reviewers diff).
2. `ledger-metrics.ts`: `recordLedgerPostingMetrics(client, operationType, startedAt)` reads both settings in the same transaction (`SELECT current_setting('flowledger.ledger_lock_wait', true), current_setting('flowledger.ledger_posting_result', true)`), records `ledger_bucket_lock_wait{logical_account, bucket}` (bucket `"none"` for unstriped; seconds), `ledger_postings_total{operation_type,result}`, `ledger_posting_latency{operation_type}`. On the P03 idempotency-conflict `DomainError`, increment `ledger_posting_conflicts{operation_type}` and rethrow.
3. Call it, in the same transaction, from the `applyProviderEvidence` wrapper when the result has a non-null `ledgerTransactionId` (operation type from the result) and from the `postBatch` wrapper (both paths share the routine).

**Expected behavior** — Two concurrent captures on payments in the same bucket produce one lock-wait sample > 0 for that bucket's `platform.processor_receivable`/`platform.fee_revenue`; different buckets show ~0 waits.

**Acceptance criteria**
- [ ] Lock wait recorded per `(logical_account, bucket)`; label values bounded (bucket 0–N−1 or `none`).
- [ ] Replay of an existing posting key increments `result="replayed"`, not `created`.
- [ ] Conflict increments `ledger_posting_conflicts`.
- [ ] All P03/P07/P10 ledger and settlement tests still pass (routine regression).
- [ ] A held lock on a bucket row (superuser `SELECT … FOR UPDATE` for 500 ms) yields a sample ≥ 0.5 s for that bucket.

**Testing requirements** — `test/integration/observability/ledger-metrics.test.ts`: `held bucket lock measured`, `different buckets no wait`, `replayed result`, `conflict counter`, `settlement posting records merchant accounts with bucket none`. Commands: `pnpm vitest run --project integration test/integration/observability/ledger-metrics.test.ts`, `pnpm test:integration`.

**Non-goals** — No contention benchmark (P12).

**Handoff checklist**
- [ ] Routine body diff limited to instrumentation lines.
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P11-T09`.

---

### P11-T10 — Payment operation, refund reservation, and reconciliation metrics

**Task ID:** `P11-T10`
**Feature:** Metrics
**Commit:** `feat(obs): add operation, refund reservation, and reconciliation metrics`
**Priority:** High
**Dependencies:** `P11-T07`
**Estimated complexity:** M
**Contract references:** `docs/08` §Recovery observability, §Recovery objectives and alerts rows 1–4 and 7; `docs/09` §Required metrics → API and database (state counts, oldest unresolved exclusive/refund), Ledger and recovery (reservations, guard rejections, UNKNOWN/REVIEW counts/age, reconciliation attempts, resolution source, discrepancies).
**Files:** create: `migrations/1170_payments_reconciliation_metrics_snapshots.sql`, `test/integration/observability/payment-metrics.test.ts`; modify: `apps/api/src/` command acceptance handler (requested counter, guard rejections), `apps/payment-worker/src/` (stale sweeper counter, snapshot registration, resolution-source counter), `apps/reconciler/src/` (attempt counter, resolution source, snapshot registration), `apps/provider-webhook-worker/src/` (resolution source, discrepancies); must not touch: transition SQL.

**Objective** — Expose operation-state gauges and ages that drive the first four alert rows, refund reservation totals, and reconciliation progress.

**Implementation instructions**
1. Migration (same snapshot conventions as P11-T08):
   - `payments.metrics_snapshot()` (owner `payments_function_owner`; `EXECUTE` to `fl_payment_worker`): `operations_processing`, `operations_unknown`, `operations_requires_review` by `operation_type`; `operations_requested_oldest_age` (oldest `REQUESTED` with null or past `not_before`, measured from `created_at` or `not_before` whichever is later); `operations_processing_overdue_lease_age` (max of `clock_timestamp() − lease_expires_at` over `PROCESSING` with expired lease, else 0); `operations_unknown_oldest_age`, `operations_requires_review_oldest_age` (from the operation's last status change time column P08 uses; if none, `updated_at`); `payment_oldest_unresolved_exclusive_age`, `payment_oldest_unresolved_refund_age`; `payment_reserved_refund_total` = Σ `reserved_refund_amount_minor` (as double; operational gauge only, never used for money); `payment_unresolved_refunds` = Σ `unresolved_refund_count`.
   - `reconciliation.metrics_snapshot()` (owner `reconciliation_function_owner`; `EXECUTE` to `fl_reconciler`): `reconciliation_age{phase="unscheduled"}` = oldest open `AMBIGUOUS_OUTCOME`/`STALE_PROCESSING` case with `attempt_count = 0`; `reconciliation_age{phase="unresolved"}` = oldest unresolved case of those types.
2. Counters: API acceptance `operations_requested_total{operation_type}` after commit; `refund_reservation_guard_rejections_total` when acceptance returns `409 MONETARY_GUARD_FAILED`; stale sweeper `stale_processing_total{operation_type,result}`; reconciler `reconciliation_attempts{case_type,result}` (`resolved`|`rescheduled`|`escalated`); every terminal resolution path `reconciliation_resolutions_total{source}`; discrepancy event creation `payment_discrepancies_total`.
3. Counters increment only after the owning transaction commits.

**Expected behavior** — A timeout-injected capture raises `operations_unknown{operation_type="CAPTURE"}` to 1 and `reconciliation_age{phase="unscheduled"}` until first lookup; resolution increments `reconciliation_resolutions_total{source="RECONCILIATION"}`.

**Acceptance criteria**
- [ ] Each gauge equals an independent SQL computation in the test.
- [ ] Each counter increments exactly once per committed event and not on rollback (fault injected before commit).
- [ ] `payment_reserved_refund_total` equals Σ unresolved refund amounts during concurrent refunds.

**Testing requirements** — `test/integration/observability/payment-metrics.test.ts`: one case per gauge (`… equals independent query`), `requested counter after commit only`, `guard rejection counter`, `stale processing reclaimed vs unknown`, `reconciliation attempts by result`, `resolution source counter`, `discrepancy counter`, `no increment on rollback`. Command: `pnpm vitest run --project integration test/integration/observability/payment-metrics.test.ts`.

**Non-goals** — No change to recovery behavior.

**Handoff checklist**
- [ ] No `Number()` applied to money outside the gauge export (gauge conversion documented in code).
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P11-T10`.

---

### P11-T11 — Settlement and invariant-checker metrics

**Task ID:** `P11-T11`
**Feature:** Metrics
**Commit:** `feat(obs): add settlement metrics and flowledger verify metric export`
**Priority:** High
**Dependencies:** `P11-T07`
**Estimated complexity:** M
**Contract references:** `docs/08` §Recovery observability (settlement, `ledger_projection_mismatches`, `duplicate_financial_effects_total`), §Recovery objectives (settlement and negative-clearing rows), §Runbook: stalled or deferring settlement; `docs/09` §Continuous invariant checker, §Defining `duplicate_financial_effects_total`, §Required metrics → settlement, §Settlement throughput (measurement boundary).
**Files:** create: `migrations/1180_settlement_metrics_snapshot.sql`, `apps/cli/src/verify/watch.ts`, `test/integration/observability/settlement-metrics.test.ts`; modify: `apps/settlement-worker/src/loop.ts`, `apps/settlement-worker/src/main.ts`, `apps/cli/src/main.ts`; must not touch: settlement SQL functions.

**Objective** — Emit settlement outcome/throughput/age metrics and export the invariant checker's per-class findings (including the duplicate-effect detector and unresolved-ambiguity gauges) as metrics.

**Implementation instructions**
1. Migration: `settlement.metrics_snapshot()` (owner `settlement_function_owner`; `EXECUTE` to `fl_settlement_worker`):
   - `settlement_unsettled_movement_age{net}`: per merchant, compute the independent eligible net (anti-join, as in `post_batch`, without a cutoff) and the oldest unsettled movement `recorded_at`; emit max age over merchants with net > 0 as `net="positive"` and over the rest as `net="nonpositive"` (0 when none).
   - `settlement_negative_clearing_age`: for merchants whose merchant-clearing normal balance < 0, age = `clock_timestamp() −` the `started_at` of the earliest `DEFERRED` run with `net_amount_minor < 0` after the merchant's latest `POSTED` run (or 0 if none yet); emit the max **[ASSUMPTION, risk R-06]**.
2. Worker: `settlement_runs_total{outcome}` per run result (`POSTED`, `DEFERRED`, `FAILED`, `LEASE_LOST`); `settlement_movements_settled_total` += member count — the migration adds `settlement.batch_summary(p_batch_id text) RETURNS TABLE (member_count integer, net_amount_minor bigint)` (`SECURITY DEFINER`, `fl_settlement_worker` only) and the worker calls it in the posting transaction after `postBatch` returns a batch ID; `settlement_batch_size` histogram; `settlement_batch_commit_latency` = time from claim commit to posting commit; `worker_lease_acquisitions_total{worker="settlement-worker",result}`; `registerDbSnapshot(pool, 'settlement.metrics_snapshot', intervalMs)`.
3. `flowledger verify --watch <seconds>`: runs the full checker every interval and exports via OTLP: `invariant_findings{class}` for every class, `ledger_projection_mismatches` (= projection-equality findings), `duplicate_financial_effects_total` (= duplicate-effect detector count, computed only against fake/unreliable provider ground truth as `docs/09` requires), `unresolved_ambiguity_operations{status}` (operations `UNKNOWN`/`REQUIRES_REVIEW` with `P = 1, L = 0`). Exit non-zero on SIGTERM only; findings never crash the watcher. Non-watch `verify` behavior unchanged.

**Expected behavior** — Positive-net merchant with worker stopped: `settlement_unsettled_movement_age{net="positive"}` grows; late refund after settlement: `settlement_negative_clearing_age` grows after the first negative deferral; corrupting a projection makes `ledger_projection_mismatches` = 1 at the next watch tick.

**Acceptance criteria**
- [ ] Settlement gauges equal independent SQL computations.
- [ ] Run outcome counter matches run rows by status after a mixed scenario.
- [ ] `verify --watch` exports every class with the class names from the checker; a corrupted fixture raises the matching `invariant_findings{class}`.
- [ ] `duplicate_financial_effects_total` becomes 1 for a fixture where the fake provider records two effects for one key (test harness only) and 0 otherwise.

**Testing requirements** — `test/integration/observability/settlement-metrics.test.ts`: `unsettled age positive net grows`, `negative clearing age`, `run outcome counters`, `movements settled and batch size`, `commit latency recorded`, `verify watch exports classes`, `projection mismatch metric`, `duplicate effect metric from ground truth`, `unresolved ambiguity gauge`. Command: `pnpm vitest run --project integration test/integration/observability/settlement-metrics.test.ts`.

**Non-goals** — No alert rules (T13).

**Handoff checklist**
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P11-T11`.

---

### P11-T12 — Dashboards as code

**Task ID:** `P11-T12`
**Feature:** Dashboards
**Commit:** `feat(obs): add provisioned Grafana dashboards as code`
**Priority:** High
**Dependencies:** `P11-T08`, `P11-T09`, `P11-T10`, `P11-T11`
**Estimated complexity:** M
**Contract references:** `docs/10` M11 bullet 3 (dashboard areas, line 488), acceptance "Dashboards show queue age, processing leases, unknown/review age, ledger conflicts, per-bucket lock wait, projection mismatches, reserved refund totals, unsettled movement age, and the duplicate-effect count" (line 508), §Demo and portfolio acceptance item 8; `docs/09` §Reporting template (dashboards as artifacts).
**Files:** create: `infra/docker/grafana/provisioning/datasources/prometheus.yaml`, `infra/docker/grafana/provisioning/dashboards/flowledger.yaml`, `infra/docker/grafana/dashboards/overview-correctness.json`, `infra/docker/grafana/dashboards/api-postgres.json`, `infra/docker/grafana/dashboards/messaging-workers-providers.json`, `infra/docker/grafana/dashboards/ledger-settlement-reconciliation.json`, `test/contract/dashboards.test.ts`; modify: `infra/docker/compose.yaml` (add `grafana` service, anonymous viewer, port 3000); must not touch: metric code.

**Objective** — Version-controlled dashboards covering every area in `docs/10` line 488 and every signal in line 508, provisioned automatically in local Compose. Cloud Monitoring equivalents are produced in P13 from the same metric names **[ASSUMPTION, risk R-07]**.

**Implementation instructions**
1. `overview-correctness.json` (the demo dashboard): throughput (`rate(http_server_requests_total[1m])`), p95/p99 (`histogram_quantile` on `http_server_request_duration`), `outbox_oldest_unpublished_age`, `operations_unknown_oldest_age`, `ledger_bucket_lock_wait` p95 by bucket heatmap, `duplicate_financial_effects_total` (stat, green at 0, red otherwise), `invariant_findings` by class.
2. `api-postgres.json`: request rate/latency by route and status class, idempotency results, `db_commit_latency`, `db_transaction_retries_total`, `db_pool_wait`, `db_pool_active_connections`, PostgreSQL exporter panels (deadlocks, locks, connections, WAL).
3. `messaging-workers-providers.json`: rows `Outbox` (created/published/retries, oldest age), `Subscriptions` (`subscription_oldest_unprocessed_age`, delivery attempts, duplicates, `dlq_depth`), `Workers` (lease acquisitions, `operations_processing`, `operations_processing_overdue_lease_age`), `Providers` (attempts by outcome, latency, rate limited, in-flight, circuit state), `Webhooks` (unprocessed age, signature failures, duplicates, merchant pending age).
4. `ledger-settlement-reconciliation.json`: rows `Ledger buckets` (postings by type/result, conflicts, lock wait by logical account and bucket, `ledger_projection_mismatches`), `Refund reservations` (`payment_reserved_refund_total`, `payment_unresolved_refunds`, guard rejections, oldest unresolved refund age), `Settlement` (runs by outcome, movements settled, batch size, commit latency, unsettled age by net, negative clearing age), `Reconciliation` (unknown/review counts and oldest ages, `reconciliation_age` by phase, attempts, resolution source, discrepancies, unresolved ambiguity).
5. Each panel's datasource is the provisioned Prometheus UID `flowledger-prometheus`; dashboards have stable `uid`s; no panel groups or filters by an ID.
6. `test/contract/dashboards.test.ts`: parse all four JSON files; extract metric names from every `expr` (regex over identifiers followed by `{`, `[`, or `)` and filtered by `METRICS` keys plus `pg_` prefix); assert every referenced name exists in `METRICS` or is a `pg_` exporter metric; assert each signal in `docs/10` line 508 maps to ≥ 1 panel via this table: queue age → `outbox_oldest_unpublished_age` and `subscription_oldest_unprocessed_age`; processing leases → `operations_processing_overdue_lease_age`; unknown/review age → `operations_unknown_oldest_age`, `operations_requires_review_oldest_age`; ledger conflicts → `ledger_posting_conflicts`; per-bucket lock wait → `ledger_bucket_lock_wait`; projection mismatches → `ledger_projection_mismatches`; reserved refund totals → `payment_reserved_refund_total`; unsettled movement age → `settlement_unsettled_movement_age`; duplicate-effect count → `duplicate_financial_effects_total`; assert each of the ten areas in line 488 has a row or dashboard title.

**Expected behavior** — `pnpm db:up` then Grafana at `localhost:3000` shows four dashboards populated during an e2e run.

**Acceptance criteria**
- [ ] Contract test passes; removing the bucket lock-wait panel fails it.
- [ ] Every expression references only registry or exporter metrics.
- [ ] Grafana container starts with provisioning and no manual step (asserted in P11-GATE).

**Testing requirements** — `test/contract/dashboards.test.ts` cases `all expressions reference known metrics`, `docs/10 M11 signals covered`, `ten areas covered`, `no id grouping`. Command: `pnpm test:contracts`.

**Non-goals** — Cloud Monitoring JSON (P13); alerting UI.

**Handoff checklist**
- [ ] Grafana image tag pinned in `docs/VERSIONS.md`.
- [ ] `pnpm check` green; `Task: P11-T12`.

---

### P11-T13 — Alert rules with contracted thresholds

**Task ID:** `P11-T13`
**Feature:** Alerting
**Commit:** `feat(obs): add Prometheus alert rules with contracted thresholds and runbook links`
**Priority:** Critical
**Dependencies:** `P11-T08`, `P11-T10`, `P11-T11`
**Estimated complexity:** M
**Contract references:** `docs/08` §Recovery objectives and alerts (table, lines 603–615), §Runbook: ledger or payment discrepancy → Detection; `docs/09` §Stop conditions; `docs/10` M11 bullet 4 (line 489), acceptance line 509.
**Files:** create: `infra/docker/prometheus/alerts.yml` (replace the empty placeholder), `infra/docker/prometheus/alerts.test.yml`, `test/integration/observability/alert-rules.test.ts`; modify: none; must not touch: metric code.

**Objective** — Encode every warning/critical threshold from `docs/08` as Prometheus rules labeled with severity and annotated with the runbook path, and prove each rule's boundary with `promtool test rules`.

**Implementation instructions**
1. Rules (no `for:` clause, so the contracted thresholds apply directly **[ASSUMPTION]**; each has `labels.severity` `warning|critical` and `annotations.runbook` = repository path):

   | Alert | Expression | Runbook |
   | --- | --- | --- |
   | `RequestedClaimAgeWarning` / `…Critical` | `max(operations_requested_oldest_age) > 15` / `> 60` | `docs/runbooks/stale-requested-operation.md` |
   | `StaleProcessingOverdueWarning` / `…Critical` | `max(operations_processing_overdue_lease_age) > 0` / `> 60` | `docs/runbooks/stale-processing-operation.md` |
   | `UnknownFirstReconciliationWarning` / `…Critical` | `max(reconciliation_age{phase="unscheduled"}) > 30` / `> 120` | `docs/runbooks/unknown-operation.md` |
   | `UnknownResolutionAgeWarning` / `…Critical` | `max(operations_unknown_oldest_age) > 900` / `> 4500` | `docs/runbooks/unknown-operation.md` |
   | `OutboxPublicationAgeWarning` / `…Critical` | `max(outbox_oldest_unpublished_age) > 10` / `> 60` | `docs/runbooks/outbox-or-subscriber-backlog.md` |
   | `WebhookProcessingAgeWarning` / `…Critical` | `max(provider_webhook_unprocessed_age) > 30` / `> 300` | `docs/runbooks/provider-webhook-incident.md` |
   | `ManualReviewAgeWarning` / `…Critical` | `max(operations_requires_review_oldest_age) > 14400` / `> 86400` | `docs/runbooks/unknown-operation.md` |
   | `SettlementUnsettledAgeWarning` | `max(settlement_unsettled_movement_age) > 240` (4 × default 60 s interval) | `docs/runbooks/stalled-or-deferring-settlement.md` |
   | `SettlementUnsettledAgeCritical` | `max(settlement_unsettled_movement_age{net="positive"}) > 720` (12 intervals with positive net) | same |
   | `NegativeClearingAgeWarning` / `…Critical` | `max(settlement_negative_clearing_age) > 14400` / `> 172800` | same |
   | `DuplicateFinancialEffects` (critical) | `max(duplicate_financial_effects_total) > 0` | `docs/runbooks/ledger-or-payment-discrepancy.md` |
   | `InvariantFindings` (critical) | `max by (class) (invariant_findings) > 0` | same |

   Business-hour thresholds (`docs/08` rows 7 and 9) are approximated with wall-clock hours (4 h, 24 h, 48 h) **[ASSUMPTION, risk R-08]**. Settlement thresholds assume `SETTLEMENT_INTERVAL_SECONDS=60`; a comment in `alerts.yml` states the formula.
2. `alerts.test.yml`: for every rule, one series just below the threshold (alert absent) and one just above (alert firing with expected `severity` and `runbook`).
3. `test/integration/observability/alert-rules.test.ts`: run `promtool test rules /work/alerts.test.yml` and `promtool check rules /work/alerts.yml` inside the pinned `prom/prometheus` image via Testcontainers (`GenericContainer` with bind mount, entrypoint `promtool`); assert exit 0. Also parse `alerts.yml` and assert every `annotations.runbook` file exists and every metric referenced is in `METRICS`.

**Expected behavior** — All promtool boundary tests pass; changing `> 10` to `> 11` in the outbox warning fails the below/above test.

**Acceptance criteria**
- [ ] One warning and one critical rule for each of the nine `docs/08` signal rows (settlement split as specified).
- [ ] Every rule has a passing below/above promtool case.
- [ ] Every runbook annotation resolves to an existing file.

**Testing requirements** — `test/integration/observability/alert-rules.test.ts` cases `promtool check rules`, `promtool boundary tests`, `runbook links exist`, `metrics exist`. Command: `pnpm vitest run --project integration test/integration/observability/alert-rules.test.ts`.

**Non-goals** — No Alertmanager routing/paging (P13 maps severity to Cloud Monitoring notification channels).

**Handoff checklist**
- [ ] `pnpm check`, `pnpm test:integration` green; `Task: P11-T13`.

---

### P11-T14 — Alerts fire under controlled fault injection; runbooks assert their signals

**Task ID:** `P11-T14`
**Feature:** Alerting verification
**Commit:** `test(obs): prove alerts fire under fault injection and runbook signals move`
**Priority:** High
**Dependencies:** `P11-T12`, `P11-T13`
**Estimated complexity:** M
**Contract references:** `docs/10` M11 acceptance "Alerts fire in a controlled fault injection and link to the correct runbook" (line 509); `docs/08` §Recovery objectives and alerts, all runbooks' Detection sections; `docs/10` M10 acceptance "expected queries/metrics".
**Files:** create: `test/e2e/alerts-fault-injection.test.ts`; modify: `test/e2e/runbooks/*.test.ts` (add signal assertions), `docs/runbooks/*.md` (`## Signals` sections list the alert names from P11-T13); must not touch: alert thresholds.

**Objective** — Show, against the running stack with collector and Prometheus, that real faults drive metrics across thresholds and that the firing alert carries the right runbook link; extend each P10 runbook test to assert its documented metric moves.

**Implementation instructions**
1. Test stack: e2e apps + Testcontainers collector and Prometheus using the checked-in configs with `scrape_interval: 1s`, `evaluation_interval: 1s` overrides (passed as a test-only config file generated in the test's temp dir from the checked-in one).
2. Fault cases (poll `GET /api/v1/alerts` up to 90 s): stop the relay → `OutboxPublicationAgeWarning` firing with `runbook=docs/runbooks/outbox-or-subscriber-backlog.md`; unreliable simulator timeout-after-commit with reconciler stopped → `UnknownFirstReconciliationWarning`; stop the provider-webhook worker after a verified webhook → `WebhookProcessingAgeWarning`; corrupt a balance projection (superuser replica mode) and run `verify --watch 1` → `InvariantFindings`. For each: restore, assert the alert resolves.
3. Runbook tests: each of the nine P10 runbook tests reads the in-memory metric reader (or the collector) after reproduction and asserts the metric named in that runbook's `## Signals` crosses the warning threshold (or, for thresholds measured in hours, that the gauge is > 0 and increasing).

**Expected behavior** — Four alerts fire and resolve; runbook tests now verify metrics as well as SQL.

**Acceptance criteria**
- [ ] Four fault-driven alerts fire with correct `runbook` annotation and resolve after recovery.
- [ ] Each runbook document's `## Signals` names alerts that exist in `alerts.yml` (test parses both).
- [ ] Nine runbook tests assert their metric.

**Testing requirements** — `test/e2e/alerts-fault-injection.test.ts` cases `outbox age alert fires and resolves`, `unknown first reconciliation alert`, `webhook processing age alert`, `invariant findings alert`, `runbook signals reference real alerts`. Command: `pnpm vitest run --project e2e test/e2e/alerts-fault-injection.test.ts test/e2e/runbooks/`.

**Non-goals** — No threshold changes.

**Handoff checklist**
- [ ] `pnpm test:e2e` green; `Task: P11-T14`.

---

### P11-T15 — Systematic cross-tenant isolation suite

**Task ID:** `P11-T15`
**Feature:** Tenant isolation
**Commit:** `test(security): add catalog-driven cross-tenant isolation suite`
**Priority:** Critical
**Dependencies:** `P11-T05`
**Estimated complexity:** M
**Contract references:** `docs/10` M11 acceptance "Automated cross-tenant tests cover API, RLS, protected functions, background roles, operator views, settlement views, and webhook correlation" (line 505); `docs/07` §Tenant isolation (items 1–9), §Schema acceptance tests bullet 1; `docs/05` line 49 (no tenant override); `docs/06` webhook correlation steps.
**Files:** create: `test/integration/security/cross-tenant-catalog.test.ts`, `test/integration/security/cross-tenant-functions.test.ts`, `test/e2e/cross-tenant-api.test.ts`; modify: none; must not touch: production code.

**Objective** — Prove tenant isolation across every exposed surface, with a catalog test that fails when a new merchant-scoped table, view, or function is added without coverage.

**Implementation instructions**
1. Fixtures: merchants A and B with payments, operations, journal postings, settlement batches, webhook deliveries, and reconciliation cases each.
2. `cross-tenant-catalog.test.ts`: query `pg_class`/`pg_attribute` for every table/view in schemas `identity, providers, payments, api, ledger, settlement, messaging, webhooks, reconciliation` with a `merchant_id` column. For each, for each role in `fl_api` (with `app.merchant_id = A`), assert any row visible has `merchant_id = A`; with `app.merchant_id` unset, zero rows; for each worker role, assert either `42501` or that the role's documented access holds (a checked-in table `EXPECTED_ROLE_ACCESS` in the test lists allowed `(role, relation)` pairs; an unlisted relation fails the test — this is the coverage guard). Operator views: visible only after authentication (any merchant), zero before.
3. `cross-tenant-functions.test.ts`: enumerate every `SECURITY DEFINER` function in those schemas from `pg_proc`; each must appear in a checked-in `FUNCTION_CASES` map with a cross-tenant invocation (e.g. capture acceptance with A's session on B's payment → not found/forbidden; `ledger.post_payment_operation` with B's operation under A's correlation → rejected; `settlement.post_batch` with B's run but A's lease token → `SETTLEMENT_LEASE_LOST`; operator functions require authentication) or an explicit `NOT_TENANT_SCOPED` justification; an unlisted function fails the test.
4. `cross-tenant-api.test.ts` (e2e): A's credential on B's payment for every GET/command route → `404 RESOURCE_NOT_FOUND`; timeline of B's payment (including SETTLEMENT entries) → 404; headers `X-Merchant-Id`, `X-Tenant-Id`, `X-Operator-Override` are ignored/rejected per P04 and never change scope; an operator token used as a bearer credential → `401`.
5. Webhook correlation: a provider webhook referencing A's provider operation delivered to an endpoint not allowlisted for A's account → quarantined, no state change for A or B.

**Expected behavior** — All isolation assertions hold; adding a new merchant-scoped view without updating `EXPECTED_ROLE_ACCESS` fails the catalog test.

**Acceptance criteria**
- [ ] Catalog coverage: every merchant-scoped relation and every `SECURITY DEFINER` function covered or justified.
- [ ] API, RLS, protected functions, background roles, operator views, settlement views, webhook correlation each have ≥ 1 passing negative case.
- [ ] Coverage guard observed failing for an uncovered dummy view created in the test database.

**Testing requirements** — The three files above. Commands: `pnpm vitest run --project integration test/integration/security/`, `pnpm vitest run --project e2e test/e2e/cross-tenant-api.test.ts`.

**Non-goals** — No penetration testing beyond these surfaces.

**Handoff checklist**
- [ ] `pnpm test:integration`, `pnpm test:e2e` green; `Task: P11-T15`.

---

### P11-T16 — Captured-telemetry redaction suite

**Task ID:** `P11-T16`
**Feature:** Sensitive-data protection
**Commit:** `test(security): prove secrets and prohibited data are absent from captured telemetry`
**Priority:** Critical
**Dependencies:** `P11-T06`, `P11-T11`
**Estimated complexity:** M
**Contract references:** `docs/10` M11 acceptance "Representative secrets and prohibited payment data are detected by negative tests and absent from captured telemetry" (line 506); `docs/04` §Sensitive data; `docs/06` §Redaction and retained evidence; `docs/08` line 595; CONVENTIONS §12.
**Files:** create: `test/e2e/telemetry-redaction.test.ts`, `packages/observability/src/redaction.detection.test.ts`; modify: `packages/testkit/src/prohibited-data.ts` (add any missing fixture: provider webhook secret, OTP secret, operator token, DB password, `OPERATOR_TOKEN_SIGNING_KEY`, merchant credential); must not touch: production redaction behavior unless a test fails (then fix in `redaction.ts` within this task).

**Objective** — Run a workload that feeds every representative secret and prohibited value into every input surface, capture every telemetry sink, and prove none of them leaks; also prove the detectors themselves catch each fixture (a detector that cannot fire is not evidence).

**Implementation instructions**
1. Detection self-test: for each fixture, assert the scanner used by the suite finds it when deliberately inserted into a sample log line, span attribute, metric label, JSON body, and DB `jsonb` value.
2. Workload: create/authorize/capture/refund with credentials in `Authorization`, PAN-like and CVV values in request bodies (expect `PROHIBITED_PAYMENT_DATA`), provider webhooks signed with the synthetic secret, unreliable-simulator responses containing raw bodies, a settlement run, a merchant webhook delivery, an operator command with a token.
3. Sinks captured: pino streams of every app, InMemorySpanExporter (names, attributes, events, links), InMemoryMetricExporter (names and label values), HTTP error bodies, `messaging.outbox_messages.envelope`, `messaging.dead_letter_records.envelope/error_detail`, `providers.provider_attempts`/`provider_evidence` rows, `reconciliation.case_activity.detail`, `audit.operator_actions`, `webhooks.deliveries` payload bytes, CLI stdout/stderr.
4. Assert zero fixture matches in every sink; assert no metric label value matches any ID pattern from `schemas/common/entity-ids.v1.schema.json`.

**Expected behavior** — Zero matches in every sink; detection self-test finds every fixture in every carrier.

**Acceptance criteria**
- [ ] Detection self-test passes for every fixture × carrier.
- [ ] Zero leaks across all sinks.
- [ ] No ID-shaped metric label values.

**Testing requirements** — Unit `packages/observability/src/redaction.detection.test.ts`; e2e `test/e2e/telemetry-redaction.test.ts` cases `detectors fire on planted fixtures`, `no leak in logs`, `no leak in traces`, `no leak in metrics`, `no leak in stored messages and evidence`, `no leak in audit and CLI output`, `no id metric labels`. Commands: `pnpm test:unit`, `pnpm vitest run --project e2e test/e2e/telemetry-redaction.test.ts`.

**Non-goals** — No change to the redaction policy itself beyond fixing a detected leak.

**Handoff checklist**
- [ ] `pnpm check`, `pnpm test:e2e` green; `Task: P11-T16`.

---

### P11-T17 — Dependency, container, IaC, and secret scans in CI

**Task ID:** `P11-T17`
**Feature:** Supply-chain security
**Commit:** `ci(security): add dependency, container, IaC, and secret scans`
**Priority:** High
**Dependencies:** `P10-GATE`
**Estimated complexity:** S
**Contract references:** `docs/10` M11 bullet 8 (line 493), §CI and verification lanes (PR: dependency-policy and prohibited-data scan; nightly: dependency/container/IaC scans); CONVENTIONS §2 (gitleaks binary approved).
**Files:** create: `.github/workflows/security.yml`, `infra/security/images.txt`, `infra/security/trivy.yaml`, `test/contract/security-workflow.test.ts`; modify: `.gitleaks.toml` (only allowlist entries for synthetic fixtures with a comment per entry); must not touch: the P00 main CI workflow except adding a `needs`-free call if required.

**Objective** — Fail CI on known-vulnerable dependencies, vulnerable or misconfigured container images and IaC, and committed secrets, on PRs that touch the relevant files and nightly.

**Implementation instructions**
1. Workflow triggers: `pull_request` with `paths: ['pnpm-lock.yaml','package.json','**/package.json','infra/**','.github/workflows/**']`, `schedule: '0 6 * * *'`, `workflow_dispatch`. All third-party actions pinned by commit SHA.
2. Jobs:
   - `dependencies`: `pnpm install --frozen-lockfile`; `pnpm audit --prod --audit-level=high`.
   - `containers`: for each image line in `infra/security/images.txt` (the pinned third-party images used in `infra/docker/compose.yaml`: PostgreSQL 17, Pub/Sub emulator, otel-collector, Prometheus, Grafana, postgres-exporter; P13 appends the application images), run `aquasec/trivy:<pinned>` `image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1`. Trivy is a CI binary, not an npm dependency **[ASSUMPTION — justification: no approved scanner covers images/IaC; same status as gitleaks]**.
   - `iac`: `trivy config --config infra/security/trivy.yaml --exit-code 1 infra/` (covers Compose, Dockerfiles, and Terraform once P13 adds it).
   - `secrets`: `gitleaks detect --source . --log-opts="--all" --redact --exit-code 1` (full history).
3. `test/contract/security-workflow.test.ts`: read the workflow and Compose files as text and assert with regular expressions (no new YAML dependency) the four jobs exist, every `uses:` is pinned to a 40-hex SHA, and every image in `compose.yaml` appears in `images.txt`.

**Expected behavior** — Workflow green on main; a planted fake AWS-style key in a branch fails `secrets`; a deliberately old vulnerable image tag fails `containers`.

**Acceptance criteria**
- [ ] Four jobs exist with the specified commands and fail on findings.
- [ ] All actions SHA-pinned; images list matches Compose.
- [ ] Gitleaks allowlist entries each cite the synthetic fixture file.

**Testing requirements** — `test/contract/security-workflow.test.ts` cases `four jobs present`, `actions sha pinned`, `compose images scanned`. Manual verification recorded in the commit body: planted-secret run URL failing, then removed. Command: `pnpm test:contracts`.

**Non-goals** — No SBOM publication or signing (P13 may add).

**Handoff checklist**
- [ ] `pnpm check` green; `Task: P11-T17`.

---

### P11-T18 — Known-limits document

**Task ID:** `P11-T18`
**Feature:** Documentation
**Commit:** `docs: add known-limits document mapped to contract sections`
**Priority:** High
**Dependencies:** `P11-T03`, `P11-T13`
**Estimated complexity:** S
**Contract references:** `docs/10` §M11 Deliberately deferred (lines 495–501), acceptance line 511, §Demo and portfolio acceptance ("known-limits document"), §Explicit non-goals; `docs/00` §Deferred, §Explicitly excluded; README §Deliberate limits; ADR-0011, ADR-0012.
**Files:** create: `docs/KNOWN_LIMITS.md`, `test/contract/known-limits.test.ts`; modify: none; must not touch: `README.md`, contracts.

**Objective** — One document listing everything deliberately not built, each mapped to the contract section that specifies it, so a reviewer learns the boundaries from the repository.

**Implementation instructions**
1. Table `| Limit | Status in MVP | Specified in (doc §, linked) | Why deferred | Risk carried |`, rows at minimum:
   - Clock-driven copy-verify-tombstone archival (published outbox bodies, attempt/notification hot detail, successful merchant-webhook attempt bodies, resolved DLQ payloads, expired API replay bodies) — `docs/07` §Hot operational retention; `docs/04` §MVP messaging decisions (Retention); `docs/10` line 499.
   - Raw-quarantine object deletion by deadline (no raw objects created) — `docs/06` §Redaction and retained evidence (line 809); `docs/07` §Hot operational retention; `docs/10` line 500.
   - Second-approver tooling: what *is* built (two named, MFA-authenticated principals, DB distinct-principal check) vs deferred (approver role tier, approval expiry, notification/routing) — `docs/07` §`ledger.correction_requests`; `docs/08` §Operator authority; `docs/02` §MVP implementation decisions; `docs/10` line 501; P10 risk R-07.
   - Real-provider adapter — ADR-0011; `docs/00` §Deferred.
   - Payouts / draining merchant payable / bank settlement — ADR-0012; `docs/00` §Deferred; `docs/02` §What settlement does not do.
   - Merchant settlement list endpoint and settlement webhooks — `docs/05` §MVP decisions (Settlement surface); `docs/00` §Deferred.
   - Multiple captures, FX, chargebacks, subscriptions, split payments, 3-D Secure, multi-region writes — `docs/00` §Deferred.
   - Cross-tenant operator HTTP API / web app — `docs/00` §Deferred; `docs/01` (operator surface).
   - Table partitioning — `docs/07` §Partitioning plan.
   - Managed schema registry — `docs/04` §MVP messaging decisions.
   - Operator IdP is a local HS256 stub; production would use an external IdP with asymmetric keys — P11 risk R-01.
   - Local metrics gaps: host CPU/memory/IOPS/storage latency and Pub/Sub backlog come from Cloud Monitoring in P13 — `docs/09` §Required metrics; P11 risk R-05.
   - Business-hour alert thresholds approximated by wall-clock hours — `docs/08` §Recovery objectives and alerts; P11 risk R-08.
   - Settlement selects every eligible movement and scans merchant history — `docs/02` §Eligible movements; P10 risks R-08, R-12.
   - No PCI certification or regulatory compliance claim — `docs/00` §Explicitly excluded.
2. Every "Specified in" cell is a relative Markdown link with an anchor (`../docs/07-DATA_MODEL.md#hot-operational-retention` style, GitHub slug rules).
3. `test/contract/known-limits.test.ts`: assert every bullet in `docs/10` lines 497–501 (three items) has a row (match by key phrases: "archival", "quarantine", "second-approver"); every link's file exists and its anchor matches a heading slug in that file; every `docs/00` §Deferred bullet is represented (key-phrase match).

**Expected behavior** — A reviewer can click from each limit to its specifying section.

**Acceptance criteria**
- [ ] All three `docs/10` deferred items and all `docs/00` deferred bullets present.
- [ ] Every link resolves to an existing heading.
- [ ] Test fails on a broken anchor (observed, reverted).

**Testing requirements** — `test/contract/known-limits.test.ts` cases `docs/10 deferred items present`, `docs/00 deferred items present`, `links resolve to headings`. Command: `pnpm test:contracts`.

**Non-goals** — No README edits (README already states the limits; align its wording separately if R-07 is accepted).

**Handoff checklist**
- [ ] `pnpm check` green; `Task: P11-T18`.

---

### P11-GATE — M11 milestone verification

**Task ID:** `P11-GATE`
**Feature:** Milestone gate
**Commit:** `test(obs): add M11 gate verification and evidence note`
**Priority:** Critical
**Dependencies:** `P11-T01` … `P11-T18`
**Estimated complexity:** M
**Contract references:** `docs/10` §M11 Test and acceptance criteria (lines 503–511); `docs/09` §Stop conditions (prohibited data); `docs/08` §Recovery observability.
**Files:** create: `test/e2e/m11-gate.test.ts`, `docs/evidence/P11.md`; modify: `test/contract/threat-model.test.ts` (remove the `planned (P11-Tnn)` allowance); must not touch: production code.

**Objective** — Prove the M11 exit gate end to end: redaction, RLS, traces, metrics, alerts, operator authentication and audit, known limits.

**Implementation instructions**
1. `test/e2e/m11-gate.test.ts` on the full local stack (apps + collector + Prometheus + Grafana via Testcontainers or `pnpm db:up` profile):
   - Run one capture → settlement → merchant webhook flow; assert the single-trace property (reuse P11-T06 helper) and that Prometheus has a non-empty series for **every** metric in the phase-overview inventory (query `/api/v1/series?match[]=<name>`; histograms by `<name>_bucket`), except metrics whose trigger did not occur, which the test triggers explicitly (signature failure, guard rejection, conflict, discrepancy, rate limit).
   - Grafana: `GET /api/search` lists the four dashboard UIDs; `GET /api/dashboards/uid/<uid>` returns 200.
   - Operator flow: unauthenticated `flowledger ops view audit` returns zero rows; authenticated alice republishes an envelope; `audit.operator_actions_view` shows the row with `actor`, `reason`, `token_id`, before/after, correlation ID, resulting event IDs; `UPDATE` on it fails for every role.
   - Re-run (do not reimplement) P11-T14, P11-T15, P11-T16 suites as part of the gate command list.
2. `docs/evidence/P11.md`: commit SHA, commands, metric-series coverage table, alert fault-injection results, cross-tenant and redaction suite results, and open risks.

**Expected behavior** — All gate checks pass from a clean clone with Docker.

**Acceptance criteria**
- [ ] Every `docs/10` M11 acceptance bullet maps to a passing test (traceability table).
- [ ] Every inventory metric has a Prometheus series.
- [ ] Threat-model test passes without the planned-evidence allowance.
- [ ] Evidence note committed.

**Testing requirements** — `pnpm check`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:chaos`, `pnpm verify:ledger`.

**Non-goals** — No feature code; no cloud deployment (P13).

**Handoff checklist**
- [ ] `Task: P11-GATE` in commit body.

---

## Parallelization

| Wave | Concurrent tasks | Shared files / conflicts |
| --- | --- | --- |
| 1 | `P11-T01`, `P11-T02`, `P11-T06`, `P11-T07`, `P11-T17` | T02 and T07 both modify `infra/docker/.env.example` and `docs/CONFIG.md` (append-only; rebase). T06 and T07 both modify `packages/database/src/tx.ts` and the P00 OTel bootstrap — **serialize T07 after T06** or split by function. |
| 2 | `P11-T03` (after T02); `P11-T08`, `P11-T09`, `P11-T10`, `P11-T11` (after T07) | T08/T10/T11 each touch different apps, except `apps/payment-worker/src/` (T08 lease/DLQ, T10 sweeper/snapshot) and `apps/settlement-worker/src/loop.ts` (T06 spans, T11 metrics) — serialize T08→T10 and T06→T11. T09 and T11 both modify `packages/database/src/functions/settlement.ts` — serialize T09→T11. Migrations 1150/1160/1170/1180 must merge in numeric order. |
| 3 | `P11-T04` (after T03) then `P11-T05`; `P11-T12`, `P11-T13` (after metrics) | T04/T05 share `apps/cli/src/commands/ops/view.ts` and `timeline.ts` — sequential by dependency. |
| 4 | `P11-T14`, `P11-T15`, `P11-T16`, `P11-T18` | T14 modifies `docs/runbooks/*.md` and `test/e2e/runbooks/*.test.ts`, which T03 also modified — T03 is earlier, no overlap at this wave. |
| 5 | `P11-GATE` | |

Migration numbers by task: T02 `1100`, T03 `1110`, T04 `1120`, T05 `1130`, T06 `1140`, T08 `1150`, T09 `1160`, T10 `1170`, T11 `1180`. Merge in numeric order (T06's `1140` before T08's `1150`).

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| docs/10 M11: threat model (7 threats) | P11-T01 | test/contract/threat-model.test.ts :: has seven threat sections; every evidence file exists |
| docs/10 M11: propagate request/correlation/causation/envelope/payment/operation IDs in logs and traces, not metric labels | P11-T06, P11-T07 | test/e2e/trace-propagation.test.ts :: logs share correlation id; metrics.test.ts :: no ID labels |
| docs/10 M11: every minimum recovery metric + dashboards for 10 areas | P11-T07–T12 | metrics.test.ts :: docs/08 parity; m11-gate.test.ts :: every inventory metric has a series; dashboards.test.ts :: ten areas covered |
| docs/10 M11: warning/critical alerts with contracted thresholds | P11-T13 | alert-rules.test.ts :: promtool boundary tests |
| docs/10 M11: read-only operator views (timeline surface, attempts, evidence, postings, buckets, outbox/inbox, webhooks, settlement, reconciliation) | P11-T04, P11-T05 | operator-views-payments.test.ts; operator-views-operations.test.ts :: <view> exact columns; operator timeline complete |
| docs/10 M11: separate authenticated operator surface; named principal + MFA claim; no merchant creds/tenant override | P11-T02, P11-T03 | operator-authentication.test.ts :: missing mfa rejected; merchant credential rejected; operator-auth.test.ts :: rejects merchant credential, rejects unknown flag |
| docs/10 M11: append-only audit with actor, reason, evidence refs, before/after, DB time, correlation, resulting events | P10-T11, P11-T03 | operator-audit-binding.test.ts :: audit row carries token_id; audit immutable; m11-gate.test.ts :: operator flow |
| docs/10 M11: dependency/container/IaC/secret scans | P11-T17 | security-workflow.test.ts :: four jobs present |
| docs/10 M11 deferred items listed in known limits | P11-T18 | known-limits.test.ts :: docs/10 deferred items present |
| docs/10 M11 acc: cross-tenant tests for API, RLS, functions, background roles, operator views, settlement views, webhook correlation | P11-T15 | cross-tenant-catalog.test.ts; cross-tenant-functions.test.ts; cross-tenant-api.test.ts |
| docs/10 M11 acc: secrets/prohibited data detected by negative tests and absent from telemetry | P11-T16 | telemetry-redaction.test.ts :: detectors fire on planted fixtures; no leak in … |
| docs/10 M11 acc: one end-to-end trace HTTP → outbox → worker → provider → ledger → settlement → merchant delivery | P11-T06 | trace-propagation.test.ts :: single trace from API to merchant delivery; settlement span links capture trace |
| docs/10 M11 acc: dashboards show the nine named signals | P11-T12 | dashboards.test.ts :: docs/10 M11 signals covered |
| docs/10 M11 acc: alerts fire under controlled fault injection and link to runbook | P11-T14 | alerts-fault-injection.test.ts :: outbox age alert fires and resolves (+3) |
| docs/10 M11 acc: operator actions authenticated, authorized, immutable, cannot mutate journal/payment/settlement tables | P11-T03 | operator-audit-binding.test.ts :: unauthenticated <function> rejected; operator roles cannot mutate financial tables |
| docs/10 M11 acc: known-limits maps each deferred item to contract section | P11-T18 | known-limits.test.ts :: links resolve to headings |
| docs/08 §Recovery observability: 25 minimum metrics, bounded labels | P11-T07–T11 | metrics.test.ts :: docs/08 parity; messaging/payment/ledger/settlement-metrics tests |
| docs/08 `duplicate_financial_effects_total` defined against provider ground truth | P11-T11 | settlement-metrics.test.ts :: duplicate effect metric from ground truth |
| docs/08 §Recovery objectives and alerts (9 rows) | P11-T13 | alert-rules.test.ts :: promtool boundary tests |
| docs/08 §Operator authority (named principal, MFA, least privilege, immutable audit) | P11-T02, P11-T03 | operator-authentication.test.ts; operator-audit-binding.test.ts |
| docs/08 runbooks "expected metrics" | P11-T14 | test/e2e/runbooks/*.test.ts signal assertions |
| docs/09 §Required metrics (API/DB, messaging/workers, ledger/recovery) | P11-T07–T11 | metrics-pipeline.test.ts; messaging-metrics.test.ts; ledger-metrics.test.ts; payment-metrics.test.ts; settlement-metrics.test.ts |
| docs/09 §Continuous invariant checker is source of correctness metrics | P11-T11 | settlement-metrics.test.ts :: verify watch exports classes |
| docs/09 §Static checks: secrets and prohibited data scanned in logs and messages | P11-T16, P11-T17 | telemetry-redaction.test.ts; security workflow `secrets` job |
| docs/07 §Tenant isolation items 1–9 | P11-T15 | cross-tenant-catalog.test.ts :: coverage guard |
| docs/05 line 49: merchant API accepts no tenant override | P11-T15 | cross-tenant-api.test.ts :: tenant headers ignored |
| docs/04 §Sensitive data / docs/06 §Redaction | P11-T16 | telemetry-redaction.test.ts |

## Phase risks / open questions

| ID | Risk / conflict | Impact | Severity | Recommended resolution | Blocked tasks |
| --- | --- | --- | --- | --- | --- |
| R-01 | Contracts require a named principal and MFA (`docs/08` line 639, `docs/10` line 491) but name no IdP; the project must run offline (`docs/10` line 783). | Without a local mechanism, MFA cannot be verified in tests. | Medium | **[ASSUMPTION]** Dev IdP stub issues HS256 tokens after RFC 6238 TOTP; PostgreSQL verifies with pgcrypto and binds the principal per backend. Shared-secret HMAC is a documented residual risk (threat model, known limits); P13 may swap in an external IdP with asymmetric verification in the CLI plus the same session binding. | P11-T02 |
| R-02 | `docs/09` §Required metrics (lines 402–424) lists metric descriptions, not names; CONVENTIONS §12 says names are "exactly as listed in docs/08 and docs/09". Several `docs/08` alert rows (requested claim age, overdue lease, first reconciliation, review age) have no metric in the `docs/08` minimum list. | Names could diverge across tasks and dashboards. | Medium | **[ASSUMPTION]** Use the inventory in this file as the single name list (registry in `packages/observability/src/metrics.ts`); add the names to `docs/09` in a contract commit. | P11-T07–T13 |
| R-03 | SQL-built envelopes (ledger event from the P03 routine) may not carry `traceparent`. | Trace has a gap at the ledger event. | Low | Link through payment terminal events (which are built in TS); optionally extend the routine to read `flowledger.traceparent` (same `CREATE OR REPLACE` pattern as P11-T09). | P11-T06 |
| R-04 | OpenTelemetry → Prometheus normally appends `_total` and unit suffixes, which would rename contracted metrics (e.g. `provider_webhook_signature_failures` → `…_total`). | Dashboards/alerts would not match contract names. | Medium | **[ASSUMPTION]** Collector `prometheus` exporter with `add_metric_suffixes: false`, units only as metadata; integration test asserts verbatim names. | P11-T07 |
| R-05 | `docs/09` lines 408 and 414 require host CPU/memory/IOPS/storage latency and subscription backlog, which local Docker/Pub/Sub emulator cannot provide. | Local dashboards incomplete. | Low | Local: postgres-exporter + consumer-side message age; P13 adds Cloud SQL and Pub/Sub Cloud Monitoring metrics. Listed in `docs/KNOWN_LIMITS.md`. | P11-T07, P11-T08 |
| R-06 | "Negative merchant clearing age" (`docs/08` line 613) has no defined start event. | Ambiguous metric. | Low | **[ASSUMPTION]** Age since the first negative-net `DEFERRED` run after the latest `POSTED` run while clearing < 0. | P11-T11 |
| R-07 | Dashboards-as-code target: `docs/10` M11 does not say local vs cloud. | Duplicate effort or missing cloud dashboards. | Low | **[ASSUMPTION]** Grafana JSON for local Compose in P11; Cloud Monitoring dashboard JSON generated in P13 from the same metric names. | P11-T12 |
| R-08 | `docs/08` rows 7 and 9 use business hours/days; Prometheus has no business calendar. | Alerts fire on weekends/nights earlier than contracted. | Low | **[ASSUMPTION]** Wall-clock approximation (4 h / 24 h / 48 h); documented in known limits. | P11-T13 |
| R-09 | `docs/10` line 501 vs line 462 and `docs/07` line 932 (see P10 risk R-07). | Correction workflow scope. | High | Two-principal flow built in P10-T14; P11-T03 makes both principals MFA-authenticated; known limits records approver-tier/expiry/notification deferral. Update `docs/10` line 501 wording. | P11-T18 |
| R-10 | Moving `audit.operator_actions` into P10 (P10 risk R-04) means P11-T03 changes its record function and adds `token_id`; existing P10-era rows have null `token_id`. | Mixed audit rows. | Low | Accept: rows predate authentication only in development databases; enforce non-null in the function for all new rows. | P11-T03 |
| R-11 | Several P11 tasks modify P10/P00 files (`apps/cli/src/commands/ops/*`, runbook tests, `tx.ts`, OTel bootstrap). | Merge conflicts with parallel work. | Medium | Follow the Parallelization serialization notes; never run T03 and T14 concurrently. | — |
| R-12 | Trivy is not in the CONVENTIONS §2 approved list. | Dependency-policy violation if unstated. | Low | **[ASSUMPTION]** CI-only binary like gitleaks; justification in the commit body; add to CONVENTIONS §2 in its own commit. | P11-T17 |
