# P09 — Provider and merchant webhooks

## Phase overview

**Goal.** Ingest signed provider webhooks safely (opaque endpoint key, raw-body signature verification through the adapter, replay window, 64 KiB bound, fast durable receipt, dedupe by `(webhook_endpoint_id, provider_event_id)`), correlate them only after verification and only to allowlisted provider accounts, turn them into evidence that resolves operations through the same path as direct responses and reconciliation, and notify merchants through immutable, signed, SSRF-safe webhook deliveries with exact retry classification and audited replay. Prove that direct response, verified webhook, and reconciliation races converge on one transition and one journal effect. (docs/10 M9; docs/06 §Provider webhook contract; docs/05 §Provider webhook ingestion boundary; openapi `ingestProviderWebhook`; docs/04 §Merchant webhook wire contract; docs/07 §provider_notifications, §provider_event_claims, §provider_identity_conflicts, §Merchant webhooks; docs/08 §Provider webhook ingestion and processing, §Merchant webhook delivery, §DLQ contract.)

**Entry criteria.** `P07-GATE` and `P08-GATE` green (docs/10: M9 depends on M7–M8).

**Exit gate (`P09-GATE`).** docs/10 M9 exit: "Signed duplicate/out-of-order delivery tests pass", plus docs/09 End-to-end-ready gate (README §3.3): authorization, capture, cancellation, refund, webhook, ambiguity, and reconciliation scenarios pass; `flowledger verify --require-ground-truth` zero findings; `docs/evidence/P09.md` committed.

### Interfaces consumed from earlier phases

| Interface | Source | Notes |
| --- | --- | --- |
| `providers.webhook_endpoints`, `providers.webhook_endpoint_secret_versions`, `providers.webhook_endpoint_accounts`, `providers.provider_accounts` | P02 | docs/07 §Provider configuration |
| `providers.provider_notifications`, `providers.provider_event_claims`, `providers.provider_identity_conflicts`, `providers.provider_evidence` | P06 | P09 adds protected functions over these tables. P06's `providers.stage_attempt_evidence` is attempt-bound (`API_RESPONSE` only) and P08's `providers.stage_reconciliation_evidence` is case-bound, so webhook-source staging `providers.stage_notification_evidence` is created by P09-T05. |
| `payments.apply_provider_evidence`, `payments.record_discrepancy` (created by P08-T17; called via `applyProviderEvidence` routing), `payments.record_authorization_expiry`, `reconciliation.request_manual_recheck`, `payments.current_recovery_fence()` | P07/P08 | EXECUTE granted to `fl_webhook_worker` by P08-T09/T11. |
| `messaging.dead_letter_records`, `messaging.dead_letter_replays`, `messaging.insert_outbox`, relay, transport, consumer framework `startConsumer(opts)` / `processDelivery(opts, msg)` / `HandlerResult` (`packages/messaging/src/consumer.ts`; `handle(tx, envelope)` runs in the inbox transaction, ack after commit), `Transport.publish(...)` → `Promise<string>` broker message ID, consumer names `provider-webhook-worker`, `merchant-webhook-projector`, `merchant-webhook-dispatcher` | P02/P05 | |
| `PaymentProvider.verifyWebhook` (verbatim docs/06); `FakeProviderAdapter`/`UnreliableProviderAdapter` constructed with `SimulatorClientOptions` (incl. `resolveWebhookSecrets(webhookEndpointId)`), throwing `WebhookVerificationError` (`reason` ∈ `MISSING_SIGNATURE`, `BAD_SIGNATURE`, `TIMESTAMP_OUT_OF_TOLERANCE`, `MALFORMED_BODY`) | P06 (T07/T09) | No adapter factory exists in `packages/providers`; the worker's registry is app-local (`apps/payment-worker/src/provider-registry.ts`) and not importable. P09-T03 adds a small provider-code → adapter-class map inside `packages/providers/src/webhook-verification.ts`. |
| `apps/provider-simulator` signed webhook emission (duplicates/delays/out-of-order) to `provider-webhook-receiver`; `/__test/*` controls; `packages/testkit/src/simulator.ts` (P08-T01) | P06/P08 | CONVENTIONS §16 |
| Secret resolution `resolveSecretReference(ref): Promise<Uint8Array>` in `packages/config/src/secrets.ts` (`local-secret://<path>` → UTF-8 bytes of env `FLOWLEDGER_SECRET_<PATH>`, no base64) | P06 | Binding (CONVENTIONS §11); P13 keeps `local-secret://` and injects Secret Manager values as env vars (P13-T07). |
| RFC 8785 canonicalizer `canonicalJson(value): string` (+ `sha256`) in `packages/domain/src/canonical-json.ts` | P01 | Binding (P01 "Interfaces provided"). |
| Pure `deriveSummaryStatus(...)` | P01 | docs/03 §Derived summary status |
| Testkit app spawner `startApp(name, env)` (`packages/testkit/src/apps.ts`, P08-T16); crash hooks `crashPoint(name)` (`packages/config/src/crash-points.ts`, P05-T08) armed via `armCrashPoint`/`disarmCrashPoints` (`packages/testkit/src/crash-points.ts`) or `FLOWLEDGER_CRASH_POINTS`; `flowledger verify` | P03/P05/P08 | |

### Interfaces provided to later phases

| Interface | Kind | Consumers |
| --- | --- | --- |
| `webhooks.endpoints`, `webhooks.deliveries`, `webhooks.delivery_attempts`, `webhooks.delivery_replays` | tables | P10 runbooks, P11 views |
| `providers.record_notification(...)`, `providers.correlate_notification(...)`, `providers.finish_notification(...)` | SQL | P10, P11 |
| `webhooks.create_delivery`, `webhooks.claim_due_deliveries`, `webhooks.start_delivery_attempt`, `webhooks.complete_delivery_attempt`, `webhooks.replay_delivery` | SQL | P10, P11 |
| `messaging.record_dead_letter_replay(p_dead_letter_id bigint, p_actor_id text, p_reason text, p_outcome text, p_broker_message_id text, p_error_class text, p_resolve boolean) RETURNS bigint` (P09-T13, migration `0950`; EXECUTE `fl_operator_command`) and its replay procedure in `apps/cli/src/commands/dlq.ts` | SQL + CLI | P10 (`messaging.operator_replay_dead_letter`) |
| `signMerchantWebhook`, `verifyMerchantWebhookSignature` (`packages/domain/src/merchant-webhook-signature.ts`) | TS | P12 load harness receiver |
| `safeDeliver()` SSRF-safe client (`apps/merchant-webhook-dispatcher/src/http-client.ts`) | TS | — |
| Apps `provider-webhook-receiver`, `provider-webhook-worker`, `merchant-webhook-projector`, `merchant-webhook-dispatcher` | apps | P11, P12, P13 |
| CLI `flowledger webhooks endpoint create|disable|rotate-secret`, `flowledger webhooks delivery replay`, `flowledger dlq list|replay`, `flowledger notifications reprocess` | CLI | P10 runbooks, P11 audit wiring |

### Internal domain error codes introduced (SQLSTATE `P0001`)

**[ASSUMPTION B4]** Same rule as P08 A8: `NOTIFICATION_CONTENT_CONFLICT`, `DELIVERY_LEASE_MISMATCH`, `DELIVERY_NOT_REPLAYABLE`, `PAYLOAD_TOO_LARGE`, `DLQ_REPLAY_REFUSED`; reuse an existing code where P02–P08 already defined an equivalent.

### Merchant webhook signature golden vectors (computed from docs/04 §Merchant webhook wire contract)

Input = UTF-8 bytes of `timestamp + "." + deliveryId + "."` followed by the exact body bytes; HMAC-SHA-256; header value `v1=` + lowercase hex. The HMAC key is the UTF-8 bytes of the resolved secret string (binding, CONVENTIONS §11). Verified independently with `openssl dgst -sha256 -hmac`.

| ID | secret | timestamp | deliveryId | body (UTF-8) | body SHA-256 (hex) | `FlowLedger-Webhook-Signature` |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | `whsec_test_0001` | `1793904271` | `whd_01ARZ3NDEKTSV4RRFFQ69G5FAS` | `{"a":1}` | `015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862` | `v1=3931c3272243d630459a2f992b456f7d49cd01c4fe37014023df1c8bd2866b48` |
| V2 (retry, new timestamp, same id/body) | `whsec_test_0001` | `1793904331` | `whd_01ARZ3NDEKTSV4RRFFQ69G5FAS` | `{"a":1}` | same as V1 | `v1=71ed06521863ebebfa370a03c9894d730fde0ab3e1b517878e85060ccedf3663` |
| V3 (rotated secret version) | `whsec_test_0002` | `1793904271` | `whd_01ARZ3NDEKTSV4RRFFQ69G5FAS` | `{"a":1}` | same as V1 | `v1=18a12312b6e793c4e2a4eccd6167dbf6f3109564a777400ec08fb5bc2375db7b` |
| V4 (non-ASCII body) | `whsec_test_0001` | `1793904271` | `whd_01ARZ3NDEKTSV4RRFFQ69G5FAT` | `{"note":"café ✓"}` (hex `7b226e6f7465223a22636166c3a920e29c93227d`) | `9e43e5636553d8b51e38c500a373d54574970efd052973228cd148091ca56ed6` | `v1=be3a6db61ef3ce13b4fbe6bb14d1a55bb61dc6a1f8332551a3e08595cfd0d490` |
| V5 (minimal) | `whsec_test_0001` | `0` | `whd_01ARZ3NDEKTSV4RRFFQ69G5FAS` | `{}` | `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a` | `v1=b6c966947f3d226a9b5e95468881e7860cbd97cf31935cd6e7657d6242a4f721` |

---

### P09-T01 — Merchant webhook tables

**Task ID:** `P09-T01`
**Feature:** Merchant webhook persistence
**Commit:** `feat(db): add merchant webhook endpoints, deliveries, and attempts`
**Priority:** Critical
**Dependencies:** `P08-GATE`
**Estimated complexity:** M
**Contract references:** docs/07 §`webhooks.endpoints`, §`webhooks.deliveries`, §`webhooks.delivery_attempts`, §Tenant isolation, §Mutability rules, §Retention (merchant webhook bytes ≥ 1 year); docs/04 §Merchant webhook wire contract; schemas `common/entity-ids.v1.schema.json` (`whe_`, `whd_`)
**Files:** create: `migrations/0900_merchant_webhooks.sql`, `test/integration/webhooks/schema.test.ts`; must not touch: earlier migrations

**Objective** — Create the three docs/07 tables plus the deferred delivery/attempt consistency trigger, fully locked down (no runtime DML; P09-T07 adds protected functions).

**Implementation instructions** — order: tables → constraints/indexes → triggers → RLS → grants.
1. `webhooks.endpoints`: columns exactly per docs/07: `id text COLLATE "C" PRIMARY KEY CHECK (id ~ '^whe_[0-7][0-9A-HJKMNP-TV-Z]{25}$')`, `merchant_id text COLLATE "C" NOT NULL REFERENCES identity.merchants(id)`, `name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100)`, `url text NOT NULL CHECK (length(url) <= 2048)`, `subscribed_event_types text[] NOT NULL CHECK (cardinality(subscribed_event_types) >= 1 AND subscribed_event_types <@ ARRAY['payment.authorization.succeeded.v1','payment.authorization.rejected.v1','payment.authorization.expired.v1','payment.capture.succeeded.v1','payment.capture.rejected.v1','payment.authorization.cancellation.succeeded.v1','payment.authorization.cancellation.rejected.v1','payment.refund.succeeded.v1','payment.refund.rejected.v1']::text[])`, `signing_secret_reference text NOT NULL`, `signing_secret_version integer NOT NULL CHECK (signing_secret_version >= 1)`, `status text NOT NULL CHECK (status IN ('ACTIVE','DISABLED'))`, `created_at`, `updated_at timestamptz NOT NULL DEFAULT clock_timestamp()`; `UNIQUE (merchant_id, id)`, `UNIQUE (merchant_id, name)`; index `(merchant_id, status) WHERE status='ACTIVE'`. The array check is the DB copy of the docs/04 public allowlist (docs/07: "application validation rejects unknown public event types" — enforced in both layers). URL safety is validated in the CLI (T12) because DNS-dependent checks cannot run in SQL.
2. `webhooks.deliveries`: columns per docs/07 with checks: `id` `whd_` regex; `(merchant_id, endpoint_id)` FK to `endpoints(merchant_id, id)`; `domain_event_id uuid NOT NULL`; `event_type` same allowlist check; `payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object')`; `body_bytes bytea NOT NULL CHECK (octet_length(body_bytes) BETWEEN 2 AND 65536)`; `payload_hash bytea NOT NULL CHECK (octet_length(payload_hash)=32 AND payload_hash = sha256(body_bytes))`; `destination_url text NOT NULL`; `signing_secret_reference text NOT NULL`; `signing_secret_version integer NOT NULL CHECK (>=1)`; `status text NOT NULL CHECK (status IN ('PENDING','DELIVERING','SUCCEEDED','RETRY','FAILED','DISABLED'))`; `attempt_count integer NOT NULL DEFAULT 0 CHECK (>=0)`; `next_attempt_at`, `lease_token uuid`, `lease_expires_at`, `created_at`, `delivered_at`; checks: `(status='SUCCEEDED') = (delivered_at IS NOT NULL)`; `(status='DELIVERING') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)`; `(lease_token IS NULL) = (lease_expires_at IS NULL)`; `(status IN ('PENDING','RETRY')) = (next_attempt_at IS NOT NULL)`. `UNIQUE (endpoint_id, domain_event_id)`; `UNIQUE (merchant_id, id)`; due index `(next_attempt_at, created_at, id) WHERE status IN ('PENDING','RETRY')`; lease index `(lease_expires_at) WHERE status='DELIVERING'`; `(merchant_id, created_at)`.
3. `webhooks.delivery_attempts` per docs/07: `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`, `delivery_id text COLLATE "C" NOT NULL REFERENCES webhooks.deliveries(id)`, `attempt_number integer NOT NULL CHECK (>=1)`, `request_started_at timestamptz NOT NULL`, `completed_at`, `http_status integer CHECK (http_status BETWEEN 100 AND 599)`, `response_hash bytea CHECK (octet_length=32)`, `error_class text CHECK (error_class IN ('TIMEOUT','CONNECTION','DNS','SSRF_BLOCKED','TLS','REDIRECT_REFUSED','RESPONSE_TOO_LARGE','INVALID_URL'))`, `retry_after timestamptz`; `UNIQUE (delivery_id, attempt_number)`; `CHECK (completed_at IS NULL OR ((http_status IS NOT NULL) <> (error_class IS NOT NULL)))`; `CHECK (completed_at IS NOT NULL OR (http_status IS NULL AND error_class IS NULL))`. **[ASSUMPTION B6]** the closed `error_class` list is P09's normalization (docs/07 says "redacted classification"); risk R6.
4. `webhooks.delivery_replays` **[ASSUMPTION B7]** (docs/04 "allow audited replay"; no generic audit table until P11; mirrors `messaging.dead_letter_replays`): `id bigint identity PK`, `delivery_id text COLLATE "C" NOT NULL REFERENCES webhooks.deliveries(id)`, `actor_id text NOT NULL`, `reason text NOT NULL`, `previous_status text NOT NULL`, `replayed_at timestamptz NOT NULL DEFAULT clock_timestamp()`; insert-only.
5. Triggers (owner `webhooks_function_owner`): deliveries BEFORE UPDATE rejects changes to `id, merchant_id, endpoint_id, domain_event_id, event_type, payload, body_bytes, payload_hash, destination_url, signing_secret_reference, signing_secret_version, created_at`, rejects leaving `SUCCEEDED`/`DISABLED`, allows `FAILED → RETRY` only (replay); attempts allow only the one completion transition (`completed_at` null → nonnull with outcome fields) and reject changes to `attempt_number`, `request_started_at`, `delivery_id`; DELETE/TRUNCATE rejected on all four tables; `delivery_replays` insert-only. Deferred constraint trigger on deliveries+attempts: at commit `attempt_count = coalesce(max(attempt_number),0)` and `status='SUCCEEDED'` implies an attempt with `http_status BETWEEN 200 AND 299`. Endpoints UPDATE may change only `url`, `subscribed_event_types`, `signing_secret_reference`, `signing_secret_version` (must increase), `status`, `updated_at`.
6. RLS enabled on `endpoints` and `deliveries` with `merchant_id = current_setting('app.merchant_id', true)`; attempts/replays are internal children.
7. Grants last: no runtime DML. SELECT: `fl_webhook_projector` (endpoints), `fl_webhook_dispatcher` (all), `fl_operator_readonly` (all), `fl_operator_command` (all), `fl_api` none (timeline read views are P04's; if the P04 timeline needs deliveries, grant SELECT to the timeline view owner only — check P04's view definition and extend it in this migration to include `MERCHANT_WEBHOOK_DELIVERY` entries only if P04 left a placeholder).

**Expected behavior** — inserting a delivery whose `payload_hash` ≠ `sha256(body_bytes)` fails `23514`; a 65 537-byte body fails; a second delivery for the same `(endpoint_id, domain_event_id)` fails `23505`.

**Acceptance criteria**
- [ ] Columns/checks/indexes per docs/07; immutable snapshot fields cannot change.
- [ ] Runtime roles have no DML.
- [ ] `SUCCEEDED` impossible without a committed 2xx attempt.

**Testing requirements** — `test/integration/webhooks/schema.test.ts` (fixture inserts as migration owner): valid insert; hash mismatch; 64 KiB boundary (65 536 ok, 65 537 fails); dedupe unique; unknown event type rejected on endpoint and delivery; snapshot update rejected; `SUCCEEDED` without attempt fails at commit; `attempt_count` mismatch fails at commit; attempt completion with both status and error fails; cross-tenant endpoint FK fails; every runtime role DML → `42501`. Command: `pnpm vitest run --project integration test/integration/webhooks/schema.test.ts`.

**Non-goals** — Functions (T07), apps.

**Handoff checklist**
- [ ] Grants last; P08 populated fixture migrates forward.

---

### P09-T02 — Provider notification receipt function

**Task ID:** `P09-T02`
**Feature:** Fast durable receipt with content-hash conflict detection
**Commit:** `feat(db): add protected provider notification receipt`
**Priority:** Critical
**Dependencies:** `P08-GATE`
**Estimated complexity:** M
**Contract references:** docs/07 §`providers.provider_notifications` (all constraints, conflict rule, RFC 8785 rule), §`providers.provider_identity_conflicts`, §Transaction and lock ownership (Ingest provider notification); docs/06 §HTTP ingestion steps 5–8; docs/08 §Provider webhook ingestion and processing rows 2–3
**Files:** create: `migrations/0910_provider_notification_receipt.sql`, `test/integration/webhooks/notification-receipt.test.ts`; modify: `packages/database/src/functions/providers.ts`, `packages/database/src/errors.ts`; must not touch: `migrations/06*`

**Objective** — One protected insert for the receiver: records a verified notification (no tenant), returns the existing row on exact duplicate, and on changed content records an identity conflict and moves the original to `CONFLICT`.

**Implementation instructions**
1. `providers.record_notification(p_webhook_endpoint_id text, p_provider_event_id text, p_provider_event_type text, p_webhook_secret_version integer, p_signature_version text, p_observed_provider_account_reference text, p_raw_payload_hash bytea, p_redacted_payload jsonb, p_redacted_payload_bytes bytea, p_provider_created_at timestamptz) RETURNS TABLE (notification_id text, outcome text)` — `outcome` ∈ `CREATED`, `DUPLICATE`, `CONFLICT`. `SECURITY DEFINER`, owner `providers` function owner used by P06 (if P06 used `payments_function_owner` for provider functions, use the same), `SET search_path = pg_catalog, providers`. EXECUTE: `fl_webhook_receiver` only.
2. Validation: endpoint exists and `status='ACTIVE'`; secret version row exists for the endpoint with status `ACTIVE`/`OVERLAP` and `accepted_from <= clock_timestamp() < coalesce(accepted_until, 'infinity')`; `p_redacted_payload_bytes` decodes (`convert_from(…,'UTF8')::jsonb`) to a value equal to `p_redacted_payload` (docs/07 parse-back rule); hashes 32 bytes.
3. `INSERT … VALUES (<new pno_ id from the P02 SQL ULID helper>, …, processing_status='RECEIVED', received_at=clock_timestamp(), redacted_payload_hash = sha256(p_redacted_payload_bytes)) ON CONFLICT (webhook_endpoint_id, provider_event_id) DO NOTHING RETURNING id`. If no row returned: `SELECT … FOR UPDATE` the existing row; equal `raw_payload_hash` → `DUPLICATE` (increment nothing); different → `INSERT INTO providers.provider_identity_conflicts (identity_kind, scope_id, stable_identity, existing_hash, conflicting_hash, received_at) VALUES ('NOTIFICATION', endpoint, event, existing, new, clock_timestamp()) ON CONFLICT DO NOTHING`, set the original `processing_status='CONFLICT'` (allowed processor-field transition), return `CONFLICT`. A row already in `CONFLICT` stays `CONFLICT`.
4. After a `CREATED` insert: `PERFORM pg_notify('provider_notification_received', <id>)` (delivered on commit; the worker LISTENs — **[ASSUMPTION B8]** native PostgreSQL notification is the "immediate processing nudge"; the sweeper remains the durable owner, docs/05).
5. No merchant/provider-account assignment, no payment lock.
6. TS wrapper `recordNotification`. Errors `NOTIFICATION_CONTENT_CONFLICT` not raised — conflict is a return value so the receiver can commit the conflict record and respond non-success.

**Expected behavior** — first call `CREATED`; identical repeat `DUPLICATE` with same id; changed body hash `CONFLICT`, one conflict row, original status `CONFLICT`.

**Acceptance criteria**
- [ ] 100 concurrent identical calls → one row, outcomes 1×`CREATED` + 99×`DUPLICATE`.
- [ ] Merchant and provider account remain null.
- [ ] Revoked endpoint or out-of-window secret version rejected.

**Testing requirements** — `test/integration/webhooks/notification-receipt.test.ts`: created; duplicate; 100-way concurrency; conflict path (row + status + second conflict with same hash deduped); redacted bytes mismatching jsonb → rejected; revoked endpoint; retired secret version; OVERLAP version inside window accepted; `LISTEN provider_notification_received` receives id after commit only (assert nothing before commit); `fl_webhook_worker` cannot execute (`42501`). Command: `pnpm vitest run --project integration test/integration/webhooks/notification-receipt.test.ts`.

**Non-goals** — Correlation (T05).

**Handoff checklist**
- [ ] Grants last.

---

### P09-T03 — Webhook verification binding and simulator emission controls

**Task ID:** `P09-T03`
**Feature:** Adapter-based raw-body verification with secret-version selection
**Commit:** `feat(providers): verify provider webhooks against endpoint secret versions`
**Priority:** Critical
**Dependencies:** `P08-GATE`
**Estimated complexity:** M
**Contract references:** docs/06 §Provider-neutral TypeScript interface (`ProviderWebhookRequest`, `VerifiedProviderWebhook`, `verifyWebhook`), §HTTP ingestion steps 1–4 and 6, §Capability model (`webhooks`), §Unreliable provider (duplicate/delayed/out-of-order webhooks); docs/07 §`providers.webhook_endpoint_secret_versions`; CONVENTIONS §16
**Files:** create: `packages/providers/src/webhook-verification.ts`, `packages/providers/src/webhook-verification.test.ts`; modify: `apps/provider-simulator/src/test-routes.ts` (or the file P06 registers `/__test/*` routes in), `packages/testkit/src/simulator.ts`; must not touch: `packages/providers/src/adapter.ts` (interface stays verbatim)

**Objective** — The receiver must verify the exact raw bytes with the adapter, try only the endpoint's bounded `ACTIVE`/`OVERLAP` secret versions, and learn which version verified (stored on the notification), without changing the docs/06 interface.

**Implementation instructions**
1. Adapter construction: P06 adapters already verify `rawBody`, enforce `capabilities.webhooks.replayToleranceSeconds`, and throw `WebhookVerificationError` (gap G1: docs/06 gives `verifyWebhook` no failure result type). In `webhook-verification.ts` define `WEBHOOK_ADAPTERS = { 'fake-provider': FakeProviderAdapter, 'unreliable-provider': UnreliableProviderAdapter }` and build one adapter per candidate with `resolveWebhookSecrets = async () => [{ version, secret }]` (single candidate) and `resolveCredential` that throws if called. Map reasons: `MISSING_SIGNATURE`/`BAD_SIGNATURE` → `SIGNATURE`, `TIMESTAMP_OUT_OF_TOLERANCE` → `REPLAY_WINDOW`, `MALFORMED_BODY` (incl. missing event id) → `MALFORMED`. No change to P06 adapter files.
2. `verifyWithSecretVersions(provider: ProviderName, request: ProviderWebhookRequest, candidates: readonly { version: number; verifierVersion: string; secret: Uint8Array }[]): Promise<{ ok: true; verified: VerifiedProviderWebhook; secretVersion: number; verifierVersion: string } | { ok: false; reason: 'SIGNATURE' | 'REPLAY_WINDOW' | 'MALFORMED' }>` — candidates ordered `ACTIVE` first then `OVERLAP` by descending version; for each, build an adapter with that secret and call `verifyWebhook`; first success wins; `REPLAY_WINDOW`/`MALFORMED` from a signature-valid attempt is returned immediately (signature proved, payload rejected); all `SIGNATURE` → `{ok:false, reason:'SIGNATURE'}`. No candidate list → `SIGNATURE`. Secrets never logged.
3. Simulator emission controls (reuse P06 equivalents if present; gated by `SIMULATOR_TEST_ENDPOINTS=1`): `POST /__test/webhooks/policy` `{ "mode": "IMMEDIATE" | "HOLD" }`; `POST /__test/webhooks/release` `{ "order": "AS_EMITTED" | "REVERSED", "duplicates": number }` (sends each held event `1 + duplicates` times with identical bytes and event id); `POST /__test/webhooks/emit` `{ "providerAccountReference": string|null, "notificationType": "OPERATION_RESULT"|"AUTHORIZATION_EXPIRED"|"INFORMATIONAL", "providerPaymentId": string|null, "providerOperationId": string|null, "providerAuthorizationId": string|null, "operationType": …|null, "amountMinor": string|null, "outcome": "SUCCEEDED"|"REJECTED"|null }` (crafts a signed event: uncorrelated or contradictory test evidence); `POST /__test/webhooks/redeliver` `{ "providerEventId": string, "times": number, "concurrency": number }`; `POST /__test/webhooks/tamper` `{ "providerEventId": string }` (next delivery flips one body byte after signing). Target URL: P06's `SIMULATOR_WEBHOOK_URL` is the receiver base URL; append `/v1/provider-webhooks/{provider}/{endpointKey}` from simulator account config (add the per-account endpoint key, P06 lacks it).
4. Testkit wrappers: `setWebhookPolicy`, `releaseWebhooks`, `emitWebhook`, `redeliverWebhook`, `tamperNextWebhook`.

**Expected behavior** — rotation: an event signed with version 1 during overlap verifies with `secretVersion: 1`; signed with version 2 → `secretVersion: 2`; tampered byte → `SIGNATURE`; old timestamp → `REPLAY_WINDOW`.

**Acceptance criteria**
- [ ] `adapter.ts` unchanged; both fake and unreliable adapters pass.
- [ ] Verification uses only raw bytes; no JSON parse before signature success.

**Testing requirements** — `packages/providers/src/webhook-verification.test.ts` (in-memory simulator core signs fixtures): valid; tampered byte; wrong secret; overlap rotation (both versions); expired timestamp (boundary: exactly tolerance accepted, tolerance+1 s rejected); missing event id → `MALFORMED`; no candidates → `SIGNATURE`; run for both adapters. Command: `pnpm vitest run --project unit packages/providers/src/webhook-verification.test.ts`.

**Non-goals** — HTTP route (T04).

**Handoff checklist**
- [ ] Prohibited-data negative test: secret absent from thrown error messages.

---

### P09-T04 — Provider webhook receiver app

**Task ID:** `P09-T04`
**Feature:** `POST /v1/provider-webhooks/{provider}/{endpointKey}`
**Commit:** `feat(webhooks): add provider webhook receiver`
**Priority:** Critical
**Dependencies:** `P09-T02`, `P09-T03`
**Estimated complexity:** M
**Contract references:** openapi `ingestProviderWebhook` (responses 202/400/401/404/413/415/500/503, `ProviderEndpointKey` pattern); docs/05 §Provider webhook ingestion boundary, §Canonical error format (`INVALID_PROVIDER_SIGNATURE`, `REQUEST_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `RESOURCE_NOT_FOUND`, `INVALID_REQUEST`), §Provider webhook boundary tests; docs/06 §HTTP ingestion; docs/08 §Recovery observability (`provider_webhook_signature_failures`, `duplicate_provider_notifications_total`); CONVENTIONS §10, §12
**Files:** create: `apps/provider-webhook-receiver/src/main.ts` (replace inert), `apps/provider-webhook-receiver/src/route.ts`, `apps/provider-webhook-receiver/src/redact.ts`, `apps/provider-webhook-receiver/src/redact.test.ts`, `packages/config/src/provider-webhook-receiver.ts`, `test/integration/webhooks/receiver.test.ts`; modify: `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `openapi/openapi.yaml`

**Objective** — Verify before parsing, insert durably, answer `202` only after commit; no tenant assignment, no payment state in any response.

**Implementation instructions**
1. Fastify (Nest standalone is optional; plain Fastify is enough for one route — CONVENTIONS allows `fastify`). `bodyLimit: 65536`; content-type parser for `application/json` returning the raw `Buffer` (no JSON parse); other types → `415 UNSUPPORTED_MEDIA_TYPE`. Oversize → `413 REQUEST_TOO_LARGE`.
2. Path validation: `provider` matches `^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$` and is a registered adapter, else `404 RESOURCE_NOT_FOUND`; `endpointKey` matches `^[0-7][0-9A-HJKMNP-TV-Z]{25}$`, else `404`. `Authorization`, `Idempotency-Key`, and `If-Match` headers are ignored (docs/05: the route does not accept them as inputs; they have no effect). Never read a merchant id from headers or body.
3. Resolve `(provider_code, endpoint_key)` → endpoint (`status='ACTIVE'`, else `404`) and its secret versions with status `ACTIVE`/`OVERLAP` inside window (read-only query as `fl_webhook_receiver`; grant SELECT on the three provider config tables in T02's migration if P02 did not). Resolve secrets via `resolveSecretReference`.
4. `verifyWithSecretVersions(provider, {webhookEndpointId, headers, rawBody, receivedAt: new Date().toISOString()}, candidates)`: `SIGNATURE`/`REPLAY_WINDOW` → `401 INVALID_PROVIDER_SIGNATURE` + increment `provider_webhook_signature_failures` (labels: provider, reason) and create no row; `MALFORMED` → `400 INVALID_REQUEST`.
5. Redaction (`redact.ts`): `toRedactedPayload(v: VerifiedProviderWebhook)` returns exactly `{notificationType, operationType, providerAccountReference, providerPaymentId, providerOperationId, providerAuthorizationId, providerCaptureId, amount, normalizedResult, evidence}` (all normalized/allowlisted by construction, docs/06 §Redaction); `bytes = Buffer.from(canonicalJson(payload), 'utf8')`; assert `JSON.parse(bytes)` deep-equals payload.
6. `recordNotification(...)` with `raw_payload_hash = sha256(rawBody)`, `provider_event_type = notificationType`, `provider_created_at = evidence.providerObservedAt`, `signature_version = verifierVersion`. Outcome `CREATED`/`DUPLICATE` → `202` (empty body, `X-Request-Id`, `X-Correlation-Id`); `DUPLICATE` increments `duplicate_provider_notifications_total`. `CONFLICT` → `400 INVALID_REQUEST` **[ASSUMPTION B9]** (openapi lists no 409 for this route; risk R4) and log `provider_notification_conflict` at error.
7. DB unavailable → `503 SERVICE_UNAVAILABLE` (never 202 before commit). Crash points: `receiver.before_insert`, `receiver.after_insert_before_response`.
8. Raw body is never logged or stored; logs include provider, endpoint id, event id, outcome only.

**Expected behavior** — valid signed event → `202`, one `RECEIVED` row with null merchant; repeat → `202` and still one row; tampered → `401`, zero rows.

**Acceptance criteria**
- [ ] Response codes exactly per openapi; problem bodies `application/problem+json` with docs/05 codes.
- [ ] Tampered, expired, oversized, unknown-endpoint, unsupported-provider requests create no row.
- [ ] `202` only after commit.

**Testing requirements** — Unit `redact.test.ts` (allowlist keys exactly; canonical bytes stable; prohibited-data fixture injected in an unknown field of a crafted object never appears). Integration `test/integration/webhooks/receiver.test.ts` (Fastify `inject` + Testcontainers + in-memory simulator core for signing): valid → 202 + row; duplicate ×100 concurrent → one row, all 202; tampered → 401, metric +1, no row; expired timestamp → 401; 65 537-byte body → 413; `text/plain` → 415; unknown endpoint key → 404; revoked endpoint → 404; unsupported provider → 404; malformed authenticated payload → 400; changed content same event id → 400 + conflict row; merchant headers ignored (row merchant null); DB down (stop container pool) → 503; OpenAPI response conformance check. Command: `pnpm vitest run --project integration test/integration/webhooks/receiver.test.ts`.

**Non-goals** — Processing (T06).

**Handoff checklist**
- [ ] Env vars (`DATABASE_URL` role `fl_webhook_receiver`, `PORT`) documented.

---

### P09-T05 — Notification correlation and quarantine functions

**Task ID:** `P09-T05`
**Feature:** Post-verification correlation to allowlisted accounts
**Commit:** `feat(db): add provider notification correlation and quarantine`
**Priority:** Critical
**Dependencies:** `P09-T02`
**Estimated complexity:** M
**Contract references:** docs/07 §`providers.provider_notifications` (match fields, due index), §`providers.provider_event_claims`, §`providers.provider_identity_conflicts`, §`providers.webhook_endpoint_accounts`, §Tenant isolation item 9; docs/06 §Asynchronous application; docs/05 §Provider webhook ingestion boundary (correlation bullet); docs/08 §Provider webhook ingestion row "Verified webhook cannot be correlated"
**Files:** create: `migrations/0920_notification_correlation.sql`, `test/integration/webhooks/correlation.test.ts`; modify: `packages/database/src/functions/providers.ts` (incl. `stageNotificationEvidence`); must not touch: `migrations/06*`

**Objective** — Attach tenant identity only when immutable provider references match exactly one existing operation whose account is actively allowlisted for the receiving endpoint; otherwise quarantine (`UNMATCHED`) without inventing state; deduplicate cross-endpoint aliases with `provider_event_claims`.

**Implementation instructions**
1. `providers.correlate_notification(p_notification_id text) RETURNS TABLE (outcome text, merchant_id text, provider_account_id text, operation_id text)` — `outcome` ∈ `MATCHED`, `UNMATCHED`, `DUPLICATE_EVENT`, `CONFLICT`, `ALREADY_DONE`. `SECURITY DEFINER`; EXECUTE `fl_webhook_worker`. Runs inside the worker's processing transaction.
2. Lock the notification `FOR UPDATE`; if status `PROCESSED`/`CONFLICT` → `ALREADY_DONE`; if `MATCHED` → return the stored match.
3. Candidate accounts = `webhook_endpoint_accounts` for this endpoint with `retired_at IS NULL`, narrowed to accounts whose `provider_accounts.external_account_reference = observed_provider_account_reference` when the observed reference is nonnull (docs/07: narrows, never chooses).
4. Candidate operation, from `redacted_payload` fields, restricted to candidate accounts:
   - `OPERATION_RESULT` with `providerOperationId` → operations with `provider_account_id IN candidates AND provider_operation_id = $ref` (`(provider_account_id, provider_operation_id)` index); if `operationType` present also `type = operationType`.
   - else with `providerPaymentId` + `operationType` → join payments `provider_payment_id = $ref`, `type = operationType`; accept only if exactly one operation matches (multiple refunds on one payment → `UNMATCHED`).
   - `AUTHORIZATION_EXPIRED` → payment with `provider_authorization_id = $ref` in candidate accounts → its `SUCCEEDED` `AUTHORIZE` operation.
   - `INFORMATIONAL` → no correlation; return `UNMATCHED` with status left for the worker to set `PROCESSED`.
   Exactly one match → continue; zero or several → set `processing_status='UNMATCHED'`, `processed_at = clock_timestamp()` (**[ASSUMPTION B10]** `processed_at` doubles as last-attempt time for `UNMATCHED`, used for recheck backoff; risk R7), return `UNMATCHED`. Never create a payment/operation.
5. On match: `INSERT INTO providers.provider_event_claims (provider_account_id, provider_event_id, notification_id, raw_payload_hash, claimed_at) VALUES (…) ON CONFLICT (provider_account_id, provider_event_id) DO NOTHING`; if not inserted, lock the claim: same `notification_id` → proceed (retry of this notification); same hash, different notification → set this notification `PROCESSED`, `processed_at`, return `DUPLICATE_EVENT` (no evidence); different hash → insert `provider_identity_conflicts ('EVIDENCE', provider_account_id, provider_event_id, …, merchant_id, operation_id)`, set `CONFLICT`, return `CONFLICT`.
6. Set `merchant_id`, `provider_account_id`, `matched_operation_id`, `processing_status='MATCHED'` (both tenant columns together, docs/07 check).
7. `providers.finish_notification(p_notification_id text, p_status text) RETURNS void` — `MATCHED → PROCESSED` or `RECEIVED/UNMATCHED → PROCESSED` (INFORMATIONAL), sets `processed_at`. EXECUTE `fl_webhook_worker`.
8. `providers.reset_unmatched_for_recheck(p_notification_id text, p_actor_id text, p_reason text) RETURNS void` — operator reprocess: requires `UNMATCHED`, sets `processed_at = NULL` so the sweeper picks it up immediately; logs nothing else (operator audit rows use `audit.operator_actions`, created P10-T11 and wired by P10/P11; the CLI prints the action). EXECUTE `fl_operator_command`.
9. `providers.stage_notification_evidence(p_notification_id text, p_evidence jsonb) RETURNS TABLE (evidence_id text, stage_result text)` (owner/grant pattern identical to P06's `providers.stage_attempt_evidence`; EXECUTE `fl_webhook_worker`): lock the notification, require `processing_status='MATCHED'` (else `EVIDENCE_NOT_APPLICABLE`); insert `providers.provider_evidence` with `source='PROVIDER_WEBHOOK'`, `source_reference = p_notification_id`, `provider_notification_id = p_notification_id`, merchant/account/operation from the notification's match (never from `p_evidence`), `received_at = clock_timestamp()`, `ON CONFLICT (provider_account_id, source, source_reference) DO NOTHING`; read/compare as `stage_attempt_evidence`: same hash → `DUPLICATE` + existing id; changed hash → `provider_identity_conflicts` row + `CONFLICT`; new → `STAGED`.

**Expected behavior** — capture success webhook with `providerOperationId` of an op on an allowlisted account → `MATCHED` with that op's merchant; same event id on an alias endpoint → `DUPLICATE_EVENT`; reference of an op on a non-allowlisted account → `UNMATCHED`.

**Acceptance criteria**
- [ ] Tenant columns set only on a unique allowlisted match.
- [ ] Payload-supplied account reference narrows only; it can never select a non-allowlisted account.
- [ ] Cross-endpoint duplicates produce no second match.

**Testing requirements** — `test/integration/webhooks/correlation.test.ts`: match by operation id; match by payment id + type; two refunds on one payment by payment id only → `UNMATCHED`; non-allowlisted account → `UNMATCHED`; retired mapping → `UNMATCHED`; observed reference narrowing excludes a second allowlisted account; tenant smuggling — payload claims an account of merchant B on merchant A's endpoint → `UNMATCHED`; expiry match by authorization id; alias endpoint same hash → `DUPLICATE_EVENT`; alias changed hash → `CONFLICT` + conflict row; INFORMATIONAL → `UNMATCHED` path; no rows inserted in payments/operations in any case (row counts); `stage_notification_evidence` on an `UNMATCHED` notification → `EVIDENCE_NOT_APPLICABLE`, restage same hash → `DUPLICATE` same id, changed hash → `CONFLICT` + conflict row. Command: `pnpm vitest run --project integration test/integration/webhooks/correlation.test.ts`.

**Non-goals** — Evidence application (T06).

**Handoff checklist**
- [ ] Grants last.

---

### P09-T06 — Provider notification worker

**Task ID:** `P09-T06`
**Feature:** Asynchronous application through the common resolution path
**Commit:** `feat(webhooks): process verified provider notifications into evidence`
**Priority:** Critical
**Dependencies:** `P09-T05`, `P09-T04`
**Estimated complexity:** L
**Contract references:** docs/06 §Asynchronous application, §Normalized write results (outcome checks before `SUCCEEDED`); docs/07 §Transaction and lock ownership (Apply provider notification), §`providers.provider_evidence` (source shape `PROVIDER_WEBHOOK`); docs/08 §Provider webhook ingestion and processing rows 4–9, §Sweep and claim defaults (webhook sweeper 10 s / 100 / 30 s), §Disaster recovery step 2; docs/03 §Racing resolution signals
**Files:** create: `apps/provider-webhook-worker/src/main.ts` (replace inert), `apps/provider-webhook-worker/src/process.ts`, `apps/provider-webhook-worker/src/evidence.ts`, `apps/provider-webhook-worker/src/evidence.test.ts`, `packages/config/src/provider-webhook-worker.ts`, `test/integration/webhooks/notification-worker.test.ts`; modify: `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/`

**Objective** — Each verified notification is processed in one transaction: correlate → stage evidence → apply via `apply_provider_evidence` (operation results) or `record_authorization_expiry` (expiry) → mark processed. Duplicates collapse to corroboration; contradictions to discrepancy; uncorrelated stays quarantined.

**Implementation instructions**
1. Triggers: `LISTEN provider_notification_received` on a dedicated client (process the notified id immediately) and a sweeper every `PROVIDER_WEBHOOK_SWEEP_INTERVAL_MS` (default `10000`), claim size `100`: `SELECT id FROM providers.provider_notifications WHERE processing_status = 'RECEIVED' ORDER BY received_at, id LIMIT 100 FOR UPDATE SKIP LOCKED`, then `UNMATCHED` with `processed_at IS NULL OR processed_at <= now() - interval '60 seconds'` limit 20 (so quarantined rows cannot starve new ones). Each row is processed in its own transaction with `SET LOCAL statement_timeout = '30s'` (the docs/08 30 s lease is the transaction bound; notifications have no lease columns and no network I/O happens during processing).
2. Fence: if `(payments.current_recovery_fence()).notification_application_enabled = false`, skip all processing (receipts keep accumulating; docs/08 DR step 2).
3. `process.ts` per notification (one transaction, role `fl_webhook_worker`):
   a. `correlate_notification`. `UNMATCHED`/`DUPLICATE_EVENT`/`CONFLICT`/`ALREADY_DONE` → commit and stop (INFORMATIONAL: `finish_notification(id,'PROCESSED')`).
   b. Build evidence (`evidence.ts`): `source='PROVIDER_WEBHOOK'`, `source_reference = notification id`, `provider_notification_id`, `provider_account_id` (matched), `operation_id`, `merchant_id`, provider references, `observed_outcome` = `normalizedResult.outcome` for `OPERATION_RESULT` (`SUCCEEDED`/`REJECTED`/`FAILED` with error/proof fields) or `AUTHORIZATION_EXPIRED`, amount/currency, `provider_observed_at`, `evidence_hash` = SHA-256 of canonical evidence JSON, `redacted_evidence_reference = 'notification:' || id`. A webhook can never produce `RETRYABLE_NO_EFFECT`/`UNKNOWN` evidence (if `normalizedResult` is null for `OPERATION_RESULT`, treat as INFORMATIONAL).
   c. `stageNotificationEvidence(notificationId, evidence)` (T05) → `(evidence_id, stage_result)` (`DUPLICATE` returns the same id; `CONFLICT` → rollback, log alert, mark nothing; the sweeper retries and the conflict is visible in `provider_identity_conflicts`).
   d. Route: `OPERATION_RESULT` → `applyProviderEvidence(evidenceId)` (handles first-wins transition from `PROCESSING`/`UNKNOWN`/`REQUIRES_REVIEW` with `resolutionSource=PROVIDER_WEBHOOK`, corroboration, discrepancy, mismatch of type/amount/currency/identity → discrepancy). An `apply` against a `REQUESTED` operation (webhook raced ahead of claim) leaves evidence unapplied: catch the P06/P07 rejection code, keep the notification `MATCHED` (not processed), commit; the staged-evidence sweeper (P08-T07) applies it once the operation reaches `PROCESSING`/`UNKNOWN`. `AUTHORIZATION_EXPIRED` → `recordAuthorizationExpiry(evidenceId)`; `DEFERRED` leaves the notification `MATCHED` and the evidence unapplied (P08 sweeper retries).
   e. `finish_notification(id,'PROCESSED')` when the evidence was applied (any `application_kind`) — same transaction.
   f. Crash points `webhook_worker.before_commit`, `webhook_worker.after_commit`.
4. Metric `provider_webhook_unprocessed_age` (gauge: now − oldest `RECEIVED` received_at) updated per sweep.
5. Graceful shutdown: UNLISTEN, finish current transaction.

**Expected behavior** — capture `UNKNOWN` + simulator success webhook → capture `SUCCEEDED` with `resolution_source='PROVIDER_WEBHOOK'`, P08 case `RESOLVED`, one journal row; the same event delivered 100× → one notification, one evidence row, one transition.

**Acceptance criteria**
- [ ] One business effect per provider event regardless of duplicates/aliases.
- [ ] Uncorrelated notifications never create payment/operation/evidence rows.
- [ ] Out-of-order webhooks cannot bypass state guards (expiry after capture → dismissed; rejection after success → discrepancy).

**Testing requirements** — Unit `evidence.test.ts` (outcome → evidence shape; null result → informational; hash stable). Integration `test/integration/webhooks/notification-worker.test.ts` (worker in-process, receiver + simulator): success resolves `UNKNOWN` capture (journal 1, case resolved); late agreeing webhook after direct response → `CORROBORATION`, payment version unchanged; contradicting webhook after `SUCCEEDED` → discrepancy, payment v+1, op version unchanged, `CONTRADICTORY_EVIDENCE` case; expiry webhook on authorized payment → `EXPIRED`; expiry webhook after capture success → dismissed, payment unchanged; webhook before claim (`REQUESTED`) → stays `MATCHED`, later applied once by sweeper; uncorrelated → `UNMATCHED`, no evidence, rechecked after 60 s and matched once provider reference becomes known (after reconciliation sets `provider_operation_id`) → `CORROBORATION`; fence off → nothing processed; crash after receipt before processing → sweeper processes (docs/08 "Receiver responds successfully; async processing has not begun"). Command: `pnpm vitest run --project integration test/integration/webhooks/notification-worker.test.ts`.

**Non-goals** — Merchant webhooks.

**Handoff checklist**
- [ ] Env vars documented; logs redacted (prohibited-data negative test).

---

### P09-T07 — Merchant webhook protected functions

**Task ID:** `P09-T07`
**Feature:** Delivery creation, claim, attempts, replay
**Commit:** `feat(db): add merchant webhook delivery functions`
**Priority:** Critical
**Dependencies:** `P09-T01`
**Estimated complexity:** M
**Contract references:** docs/07 §`webhooks.deliveries`, §`webhooks.delivery_attempts`, §`messaging.outbox_messages` (merchant-webhook command correlation), §Transaction and lock ownership (Deliver merchant webhook); docs/04 §Merchant webhook wire contract, §Initial command catalog; schemas `commands/merchant-webhook-deliver.v1.schema.json`, `schemas/README.md` correlation rules
**Files:** create: `migrations/0930_merchant_webhook_functions.sql`, `packages/database/src/functions/webhooks.ts`, `test/integration/webhooks/delivery-functions.test.ts`; modify: `packages/database/src/errors.ts`; must not touch: `schemas/**`

**Objective** — All delivery state changes go through protected functions owned by `webhooks_function_owner`: idempotent creation with the deliver command, `SKIP LOCKED` claims with leases and per-endpoint fairness, append-only attempts, exact terminal states, audited replay.

**Implementation instructions** — every function `SECURITY DEFINER`, `SET search_path = pg_catalog, webhooks, messaging`.
1. `webhooks.create_delivery(p_delivery_id text, p_endpoint_id text, p_domain_event_id uuid, p_event_type text, p_payload jsonb, p_body_bytes bytea, p_envelope jsonb) RETURNS TABLE (delivery_id text, created boolean)` — EXECUTE `fl_webhook_projector`. Lock the endpoint `FOR SHARE`; require `ACTIVE` and `p_event_type = ANY(subscribed_event_types)`; require `convert_from(p_body_bytes,'UTF8')::jsonb = p_payload` and `octet_length(p_body_bytes) <= 65536` (else `PAYLOAD_TOO_LARGE`). Snapshot `destination_url`, `signing_secret_reference`, `signing_secret_version` from the endpoint row. `INSERT … status='PENDING', next_attempt_at=clock_timestamp(), payload_hash=sha256(p_body_bytes) ON CONFLICT (endpoint_id, domain_event_id) DO NOTHING`; if inserted, verify `p_envelope` is `merchant.webhook.deliver.v1` with `aggregateId = p_delivery_id`, `data.deliveryId`, `data.endpointId`, `data.domainEventId` matching, `orderingKey = p_endpoint_id`, `aggregateType='webhook_delivery'`, `aggregateVersion = 1`, and `PERFORM messaging.insert_outbox(p_envelope)`; else return existing id with `created=false` and insert nothing.
2. `webhooks.claim_due_deliveries(p_batch_size integer, p_lease_ms integer, p_excluded_endpoint_ids text[], p_per_endpoint_limit integer) RETURNS TABLE (delivery_id text, lease_token uuid, attempt_number integer)` — EXECUTE `fl_webhook_dispatcher`. Candidates: `status IN ('PENDING','RETRY') AND next_attempt_at <= clock_timestamp()` or `status='DELIVERING' AND lease_expires_at <= clock_timestamp()` (stale lease), excluding `p_excluded_endpoint_ids`; rank `row_number() OVER (PARTITION BY endpoint_id ORDER BY next_attempt_at, created_at, id)` and keep `rank <= p_per_endpoint_limit` (fairness: one endpoint cannot fill the batch); lock with `FOR UPDATE SKIP LOCKED`; for endpoints now `DISABLED`, set the delivery `DISABLED` (terminal, `next_attempt_at` null) instead of claiming; others → `DELIVERING`, new `lease_token`, `lease_expires_at = now + p_lease_ms` (bounded 15 000–120 000 ms; dispatcher uses 30 000 ≥ 10 s deadline + margin). Returned `attempt_number = attempt_count + 1`. A stale `DELIVERING` row whose last attempt has `completed_at IS NULL` gets that attempt completed with `error_class='TIMEOUT'` first (outcome unknown → retry the same delivery; docs/08 §Merchant webhook delivery row 2).
3. `webhooks.start_delivery_attempt(p_delivery_id text, p_lease_token uuid, p_attempt_number integer) RETURNS void` — token must match and `DELIVERING` (else `DELIVERY_LEASE_MISMATCH`); inserts `delivery_attempts (delivery_id, attempt_number, request_started_at=clock_timestamp())`; sets `attempt_count = p_attempt_number`. Committed **before** the HTTP request.
4. `webhooks.complete_delivery_attempt(p_delivery_id text, p_lease_token uuid, p_attempt_number integer, p_http_status integer, p_error_class text, p_response_hash bytea, p_retry_after timestamptz, p_next_status text, p_next_attempt_at timestamptz) RETURNS void` — token must match; completes the attempt row; `p_next_status` ∈ `SUCCEEDED` (requires `p_http_status` 200–299; sets `delivered_at`), `RETRY` (requires nonnull `p_next_attempt_at` in `(now, now + 1 hour]`), `FAILED`; clears lease. Classification is decided by the dispatcher (T11) and re-checked here: `SUCCEEDED` ⇔ 2xx; `FAILED` with an `http_status` requires it not in (`408`,`425`,`429`,`500`–`599`) unless `p_attempt_number >= 8` (retry budget exhausted).
5. `webhooks.replay_delivery(p_delivery_id text, p_actor_id text, p_reason text) RETURNS void` — EXECUTE `fl_operator_command`; only `FAILED` (else `DELIVERY_NOT_REPLAYABLE`); → `RETRY`, `next_attempt_at = clock_timestamp()`; inserts `webhooks.delivery_replays (delivery_id, actor_id, reason, previous_status='FAILED')`. Same delivery id, body bytes, and event id (docs/08 §Merchant webhook delivery).
6. TS wrappers in `packages/database/src/functions/webhooks.ts`.

**Expected behavior** — two projections of the same event → one delivery, one outbox command; claims under load give each delivery to one dispatcher; replay keeps id and bytes.

**Acceptance criteria**
- [ ] `(endpoint_id, domain_event_id)` creation idempotency; deliver command written only with a newly created delivery.
- [ ] Attempts are append-only and the attempt row is committed before the HTTP call.
- [ ] Per-endpoint claim limit enforced; disabled endpoints → `DISABLED`.

**Testing requirements** — `test/integration/webhooks/delivery-functions.test.ts`: create idempotent (100 concurrent → one row, one outbox row); unsubscribed type rejected; disabled endpoint rejected at create; bytes/jsonb mismatch rejected; claim SKIP LOCKED across 5 concurrent claimers; per-endpoint limit (endpoint A with 50 due, B with 1 due, batch 10, limit 2 → B claimed); stale DELIVERING reclaimed and open attempt completed `TIMEOUT`; complete SUCCEEDED requires 2xx; FAILED with 503 at attempt 3 rejected; RETRY beyond 1 h rejected; replay only from FAILED, audit row written, bytes unchanged; deliver envelope validates (no `aggregateVersion` other than 1). Command: `pnpm vitest run --project integration test/integration/webhooks/delivery-functions.test.ts`.

**Non-goals** — HTTP, signing.

**Handoff checklist**
- [ ] Grants last.

---

### P09-T08 — Merchant webhook projector

**Task ID:** `P09-T08`
**Feature:** Allowlisted event projection into immutable delivery snapshots
**Commit:** `feat(webhooks): project domain events into merchant webhook deliveries`
**Priority:** High
**Dependencies:** `P09-T07`
**Estimated complexity:** M
**Contract references:** docs/04 §Merchant webhook wire contract (allowlist table, snapshot rules), §Sensitive data, §Required contract tests (projection bullets); schema `webhooks/merchant-event.v1.schema.json`; docs/07 §`webhooks.deliveries` (RFC 8785 rule); docs/03 §Derived summary status
**Files:** create: `apps/merchant-webhook-projector/src/main.ts` (replace inert), `apps/merchant-webhook-projector/src/project.ts`, `apps/merchant-webhook-projector/src/payload.ts`, `apps/merchant-webhook-projector/src/payload.test.ts`, `packages/config/src/merchant-webhook-projector.ts`, `test/integration/webhooks/projector.test.ts`, `packages/domain/src/canonical-json.ts` + test (only if B3 fails); modify: `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `schemas/**`

**Objective** — For each allowlisted payment event, create at most one delivery per subscribed active endpoint, with the exact canonical bytes that every retry will send.

**Implementation instructions**
1. Consumer name `merchant-webhook-projector` on the events subscription via P05 `startConsumer` (`handle(tx, envelope)`: inbox row + all deliveries in one transaction; ack after commit).
2. Allowlist (constant `PUBLIC_EVENT_TYPES` = the nine docs/04 types). Any other type (including `payment.created.v1`, `*.failed.v1`, `*.requested.v1`, reconciliation/review/discrepancy, ledger, settlement) → inbox row only, no delivery.
3. `payload.ts` `buildMerchantEvent(envelope, summaryStatus): MerchantEventV1`: `id = envelope.id`, `type`, `schemaVersion: 1`, `createdAt` = `envelope.occurredAt` normalized to millisecond `…Z` form, `merchantId`, `data = { paymentId, paymentVersion: envelope.aggregateVersion, operationId, operationType, outcome, amount, totals: data.totalsAfter, summaryStatus }`. Terminal events: `outcome`/`amount`/`operationType` from event data. `payment.authorization.expired.v1`: `operationType='AUTHORIZE'`, `outcome='EXPIRED'`, `amount = { amountMinor: totalsAfter.authorizedAmountMinor, currency: 'USD' }`. Validate with the Ajv validator for `merchant-event.v1`; failure → throw schema error (DLQ via runner), never create a delivery.
4. `summaryStatus` **[ASSUMPTION B11]** (docs/04 requires it; the event alone lacks unresolved-operation state): computed with P01 `deriveSummaryStatus` from `totalsAfter`, the authorization outcome implied by the event and payment row, and the payment's operations that were unresolved at the event's recorded time (`created_at <= envelope.recordedAt AND (resolved_at IS NULL OR resolved_at > envelope.recordedAt)`), using their current status when still unresolved and `PROCESSING` otherwise. Risk R5.
5. Bytes: `body = Buffer.from(canonicalJson(payload), 'utf8')`; assert `≤ 65536` and `JSON.parse(body)` deep-equals payload.
6. For each `webhooks.endpoints` row `merchant_id = envelope.merchantId AND status='ACTIVE' AND type = ANY(subscribed_event_types)`: `deliveryId = newId('whd')`, deliver envelope via `buildEnvelope({ kind:'COMMAND', type:'merchant.webhook.deliver.v1', aggregateType:'webhook_delivery', aggregateId: deliveryId, aggregateVersion: 1, orderingKey: endpointId, merchantId, correlationId: envelope.correlationId, causationId: envelope.id, data:{deliveryId, endpointId, domainEventId: envelope.id} })`, then `createDelivery(...)`. Redelivered events create nothing new (unique key + inbox).
7. Ordering key (decided D-06, 2026-11-08: endpoint ID; risk R2 resolved): `orderingKey = endpointId` in the envelope (deliver command schema, envelope required field, docs/07 `insert_outbox` rule) and the P05 relay publishes it unchanged as the broker ordering key — the docs/10 M9 "per-endpoint ordering key". No relay change. Different endpoints of one merchant have different keys, so one slow endpoint cannot delay another.

**Expected behavior** — `payment.capture.succeeded.v1` for a merchant with two subscribed endpoints → two deliveries, two deliver commands; `payment.created.v1` → none; redelivering the event 10× → still two.

**Acceptance criteria**
- [ ] Only the nine public types project; payload validates against `merchant-event.v1`.
- [ ] One delivery per endpoint/event; `body_bytes` canonical and immutable.
- [ ] Payload contains no provider ids, evidence, errors, or internal envelope fields.

**Testing requirements** — Unit `payload.test.ts`: each of nine types → valid payload with correct `operationType`/`outcome`; expired payload amount; `createdAt` format; schema rejects unknown type; prohibited-data fixture in an internal field never copied; canonical bytes golden (`{"createdAt":…}` key order per RFC 8785). Integration `test/integration/webhooks/projector.test.ts`: created event → no delivery; capture succeeded → per-endpoint deliveries; unsubscribed endpoint → none; disabled endpoint → none; duplicate envelope ×10 → no new delivery; relay publishes the deliver command with transport ordering key equal to the endpoint id (InMemoryTransport captures `orderingKey === endpointId`); endpoint secret rotation after projection leaves delivery snapshot unchanged. Command: `pnpm vitest run --project unit apps/merchant-webhook-projector/src/payload.test.ts` and `pnpm vitest run --project integration test/integration/webhooks/projector.test.ts`.

**Non-goals** — HTTP dispatch.

**Handoff checklist**
- [ ] Env vars documented.

---

### P09-T09 — Merchant webhook signature module and golden vectors

**Task ID:** `P09-T09`
**Feature:** Exact HMAC signing and constant-time verification
**Commit:** `feat(domain): add merchant webhook signature with golden vectors`
**Priority:** High
**Dependencies:** `P08-GATE`
**Estimated complexity:** S
**Contract references:** docs/04 §Merchant webhook wire contract (headers, signature input, multiple `v1=` values, five-minute tolerance); docs/10 M9 AC "Signature golden vectors"
**Files:** create: `packages/domain/src/merchant-webhook-signature.ts`, `test/contract/merchant-webhook-signature.test.ts`; must not touch: other domain files

**Objective** — One pure module computes `FlowLedger-Webhook-Signature` exactly and verifies it as a receiver would (used by tests and by the P12 harness receiver).

**Implementation instructions**
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
export function signMerchantWebhook(secret: Uint8Array, timestamp: number, deliveryId: string, body: Uint8Array): string; // 'v1=' + hex
export function verifyMerchantWebhookSignature(args: { header: string; secrets: readonly Uint8Array[]; timestamp: string; deliveryId: string; body: Uint8Array; nowSeconds: number; toleranceSeconds?: number /* default 300 */ }): boolean;
```
- Input bytes: `Buffer.concat([Buffer.from(`${timestamp}.${deliveryId}.`, 'utf8'), body])`. `timestamp` is decimal Unix seconds, no leading zeros except `0`.
- `verify`: reject if `|now − ts| > tolerance`; split header on `,`, trim, accept entries `v1=<64 lowercase hex>`; compare each against each secret with `timingSafeEqual` on equal-length buffers; true on any match.
- Secret key = UTF-8 bytes of the secret string (CONVENTIONS §11, binding).

**Expected behavior** — vectors V1–V5 (phase overview) reproduce exactly.

**Acceptance criteria**
- [ ] V1–V5 match byte for byte; V1 and V2 share body hash but differ in signature (stable body/id across retries, timestamp recomputed); V3 shows rotation changes the signature.
- [ ] Verification uses `timingSafeEqual` only.

**Testing requirements** — `test/contract/merchant-webhook-signature.test.ts`: V1–V5; header with two `v1=` values (old+new secret) verifies with either secret; tampered body byte fails; tolerance boundary 300 s passes, 301 s fails; uppercase hex rejected; non-`v1` scheme ignored; spy on `crypto.timingSafeEqual` proves it is used. Command: `pnpm vitest run --project contracts test/contract/merchant-webhook-signature.test.ts`.

**Non-goals** — HTTP.

**Handoff checklist**
- [ ] No dependency added.

---

### P09-T10 — SSRF-safe bounded outbound HTTP client

**Task ID:** `P09-T10`
**Feature:** Outbound delivery security
**Commit:** `feat(webhooks): add ssrf-safe bounded webhook http client`
**Priority:** Critical
**Dependencies:** `P08-GATE`
**Estimated complexity:** M
**Contract references:** docs/04 §Merchant webhook wire contract (HTTPS, no redirects, loopback/link-local/private/metadata rejection, 64 KiB, 10 s); docs/10 M9 "Enforce HTTPS outside local tests…"
**Files:** create: `apps/merchant-webhook-dispatcher/src/http-client.ts`, `apps/merchant-webhook-dispatcher/src/http-client.test.ts`; must not touch: `package.json` (no new dependency)

**Objective** — Send one POST with `body_bytes` verbatim to a vetted address, never following redirects, rejecting forbidden destinations **after DNS resolution**, bounded in bytes and time.

**Implementation instructions**
1. Signature: `safeDeliver(args: { url: string; headers: Record<string,string>; body: Uint8Array; allowPrivateDestinations: boolean }): Promise<{ kind: 'HTTP'; status: number; retryAfterHeader: string | null; responseSha256: Buffer } | { kind: 'ERROR'; errorClass: 'TIMEOUT' | 'CONNECTION' | 'DNS' | 'SSRF_BLOCKED' | 'TLS' | 'REDIRECT_REFUSED' | 'RESPONSE_TOO_LARGE' | 'INVALID_URL' }>`.
2. URL: `new URL()`; scheme must be `https:` unless `allowPrivateDestinations` (then `http:` also allowed); no userinfo; else `INVALID_URL`. Hostname `metadata.google.internal` (case-insensitive) or `metadata` → `SSRF_BLOCKED`.
3. Resolve with `dns.promises.lookup(host, { all: true, verbatim: true })` (or the literal IP). Reject (`SSRF_BLOCKED`) if **any** address is in a `net.BlockList` containing: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` (includes `169.254.169.254` metadata), `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255/32`, IPv6 `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `fd00:ec2::254/128`, and IPv4-mapped `::ffff:0:0/96` addresses checked against the IPv4 list after unmapping. Skipped entirely only when `allowPrivateDestinations`.
4. Connect to the vetted address only (DNS-rebinding defense): `https.request({ host: vettedAddress, servername: hostname, headers: { ...headers, Host: url.host }, method: 'POST', agent: false })` (for `http:` in tests, `http.request` same way). Never set a redirect follower; any `3xx` is returned as `HTTP` status (classification in T11 makes it terminal); `REDIRECT_REFUSED` is used only if a library-level redirect is attempted (not applicable with `node:https`; keep the class for the attempt table).
5. Deadlines: one `AbortSignal.timeout(10_000)` covering connect + response body; abort → `TIMEOUT`. Request body ≤ 65 536 bytes (assert). Response: read at most 65 536 bytes; exceeding → abort, `RESPONSE_TOO_LARGE`; hash the bytes read with SHA-256. Connection errors → `CONNECTION`; `ENOTFOUND`/`EAI_AGAIN` → `DNS`; TLS errors (`ERR_TLS_*`, `CERT_*`, `DEPTH_ZERO_SELF_SIGNED_CERT`) → `TLS`.
6. `allowPrivateDestinations` comes from `MERCHANT_WEBHOOK_ALLOW_PRIVATE_DESTINATIONS=1`, which config parsing permits only when `NODE_ENV=test` (startup fails otherwise) — "explicitly isolated local tests" (docs/04).

**Expected behavior** — `https://127.0.0.1/` → `SSRF_BLOCKED` without a connection attempt; a host resolving to `10.0.0.5` → `SSRF_BLOCKED`; a server replying `302` → `{kind:'HTTP', status:302}` with no second request.

**Acceptance criteria**
- [ ] Every listed range rejected after DNS resolution (test with a stub `lookup`).
- [ ] No redirects followed; 10 s total deadline; 64 KiB response cap.
- [ ] Production config cannot enable private destinations.

**Testing requirements** — `apps/merchant-webhook-dispatcher/src/http-client.test.ts` (local `node:http`/`node:https` servers with self-signed cert where needed; DNS stubbed by injecting a `lookup` function parameter defaulting to `dns.promises.lookup`): one case per blocked range incl. `169.254.169.254`, `::1`, `::ffff:127.0.0.1`, `fe80::1`, `fc00::1`; hostname resolving to mixed public+private → blocked; `http:` without flag → `INVALID_URL`; userinfo → `INVALID_URL`; 302 → status returned, server saw exactly one request; slow server → `TIMEOUT`: `safeDeliver` takes an optional `deadlineMs` parameter (default `10_000`, exported as `DELIVERY_DEADLINE_MS`); the test asserts `DELIVERY_DEADLINE_MS === 10_000` and runs the slow-server case with `deadlineMs: 500` against a server that never responds (abort observed within 1 s, covering both connect and body phases); response 70 000 bytes → `RESPONSE_TOO_LARGE`; DNS rebinding: stub resolves public then private on second call → connection uses first vetted address only (server records remote target); config test: flag with `NODE_ENV=production` → startup error. Command: `pnpm vitest run --project unit apps/merchant-webhook-dispatcher/src/http-client.test.ts`.

**Non-goals** — Retry policy (T11).

**Handoff checklist**
- [ ] No new dependency.

---

### P09-T11 — Merchant webhook dispatcher

**Task ID:** `P09-T11`
**Feature:** Signed delivery with exact retry/terminal classification and fairness
**Commit:** `feat(webhooks): dispatch signed merchant webhooks with bounded retries`
**Priority:** Critical
**Dependencies:** `P09-T07`, `P09-T09`, `P09-T10`
**Estimated complexity:** L
**Contract references:** docs/04 §Merchant webhook wire contract (headers, classification, Retry-After ≤ 1 h, at-least-once), §Retry and dead-letter policy (`1s, 5s, 30s, 2m, 10m, 30m, 1h`), §Initial command catalog (per-endpoint fairness in dispatcher; ordering key per risk R2); docs/08 §Merchant webhook delivery; docs/07 §Transaction and lock ownership (Deliver merchant webhook)
**Files:** create: `apps/merchant-webhook-dispatcher/src/main.ts` (replace inert), `apps/merchant-webhook-dispatcher/src/dispatch.ts`, `apps/merchant-webhook-dispatcher/src/classify.ts`, `apps/merchant-webhook-dispatcher/src/classify.test.ts`, `apps/merchant-webhook-dispatcher/src/endpoint-breaker.ts`, `packages/config/src/merchant-webhook-dispatcher.ts`, `test/integration/webhooks/dispatcher.test.ts`; modify: `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/`

**Objective** — Claim due deliveries (lease committed), send the stored bytes signed with the snapshotted secret version, record attempt outcome, and schedule retries or terminal state exactly per docs/04, without letting one endpoint starve others.

**Implementation instructions**
1. Config: `MERCHANT_WEBHOOK_POLL_INTERVAL_MS` = `1000`, `MERCHANT_WEBHOOK_CLAIM_SIZE` = `100`, `MERCHANT_WEBHOOK_LEASE_MS` = `30000`, `MERCHANT_WEBHOOK_PER_ENDPOINT_INFLIGHT` = `4`, `MERCHANT_WEBHOOK_ALLOW_PRIVATE_DESTINATIONS` (test only). Role `fl_webhook_dispatcher`.
2. Triggers: poll loop + consumer `merchant-webhook-dispatcher` for `merchant.webhook.deliver.v1` (P05 `startConsumer`; handler only triggers an immediate poll — the delivery row is the work record).
3. Per claim (`claimDueDeliveries(size, leaseMs, breaker.openEndpoints(), perEndpointInflight)`), for each delivery (semaphore per endpoint, global limit = claim size):
   a. Load delivery (snapshot fields). Resolve `signing_secret_reference` (snapshotted version — rotation does not affect existing deliveries).
   b. `startDeliveryAttempt(id, token, attemptNumber)` and commit.
   c. `timestamp = Math.floor(Date.now()/1000)`; headers: `Content-Type: application/json`, `FlowLedger-Webhook-Id: <delivery id>`, `FlowLedger-Webhook-Timestamp: <timestamp>`, `FlowLedger-Webhook-Signature: signMerchantWebhook(secret, timestamp, id, body_bytes)`, `User-Agent: FlowLedger-Webhooks/1`. `safeDeliver({ url: destination_url, headers, body: body_bytes, allowPrivateDestinations })` — no DB connection held.
   d. `classify.ts` `classifyDelivery(result, attemptNumber, now)`: `HTTP 200–299` → `SUCCEEDED`; `ERROR` (any class except `INVALID_URL` and `SSRF_BLOCKED`) or `HTTP 408, 425, 429, 500–599` → retryable; `INVALID_URL`/`SSRF_BLOCKED` → `FAILED` (configuration, not transient) **[ASSUMPTION B12]** (docs/04 lists network failures as retryable; a destination rejected by policy is not a network failure; risk R8); every other `300–499` → `FAILED`. Retryable with `attemptNumber >= 8` → `FAILED` (initial + 7 delays). Retryable next time: `BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000]`, base = `BACKOFF_MS[attemptNumber - 1]` plus jitter `[0, 10%]`; valid `Retry-After` (delta-seconds integer ≥ 0 or IMF-fixdate in the future) overrides the backoff, capped at 1 hour; invalid `Retry-After` ignored. `retry_after` column = parsed hint (uncapped value for audit is not stored; store the capped absolute time).
   e. `completeDeliveryAttempt(...)` with `response_hash` and the decision; commit.
   f. Breaker (`endpoint-breaker.ts`, in-memory per process): 5 consecutive retryable failures for an endpoint → open 60 s (its deliveries are excluded from claims; they stay `RETRY` with their `next_attempt_at`); success closes. Business outcome of the payment is never touched.
   g. Crash points: `dispatcher.after_claim`, `dispatcher.after_attempt_start`, `dispatcher.after_http_before_complete`.
4. Metrics (names from the P11 metric table only): `merchant_webhook_oldest_pending_age` (gauge, oldest due delivery age). No other metric name is introduced here.
5. Graceful shutdown: stop claiming; in-flight requests abort at the 10 s deadline; leases expire and are reclaimed.

**Expected behavior** — endpoint returns 500 twice then 200 → three attempts, same `FlowLedger-Webhook-Id` and identical body bytes on each, signatures differ only via timestamp, final `SUCCEEDED`; endpoint returns 410 → one attempt, `FAILED`; `429` with `Retry-After: 7200` → next attempt in 1 h.

**Acceptance criteria**
- [ ] Classification exactly per docs/04 (table-driven test over all codes 200–599 plus every error class).
- [ ] Body bytes identical across retries (hash of received bodies equals `payload_hash`).
- [ ] One slow/unresponsive endpoint does not delay another endpoint of the same merchant.

**Testing requirements** — Unit `classify.test.ts`: every status 200–599 mapped (assert sets {2xx}=success, {408,425,429,5xx}=retry, others=terminal); each error class; Retry-After seconds/date/invalid/past/over-1h cap; attempt 8 retryable → FAILED; backoff ladder values. Integration `test/integration/webhooks/dispatcher.test.ts` (local HTTP receiver servers, `MERCHANT_WEBHOOK_ALLOW_PRIVATE_DESTINATIONS=1`, `NODE_ENV=test`): 500,500,200 sequence (three attempts, identical body bytes, receiver verifies each signature with `verifyMerchantWebhookSignature`); 302 → FAILED, receiver saw one request, no redirect followed; 410 → FAILED; timeout (receiver hangs) → attempt `TIMEOUT`, RETRY; crash after HTTP before complete (simulate by killing in-process after send) → lease expiry → retry with same delivery id and bytes (receiver dedupes by id), attempt rows show the unknown attempt as `TIMEOUT`; slow endpoint A (hangs) + fast endpoint B same merchant → B delivered within 2 s while A in flight; breaker opens after 5 failures; secret rotated between attempts → still signed with snapshotted version (verify with old secret); disabled endpoint → `DISABLED`, no request. Command: `pnpm vitest run --project unit apps/merchant-webhook-dispatcher/src/classify.test.ts` and `pnpm vitest run --project integration test/integration/webhooks/dispatcher.test.ts`.

**Non-goals** — Replay CLI (T12).

**Handoff checklist**
- [ ] Env vars documented; secrets absent from logs (negative test).

---

### P09-T12 — Operator CLI: merchant endpoints, delivery replay, notification reprocess

**Task ID:** `P09-T12`
**Feature:** Endpoint seeds/configuration and audited delivery replay
**Commit:** `feat(cli): add merchant webhook endpoint and replay commands`
**Priority:** Medium
**Dependencies:** `P09-T07`, `P09-T05`, `P09-T10`
**Estimated complexity:** M
**Contract references:** docs/04 §Merchant webhook wire contract ("Endpoint configuration is seeded or changed through separately authenticated operator tooling"; audited replay); docs/07 §`webhooks.endpoints`; docs/08 §Manual review contract ("Reprocess a verified webhook"), §Merchant webhook delivery row 4
**Files:** create: `apps/cli/src/commands/webhooks.ts`, `apps/cli/src/commands/notifications.ts`, `migrations/0940_webhook_operator_functions.sql`, `test/integration/cli/webhook-commands.test.ts`; modify: `apps/cli/src/main.ts`, `apps/cli/src/seed.ts` (dev profile: one endpoint per seeded merchant pointing at `http://127.0.0.1:<port>`, test-only); must not touch: `migrations/09[0-3]*`

**Objective** — Provide the MVP operator surface for endpoint configuration and replay; no merchant API.

**Implementation instructions**
1. Migration `0940`: `webhooks.create_endpoint(p_id text, p_merchant_id text, p_name text, p_url text, p_event_types text[], p_secret_reference text) RETURNS void` (version 1, `ACTIVE`); `webhooks.update_endpoint(p_id, p_url text, p_event_types text[], p_status text)`; `webhooks.rotate_endpoint_secret(p_id text, p_secret_reference text) RETURNS integer` (version+1). All `SECURITY DEFINER`, EXECUTE `fl_operator_command`. Changes never touch existing deliveries.
2. Commands (all mutating ones require `--actor` and `--reason`, printed in output; `audit.operator_actions` rows are added by P10/P11 wrappers — table created in P10-T11):
   - `flowledger webhooks endpoint create --merchant <mer_> --name --url --events <csv> --secret-ref <ref>`: validate URL (`https:` unless `NODE_ENV=test` with the private-destination flag), resolve DNS once and reject blocked ranges using the same BlockList exported from `http-client.ts` (refactor the list into an exported `isForbiddenAddress(ip)`), validate event types against the public allowlist.
   - `flowledger webhooks endpoint disable <whe_>`; `flowledger webhooks endpoint rotate-secret <whe_> --secret-ref <ref>`.
   - `flowledger webhooks delivery replay <whd_>` → `webhooks.replay_delivery`.
   - `flowledger notifications reprocess <pno_>` → `providers.reset_unmatched_for_recheck`.
3. Exit codes as P08-T14 (0/1/2).

**Expected behavior** — `endpoint create` with `https://10.0.0.1/hook` → exit 2 `SSRF_BLOCKED`; replay of a FAILED delivery → status RETRY, audit row, delivery retried by dispatcher with identical bytes.

**Acceptance criteria**
- [ ] Unsafe URLs and non-public event types rejected before any row.
- [ ] Replay preserves delivery id/body and writes `webhooks.delivery_replays`.

**Testing requirements** — `test/integration/cli/webhook-commands.test.ts`: create valid; private/loopback/metadata URL rejected; `http:` rejected outside test flag; unknown event type rejected; rotate increments version and an existing delivery keeps old version; replay FAILED ok / SUCCEEDED rejected (`DELIVERY_NOT_REPLAYABLE`); reprocess UNMATCHED sets `processed_at` null; missing `--actor` → exit 2. Command: `pnpm vitest run --project integration test/integration/cli/webhook-commands.test.ts`.

**Non-goals** — Merchant-facing endpoint API (out of MVP).

**Handoff checklist**
- [ ] Seed endpoints only in `--profile dev`.

---

### P09-T13 — DLQ replay controls with operation-state checks

**Task ID:** `P09-T13`
**Feature:** Safe, audited DLQ replay
**Commit:** `feat(cli): add operation-aware dlq replay`
**Priority:** High
**Dependencies:** `P09-T12` (migration order `0940` → `0950`)
**Estimated complexity:** M
**Contract references:** docs/08 §DLQ contract, §Runbook: provider execution command in DLQ (state table), §Message acknowledgement and DLQ; docs/07 §`messaging.dead_letter_records`, §`messaging.dead_letter_replays`; docs/04 §Retry and dead-letter policy; docs/10 M9 "DLQ records and replay history without allowing replay to change financial truth directly"
**Files:** create: `migrations/0950_dead_letter_replay.sql`, `apps/cli/src/commands/dlq.ts`, `test/integration/cli/dlq-replay.test.ts`; modify: `apps/cli/src/main.ts`, `packages/database/src/functions/messaging.ts`; must not touch: `migrations/02*`, `migrations/05*`

**Objective** — Replay a dead-lettered message only when safe, always with the original envelope UUID, recording every attempt; execution commands are checked against the durable operation first.

**Implementation instructions**
1. Migration `0950`: `messaging.record_dead_letter_replay(p_dead_letter_id bigint, p_actor_id text, p_reason text, p_outcome text, p_broker_message_id text, p_error_class text, p_resolve boolean) RETURNS bigint` — inserts `dead_letter_replays` (`outcome` ∈ `PUBLISHED`, `SKIPPED_TERMINAL`, `FAILED`), and when `p_resolve` sets `dead_letter_records.resolved_at = clock_timestamp()` (only if null). `SECURITY DEFINER`, owner `messaging_function_owner`, EXECUTE `fl_operator_command`. P05 provides no replay function; this is the only one.
2. `flowledger dlq list [--consumer] [--unresolved]` (readonly role): id, consumer, type, failure_class, attempt_count, operation_id, first/last failed.
3. `flowledger dlq replay <id> --actor --reason`:
   - Load record; the embedded `envelope` is published unchanged (same `id`) via the transport to the original topic for that consumer's subscription (`packages/messaging/src/topology.ts`).
   - If `envelope.type === 'payment.operation.execute.v1'`, load the operation and apply docs/08 table: `REQUESTED` never dispatch-marked → publish, `PUBLISHED`, resolve; live `PROCESSING` → no publish, `FAILED` with `error_class='LIVE_LEASE'`, not resolved; stale `PROCESSING` (either dispatch state) → no publish, `FAILED`, `error_class='SWEEPER_OWNS_STALE_PROCESSING'`; `UNKNOWN`/`REQUIRES_REVIEW` → `reconciliation.request_manual_recheck(case, actor, 'DLQ_REPLAY')` (schedules read-only reconciliation, never execution), outcome `SKIPPED_TERMINAL` with `error_class='AMBIGUOUS_RECONCILIATION_SCHEDULED'` **[ASSUMPTION B13]** (docs/07 outcome enum has no ambiguous value; risk R9), resolve; `SUCCEEDED`/`REJECTED`/`FAILED` → `SKIPPED_TERMINAL`, resolve, no publish.
   - If `envelope.type === 'payment.operation.reconcile.v1'`: publish (it is a nudge; the case is the work record).
   - Failure classes: use the `failure_class` values P02 defined for `messaging.dead_letter_records` (do not redefine them). Schema-error and unsupported-version classes: refuse unless `--confirm-compatible` is passed (docs/08 "wait for compatible code"), outcome `FAILED`, `error_class='SCHEMA_NOT_COMPATIBLE'`; invariant failures require `--confirm-investigated`.
   - `p_broker_message_id` = the string returned by `Transport.publish` (null when nothing was published).
   - Publish failure → `FAILED` with redacted error class.
4. Replay never calls a protected payment/ledger function other than `request_manual_recheck`, never edits the envelope.

**Expected behavior** — replaying an execute command whose operation is `SUCCEEDED` publishes nothing, records `SKIPPED_TERMINAL`, resolves the DLQ row.

**Acceptance criteria**
- [ ] Execute-command replay follows the docs/08 table for all seven operation states.
- [ ] Every replay attempt is a `dead_letter_replays` row with actor and reason; envelope UUID unchanged.

**Testing requirements** — `test/integration/cli/dlq-replay.test.ts` (InMemoryTransport captures publishes): one case per operation state (`REQUESTED`, live `PROCESSING`, stale pre-dispatch, stale post-dispatch, `UNKNOWN`, `REQUIRES_REVIEW`, `SUCCEEDED`/`REJECTED`/`FAILED`) asserting publish count, replay outcome, case `next_check_at` update for ambiguous, and simulator write count unchanged afterwards (worker running); published envelope `id` equals original; schema-class refusal; non-execute message published; missing actor → exit 2. Command: `pnpm vitest run --project integration test/integration/cli/dlq-replay.test.ts`.

**Non-goals** — DLQ insertion (P05).

**Handoff checklist**
- [ ] Grants last in `0950`.

---

### P09-T14 — Webhook duplicate, ordering, and three-source race suite

**Task ID:** `P09-T14`
**Feature:** Convergence proofs with real signed webhooks
**Commit:** `test(webhooks): add three-source race and duplicate delivery suite`
**Priority:** Critical
**Dependencies:** `P09-T06`, `P09-T11`
**Estimated complexity:** L
**Contract references:** docs/08 §Required failure-injection tests (Webhooks; Ledger "race duplicate success signals from API response, webhook, and reconciliation"; Messaging "remove or delay broker messages … verified notifications"); docs/03 §Racing resolution signals; docs/06 §Webhooks and reconciliation tests; docs/05 §Provider webhook boundary tests; docs/09 §End-to-end scenarios 14, 15
**Files:** create: `test/chaos/webhook-ingestion-crash.test.ts`, `test/e2e/webhook-duplicates-ordering.test.ts`, `test/e2e/three-source-race.test.ts`; must not touch: application source

**Objective** — Drive the simulator's real webhook emission against running apps and prove one effect per provider event and per operation under duplicates, reordering, crashes, and three-way races.

**Implementation instructions** — apps: API, relay, payment-worker, reconciler, provider-webhook-receiver, provider-webhook-worker, merchant projector/dispatcher, simulator (with `SIMULATOR_WEBHOOK_URL` → receiver). After each scenario: `flowledger verify --require-ground-truth` zero findings; `groundTruthEffects(key) <= 1`; journal ≤ 1 per operation.
1. `webhook-ingestion-crash.test.ts` (chaos): crash receiver at `receiver.before_insert` → simulator retries → one notification; crash at `receiver.after_insert_before_response` → redelivery returns 202 to the same unique row; crash worker at `webhook_worker.before_commit`/`webhook_worker.after_commit` (armed via `FLOWLEDGER_CRASH_POINTS`) → one application; tampered (`tamperNextWebhook`) → 401, zero notifications, valid redelivery accepted; drop the LISTEN nudge (worker started after the receipt) → sweeper processes within 10 s + slack.
2. `webhook-duplicates-ordering.test.ts` (e2e): one provider event delivered 100× (`redeliverWebhook(id, 100, 20)`) → one notification, one evidence, one transition; HOLD then release `REVERSED` for authorization success + capture success + refund success/rejection webhooks → final state equals ground truth, no state-guard bypass; success, rejection, and expiry notifications out of order for one payment (expiry emitted after capture success → dismissed, payment `CAPTURED`); valid uncorrelated event (`emitWebhook` with unknown provider ids) → `UNMATCHED`, no payment/operation/evidence; contradictory event after terminal success (`emitWebhook` outcome `REJECTED`) → discrepancy event, operation unchanged, journal unchanged; merchant deliveries: one delivery per endpoint/event despite duplicate events, intentional HTTP retries visible as multiple attempts.
3. `three-source-race.test.ts` (e2e): for each of CAPTURE and REFUND (20 iterations each): script `TIMEOUT_AFTER_COMMIT` (direct response lost), HOLD webhooks, then simultaneously (a) release the late direct response evidence (simulate by letting the worker's stale path apply staged success evidence), (b) release the success webhook, (c) make the case due (`request_manual_recheck`) so a lookup races — assert exactly one terminal transition (`payment_operations.version` path), one journal transaction with the original posting key, one terminal event; the other two evidence rows `CORROBORATION`; `resolution_source` is whichever won; P=1, L=1. Repeat with an authorization-expiry webhook racing a capture acceptance through the API: exactly one ordering (docs/10 M9 "expiry webhooks obey the same guarded expiry path").

**Expected behavior** — all converge; zero duplicate financial effects.

**Acceptance criteria**
- [ ] Every docs/08 Webhooks bullet and the Ledger three-source race bullet pass.
- [ ] Deliberate break check: temporarily make the receiver skip the `(webhook_endpoint_id, provider_event_id)` dedupe (insert with a random event id suffix) and observe the 100× test fail its "one notification, one evidence row" assertion; restore and record the observation in the commit body.

**Testing requirements** — Commands: `pnpm test:chaos`, `pnpm vitest run --project e2e test/e2e/webhook-duplicates-ordering.test.ts test/e2e/three-source-race.test.ts`.

**Non-goals** — Load-level webhook throughput (P12).

**Handoff checklist**
- [ ] Deliberate-break observation noted.

---

### P09-GATE — Milestone M9 / End-to-end-ready verification

**Task ID:** `P09-GATE`
**Feature:** M9 exit gate
**Commit:** `test(webhooks): verify M9 webhook gate and end-to-end readiness`
**Priority:** Critical
**Dependencies:** `P09-T01`…`P09-T14`
**Estimated complexity:** M
**Contract references:** docs/10 M9 §Test and acceptance criteria; docs/09 §Quality gates (End-to-end-ready), §End-to-end scenarios 1–15 (19 partial); docs/05 §Provider webhook boundary tests; docs/04 §Required contract tests (merchant webhook bullets)
**Files:** create: `test/e2e/m9-end-to-end-ready.test.ts`, `docs/evidence/P09.md`, `test/fixtures/db/p09-populated.sql`; must not touch: feature code

**Objective** — Prove M9 and the End-to-end-ready gate with all apps running.

**Implementation instructions**
1. `test/e2e/m9-end-to-end-ready.test.ts`: docs/09 scenarios 1–15 through the API with the unreliable adapter and real webhooks enabled (scenarios 11–13 already exist from P08; re-run here with webhooks on to prove no interference); for each scenario with a public outcome, the test merchant endpoint receives exactly one delivery per event (deduped by `FlowLedger-Webhook-Id`) with a valid signature; `payment.created.v1` produces no delivery.
2. Run and record in `docs/evidence/P09.md`: `pnpm check`, `pnpm test:contracts`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:chaos`, `pnpm verify:ledger -- --require-ground-truth`; SHA; per-class counts.
3. Produce `test/fixtures/db/p09-populated.sql` (deliveries in every status, notifications MATCHED/UNMATCHED/CONFLICT).

**Acceptance criteria**
- [ ] Every traceability row below has a passing test.
- [ ] `verify` zero findings including duplicate-effect class with ground truth.

**Testing requirements** — `pnpm test:e2e test/e2e/m9-end-to-end-ready.test.ts` plus the lanes above.

**Non-goals** — Settlement (P10).

**Handoff checklist**
- [ ] Evidence note and fixture committed.

---

## Parallelization

| Can run concurrently | Notes |
| --- | --- |
| `P09-T03` ‖ `P09-T09` ‖ `P09-T10` | Disjoint files, no migrations. |
| Provider track (T02 → T04/T05 → T06) ‖ merchant track (T01 → T07 → T08, T11) | Disjoint apps; their migrations still serialize in number order. |
| `P09-T13` after `P09-T12` | Migration order; both also edit `apps/cli/src/main.ts`. |

Strictly sequential: migrations `0900 (T01) → 0910 (T02) → 0920 (T05) → 0930 (T07) → 0940 (T12) → 0950 (T13)` — one agent at a time on `migrations/` and SECURITY DEFINER bodies (README §5.4). Shared files: `packages/database/src/functions/providers.ts` (T02, T05), `packages/database/src/functions/webhooks.ts` (T07), `packages/database/src/errors.ts` (T02, T07), `packages/testkit/src/simulator.ts` (T03), `apps/merchant-webhook-dispatcher/src/http-client.ts` (T10, T12 refactor export), P09 does not edit the relay. P09 does not edit `apply_provider_evidence` (P08 already extended it; P09 only calls it).

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| docs/10 M9: opaque endpoint keys, body bound, raw-body verify, timestamp/replay, allowlists, fast durable receipt | T02, T03, T04, T05 | `receiver.test.ts` :: valid/tampered/expired/413/unknown endpoint; `webhook-verification.test.ts`; `correlation.test.ts` :: non-allowlisted |
| docs/10 M9: dedupe by `(webhook_endpoint_id, provider_event_id)` | T02 | `notification-receipt.test.ts` :: 100-way; `receiver.test.ts` :: duplicate ×100 |
| docs/10 M9: correlate after verification via immutable refs; quarantine uncorrelated | T05, T06 | `correlation.test.ts`; `notification-worker.test.ts` :: uncorrelated |
| docs/10 M9: async processing into evidence and common resolution path | T06 | `notification-worker.test.ts` :: success resolves UNKNOWN |
| docs/10 M9: endpoint seeds/config, allowlist projection, signing, immutable snapshots, retries, leases, attempts | T01, T07, T08, T11, T12 | `projector.test.ts`; `delivery-functions.test.ts`; `dispatcher.test.ts`; `webhook-commands.test.ts` |
| docs/10 M9: HTTPS, no redirects, SSRF rejection, 64 KiB, 10 s | T10, T11 | `http-client.test.ts` (all cases); `dispatcher.test.ts` :: 302 |
| docs/10 M9: exact classification; Retry-After ≤ 1 h | T11 | `classify.test.ts` :: full status table, Retry-After cases |
| docs/10 M9: terminal states, replay controls, per-endpoint ordering key, endpoint circuit/fairness | T07, T11, T12 | `delivery-functions.test.ts` :: per-endpoint limit; `dispatcher.test.ts` :: slow endpoint, breaker; `webhook-commands.test.ts` :: replay. Ordering key = endpoint id (risk R2, D-06) — `projector.test.ts` :: transport ordering key equals endpoint id |
| docs/10 M9: DLQ records and replay history without changing financial truth | T13 | `dlq-replay.test.ts` |
| docs/10 M9 AC: tampered/expired/oversized/unknown-endpoint fail before durable effects | T04 | `receiver.test.ts` |
| docs/10 M9 AC: crash before insert permits retry; after insert same receipt | T04, T14 | `webhook-ingestion-crash.test.ts` |
| docs/10 M9 AC: one provider event ×100 applies once | T14 | `webhook-duplicates-ordering.test.ts` :: 100× |
| docs/10 M9 AC: uncorrelated quarantined, no invented merchant/payment | T05, T14 | `correlation.test.ts`; `webhook-duplicates-ordering.test.ts` :: uncorrelated |
| docs/10 M9 AC: out-of-order success/rejection/expiry follow state machine | T06, T14 | `webhook-duplicates-ordering.test.ts` :: reversed release, expiry after capture |
| docs/10 M9 AC: stable payload/signature inputs, bounded retries, one delivery per endpoint/event | T07, T08, T11 | `delivery-functions.test.ts` :: idempotent create; `dispatcher.test.ts` :: identical bytes |
| docs/10 M9 AC: signature golden vectors incl. constant-time, stable body/id, secret-version snapshot | T09, T11 | `merchant-webhook-signature.test.ts` :: V1–V5; `dispatcher.test.ts` :: rotation |
| docs/10 M9 AC: outbound URL/DNS tests | T10 | `http-client.test.ts` |
| docs/10 M9 AC: direct/webhook/reconciliation race converge; expiry webhooks guarded | T14 | `three-source-race.test.ts` |
| docs/10 M9 AC: duplicate projection/dispatch no duplicate delivery identity; retries visible as attempts | T07, T14 | `delivery-functions.test.ts`; `webhook-duplicates-ordering.test.ts` :: merchant deliveries |
| docs/10 M9 AC: DLQ replay against every operation state safe and audited | T13 | `dlq-replay.test.ts` :: per-state cases |
| docs/06 HTTP ingestion steps 1–8 (secret version recorded, hash compare on conflict, success only after insert) | T02, T03, T04 | `notification-receipt.test.ts` :: conflict; `receiver.test.ts` |
| docs/06 Async application bullets (verify type/amount/currency/identity; corroboration; discrepancy; never invent) | T06 | `notification-worker.test.ts` :: corroboration, contradiction |
| docs/06 contradiction increments payment version once; duplicate does not | T06 | `notification-worker.test.ts` :: contradiction ×2 |
| docs/05 boundary: 202 only after commit; 401/400/404/413/415; no merchant auth/tenant input; no payment state in response | T04 | `receiver.test.ts` |
| docs/05 boundary tests: secrets/credentials absent from errors and stored evidence | T03, T04, T06 | `redact.test.ts`; `webhook-verification.test.ts` :: secret absent |
| docs/07 provider_notifications constraints (tenant null until match; RFC 8785 bytes + parse-back; conflict → identity conflict + CONFLICT) | T02, T05 | `notification-receipt.test.ts`; `correlation.test.ts` |
| docs/07 provider_event_claims cross-endpoint dedupe | T05 | `correlation.test.ts` :: alias endpoint |
| docs/07 webhooks.* constraints and deferred attempt consistency trigger | T01 | `webhooks/schema.test.ts` |
| docs/07 Schema acceptance: every merchant retry transmits identical `body_bytes`; hash + HMAC golden vectors reproduce | T01, T09, T11 | `schema.test.ts` :: hash check; `merchant-webhook-signature.test.ts`; `dispatcher.test.ts` |
| docs/07 Schema acceptance: duplicate merchant webhook projection → one effect | T07, T08 | `projector.test.ts` :: duplicate ×10 |
| docs/04 contract tests: public payload schema + correlation table; `payment.created.v1` no delivery; outside-allowlist fails before delivery row | T08 | `payload.test.ts`; `projector.test.ts` |
| docs/04 contract tests: deliver command ordering key (conflict R2: plan uses endpoint id); slow endpoint does not delay another endpoint of same merchant | T08, T11 | `projector.test.ts`; `dispatcher.test.ts` :: slow endpoint |
| docs/04 retry classification, timestamp tolerance, no-redirect/SSRF, stable delivery IDs/bodies, endpoint/event dedupe | T07, T09, T10, T11 | as above |
| docs/08 FI Webhooks: tampered rejected / valid accepted | T04, T14 | `receiver.test.ts`; `webhook-ingestion-crash.test.ts` :: tamper |
| docs/08 FI Webhooks: crash before insert / after insert before response | T14 | `webhook-ingestion-crash.test.ts` |
| docs/08 FI Webhooks: one event ×100 → one application | T14 | `webhook-duplicates-ordering.test.ts` |
| docs/08 FI Webhooks: success/rejection/expiry out of order | T14 | `webhook-duplicates-ordering.test.ts` |
| docs/08 FI Webhooks: valid uncorrelated → no invented payment | T14 | `webhook-duplicates-ordering.test.ts` |
| docs/08 FI Webhooks: contradicting terminal → discrepancy not overwrite | T06, T14 | `notification-worker.test.ts`; `webhook-duplicates-ordering.test.ts` |
| docs/08 FI Ledger: race duplicate success signals from API, webhook, reconciliation | T14 | `three-source-race.test.ts` |
| docs/08 FI Messaging: replay DLQ execution commands against all statuses | T13 | `dlq-replay.test.ts` |
| docs/08 FI Messaging: remove/delay broker messages → sweepers rediscover verified notifications | T06, T14 | `webhook-ingestion-crash.test.ts` :: dropped nudge |
| docs/08 Merchant webhook delivery rows 1–4 | T11, T12 | `dispatcher.test.ts` :: timeout, crash after HTTP; `webhook-commands.test.ts` :: replay |
| docs/08 DLQ contract rules (original UUID, terminal → no provider call, ambiguous → reconciliation, audited) | T13 | `dlq-replay.test.ts` |
| docs/08 DR step 2: receipt continues, application deferred while fenced | T06 | `notification-worker.test.ts` :: fence off |
| docs/08 metrics `provider_webhook_signature_failures`, `provider_webhook_unprocessed_age`, `duplicate_provider_notifications_total` | T04, T06 | `receiver.test.ts` :: metric; `notification-worker.test.ts` |
| docs/09 E2E 14, 15 and End-to-end-ready gate | T14, GATE | `three-source-race.test.ts`; `m9-end-to-end-ready.test.ts` |

## Phase risks / open questions

| ID | Risk / question | Impact | Severity | Recommended resolution | Blocked tasks |
| --- | --- | --- | --- | --- | --- |
| R1 | docs/06 `verifyWebhook(request): Promise<VerifiedProviderWebhook>` (docs/06:160) has no failure result and no secret input, yet docs/06:507 requires storing the exact secret version that verified the request. | Receiver cannot learn the version without an extension | Medium | Keep the interface verbatim; build one P06 adapter per candidate version (single-entry `resolveWebhookSecrets`), map P06's `WebhookVerificationError` reasons, iterate candidate versions (gap G1). Record in docs/06. | T03, T04 |
| R2 | Prose (docs/04:79/102/106, `schemas/README.md`:86, docs/01:237) says `merchant.webhook.deliver.v1` has **no** ordering key; the machine contracts (`schemas/commands/merchant-webhook-deliver.v1.schema.json`:14, envelope schema required field :18, docs/07:1067/1090) and docs/10:427 say endpoint id. | Contradictory ordering contract | Medium | Plan-wide decision (P02, pending human decision D-06): follow the machine schema + docs/07 — `orderingKey = endpointId`, published as the broker ordering key. Per-endpoint fairness still enforced by the dispatcher. If D-06 picks "none", only the T08 test assertion and relay key selection change. | T08 |
| R3 | Merchant webhook HMAC key encoding (bytes of what?) is unspecified in docs/04. | Golden vectors could disagree with a receiver | Low | UTF-8 bytes of the resolved secret string (binding, CONVENTIONS §11); state in docs/04. | T09 |
| R4 | openapi `ingestProviderWebhook` has no `409`; docs/07 requires a non-success response for a same-event-id content conflict. | Response code choice | Low | `400 INVALID_REQUEST` (B9). | T04 |
| R5 | `summaryStatus` in the merchant payload cannot be derived from the event alone (needs unresolved operations at that version). | Snapshot may be approximate under concurrent refunds | Low | Reconstruct from operation timestamps (B11); merchants read the payment for authoritative state (docs/04). | T08 |
| R6 | `delivery_attempts.error_class` and dispatcher policy for SSRF/invalid-URL failures are not enumerated (docs/04 lists only network/timeout as retryable). | Divergent classification | Low | Closed list (B6); policy rejections terminal (B12). | T01, T11 |
| R7 | `provider_notifications` has no lease or recheck column; docs/08 specifies a 30 s lease for the webhook sweeper; `UNMATCHED` rows need recheck backoff. | Starvation or hot-looping | Low | Per-row transaction with 30 s statement timeout under `SKIP LOCKED`; reuse `processed_at` as last attempt time for `UNMATCHED` (B10). | T05, T06 |
| R8 | Webhooks for an `AUTHORIZE` whose direct response was lost cannot correlate (payment has no provider references yet; webhook carries no idempotency key). | Webhook cannot resolve such authorizations | Low | Expected: stays `UNMATCHED` until reconciliation sets references, then rechecked as corroboration (docs/06 "Parks uncorrelated valid notifications for reconciliation"). | T05, T06 |
| R9 | `dead_letter_replays.outcome` has no value for "ambiguous → reconciliation scheduled". | Audit semantics | Low | `SKIPPED_TERMINAL` + `error_class='AMBIGUOUS_RECONCILIATION_SCHEDULED'` (B13); propose `SKIPPED_AMBIGUOUS` in docs/07. | T13 |
| R10 | Operator audit table `audit.operator_actions` arrives in P10-T11; P09 records actor/reason in `webhooks.delivery_replays` (invented, B7) and `dead_letter_replays`. | Two audit locations | Low | P10 (`messaging.operator_replay_dead_letter`) / P11 add audit rows for these commands and keep the domain replay tables. | T12, T13 |
| R11 | (Resolved) Secret resolution is P06's `resolveSecretReference`; RFC 8785 is P01's `canonicalJson`. | None | Low | Consume; do not re-create. | — |
