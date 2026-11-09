# P06 — Provider adapters, provider simulator, and payment execution worker

## Phase overview

**Goal.** Make accepted `AUTHORIZE` and `CANCEL` operations execute end to end against a simulated provider without ever converting ambiguity into a guess:

1. A standalone provider simulator (`apps/provider-simulator`, own database `flowledger_sim`) that is the server side of the deterministic fake and the seeded unreliable provider, with deterministic IDs, a controllable clock, server-side post-commit fault injection, signed webhooks, and ground truth readable only by harnesses (CONVENTIONS §16).
2. `packages/providers`: the provider-neutral interface copied verbatim from `docs/06`, capability validation, two HTTP-client adapters (`FakeProviderAdapter`, `UnreliableProviderAdapter`), and one shared conformance suite run against both.
3. Provider execution persistence (`providers.provider_attempts`, `provider_notifications`, `provider_event_claims`, `provider_identity_conflicts`, `provider_evidence`) and the protected execution functions.
4. The payment worker (`apps/payment-worker`): claim → dispatch mark → provider call outside any transaction → stage evidence → apply authorization/cancellation outcomes or reschedule a proven-no-effect retry; a due-work scheduler; per-account concurrency/fairness/circuit breaking; crash hooks at every named crash point.

**Entry criteria.** `P05-GATE` green (durable command acceptance, outbox relay, inbox consumer, DLQ, `REQUESTED` rediscovery sweeper).

**Exit gate (docs/10 M6).** "Adapter conformance and authorize/cancel paths pass": `P06-GATE` proves both adapters pass the same conformance suite, authorize/cancel resolve through the worker against the simulator, every M6 acceptance bullet holds, and `pnpm check && pnpm test:integration && pnpm test:e2e && pnpm test:chaos` are green.

### Function-to-phase assignment (decided here, as README §4.3 requires)

| Function / responsibility | Phase | Reasoning |
| --- | --- | --- |
| `payments.claim_operation` | P06 | docs/10 M6: "operation claim … `REQUESTED -> PROCESSING`, `RESERVED` attempt creation, lease acquisition". |
| `payments.mark_dispatch` | P06 | docs/10 M6: "pre-call dispatch marker". |
| `payments.defer_operation` | P06 | docs/10 M6: per-account limits and circuit breaking; docs/06 §Rate limits "a locally open circuit before dispatch leaves the operation safely queued". This function is that queueing primitive. |
| `payments.schedule_same_operation_retry` | P06 | docs/10 M6 `RETRYABLE_NO_EFFECT` bullet. |
| `payments.enqueue_due_operations` | P06 | docs/10 M6 due-work scheduler bullet. |
| `payments.apply_provider_evidence` — `AUTHORIZE`/`CANCEL` from `PROCESSING`, plus corroboration | P06 | docs/10 M6: "Apply authorization and cancellation outcomes through protected transitions". README §4.3 lists the direct-response path under P07; docs/10 M6 wins (contract over plan) and P07 extends it to capture/refund (see risk R-06-01). |
| `providers.stage_attempt_evidence` (new name, see R-06-02) | P06 | docs/10 M6: "stage normalized evidence before applying it". |
| `payments.requeue_stale_pre_dispatch` | **P08** | docs/10 M8 owns "processing leases, worker fencing, stale `REQUESTED` and stale `PROCESSING` sweepers"; this function exists only to serve the stale-`PROCESSING` sweep (docs/07 §Protected payment transition functions: "requires an expired lease"), and its acceptance test "Kill the worker before dispatch: the same operation is safely reclaimed" is an M8 bullet. P06 leaves an expired pre-dispatch `RESERVED` attempt in place; it is safe because no dispatch mark exists. |
| `payments.mark_unknown`, `require_operation_review`, `record_authorization_expiry`, reconciliation cases, stale sweepers | P08 | Stated by the phase brief and docs/10 M8. Consequence for P06: an `UNKNOWN` adapter result is staged as evidence and the operation is deliberately left `PROCESSING` with a dispatched, non-completed attempt (R-06-03). |
| `payments.record_discrepancy`, discrepancy event | P08-T17 | Binding coordinator decision: the event requires a `caseId` and cases are created in P08 (see P07 R-07-01). P06 raises `DISCREPANCY_NOT_SUPPORTED`/`EVIDENCE_MISMATCH` and leaves the evidence unapplied; P07 makes those non-raising "retained, not applied" returns (`UNAPPLIED_CONTRADICTION`/`UNAPPLIED_MISMATCH`, no event). |
| Provider webhook receiver/notification processing | P09 | docs/10 M9. P06 creates the notification tables (docs/10 M6 persistence bullet), the simulator's webhook emission, and `verifyWebhook` in the adapters (conformance requirement). |

### Interfaces consumed from earlier phases

Names marked **[ASSUMPTION]** are not fixed by the contracts; the implementing agent uses the exact export named in the cited phase's GATE "Interfaces provided" list, and stops with `BLOCKED` (CONVENTIONS §14) if it differs materially.

| From | Interface |
| --- | --- |
| P01 | `packages/domain`: `MinorUnits`, `parseAmountMinor`, `toAmountString` (`src/money.ts`), `newId(prefix)` and branded ID parsers (`src/ids.ts`), RFC 8785 canonical JSON + SHA-256 helpers `canonicalJson`, `sha256` (`src/canonical-json.ts`), normalized provider result unions and `PaymentProvider` types (`src/provider.ts`), `deriveProviderIdempotencyKey` (`src/provider-key.ts`). |
| P02 | Tables `payments.payments`, `payments.payment_operations` (all docs/07 checks, partial unique indexes, deferred aggregate trigger), `providers.provider_accounts`, `provider_account_versions`, `provider_account_credentials`, `webhook_endpoints`, `webhook_endpoint_secret_versions`, `webhook_endpoint_accounts`, `api.idempotency_records`, `messaging.*`, `messaging.insert_outbox(envelope jsonb)`; roles from CONVENTIONS §7; `packages/database/src/migrate.ts` runner `migrate({ connectionString, dir?, upTo?, ledgerBucketCount, ledgerEnvironment?, expectedOwner? })` (P02-T01; throws `NOT_MIGRATION_OWNER` unless `current_user = expectedOwner`, default `fl_migration_owner`); `packages/database/src/tx.ts` `withTransaction`; `packages/database/src/errors.ts` `DomainError`; `packages/testkit/src/pg.ts` `useTestDatabase()`, `withRole()`, `createEmptyDatabase()`; dev seed with merchants, provider accounts (`provider_code` `fake-provider` and `unreliable-provider`), ACTIVE credential version 1 per account, fee policies. |
| P04 | `packages/domain/src/payment-method-crypto.ts` `encryptPaymentMethodRef(plain, aad, key): Buffer`, `decryptPaymentMethodRef(blob, aad, key): string` (AES-256-GCM, layout `iv(12) ‖ ciphertext ‖ tag(16)`, AAD = UTF-8 `merchantId|paymentId|providerAccountId`), keys from `PAYMENT_METHOD_ENCRYPTION_KEYS` (`version:base64key`, selected by `payments.payment_method_key_version`); payment-method references match `^pm_fake_[A-Za-z0-9]{1,247}$` for both provider codes; timeline = SQL `payments.payment_timeline(text)` (later phases `CREATE OR REPLACE` it with new `UNION ALL` branches, fixed `kind_rank`) + `packages/contracts/src/timeline-detail.ts` `TIMELINE_DETAIL_SCHEMAS`. |
| P05 | `payments.accept_operation` (derives `provider_idempotency_key = flowledger:{environment}:{provider}:{operationId}` and stores it); `payment.operation.execute.v1` envelopes; `packages/messaging` `Transport`, `InMemoryTransport`, `PubSubTransport`, `Transport.publish(...): Promise<string>` (broker message ID); consumer framework `packages/messaging/src/consumer.ts` (`startConsumer`, `processDelivery`, `HandlerResult`) and SQL `messaging.record_inbox_message(text, jsonb)` (`NEW`/`DUPLICATE`, wrapper `recordInboxMessage`), `messaging.insert_dead_letter(...)`; topology constants `packages/messaging/src/topology.ts` (`SUBSCRIPTIONS`, topic `flowledger-commands-v1`); consumer constant `payment-worker`; `REQUESTED` rediscovery sweeper; crash hooks `crashPoint(name)` in `packages/config/src/crash-points.ts` and `armCrashPoint`/`disarmCrashPoints` in `packages/testkit/src/crash-points.ts` (P05-T08; P06-T02 adds the name catalog). |

### Interfaces provided to later phases

| To | Interface |
| --- | --- |
| P07 | `payments.apply_provider_evidence(p_evidence_id text)` (to be replaced in full by P07), helper `payments._terminal_event_envelope(...)`, `payments._operation_correlation_id(text)`, `public.new_entity_id(text)`, `public.fault_point(text)`; worker constant `EXECUTABLE_OPERATION_TYPES` in `apps/payment-worker/src/execute-handler.ts`; simulator ground truth tables `sim.effects`, `sim.requests`; `test/support/simulator.ts` fixture. |
| P08 | Attempt/evidence tables and lease fields; `claim_operation`'s `NOT_CLAIMABLE` result for stale `PROCESSING`; the `UNKNOWN`-result branch marked `// P08: mark_unknown` in the execute handler; adapter `lookup`/`lookupAuthorizationStatus`; `reconciliationReasonFor(result)` in `packages/providers/src/classify.ts`; crash point names in §Crash points. |
| P09 | `providers.provider_notifications`, `provider_event_claims`, `provider_identity_conflicts`; adapter `verifyWebhook`; simulator webhook emitter (`SIMULATOR_WEBHOOK_URL`). |
| P09 / P13 | `resolveSecretReference(ref)` in `packages/config/src/secrets.ts` (`local-secret://` scheme; P13 keeps it, injecting values from Secret Manager as env vars — see P13-T07). |
| P12 | `crashPoint`, `CRASH_POINTS` (`packages/config/src/crash-points.ts`), SQL `public.fault_point` (GUC `flowledger.fault_point`), simulator `SIMULATOR_SEED` + `SIMULATOR_FAULT_WEIGHTS`. |
| P03 / P07 / P12 (verify) | Ground truth relation `truth.provider_financial_effects(provider_idempotency_key text, payment_ref text, operation_type text, effect_count int)` (`payment_ref` = the FlowLedger `paymentId` and `operation_type` the adapter sent in `ProviderOperationCommand`, recorded by the simulator per effect) in database `flowledger_sim`, readable only by `fl_simulator_truth` via `SIMULATOR_DATABASE_URL` (P06-T03); CI integration job runs `flowledger verify --require-ground-truth`. |

TypeScript signatures provided (exact):

```ts
// packages/providers/src/adapter.ts  — docs/06 types, verbatim, each with `export`
export interface PaymentProvider { /* docs/06 §Provider-neutral TypeScript interface */ }
// packages/providers/src/capabilities.ts
export const FAKE_PROVIDER_CAPABILITIES: ProviderCapabilities;
export const UNRELIABLE_PROVIDER_CAPABILITIES: ProviderCapabilities;
export function validateCapabilities(c: ProviderCapabilities): void; // throws CapabilityValidationError
// packages/providers/src/fake-adapter.ts / unreliable-adapter.ts
export class FakeProviderAdapter implements PaymentProvider { constructor(o: SimulatorClientOptions) }
export class UnreliableProviderAdapter implements PaymentProvider { constructor(o: SimulatorClientOptions & { faultSeed: string }) }
export type SimulatorClientOptions = {
  baseUrl: string; environment: string;
  resolveCredential: (providerAccountId: string) => Promise<Uint8Array>; // API key bytes from the account's ACTIVE credential secret_reference
  requestTimeoutMs?: number; // test override only; default from capabilities
  resolveWebhookSecrets: (webhookEndpointId: string) => Promise<ReadonlyArray<{ version: number; secret: Uint8Array }>>;
  now?: () => Date;
};
// packages/config/src/crash-points.ts (created P05-T08; P06-T02 appends the catalog)
export const CRASH_POINTS: readonly string[]; export type CrashPointName = (typeof CRASH_POINTS)[number];
// crashPoint(name: string): void and CrashPointError are P05's, unchanged
// packages/config/src/secrets.ts (CONVENTIONS §11; created by P06-T15, reused by P09/P13)
export function resolveSecretReference(ref: string): Promise<Uint8Array>; // local-secret://<path> → UTF-8 bytes of FLOWLEDGER_SECRET_<PATH>
```

### Crash points (named once here; P08/P12 reuse the names)

TypeScript (`crashPoint`), taken from docs/08 §Worker claim and provider dispatch, §Provider result resolution, and the M6 due-scheduling bullet:

| Name | Where | docs/08 row |
| --- | --- | --- |
| `worker.before_claim` | handler, before the claim transaction | "Before consuming/claiming execution command" |
| `worker.after_claim_commit` | after claim commit, before `mark_dispatch` | "After operation becomes `PROCESSING` … before `dispatchMarkedAt`" |
| `worker.after_dispatch_mark` | after `mark_dispatch` commit, before the request is sent | "After `dispatchMarkedAt` commits but before the network stack sends bytes" |
| `worker.during_provider_call` | after the adapter promise is created, before it is awaited | "While provider request is in flight" |
| `worker.after_provider_response` | after the adapter resolves, before staging | "Complete provider response arrives, process crashes before it is durably recorded" |
| `worker.after_evidence_staged` | after `stage_attempt_evidence` commit, before apply/retry | "Normalized result is stored but terminal payment transaction has not committed" |
| `worker.after_result_commit` | after apply/retry commit, before the message is acknowledged | "Terminal transaction commits, process crashes before command acknowledgement" |
| `scheduler.after_enqueue_commit` | after an `enqueue_due_operations` commit, before the next batch | M6 "crashes before/after scheduling" |

SQL (`PERFORM public.fault_point('<name>')`), for "inject failure after every statement" tests:
`claim.after_operation_update`, `claim.after_attempt_insert`, `dispatch.after_attempt_update`, `stage.after_attempt_update`, `stage.after_evidence_insert`, `apply.after_operation_update`, `apply.after_attempt_update`, `apply.after_payment_update`, `apply.after_evidence_update`, `retry.after_attempt_update`, `retry.after_operation_update`, `enqueue_due.after_clear`, `defer.after_operation_update`.

---

### P06-T01 — Provider-neutral interface, capabilities, and startup validation

**Task ID:** `P06-T01`
**Feature:** Provider-neutral interface and capability checks
**Commit:** `feat(providers): add provider-neutral interface and capability validation`
**Priority:** Critical
**Dependencies:** `P05-GATE`
**Estimated complexity:** S
**Contract references:** docs/06 §Provider-neutral TypeScript interface, §Capability model, §Normalized write results, §Error taxonomy, §Reconciliation lookup and evidence (result types), §Required contract tests "Capability and binding" + "Capability semantics" (startup validation), §MVP provider decisions "Deadlines and leases"; ADR-0011.
**Files:** create: `packages/providers/src/adapter.ts`, `packages/providers/src/capabilities.ts`, `packages/providers/src/capabilities.test.ts`, `packages/providers/src/adapter.types.test.ts`, `packages/providers/src/index.ts`; modify: `packages/providers/package.json` (add `@flowledger/domain` dependency only if absent); must not touch: `packages/domain/**`, `migrations/**`.

**Objective** — Freeze the provider boundary exactly as written in docs/06 so the simulator, adapters, worker, and P08/P09 all compile against one definition, and reject inconsistent capability configuration at process start.

**Implementation instructions**
1. In `adapter.ts`, copy verbatim every `type`/`interface` block from docs/06 §Provider-neutral TypeScript interface, §Capability model (`ProviderCapabilities`), §Normalized write results (`ResolutionSource`, `ProviderEvidence`, `ProviderOutcome`, `ProviderTerminalOutcome`, `ProviderWriteResult`), §Error taxonomy (`ProviderErrorCategory`, `RetryDirective`, `NormalizedProviderError`, `NoEffectProof`), and §Reconciliation lookup (`ProviderLookupResult`, `ProviderAuthorizationLookupResult`). The only permitted edits: prefix each declaration with `export`, and order declarations so the file compiles. The interface is named `PaymentProvider` (docs/06 line 126); do not rename it.
2. If `@flowledger/domain` already exports a type with one of these names (P01 deliverable "normalized provider result/error/evidence types as discriminated unions"), keep the verbatim copy in `adapter.ts` and add to `adapter.types.test.ts` a compile-time mutual-assignability assertion for each overlapping name: `type Eq<A,B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false; const _x: Eq<Adapter.ProviderOutcome, Domain.ProviderOutcome> = true;`.
3. In `capabilities.ts` define `FAKE_PROVIDER_CAPABILITIES` and `UNRELIABLE_PROVIDER_CAPABILITIES` (both `Object.freeze`d, `contractVersion: 1`):
   - `supportedOperations: ['AUTHORIZE','CAPTURE','CANCEL','REFUND']`, `manualCapture: true`, `partialCapture: 'SUPPORTED_RELEASES_REMAINDER'`, `multipleCaptures: false`, `partialRefunds: true`, `multipleRefunds: true`, `cancellationBeforeCapture: true`.
   - `authorizationExpiry: { statusLookup: true, returnsExpiryTimestamp: true, initialCheckAfterSeconds: 604800 }`.
   - `writeIdempotency: { AUTHORIZE: 'SAME_KEY_REPLAY', CAPTURE: 'SAME_KEY_REPLAY', CANCEL: 'SAME_KEY_REPLAY', REFUND: 'SAME_KEY_REPLAY', documentedRetentionSeconds: null, maxKeyLength: 255 }`.
   - `lookup: { byProviderOperationId: true, byProviderPaymentId: true, byIdempotencyKey: true, absenceConclusiveAfterSeconds: 60 }`.
   - `webhooks: { signed: true, stableEventId: true, timestamped: true, replayToleranceSeconds: 300 }`.
   - `execution`: fake `{ requestTimeoutMs: 5000, processingLeaseMs: 15000, maxInFlightPerAccount: 100 }`; unreliable `{ requestTimeoutMs: 10000, processingLeaseMs: 30000, maxInFlightPerAccount: 100 }` (docs/06 §Deadlines and leases table).
4. `validateCapabilities(c)` throws `CapabilityValidationError` (message names the field, never a secret) when any of: `contractVersion !== 1`; `supportedOperations` missing any of the four types; `manualCapture !== true`; `partialCapture !== 'SUPPORTED_RELEASES_REMAINDER'`; `partialRefunds` or `multipleRefunds` false; `cancellationBeforeCapture` false; no lookup method true; any lookup method true while `absenceConclusiveAfterSeconds === null` (docs/06: lookup must distinguish explicit absence from inconclusive absence); `authorizationExpiry.statusLookup` false; `webhooks.signed` or `webhooks.stableEventId` false; `processingLeaseMs < requestTimeoutMs + 10000`; `maxInFlightPerAccount < 1`; `writeIdempotency.maxKeyLength < 1`.
5. `index.ts` re-exports `adapter.ts` and `capabilities.ts`.

**Expected behavior** — `validateCapabilities(FAKE_PROVIDER_CAPABILITIES)` returns; `validateCapabilities({...FAKE, execution: {...FAKE.execution, processingLeaseMs: 14999}})` throws naming `execution.processingLeaseMs`.

**Acceptance criteria**
- [ ] `adapter.ts` declarations are textually identical to docs/06 apart from `export` keywords and ordering (reviewer diffs the blocks).
- [ ] Both capability constants pass validation; each listed invalid mutation throws and names its field.
- [ ] `pnpm typecheck` passes with the mutual-assignability assertions (when applicable).

**Testing requirements** — `packages/providers/src/capabilities.test.ts`: one positive case per constant; one negative case per rule in step 4 (13 cases); boundary `processingLeaseMs === requestTimeoutMs + 10000` passes. `packages/providers/src/adapter.types.test.ts`: compile-time assertions plus a runtime `it` that constructs one value of each `ProviderOutcome` variant and uses `// @ts-expect-error` to prove a `FAILED` without `noEffectProof` and a `SUCCEEDED` without `providerOperationId` do not compile. Command: `pnpm vitest run --project unit packages/providers/src`.

**Non-goals** — No adapter implementation, no HTTP, no database.

**Handoff checklist**
- [ ] Verbatim diff against docs/06 reviewed.
- [ ] Each negative validation test observed failing when its rule is removed.
- [ ] `pnpm check` green.

---

### P06-T02 — Crash hooks, SQL fault points, and SQL ID generator

**Task ID:** `P06-T02`
**Feature:** Fault-injection hooks for M6/M7 code paths
**Commit:** `feat(config): add execution crash-point catalog and SQL fault points`
**Priority:** Critical
**Dependencies:** `P05-GATE`
**Estimated complexity:** S
**Contract references:** docs/08 §Crash-point matrix (Worker claim and provider dispatch, Provider result resolution), §Required failure-injection tests "Worker and provider", "Ledger"; docs/10 Risk register ("add fault hooks while implementing M6/M7"), M12 ("hooks … disabled outside test environments"); docs/07 §IDs.
**Files:** create: `migrations/0600_fault_points_and_id_generator.sql`, `test/integration/db/fault-points.test.ts`, `packages/config/src/crash-points.test.ts` (if P05 did not create it); modify: `packages/config/src/crash-points.ts` (P05-T08; add the catalog only), `docs/CONFIG.md`, `infra/docker/.env.example`; must not touch: `apps/**`, `packages/testkit/src/crash-points.ts` (P05-owned arm/disarm helpers; reuse as-is).

**Objective** — Provide the hook API every later crash test uses, so hooks are written into M6/M7 code as it is authored rather than retrofitted.

**Implementation instructions**
1. The crash-hook primitive already exists (CONVENTIONS §3, P05-T08): `crashPoint(name: string)` in `packages/config/src/crash-points.ts` — no-op unless `FLOWLEDGER_FAULT_HOOKS=1`; a point armed in-process with `armCrashPoint(name)` (`packages/testkit/src/crash-points.ts`) throws `CrashPointError`; a point listed in `FLOWLEDGER_CRASH_POINTS=<name,…>` SIGKILLs the process (exit 137). Do not create any other crash-hook module or arming mechanism; do not change `crashPoint`'s signature or behavior.
2. Append to `packages/config/src/crash-points.ts`: `export const CRASH_POINTS = [ ...P05 names, ...the eight worker.*/scheduler.* names in §Crash points above ] as const; export type CrashPointName = (typeof CRASH_POINTS)[number];` — the single catalog P08/P12 enumerate. P06 code calls `crashPoint(name satisfies CrashPointName)` so a misspelt name is a type error.
3. Behavior added to `crashPoint`: if `FLOWLEDGER_FAULT_HOOKS === '1'` while `NODE_ENV === 'production'`, the first call throws `Error('FLOWLEDGER_FAULT_HOOKS forbidden in production')`.
4. `migrations/0600_fault_points_and_id_generator.sql`:
   ```sql
   CREATE FUNCTION public.fault_point(p_name text) RETURNS void
   LANGUAGE plpgsql SET search_path = pg_catalog AS $$
   BEGIN
     IF current_setting('flowledger.fault_point', true) = p_name THEN
       RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FAULT_INJECTED', DETAIL = json_build_object('point', p_name)::text;
     END IF;
   END $$;
   ```
   Raising aborts only the caller's own transaction, so a session that sets the GUC can only fail itself; no privileged effect is reachable. `GRANT EXECUTE ON FUNCTION public.fault_point(text) TO PUBLIC` (last statement).
5. Same file: `public.new_entity_id(p_prefix text) RETURNS text` (`VOLATILE`, `SECURITY INVOKER`), producing `<prefix>_<ULID>`: 48-bit `floor(extract(epoch from clock_timestamp())*1000)` + 80 bits from `gen_random_bytes(10)`, Crockford Base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), first character in `0`–`7`. Validate `p_prefix ~ '^[a-z][a-z0-9]{1,15}$'`. If migration-owned function `public.new_entity_id` or an equivalent P02 generator already exists (`\df public.*`), do not create a second one: use the existing one in all P06/P07 SQL and record its name in the commit body. `GRANT EXECUTE … TO PUBLIC` last.
6. Ensure `FLOWLEDGER_FAULT_HOOKS` and `FLOWLEDGER_CRASH_POINTS` (P05-T08) are in `docs/CONFIG.md` and `.env.example` (`FLOWLEDGER_FAULT_HOOKS=0`); add the `flowledger.fault_point` GUC note.

**Expected behavior** — With hooks off, `crashPoint('worker.after_dispatch_mark')` is a no-op. With `FLOWLEDGER_FAULT_HOOKS=1` and `armCrashPoint('worker.after_dispatch_mark')`, the call throws `CrashPointError`; after `disarmCrashPoints()` it does not. In SQL, `SET LOCAL flowledger.fault_point='claim.after_operation_update'` makes the function raise at that statement only.

**Acceptance criteria**
- [ ] `packages/config/src/crash-points.ts` still imports nothing except `node:process`; `CRASH_POINTS` contains every name in §Crash points.
- [ ] Production guard behaves as specified; no file named `crash.ts` or other crash-hook module exists.
- [ ] `public.fault_point` raises `P0001`/`FAULT_INJECTED` only for the matching name; `public.new_entity_id('pev')` matches `^pev_[0-7][0-9A-HJKMNP-TV-Z]{25}$`.

**Testing requirements** — `packages/config/src/crash-points.test.ts`: inert when unset; throws in production; armed point throws `CrashPointError` and stops after `disarmCrashPoints()`; `FLOWLEDGER_CRASH_POINTS=worker.after_dispatch_mark` verified by spawning a `node -e` child and asserting it dies by SIGKILL (exit 137); every §Crash points name is in `CRASH_POINTS`. `test/integration/db/fault-points.test.ts`: matching/non-matching names; 1,000 generated IDs all match the regex and are unique. Commands: `pnpm vitest run --project unit packages/config/src/crash-points.test.ts`, `pnpm vitest run --project integration test/integration/db/fault-points.test.ts`.

**Non-goals** — No hook placement in app code (each feature task places its own hooks).

**Handoff checklist**
- [ ] Apps import `crashPoint` from `@flowledger/config` (never from testkit).
- [ ] Config docs updated.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-T03 — Simulator database bootstrap and `flowledger migrate --simulator`

**Task ID:** `P06-T03`
**Feature:** Separate provider-side persistence
**Commit:** `feat(infra): bootstrap provider simulator database and migrations`
**Priority:** Critical
**Dependencies:** `P05-GATE`
**Estimated complexity:** M
**Contract references:** CONVENTIONS §16, §8; docs/06 §Deterministic fake provider ("Persist provider-side state separately", "Expose ground truth only to test harnesses"); docs/09 §Defining `duplicate_financial_effects_total`.
**Files:** modify: `.github/workflows/ci.yml` (integration job, see step 6); create: `apps/provider-simulator/package.json`, `apps/provider-simulator/tsconfig.json`, `apps/provider-simulator/migrations/0001_sim_schema.sql`, `infra/docker/postgres-init/20-provider-simulator.sql`, `packages/testkit/src/simulator-db.ts`, `test/integration/provider-simulator/schema.test.ts`; modify: `infra/docker/compose.yaml` (mount init dir if not mounted), `apps/cli/src/commands/migrate.ts`, `packages/config/src/cli.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`, root `tsconfig.json` references, `pnpm-workspace.yaml` only if `apps/*` is not already globbed; must not touch: `migrations/**`, `packages/database/src/migrate.ts` (call it, do not change it).

**Objective** — Give the simulator its own database and roles so FlowLedger roles cannot read provider ground truth and the simulator cannot touch FlowLedger data.

**Implementation instructions**
1. **Decision (documented in `docs/CONFIG.md` under "Provider simulator"):** simulator migrations are applied by the explicit command `flowledger migrate --simulator`, never at simulator startup. Reason: one migration runner and checksum policy for both databases (CONVENTIONS §8), and docs/10 M13 requires migration to be an explicit deployment step, not a startup side effect.
2. `infra/docker/postgres-init/20-provider-simulator.sql` (runs once on a fresh volume as the superuser): `CREATE ROLE fl_simulator LOGIN PASSWORD '<synthetic>'`; `CREATE ROLE fl_simulator_truth LOGIN PASSWORD '<synthetic>'`; `CREATE DATABASE flowledger_sim OWNER fl_simulator`; `REVOKE CONNECT, TEMPORARY ON DATABASE flowledger_sim FROM PUBLIC`; `GRANT CONNECT ON DATABASE flowledger_sim TO fl_simulator, fl_simulator_truth`; `REVOKE CONNECT ON DATABASE flowledger FROM fl_simulator, fl_simulator_truth` (if the FlowLedger database name differs, use the name P00 set in compose). Passwords match `.env.example`.
3. `flowledger migrate --simulator` calls the P02 runner `migrate({ connectionString: PROVIDER_SIMULATOR_DATABASE_URL, dir: 'apps/provider-simulator/migrations', expectedOwner: 'fl_simulator', ledgerBucketCount })` (role `fl_simulator`; the bucket GUC is unused by simulator SQL). It records history in `flowledger_sim.public.schema_migrations`. Without the flag the command behaves exactly as before.
4. `0001_sim_schema.sql` (schema `sim`, owner `fl_simulator`; tables then indexes then grants):
   - `sim.clock(singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), offset_ms bigint NOT NULL DEFAULT 0)`; insert the one row.
   - `sim.payments(provider_payment_id text PRIMARY KEY, account_ref text NOT NULL, authorization_idempotency_key text NOT NULL, provider_authorization_id text NOT NULL UNIQUE, authorized_amount_minor bigint NOT NULL CHECK (authorized_amount_minor > 0), captured_amount_minor bigint NOT NULL DEFAULT 0, refunded_amount_minor bigint NOT NULL DEFAULT 0, status text NOT NULL CHECK (status IN ('AUTHORIZED','CAPTURED','CANCELED','EXPIRED')), provider_capture_id text, authorization_expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, CHECK (captured_amount_minor <= authorized_amount_minor), CHECK (refunded_amount_minor <= captured_amount_minor))`.
   - `sim.requests(account_ref text NOT NULL, idempotency_key text NOT NULL, operation_type text NOT NULL CHECK (operation_type IN ('AUTHORIZE','CAPTURE','CANCEL','REFUND')), request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32), flowledger_operation_id text NOT NULL, flowledger_payment_id text NOT NULL, outcome text NOT NULL CHECK (outcome IN ('SUCCEEDED','DECLINED','NOT_APPLIED')), response_status integer NOT NULL, response_body jsonb NOT NULL, provider_payment_id text, provider_operation_id text, committed_at timestamptz NOT NULL, PRIMARY KEY (account_ref, idempotency_key))` — the provider's idempotency record; one row per committed decision.
   - `sim.effects(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_ref text NOT NULL, idempotency_key text NOT NULL, flowledger_operation_id text NOT NULL, flowledger_payment_id text NOT NULL, operation_type text NOT NULL CHECK (operation_type IN ('AUTHORIZE','CAPTURE','CANCEL','REFUND')), provider_payment_id text NOT NULL, provider_operation_id text NOT NULL, amount_minor bigint NOT NULL CHECK (amount_minor > 0), currency text NOT NULL CHECK (currency='USD'), applied_at timestamptz NOT NULL)` — ground truth: exactly one row per applied provider financial effect. Indexes on `(idempotency_key)`, `(flowledger_operation_id)`, and `(flowledger_payment_id, operation_type)`. `flowledger_operation_id`/`flowledger_payment_id`/`operation_type` are copied from the `operationId`/`paymentId`/`operationType` the adapter sent (docs/06 `ProviderOperationCommand` carries all three) — provider-side metadata, so a blind retry under a substituted idempotency key is still attributable to its payment. No unique constraint (a duplicate effect must be representable so the detector can see it).
   - `sim.request_log(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_ref text NOT NULL, idempotency_key text NOT NULL, operation_type text NOT NULL, received_at timestamptz NOT NULL, fault text NOT NULL, committed boolean NOT NULL)` — every received write, including uncommitted ones; this is the test-only fault diagnostics table (CONVENTIONS §16). Index `(account_ref, idempotency_key, received_at)`.
   - `sim.forced_outcomes(provider_payment_id text NOT NULL, operation_type text NOT NULL, outcome text NOT NULL CHECK (outcome IN ('DECLINED','NOT_APPLIED')), code text NOT NULL, remaining integer NOT NULL CHECK (remaining >= 0), PRIMARY KEY (provider_payment_id, operation_type))`.
   - `sim.fault_overrides(idempotency_key text PRIMARY KEY, fault text NOT NULL, remaining integer NOT NULL CHECK (remaining >= 0))`.
   - `sim.webhook_events(event_id text PRIMARY KEY, account_ref text NOT NULL, provider_payment_id text, raw_body bytea NOT NULL, deliver_at timestamptz NOT NULL, delivered_at timestamptz, attempts integer NOT NULL DEFAULT 0, fault text NOT NULL DEFAULT 'NONE', created_at timestamptz NOT NULL)`; index `(deliver_at) WHERE delivered_at IS NULL`.
   - Cross-phase ground-truth relation required by P03's duplicate-effect class (exact name and columns): `CREATE SCHEMA truth AUTHORIZATION fl_simulator; CREATE VIEW truth.provider_financial_effects AS SELECT idempotency_key AS provider_idempotency_key, flowledger_payment_id AS payment_ref, operation_type, count(*)::int AS effect_count FROM sim.effects GROUP BY idempotency_key, flowledger_payment_id, operation_type;` (columns `provider_idempotency_key text`, `payment_ref text`, `operation_type text`, `effect_count int`; a key with no effect has no row, which the checker reads as 0; per-key totals are `sum(effect_count)` grouped by key; per-payment/type totals are `sum(effect_count)` grouped by `payment_ref, operation_type`).
   - Grants last: `REVOKE ALL ON SCHEMA truth FROM PUBLIC; GRANT USAGE ON SCHEMA truth TO fl_simulator_truth; GRANT SELECT ON truth.provider_financial_effects TO fl_simulator_truth;` (no other role may read it); `GRANT USAGE ON SCHEMA sim TO fl_simulator_truth; GRANT SELECT ON sim.effects, sim.requests, sim.payments, sim.request_log TO fl_simulator_truth;` (harness diagnostics); nothing else.
5. `packages/testkit/src/simulator-db.ts`: `createSimulatorDatabase(container): Promise<{ ownerUrl: string; truthUrl: string }>` creates the two roles and database on the shared Testcontainers instance (same statements as step 2), runs the runner against `apps/provider-simulator/migrations`, and returns URLs.
6. CI: in the integration job of `.github/workflows/ci.yml` (P00/P03), create the simulator database (same statements as step 2), run `flowledger migrate --simulator`, export `SIMULATOR_DATABASE_URL` (truth role), and change the job's `flowledger verify` invocation to `flowledger verify --require-ground-truth` (CONVENTIONS §16; cross-phase request from P03).
7. Env vars (`.env.example` synthetic values, `docs/CONFIG.md`): `PROVIDER_SIMULATOR_DATABASE_URL` (fl_simulator owner connection; simulator app and `flowledger migrate --simulator`), `SIMULATOR_DATABASE_URL` (fl_simulator_truth, harnesses and `flowledger verify` only, CONVENTIONS §16).

**Expected behavior** — `pnpm db:up && flowledger migrate --simulator` creates schema `sim`; rerunning is a no-op; editing an applied file fails on checksum.

**Acceptance criteria**
- [ ] `fl_simulator_truth` can `SELECT` the four truth tables and cannot `INSERT/UPDATE/DELETE` any `sim` table.
- [ ] `fl_payment_worker`, `fl_api`, `fl_reconciler` cannot connect to `flowledger_sim`; `fl_simulator` cannot connect to the FlowLedger database.
- [ ] `sim.effects` accepts two rows with the same idempotency key (no unique constraint), and `truth.provider_financial_effects` then reports `effect_count = 2` for that key.
- [ ] Two `CAPTURE` effects for one `flowledger_payment_id` under different idempotency keys appear as two truth rows with the same `payment_ref` and `operation_type = 'CAPTURE'`.
- [ ] `fl_simulator_truth` can select `truth.provider_financial_effects`; `PUBLIC`/any other non-owner role cannot (`42501`).
- [ ] CI integration job runs `flowledger verify --require-ground-truth` with `SIMULATOR_DATABASE_URL` set.

**Testing requirements** — `test/integration/provider-simulator/schema.test.ts`: migration from empty; idempotent rerun; checksum mismatch rejected; truth role read-only (each DML statement expected to fail with SQLSTATE `42501`); cross-database connect denied for `fl_payment_worker` (expect `42501`/`28000`); duplicate effects insertable and counted 2 by the truth view; substituted-key pair (same payment, `CAPTURE`, two keys) visible per `payment_ref`; view column names/types (`provider_idempotency_key`, `payment_ref`, `operation_type`, `effect_count`) asserted via `information_schema.columns`. Command: `pnpm vitest run --project integration test/integration/provider-simulator/schema.test.ts`.

**Non-goals** — No HTTP server, no business logic.

**Handoff checklist**
- [ ] Decision on migration application recorded in `docs/CONFIG.md`.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-T04 — Simulator core: provider-side state machine, idempotency, deterministic IDs

**Task ID:** `P06-T04`
**Feature:** Deterministic fake provider (reference implementation)
**Commit:** `feat(providers): add provider simulator core state machine`
**Priority:** Critical
**Dependencies:** `P06-T03`
**Estimated complexity:** L
**Contract references:** docs/06 §Deterministic fake provider, §Capability model (one capture releasing remainder, multiple refunds, cancellation before capture), §Stable provider idempotency ("same key with different request semantics … `CONFLICT`"), §Reconciliation lookup (search order, absence window), §Authorization-expiry lookup; CONVENTIONS §16 (core.ts).
**Files:** create: `apps/provider-simulator/src/core.ts`, `apps/provider-simulator/src/store.ts`, `apps/provider-simulator/src/memory-store.ts`, `apps/provider-simulator/src/core.test.ts`; must not touch: `packages/**`, `migrations/**`.

**Objective** — One pure decision module that both the HTTP service (P06-T05) and adapter unit tests run, so the fake is a complete reference provider and not a mock.

**Implementation instructions**
1. `store.ts` defines the persistence port used by core, with exactly two implementations (memory now, PostgreSQL in P06-T05): `getRequest(account, key)`, `getPayment(providerPaymentId)`, `getPaymentByAuthorization(id)`, `insertRequest(row)`, `upsertPayment(row)`, `insertEffect(row)`, `logRequest(row)`, `takeForcedOutcome(providerPaymentId, type)`, `findRequestByProviderOperationId(id)`, `findRequestsByPayment(providerPaymentId, type)`, `lastRequestAt(account, key)`, `now()` (real time + `sim.clock.offset_ms`). Row shapes mirror the `sim.*` columns from P06-T03.
2. Deterministic IDs: `deriveId(kind, account, key) = kind + '_' + base32(sha256(`${kind}|${account}|${key}`)).slice(0, 26)` with kinds `pp` (provider payment, derived from the AUTHORIZE key), `pa` (authorization), `po` (operation, from that operation's key), `pc` (capture). Use `node:crypto`.
3. Request hash = SHA-256 over RFC 8785 JSON of `{ account, operationType, paymentRef, amountMinor, currency, providerPaymentId, providerAuthorizationId, paymentMethodTokenHash }` (`paymentRef` = FlowLedger `paymentId` sent as provider metadata, so docs/06 "same key with changed … payment reference → CONFLICT" holds) where `paymentMethodTokenHash` is hex SHA-256 of the token for `AUTHORIZE` and null otherwise. The raw token is never stored or logged by the simulator.
4. `decideWrite(store, req) → Decision` inside one store transaction:
   - Existing `sim.requests` row for `(account, key)`: equal hash → `{ kind: 'REPLAY', status, body }` (exact stored response, no new effect); different hash → `{ kind: 'CONFLICT', status: 409, body: { status: 'idempotency_conflict', code: 'idempotency_key_reused' } }` (not stored).
   - Forced outcome present for `(providerPaymentId, type)` with `remaining > 0` → decrement, store and return that outcome.
   - `AUTHORIZE`: token prefix `pm_fake_approve` → success: create `sim.payments` (`AUTHORIZED`, `authorization_expires_at = now + 7 days`), effect row, response 200 `{ status: 'succeeded', providerPaymentId, providerOperationId, providerAuthorizationId, providerCaptureId: null, authorizationExpiresAt, amountMinor, currency, observedAt }`; `pm_fake_decline` → 402 `{ status: 'declined', code: 'card_declined', providerPaymentId: null, providerOperationId }` (DECLINED, no effect); `pm_fake_invalid` → 422 `{ status: 'not_applied', code: 'invalid_payment_method' }` (NOT_APPLIED); any other token → 422 `not_applied`/`unknown_token`.
   - `CAPTURE`: requires payment `AUTHORIZED`, captured 0, `0 < amount <= authorized`; success sets `CAPTURED`, `captured_amount_minor`, `provider_capture_id = pc_…` (remainder released implicitly), response includes `providerCaptureId`. Violations → 422 `not_applied` with code `invalid_state` or `amount_exceeds_authorized`.
   - `CANCEL`: requires `AUTHORIZED` → `CANCELED`; otherwise 422 `invalid_state`.
   - `REFUND`: requires `CAPTURED` and `refunded + amount <= captured`; success increments `refunded_amount_minor`; otherwise 422 `amount_exceeds_refundable` / `invalid_state`.
   - Every committed decision (SUCCEEDED/DECLINED/NOT_APPLIED) inserts its `sim.requests` row; only SUCCEEDED inserts a `sim.effects` row (with `flowledger_operation_id`, `flowledger_payment_id`, and `operation_type` from the request body's `operationId`, `paymentRef`, and endpoint type).
   - Expiry: when `now() >= authorization_expires_at` and status is `AUTHORIZED`, any read or write first moves the payment to `EXPIRED` (lazy); capture/cancel against `EXPIRED` → 422 `authorization_expired`.
5. `lookup(store, q)`: search by `providerOperationId`, then `providerPaymentId + operationType`, then `(account, idempotencyKey)` (docs/06 order). Found → the stored decision. Not found → `{ found: false, checkedAt: now(), lastRequestAt }`.
6. `authorizationStatus(store, providerAuthorizationId, account)` → `{ status: 'ACTIVE', expiresAt }` | `{ status: 'EXPIRED', expiredAt }` | `{ status: 'NOT_FOUND' }`.
7. `memory-store.ts` implements the port with `Map`s and a settable clock.

**Expected behavior** — Authorize key K1 twice with the same body → second call returns byte-identical body, `effects` count 1. Same K1 with amount changed → 409. Capture 6000 of 10000 → `CAPTURED`, then refund 2000 + 2000 succeed, refund 2001 → 422 `amount_exceeds_refundable`.

**Acceptance criteria**
- [ ] `core.ts` imports only `node:crypto` and `./store`.
- [ ] Every rule in step 4 has a positive and a negative test.
- [ ] 100 sequential identical requests → one effect row and 100 identical bodies.

**Testing requirements** — `apps/provider-simulator/src/core.test.ts` (memory store): replay identity; conflict on changed amount, currency, operation type, payment reference (`paymentRef` and `providerPaymentId`); effect rows carry `flowledger_payment_id`/`operation_type` from the request; each token outcome; full capture; partial capture then second capture rejected; cancel then capture rejected; multiple partial refunds up to captured; over-refund rejected; forced outcome consumed once; lazy expiry after clock advance; lookup by each identifier; absence returns `lastRequestAt`; ID determinism across two store instances. Command: `pnpm vitest run --project unit apps/provider-simulator/src/core.test.ts`.

**Non-goals** — No HTTP, no faults, no webhooks.

**Handoff checklist**
- [ ] No raw token persisted (grep store writes).
- [ ] `pnpm check` green.

---

### P06-T05 — Simulator HTTP service, PostgreSQL store, and test endpoints

**Task ID:** `P06-T05`
**Feature:** Deterministic fake provider service
**Commit:** `feat(providers): serve provider simulator over HTTP with postgres state`
**Priority:** Critical
**Dependencies:** `P06-T04`
**Estimated complexity:** L
**Contract references:** CONVENTIONS §16, §11; docs/06 §Deterministic fake provider, §Redaction and retained evidence; docs/10 §Delivery safety (health, readiness, graceful shutdown).
**Files:** create: `apps/provider-simulator/src/main.ts`, `apps/provider-simulator/src/server.ts`, `apps/provider-simulator/src/pg-store.ts`, `packages/config/src/provider-simulator.ts`, `test/support/simulator.ts`, `test/integration/provider-simulator/http.test.ts`; modify: `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `apps/provider-simulator/src/core.ts` (except bug fixes found by these tests, called out in the commit body).

**Objective** — Run the core as a multi-process-safe HTTP service so the worker, reconciler, and webhook processes share one provider truth.

**Implementation instructions**
1. Fastify app built by `buildSimulatorServer(config): FastifyInstance` in `server.ts`; `main.ts` parses config and listens. Routes (JSON; auth `Authorization: Bearer <SIMULATOR_API_KEY>`, compared with `timingSafeEqual`; missing/wrong → 401 `{status:'unauthenticated'}` before any state access):
   - `POST /v1/authorizations`, `POST /v1/captures`, `POST /v1/cancellations`, `POST /v1/refunds`. Body: `{ account, idempotencyKey, operationId, paymentRef, amountMinor, currency, providerPaymentId?, providerAuthorizationId?, paymentMethodToken? }` (`paymentRef` required, `^pay_[0-7][0-9A-HJKMNP-TV-Z]{25}$`, else 400 `not_applied`/`invalid_payment_ref`); header `Idempotency-Key` must equal `idempotencyKey` (else 400 `{status:'not_applied', code:'idempotency_header_mismatch'}`). Each response carries header `X-Request-Id` (`sim-req-<uuid>`).
   - `GET /v1/operations/by-key?account=&idempotencyKey=`, `GET /v1/operations/{providerOperationId}?account=`, `GET /v1/payments/{providerPaymentId}/operations?account=&operationType=` → `{ found: true, decision }` or `{ found: false, checkedAt, lastRequestAt }`.
   - `GET /v1/authorizations/{providerAuthorizationId}/status?account=`.
   - `GET /healthz` (process up), `GET /readyz` (DB reachable).
   - Test endpoints, registered only when `SIMULATOR_TEST_ENDPOINTS === '1'` (otherwise 404): `POST /__test/clock` `{ advanceMs }` or `{ setOffsetMs }`; `POST /__test/outcomes` `{ providerPaymentId, operationType, outcome: 'DECLINED'|'NOT_APPLIED', code, remaining }`; `POST /__test/faults` `{ idempotencyKey, fault, remaining }` (consumed by P06-T06).
2. `pg-store.ts` implements the core port with `pg` against `PROVIDER_SIMULATOR_DATABASE_URL`. Each write decision runs in one transaction that first takes `pg_advisory_xact_lock(hashtextextended(account || ':' || key, 0))`, then (for capture/cancel/refund) `SELECT … FOR UPDATE` on `sim.payments`. Concurrent identical requests therefore serialize and the second replays.
3. Every received write appends `sim.request_log` (`fault='NONE'` until P06-T06, `committed` true/false).
4. Logging: pino with an allowlist of `account`, operation type, amount, status code, request id, duration; never body, token, or API key.
5. Graceful shutdown: close listener, drain in-flight requests (max 10 s), close pool.
6. `test/support/simulator.ts` (not a package; imported by integration/e2e tests): `startSimulator(opts?: { seed?: string; faultWeights?: Record<string, number>; webhookUrl?: string }) → Promise<{ baseUrl; apiKey; truth: pg.Pool; control: { advanceClock(ms); forceOutcome(...); setFault(key, fault, remaining?) }; stop() }>` using `createSimulatorDatabase` (P06-T03) and `buildSimulatorServer` on port 0.
7. Config (`packages/config/src/provider-simulator.ts`): `PROVIDER_SIMULATOR_PORT` (default 4100), `PROVIDER_SIMULATOR_DATABASE_URL`, `SIMULATOR_API_KEY`, `SIMULATOR_TEST_ENDPOINTS`, `SIMULATOR_SEED`, `SIMULATOR_FAULT_WEIGHTS`, `SIMULATOR_HOLD_MS` (default 60000), `SIMULATOR_WEBHOOK_URL` (optional), `SIMULATOR_WEBHOOK_SECRET`. Add each to `.env.example` and `docs/CONFIG.md`.

**Expected behavior** — 100 concurrent identical `POST /v1/authorizations` → 100 × 200 with identical bodies, `sim.effects` count 1. `POST /__test/clock` returns 404 without the flag.

**Acceptance criteria**
- [ ] Wrong API key → 401 and no `request_log` row.
- [ ] 100 concurrent identical requests → one effect; 100 concurrent conflicting requests (different amounts, same key) → exactly one 200 and 99 × 409.
- [ ] Test endpoints absent unless `SIMULATOR_TEST_ENDPOINTS=1`.
- [ ] Logs captured during the suite contain none of the prohibited-data fixtures nor the API key nor any `pm_fake_` token.

**Testing requirements** — `test/integration/provider-simulator/http.test.ts`: auth; each route happy path; replay; concurrent identical (100) and concurrent conflicting (100); header mismatch; test endpoint gating; clock advance drives lazy expiry; log redaction scan using `packages/testkit/src/prohibited-data.ts`. Command: `pnpm vitest run --project integration test/integration/provider-simulator/http.test.ts`.

**Non-goals** — Fault injection (T06), webhook emission (T07).

**Handoff checklist**
- [ ] `docs/CONFIG.md` lists every new variable.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-T06 — Simulator fault engine (seeded, server-side, post-commit)

**Task ID:** `P06-T06`
**Feature:** Seeded unreliable provider
**Commit:** `feat(providers): add seeded server-side fault injection to simulator`
**Priority:** Critical
**Dependencies:** `P06-T05`
**Estimated complexity:** M
**Contract references:** docs/06 §Unreliable provider (fault list), §Timeout and ambiguous-result policy; docs/10 Risk register ("Make fault distribution configurable and preserve deterministic seeds"); docs/09 §Provider contract tests ("recorded seed"); CONVENTIONS §16.
**Files:** create: `apps/provider-simulator/src/faults.ts`, `apps/provider-simulator/src/faults.test.ts`, `test/integration/provider-simulator/faults.test.ts`; modify: `apps/provider-simulator/src/server.ts`; must not touch: `apps/provider-simulator/src/core.ts`.

**Objective** — Produce, deterministically from a recorded seed, the failures a real sandbox cannot produce on demand — above all "timeout after the provider committed".

**Implementation instructions**
1. PRNG — mulberry32 (stdlib-free):
   ```ts
   export function mulberry32(a: number): () => number {
     return () => {
       a |= 0; a = (a + 0x6d2b79f5) | 0;
       let t = Math.imul(a ^ (a >>> 15), 1 | a);
       t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
       return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
     };
   }
   export function seedFor(seed: string, key: string, ordinal: number): number {
     return createHash('sha256').update(`${seed}:${key}:${ordinal}`).digest().readUInt32BE(0);
   }
   ```
   `ordinal` = number of prior `sim.request_log` rows for `(account, key)`, read inside the request's advisory-lock transaction, so the choice is identical across processes and restarts. (`Math` here is fault selection, never money.)
2. Fault vocabulary (`Fault` union): `NONE`, `LATENCY`, `RATE_LIMITED`, `UNAVAILABLE_NOT_EXECUTED`, `PROVIDER_5XX_BEFORE_COMMIT`, `PROVIDER_5XX_AFTER_COMMIT`, `TIMEOUT_BEFORE_COMMIT`, `TIMEOUT_AFTER_COMMIT`, `CONNECTION_LOSS_AFTER_COMMIT`, `MALFORMED_SUCCESS`. Behavior:
   - `LATENCY`: sleep `50 + floor(rand*450)` ms, then normal.
   - `RATE_LIMITED`: no commit; 429 `{status:'rate_limited', retryAfterMs: 1000}`, header `Sim-Not-Executed: true`.
   - `UNAVAILABLE_NOT_EXECUTED`: no commit; 503, header `Sim-Not-Executed: true`.
   - `PROVIDER_5XX_BEFORE_COMMIT`: no commit; 500, no header (ambiguous to the client; truth = no effect).
   - `PROVIDER_5XX_AFTER_COMMIT`: commit; 500, no header.
   - `TIMEOUT_BEFORE_COMMIT`: no commit; hold the socket open `SIMULATOR_HOLD_MS`, then destroy it.
   - `TIMEOUT_AFTER_COMMIT`: commit (transaction finished), then hold `SIMULATOR_HOLD_MS`, then destroy.
   - `CONNECTION_LOSS_AFTER_COMMIT`: commit, then `reply.raw.socket.destroy()` without a response.
   - `MALFORMED_SUCCESS`: commit; 200 with the stored success body minus `providerOperationId` (and `providerAuthorizationId` for authorize).
   A replayed request (existing `sim.requests` row) is also subject to the selected fault; the stored decision is unchanged.
3. Selection order per write: (a) `sim.fault_overrides` row for the key with `remaining > 0` → use it and decrement — applies to every request regardless of mode, so directed faults work for both adapters; (b) else if the request carries header `Sim-Fault-Mode: seeded` → weighted draw from `SIMULATOR_FAULT_WEIGHTS` (JSON object fault→non-negative integer; default `{"NONE":100}`) using `mulberry32(seedFor(SIMULATOR_SEED, key, ordinal))()`; (c) else `NONE`.
4. Record the selected fault and whether the effect committed in `sim.request_log`.
5. Startup rejects `SIMULATOR_FAULT_WEIGHTS` with unknown names, negative values, or zero total.

**Expected behavior** — With seed `"p06"` and weights `{"NONE":1,"TIMEOUT_AFTER_COMMIT":1}`, the fault sequence for a given key is identical across two simulator processes. With override `TIMEOUT_AFTER_COMMIT` for key K, the client times out while `sim.effects` holds exactly one row for K.

**Acceptance criteria**
- [ ] Same seed + key + ordinal → same fault in two separately started servers.
- [ ] Each "after commit" fault leaves exactly one effect row; each "before commit"/not-executed fault leaves zero.
- [ ] Without `Sim-Fault-Mode: seeded` and without an override, no fault ever fires.

**Testing requirements** — `apps/provider-simulator/src/faults.test.ts`: mulberry32 golden vector (first 5 outputs for seed 1 checked into the test); weighted-draw distribution over 10,000 draws within ±2% of weights; config validation negatives. `test/integration/provider-simulator/faults.test.ts`: one case per fault asserting HTTP observation and `sim.effects` count; cross-process determinism (two servers, same seed). Command: `pnpm vitest run --project unit apps/provider-simulator/src/faults.test.ts && pnpm vitest run --project integration test/integration/provider-simulator/faults.test.ts`.

**Non-goals** — Client-side pre-send faults (P06-T08); webhook faults (P06-T07).

**Handoff checklist**
- [ ] Golden vector committed.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-T07 — Simulator signed webhook emitter

**Task ID:** `P06-T07`
**Feature:** Duplicate, delayed, out-of-order, and contradictory webhooks
**Commit:** `feat(providers): emit signed simulator webhooks with seeded delivery faults`
**Priority:** High
**Dependencies:** `P06-T06`
**Estimated complexity:** M
**Contract references:** docs/06 §Deterministic fake provider ("stable event ID and verifiable signature"), §Unreliable provider (duplicate, delayed/out-of-order, contradictory), §Provider webhook contract; CONVENTIONS §16.
**Files:** create: `apps/provider-simulator/src/webhooks.ts`, `apps/provider-simulator/src/webhooks.test.ts`, `test/integration/provider-simulator/webhooks.test.ts`; modify: `apps/provider-simulator/src/server.ts`, `apps/provider-simulator/src/pg-store.ts`; must not touch: `apps/provider-webhook-receiver/**`.

**Objective** — Give P09 a provider that pushes realistic webhooks, and give P06 conformance a signature format to verify.

**Implementation instructions**
1. Every committed decision (SUCCEEDED/DECLINED/NOT_APPLIED) inserts one `sim.webhook_events` row in the same transaction. Body (compact JSON, stored as exact bytes in `raw_body`): `{ eventId, type, account, operationType, providerPaymentId, providerOperationId, providerAuthorizationId, providerCaptureId, amountMinor, currency, code, occurredAt }`, `type` ∈ `operation.succeeded|operation.declined|operation.not_applied|authorization.expired`. `eventId = 'evt_' + base32(sha256('evt|'+account+'|'+key+'|'+type)).slice(0,26)` (stable across replays). A lazy expiry inserts one `authorization.expired` event.
2. Signature: header `Sim-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(SIMULATOR_WEBHOOK_SECRET, `${t}.${rawBody}`)>`, header `Sim-Event-Id: <eventId>`. Export `signWebhook(secret, t, rawBody)` for tests.
3. Delivery faults (only in seeded mode for the originating request, or by override key `webhook:<eventId>`), drawn with the same PRNG using ordinal `-1`: `DUPLICATE` (deliver twice, same bytes and event id), `DELAY` (`deliver_at += 1..30 s` on the simulator clock), `OUT_OF_ORDER` (deliver after the next event for the same `provider_payment_id`), `CONTRADICTORY` (additionally emit a second event with a new event id whose `type` contradicts the committed decision, e.g. `operation.declined` for a succeeded capture). Default weights for webhook faults come from keys `WEBHOOK_DUPLICATE`, `WEBHOOK_DELAY`, `WEBHOOK_OUT_OF_ORDER`, `WEBHOOK_CONTRADICTORY` in `SIMULATOR_FAULT_WEIGHTS` (absent = 0).
4. Dispatcher loop (every 200 ms, only when `SIMULATOR_WEBHOOK_URL` is set): claim due rows `FOR UPDATE SKIP LOCKED LIMIT 50`, POST raw bytes with `content-type: application/json`, mark `delivered_at` on 2xx, otherwise `attempts += 1` and `deliver_at = now + min(2^attempts, 60) s`, stop after 10 attempts. No redirect following.

**Expected behavior** — A succeeded authorization with URL set produces one POST whose signature verifies with `signWebhook`; with override `DUPLICATE` the receiver sees two identical bodies.

**Acceptance criteria**
- [ ] Event id stable across a replayed request.
- [ ] Signature golden vector (fixed secret, t, body) committed.
- [ ] Each delivery fault observable at a local test HTTP receiver.

**Testing requirements** — `apps/provider-simulator/src/webhooks.test.ts`: signature golden vector; event-id determinism. `test/integration/provider-simulator/webhooks.test.ts`: local `node:http` receiver; normal delivery; duplicate; delay with clock advance; out-of-order; contradictory; retry on 500 then success. Command: `pnpm vitest run --project integration test/integration/provider-simulator/webhooks.test.ts`.

**Non-goals** — Receiving/processing webhooks in FlowLedger (P09).

**Handoff checklist**
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-T08 — Adapters: write path and result classification

**Task ID:** `P06-T08`
**Feature:** Fake and unreliable adapters (HTTP clients)
**Commit:** `feat(providers): add fake and unreliable adapters with outcome classification`
**Priority:** Critical
**Dependencies:** `P06-T01`, `P06-T06`
**Estimated complexity:** L
**Contract references:** docs/06 §Normalized write results, §Error taxonomy (observation table), §Stable provider idempotency, §Timeout and ambiguous-result policy (reason vocabulary), §Redaction and retained evidence, §Capability model ("reject … before transmitting"); docs/08 §Retry classification.
**Files:** create: `packages/providers/src/simulator-client.ts`, `packages/providers/src/classify.ts`, `packages/providers/src/fake-adapter.ts`, `packages/providers/src/unreliable-adapter.ts`, `packages/providers/src/classify.test.ts`, `packages/providers/src/adapters.write.test.ts`; modify: `packages/providers/src/index.ts`; must not touch: `apps/**`.

**Objective** — Convert every simulator observation into exactly one contracted normalized outcome, with ambiguity whenever a request may have been transmitted and no proof of no-effect exists.

**Implementation instructions**
1. `simulator-client.ts`: `postWrite(path, body, idempotencyKey, signal, extraHeaders)` using global `fetch` with `signal = AbortSignal.any([callerSignal, AbortSignal.timeout(requestTimeoutMs)])`, `redirect: 'error'`. Returns a discriminated observation: `{ kind: 'RESPONSE', status, headers, bodyText }` | `{ kind: 'PRE_SEND_ERROR', code }` (cause code `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) | `{ kind: 'TIMEOUT' }` (timeout abort) | `{ kind: 'CONNECTION_LOST', code }` (any other transport error) | `{ kind: 'CALLER_ABORT' }` (caller signal — rethrown as shutdown cancellation, the only permitted throw besides programmer errors).
2. `classify.ts` exports `classifyWrite(type, obs, now, caps): ProviderOutcome` and `reconciliationReasonFor(outcome)`. Mapping (normalized `code` values are bounded constants):

   | Observation | Outcome | category / code / directive / proof |
   | --- | --- | --- |
   | 200 + valid body with `providerPaymentId`, `providerOperationId`, `amountMinor`, `currency` (+ `providerAuthorizationId` for AUTHORIZE) | `SUCCEEDED` | ids, `amount`, `authorizationExpiresAt` only for AUTHORIZE, `providerCaptureId` only for CAPTURE |
   | 200 but JSON invalid or a required identity missing | `UNKNOWN` | `MALFORMED_RESPONSE` / `MALFORMED_PROVIDER_RESPONSE` (missing `providerOperationId` only → `MISSING_PROVIDER_CORRELATION`) / `RECONCILE_FIRST` |
   | 402 `declined` | `REJECTED` | `BUSINESS_DECLINE` / `PROVIDER_DECLINED` / `DO_NOT_RETRY` |
   | 422 or 400 `not_applied` | `FAILED` | `INVALID_REQUEST` / `PROVIDER_NOT_APPLIED` / `DO_NOT_RETRY` / `AUTHENTICATED_PROVIDER_REJECTION { providerCode: body.code }` |
   | 401 | `FAILED` | `AUTHENTICATION` / `PROVIDER_AUTHENTICATION_FAILED` / `DO_NOT_RETRY` / `AUTHENTICATED_PROVIDER_REJECTION { providerCode: 'unauthenticated' }` |
   | 409 `idempotency_conflict` | `UNKNOWN` | `CONFLICT` / `PROVIDER_IDEMPOTENCY_CONFLICT` / `RECONCILE_FIRST` (docs/06: discrepancy + operator review; see R-06-05) |
   | 429 with `Sim-Not-Executed: true` | `RETRYABLE_NO_EFFECT` | `RATE_LIMITED` / `PROVIDER_RATE_LIMITED` / `RETRY_SAME_OPERATION` / `AUTHENTICATED_PROVIDER_REJECTION { providerCode: 'rate_limited' }`; `retryAfterMs = body.retryAfterMs`; `retryNotBefore = now + min(retryAfterMs, 60000)` |
   | 503 with `Sim-Not-Executed: true` | `RETRYABLE_NO_EFFECT` | `PROVIDER_UNAVAILABLE` / `PROVIDER_UNAVAILABLE_NOT_EXECUTED` / `RETRY_SAME_OPERATION` / `AUTHENTICATED_PROVIDER_REJECTION { providerCode: 'unavailable' }`; `retryNotBefore = now + 2000` |
   | 5xx without the header | `UNKNOWN` | `PROVIDER_UNAVAILABLE` / `PROVIDER_5XX_AMBIGUOUS` / `RECONCILE_FIRST` |
   | `PRE_SEND_ERROR` | `RETRYABLE_NO_EFFECT` | `TRANSPORT_PRE_SEND` / `TRANSPORT_PRE_SEND` / `RETRY_SAME_OPERATION` / `LOCAL_REJECTION_BEFORE_TRANSMISSION`; `retryNotBefore = now + 2000` |
   | `TIMEOUT` | `UNKNOWN` | `TRANSPORT_AMBIGUOUS` / `TIMEOUT_AFTER_SEND` / `RECONCILE_FIRST` |
   | `CONNECTION_LOST` | `UNKNOWN` | `TRANSPORT_AMBIGUOUS` / `CONNECTION_LOST_AFTER_SEND` / `RECONCILE_FIRST` |
   | Any other status, or an exception thrown after the request may have been sent | `UNKNOWN` | `ADAPTER_DEFECT` / `ADAPTER_DEFECT` (or `SDK_EXCEPTION_AFTER_SEND` for exceptions from `fetch` itself) / `RECONCILE_FIRST` |

   Every `UNKNOWN` carries `lookupHint = { providerPaymentId, providerOperationId, mayReplaySameKey: caps.writeIdempotency[type] === 'SAME_KEY_REPLAY', lookupNotBefore: now + 5 s }` and passes through any ids the body contained. `reconciliationReasonFor` returns `outcome.error.code` when it is one of the nine docs/06 reasons (`TIMEOUT_AFTER_SEND`, `CONNECTION_LOST_AFTER_SEND`, `PROVIDER_5XX_AMBIGUOUS`, `SDK_EXCEPTION_AFTER_SEND`, `MALFORMED_PROVIDER_RESPONSE`, `MISSING_PROVIDER_CORRELATION`, `WORKER_CRASH_AFTER_SEND`, `STALE_PROCESSING`, `ADAPTER_DEFECT`) and `ADAPTER_DEFECT` for `PROVIDER_IDEMPOTENCY_CONFLICT`. `safeMessage` is a fixed English sentence per code; raw provider text never crosses the boundary.
3. Adapter methods `authorize/capture/cancel/refund(command, signal)`:
   - If `command.operationType` is not in `capabilities.supportedOperations`, or the method does not match `operationType`, or `paymentMethodReference` is non-null for a non-AUTHORIZE / null for AUTHORIZE: return `FAILED` / `UNSUPPORTED_OPERATION` (or `INVALID_REQUEST`) / `LOCAL_REJECTION_BEFORE_TRANSMISSION` without any network call.
   - If `command.idempotencyKey.length > capabilities.writeIdempotency.maxKeyLength`: return `FAILED`/`INVALID_REQUEST`/`LOCAL_REJECTION_BEFORE_TRANSMISSION` (the worker never alters the key).
   - Credential: `Authorization: Bearer ${utf8(await resolveCredential(command.providerAccountId))}`; a resolver failure before sending → `RETRYABLE_NO_EFFECT`/`AUTHENTICATION`/`PROVIDER_CREDENTIAL_UNAVAILABLE`/`LOCAL_REJECTION_BEFORE_TRANSMISSION`, `retryNotBefore = now + 60 s` (nothing transmitted). The key is never logged, placed in an error, or returned.
   - Body: `{ account: providerAccountId, idempotencyKey, operationId, paymentRef: paymentId, amountMinor: amount.amountMinor, currency, providerPaymentId, providerAuthorizationId, paymentMethodToken: paymentMethodReference }` (`operationId`/`paymentId`/`operationType` come verbatim from `ProviderOperationCommand`; they are provider-side metadata recorded in ground truth); header `Idempotency-Key`. Amounts stay decimal strings; parse with `parseAmountMinor` (no `Number`).
   - Attach `evidence = { source: 'API_RESPONSE', providerObservedAt: body.observedAt ?? null, receivedAt: now().toISOString(), providerEventId: null, redactedEvidenceRef: 'sim-req:' + (X-Request-Id ?? 'none') }`.
4. `UnreliableProviderAdapter` = same client plus header `Sim-Fault-Mode: seeded`, `UNRELIABLE_PROVIDER_CAPABILITIES`, and a client-side pre-send fault: when `mulberry32(seedFor(faultSeed, key, 0))() < 0.05` and this adapter instance has not yet failed this key, return `RETRYABLE_NO_EFFECT`/`TRANSPORT_PRE_SEND` without sending (in-memory set of failed keys; `ponytail:` comment — per-process determinism only, persistent client state would be needed for cross-process determinism).
5. Neither adapter ever logs; the worker logs normalized fields only.

**Expected behavior** — Directed fault `TIMEOUT_AFTER_COMMIT` with `requestTimeoutMs: 300` → `UNKNOWN`/`TIMEOUT_AFTER_SEND` while truth shows one effect.

**Acceptance criteria**
- [ ] Every table row has a unit test (stubbed `fetch` returning `Response` objects / rejecting with coded errors).
- [ ] No code path returns `FAILED` without `noEffectProof` or `RETRYABLE_NO_EFFECT` without proof, `RETRY_SAME_OPERATION`, and `retryNotBefore` in `(now, now + 1 h]` (property test over random observations).
- [ ] Capability mismatch performs zero `fetch` calls.
- [ ] Serialized results contain no API key, no token, no response body text.

**Testing requirements** — `packages/providers/src/classify.test.ts`: one case per row; fast-check property over arbitrary `{status, headers, bodyText}` asserting the proof/directive invariants and that any non-2xx/4xx-declared status yields `UNKNOWN`. `packages/providers/src/adapters.write.test.ts`: capability guard (fetch spy called 0 times), key-length guard, body shape, evidence attachment, unreliable pre-send fault determinism for a fixed seed, redaction (`JSON.stringify(result)` scanned for the token and key). Command: `pnpm vitest run --project unit packages/providers/src`.

**Non-goals** — Lookup and webhook verification (T09).

**Handoff checklist**
- [ ] Classification table reproduced in a header comment of `classify.ts`.
- [ ] `pnpm check` green.

---

### P06-T09 — Adapters: lookup, authorization status, webhook verification

**Task ID:** `P06-T09`
**Feature:** Read-only provider evidence and signed notifications
**Commit:** `feat(providers): add adapter lookup, authorization status, and webhook verification`
**Priority:** High
**Dependencies:** `P06-T08`, `P06-T07`
**Estimated complexity:** M
**Contract references:** docs/06 §Reconciliation lookup and evidence (NOT_FOUND conclusive rule, exact normalized shapes), §Authorization-expiry lookup, §Provider webhook contract (verification, replay tolerance), §Normalized write results (outer evidence only once).
**Files:** create: `packages/providers/src/adapters.read.test.ts`; modify: `packages/providers/src/simulator-client.ts`, `packages/providers/src/fake-adapter.ts`, `packages/providers/src/unreliable-adapter.ts`; must not touch: `apps/**`.

**Objective** — Provide the read-only evidence paths P08 reconciles with and the verification P09 ingests with, so the conformance suite can cover them now.

**Implementation instructions**
1. `lookup(query, signal)`: GET in docs/06 order — by `providerOperationId` if non-null, else by `providerPaymentId` + `operationType` if non-null, else by key. Found decision → `{ outcome: 'FOUND', result: <ProviderTerminalOutcome from classifyWrite of the stored status/body>, evidence: { source: 'RECONCILIATION', providerObservedAt, receivedAt, providerEventId: null, redactedEvidenceRef } }`. Not found → `absenceIsConclusive = (lastRequestAt === null || checkedAt - lastRequestAt >= absenceConclusiveAfterSeconds)`; conclusive → `{ outcome:'NOT_FOUND', absenceIsConclusive:true, checkedAt, nextCheckNotBefore:null, evidence }`; else `nextCheckNotBefore = lastRequestAt + window`. Transport failures/5xx/timeouts → `{ outcome:'INCONCLUSIVE', error: {category, code, retryDirective:'RECONCILE_FIRST', retryAfterMs, safeMessage}, evidence }`. Lookup never sends a write.
2. `lookupAuthorizationStatus(query, signal)`: `ACTIVE` → `{ outcome:'ACTIVE', providerPaymentId, providerAuthorizationId, authorizationExpiresAt, nextCheckNotBefore: min(expiresAt, now + 24 h), evidence }`; `EXPIRED` → `{ outcome:'EXPIRED', …, expiredAt }`; `NOT_FOUND`/transport failure → `INCONCLUSIVE` (absence is never expiry).
3. `verifyWebhook(request)`: parse `Sim-Signature`; reject (throw `WebhookVerificationError` with a bounded `reason` of `MISSING_SIGNATURE|BAD_SIGNATURE|TIMESTAMP_OUT_OF_TOLERANCE|MALFORMED_BODY`) unless some secret from `resolveWebhookSecrets(webhookEndpointId)` produces an equal HMAC under `timingSafeEqual` and `|receivedAt - t| <= replayToleranceSeconds`. Verification happens on `rawBody` before JSON parsing. Success maps to `VerifiedProviderWebhook`: `providerAccountReference = body.account`, `notificationType` (`authorization.expired` → `AUTHORIZATION_EXPIRED`; `operation.*` → `OPERATION_RESULT`), `normalizedResult` (succeeded → SUCCEEDED; declined → REJECTED; not_applied → FAILED with `AUTHENTICATED_PROVIDER_REJECTION`), `evidence.source='PROVIDER_WEBHOOK'`, `providerEventId = body.eventId`. Throwing is the only representation of an invalid signature because `VerifiedProviderWebhook` has no invalid variant (R-06-06).

**Expected behavior** — Lookup for a key never received, checked immediately → conclusive `NOT_FOUND`; for a key whose request timed out before commit 10 s ago → inconclusive with `nextCheckNotBefore = lastRequestAt + 60 s`; after `advanceClock(61000)` → conclusive.

**Acceptance criteria**
- [ ] Lookup issues only GET requests (fetch spy asserts method).
- [ ] Absence-window boundary (exactly 60 s) is conclusive; 59.999 s is not.
- [ ] Tampered body, wrong secret, stale timestamp each throw with the right `reason`; rotated secret (second entry) verifies.

**Testing requirements** — `packages/providers/src/adapters.read.test.ts` (stubbed fetch + `signWebhook` from the simulator package imported only in the test): every branch above, including window boundary, `INCONCLUSIVE` on 500, authorization `NOT_FOUND` → `INCONCLUSIVE`. Command: `pnpm vitest run --project unit packages/providers/src/adapters.read.test.ts`.

**Non-goals** — Persisting webhooks or lookups (P08/P09).

**Handoff checklist**
- [ ] `pnpm check` green.

---

### P06-T10 — Shared adapter conformance suite

**Task ID:** `P06-T10`
**Feature:** Adapter conformance (both adapters, one suite)
**Commit:** `test(providers): add shared adapter conformance suite`
**Priority:** Critical
**Dependencies:** `P06-T09`
**Estimated complexity:** L
**Contract references:** docs/06 §Required contract tests (Capability and binding, Idempotency and attempts [adapter-level rows], Result classification, Webhooks and reconciliation [adapter-level rows], Redaction, Capability semantics); docs/09 §Provider contract tests; docs/10 M6 test bullets 1, 3, 4, 5.
**Files:** create: `packages/providers/src/conformance/suite.ts`, `packages/providers/src/conformance/harness.ts`, `test/integration/providers/conformance.test.ts`; must not touch: adapter source files (failures found here are fixed in a follow-up commit referencing this task).

**Objective** — Prove two independent adapters satisfy the same contract, which is the evidence the abstraction is real (ADR-0011).

**Implementation instructions**
1. `harness.ts`: `type ConformanceHarness = { name: string; adapter: PaymentProvider; truth: { effectsForKey(key: string): Promise<number>; requestsForKey(key: string): Promise<number>; effectsForPayment(paymentRef: string, type: OperationType): Promise<number> }; control: { advanceClock(ms: number): Promise<void>; forceOutcome(providerPaymentId: string, type: OperationType, outcome: 'DECLINED'|'NOT_APPLIED', code: string): Promise<void>; setFault(key: string, fault: string, remaining?: number): Promise<void> }; signWebhook(rawBody: Uint8Array, t: number): Record<string,string>; command(type: OperationType, o?: Partial<ProviderOperationCommand>): ProviderOperationCommand }`.
2. `suite.ts`: `export function defineProviderConformanceSuite(makeHarness: () => Promise<ConformanceHarness>): void` registering `describe`/`it` from `vitest`. Cases (each names the docs/06 bullet it proves):
   - Capability: startup validation accepts the adapter's capabilities; unsupported operation → `FAILED` with zero simulator requests (`requestsForKey === 0`).
   - Idempotency: 100 concurrent identical same-key authorizations → one effect and 100 deep-equal results; same key with changed amount, currency, operation type, payment reference → `UNKNOWN` with category `CONFLICT`; the key in every request equals `command.idempotencyKey` (assert via `sim.request_log`).
   - Classification: decline → `REJECTED`; not applied → `FAILED` with proof; directed `RATE_LIMITED` → `RETRYABLE_NO_EFFECT` with proof, directive, bounded future `retryNotBefore`, zero effects; `TIMEOUT_AFTER_COMMIT` → `UNKNOWN`/`TIMEOUT_AFTER_SEND` with one effect in truth; `CONNECTION_LOSS_AFTER_COMMIT` → `UNKNOWN`/`CONNECTION_LOST_AFTER_SEND`; `MALFORMED_SUCCESS` → `UNKNOWN`; `PROVIDER_5XX_AFTER_COMMIT` → `UNKNOWN`/`PROVIDER_5XX_AMBIGUOUS`; `resolveCredential` returning a wrong key → `FAILED`/`AUTHENTICATION`; simulator stopped (pre-send) → `RETRYABLE_NO_EFFECT`/`TRANSPORT_PRE_SEND`.
   - Capability semantics: authorize → full capture; authorize → partial capture (remainder released: second capture `FAILED`); authorize → cancel; capture → three partial refunds summing to captured, fourth `FAILED`; declared `SAME_KEY_REPLAY`: repeating an identical same-key write after success returns the original effect (effects stay 1) and the request carried the identical key. Metadata: every effect row records the command's `paymentId` and `operationType` (`effectsForPayment(cmd.paymentId, type)` equals 1 after a success).
   - Lookup: by provider operation id, by payment+type, by key; `NOT_FOUND` inconclusive inside window, conclusive after `advanceClock`.
   - Authorization status: `ACTIVE` before expiry, `EXPIRED` after `advanceClock(7 d)`, unknown id → `INCONCLUSIVE`.
   - Webhooks: valid signature verifies; tampered body throws; stale timestamp throws.
   - Redaction: `JSON.stringify` of every result in the suite contains no prohibited-data fixture, no `pm_fake_` token, no API key.
3. `test/integration/providers/conformance.test.ts` calls `defineProviderConformanceSuite` twice — `FakeProviderAdapter` and `UnreliableProviderAdapter` — against `startSimulator()` (`resolveCredential` returns the simulator's API key bytes) with `requestTimeoutMs: 300` and `SIMULATOR_HOLD_MS=2000`, unreliable seeded weights `{"NONE":100}` so only directed faults fire (random-fault behavior is covered in P06-T06 and P06-GATE).

**Expected behavior** — 2 × N cases green; deleting the 409 branch in `classify.ts` makes the conflict case fail for both adapters.

**Acceptance criteria**
- [ ] Every case runs for both adapters; no adapter-conditional `skip`.
- [ ] Each docs/06 adapter-level conformance bullet is referenced by at least one case title.

**Testing requirements** — The file above. Command: `pnpm vitest run --project integration test/integration/providers/conformance.test.ts`.

**Non-goals** — Worker-level bullets (live lease, stale lease, notBefore) — covered in P06-T14..T18 and P08.

**Handoff checklist**
- [ ] Mutation spot-checks recorded in the commit body (three deliberate breaks, all caught).
- [ ] `pnpm test:integration` green.

---

### P06-T11 — Migration: provider attempts and provider evidence

**Task ID:** `P06-T11`
**Feature:** Provider execution persistence
**Commit:** `feat(db): add provider attempts and append-only provider evidence`
**Priority:** Critical
**Dependencies:** `P06-T02`
**Estimated complexity:** L
**Contract references:** docs/07 §`providers.provider_attempts`, §`providers.provider_evidence`, §`payments.payment_operations` (resolution evidence FK bullet), §Migration order step 12, §Mutability rules, §Tenant isolation; docs/06 §Provider attempts and leases.
**Files:** create: `migrations/0610_provider_attempts_and_evidence.sql`, `test/integration/db/provider-attempts.test.ts`, `test/integration/db/provider-evidence.test.ts`; must not touch: earlier migrations.

**Objective** — Create the attempt and evidence tables with every docs/07 constraint so that no runtime code can forge an attempt, reuse another tenant's evidence, or apply evidence without proof.

**Implementation instructions** (order inside the file: tables → constraints/indexes → triggers → RLS → grants)
1. `providers.provider_attempts` exactly per docs/07 columns: `id text COLLATE "C" PRIMARY KEY CHECK (id ~ '^pat_[0-7][0-9A-HJKMNP-TV-Z]{25}$')`, `merchant_id`, `operation_id`, `provider_account_id`, `credential_version integer NOT NULL`, `attempt_number integer NOT NULL CHECK (attempt_number >= 1)`, `provider_idempotency_key text COLLATE "C" NOT NULL`, `state text NOT NULL CHECK (state IN ('RESERVED','DISPATCH_MARKED','RESPONSE_RECEIVED','COMPLETED','ABANDONED'))`, `worker_id text NOT NULL CHECK (char_length(worker_id) BETWEEN 1 AND 128)`, `lease_token uuid NOT NULL`, `lease_expires_at timestamptz NOT NULL`, `outcome_class text CHECK (outcome_class IN ('SUCCESS','REJECTED','NO_EFFECT_FAILURE','RETRYABLE_NO_EFFECT','AMBIGUOUS'))`, `http_status integer`, `provider_request_id text`, `provider_operation_id text`, `request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32)`, `response_hash bytea CHECK (response_hash IS NULL OR octet_length(response_hash)=32)`, `normalized_response jsonb CHECK (normalized_response IS NULL OR jsonb_typeof(normalized_response)='object')`, `archived_response_reference text`, `error_class text`, `reserved_at timestamptz NOT NULL`, `dispatch_marked_at`, `response_received_at`, `completed_at timestamptz`.
   Constraints: `UNIQUE (operation_id, attempt_number)`; FK `(merchant_id, operation_id, provider_account_id, provider_idempotency_key) REFERENCES payments.payment_operations (merchant_id, id, provider_account_id, provider_idempotency_key)`; FK `(provider_account_id, credential_version) REFERENCES providers.provider_account_credentials (provider_account_id, version)`; `CHECK (state <> 'COMPLETED' OR (outcome_class IS NOT NULL AND completed_at IS NOT NULL))`; `CHECK (state NOT IN ('RESPONSE_RECEIVED','COMPLETED') OR response_received_at IS NOT NULL OR state = 'COMPLETED')`; `CHECK (state <> 'RESPONSE_RECEIVED' OR response_received_at IS NOT NULL)`; `CHECK (state <> 'DISPATCH_MARKED' OR dispatch_marked_at IS NOT NULL)`; `CHECK (state <> 'ABANDONED' OR dispatch_marked_at IS NULL)`. Indexes `(operation_id, reserved_at)`, `(state, lease_expires_at) WHERE state IN ('RESERVED','DISPATCH_MARKED','RESPONSE_RECEIVED')`, `(provider_account_id, credential_version)`.
2. Trigger `provider_attempts_forward_only` (BEFORE UPDATE): allowed state edges `RESERVED→DISPATCH_MARKED`, `RESERVED→RESPONSE_RECEIVED` (local pre-send rejection only), `RESERVED→ABANDONED`, `DISPATCH_MARKED→RESPONSE_RECEIVED`, `DISPATCH_MARKED→COMPLETED`, `RESPONSE_RECEIVED→COMPLETED`, plus same-state updates of nothing; `dispatch_marked_at`, identity, key, `request_hash`, `reserved_at` immutable once set; `COMPLETED`/`ABANDONED` rows immutable except `archived_response_reference` (set once) with `normalized_response` cleared only when `archived_response_reference` is set. BEFORE DELETE/TRUNCATE triggers raise.
3. `providers.provider_evidence` exactly per docs/07 columns (id check `^pev_[0-7][0-9A-HJKMNP-TV-Z]{25}$`). Constraints:
   - `UNIQUE (provider_account_id, source, source_reference)`; `UNIQUE (merchant_id, operation_id, id)`.
   - FK `(merchant_id, operation_id) REFERENCES payments.payment_operations (merchant_id, id)`; FK `(merchant_id, provider_account_id) REFERENCES providers.provider_accounts (merchant_id, id)`; `provider_attempt_id REFERENCES providers.provider_attempts(id) DEFERRABLE INITIALLY DEFERRED`; `provider_notification_id` FK is added by `0620` after notifications exist; `reconciliation_case_id` FK is deferred until cases exist (P08-T02, R-06-04).
   - Source shape `CHECK`: `(source='API_RESPONSE' AND provider_attempt_id IS NOT NULL AND provider_notification_id IS NULL AND reconciliation_case_id IS NULL AND reconciliation_attempt_number IS NULL AND source_reference = provider_attempt_id) OR (source='PROVIDER_WEBHOOK' AND provider_notification_id IS NOT NULL AND provider_attempt_id IS NULL AND reconciliation_case_id IS NULL AND reconciliation_attempt_number IS NULL AND source_reference = provider_notification_id) OR (source='RECONCILIATION' AND reconciliation_case_id IS NOT NULL AND reconciliation_attempt_number >= 1 AND provider_attempt_id IS NULL AND provider_notification_id IS NULL AND source_reference = reconciliation_case_id || ':' || reconciliation_attempt_number)`.
   - `observed_outcome` CHECK in the 8 docs/07 values; amount/currency both null or both non-null, amount `BETWEEN 1 AND 1000000000000`, currency `'USD'`.
   - Proof: `(observed_outcome IN ('FAILED','RETRYABLE_NO_EFFECT')) = (no_effect_proof_kind IS NOT NULL)`; `no_effect_proof_kind IN ('LOCAL_REJECTION_BEFORE_TRANSMISSION','AUTHENTICATED_PROVIDER_REJECTION','CONCLUSIVE_PROVIDER_LOOKUP_ABSENCE')`; `no_effect_proof_detail` null or object and null iff kind null.
   - Error fields: `(observed_outcome IN ('REJECTED','FAILED','RETRYABLE_NO_EFFECT','UNKNOWN','AUTHORIZATION_INCONCLUSIVE')) = (normalized_error_category IS NOT NULL AND normalized_error_code IS NOT NULL AND retry_directive IS NOT NULL)`; category in the 13 docs/06 values; `retry_directive IN ('DO_NOT_RETRY','RETRY_SAME_OPERATION','RECONCILE_FIRST')`; `normalized_retry_after_ms IS NULL OR (normalized_retry_after_ms >= 0 AND normalized_error_code IS NOT NULL)`.
   - Retry: `(observed_outcome='RETRYABLE_NO_EFFECT') = (retry_not_before IS NOT NULL)`; `observed_outcome <> 'RETRYABLE_NO_EFFECT' OR retry_directive = 'RETRY_SAME_OPERATION'`; `retry_not_before IS NULL OR retry_not_before <= received_at + interval '1 hour'`.
   - `observed_outcome <> 'SUCCEEDED' OR (provider_operation_id IS NOT NULL AND observed_amount_minor IS NOT NULL)`.
   - `next_check_not_before`: required for `AUTHORIZATION_ACTIVE`, `AUTHORIZATION_INCONCLUSIVE`, `UNKNOWN`; null for `SUCCEEDED`,`REJECTED`,`FAILED`,`RETRYABLE_NO_EFFECT`,`AUTHORIZATION_EXPIRED`; when set, `> received_at` and `<= received_at + interval '7 days'`.
   - `AUTHORIZATION_*` outcomes require `source='RECONCILIATION'`, except `AUTHORIZATION_EXPIRED` also allows `PROVIDER_WEBHOOK`; `ACTIVE`/`EXPIRED` require provider payment and authorization ids.
   - Raw quarantine creation fields all null or all non-null; `raw_quarantine_delete_at <= received_at + interval '90 days'`; deletion fields both null or both non-null, result in `('DELETED','ALREADY_ABSENT')`.
   - Application shape: `(applied_at IS NULL) = (application_kind IS NULL)`; `application_kind IN (...)` six values; `OPERATION_TRANSITION` → both versions non-null; `OPERATION_RETRY` → op version only; `AUTHORIZATION_EXPIRY`,`DISCREPANCY` → payment version only; `CORROBORATION`,`CASE_OBSERVATION` → neither.
   - `evidence_hash` 32 bytes. Indexes `(operation_id, received_at, id)`, `(received_at, id) WHERE applied_at IS NULL`, `(provider_attempt_id)`, `(provider_notification_id)`, `(reconciliation_case_id)`.
4. Constraint trigger `provider_evidence_subject_check` (AFTER INSERT, DEFERRABLE INITIALLY DEFERRED): for `API_RESPONSE`, the attempt's `operation_id`/`provider_account_id`/`merchant_id` equal the evidence row's; when the subject operation type is `AUTHORIZE` and outcome `SUCCEEDED`, provider payment and authorization ids are non-null; `authorization_expires_at` only when (op `AUTHORIZE` and `SUCCEEDED`) or `AUTHORIZATION_ACTIVE`; `provider_capture_id` only when op `CAPTURE` and `SUCCEEDED`; `AUTHORIZATION_*` require op type `AUTHORIZE`.
5. Trigger `provider_evidence_immutable` (BEFORE UPDATE): every fact column unchanged; application columns may go null→non-null once (all together); quarantine deletion fields null→non-null once; DELETE/TRUNCATE raise.
6. Add to `payments.payment_operations`: `ALTER TABLE … ADD CONSTRAINT payment_operations_resolution_evidence_fk FOREIGN KEY (merchant_id, id, resolution_evidence_id) REFERENCES providers.provider_evidence (merchant_id, operation_id, id) DEFERRABLE INITIALLY DEFERRED`.
7. Deferred constraint trigger `payment_operations_lease_consistency` on `payments.payment_operations` (AFTER INSERT OR UPDATE) and `providers.provider_attempts` (AFTER INSERT OR UPDATE), `DEFERRABLE INITIALLY DEFERRED`: a `PROCESSING` operation has exactly one attempt in `RESERVED|DISPATCH_MARKED|RESPONSE_RECEIVED` whose `lease_token` and `lease_expires_at` equal the operation's; a non-`PROCESSING` operation has zero such attempts and null lease fields.
8. RLS: `ENABLE ROW LEVEL SECURITY` on both tables; policy for `fl_api` and `fl_operator_readonly` per the P02 pattern (`merchant_id = current_setting('app.merchant_id', true)`); `SELECT USING (true)` policies for `fl_payment_worker`, `fl_reconciler`, `fl_webhook_worker`.
9. Grants last: `REVOKE ALL … FROM PUBLIC`; `GRANT SELECT` to the five roles above; `GRANT SELECT, INSERT, UPDATE` on both tables to `payments_function_owner` (its functions are the only writers); no runtime role gets DML.

**Expected behavior** — Direct `INSERT` into either table as `fl_payment_worker` fails `42501`; a `FAILED` evidence row without proof fails `23514`.

**Acceptance criteria**
- [ ] Every docs/07 constraint for both tables has a negative test that fails with the expected SQLSTATE and constraint name.
- [ ] Cross-tenant: evidence referencing an operation of another merchant fails the composite FK; terminal resolution referencing another operation's evidence fails the deferred FK at commit.
- [ ] Lease-consistency trigger rejects `PROCESSING` without an attempt and two live attempts.

**Testing requirements** — `test/integration/db/provider-attempts.test.ts` and `test/integration/db/provider-evidence.test.ts`, using a clearly named migration-owner fixture helper for direct inserts: each check, each FK, each forward/backward state edge, immutability (update every fact column → rejected), delete/truncate rejected, runtime-role DML denied for all CONVENTIONS §7 runtime roles, RLS (merchant A context cannot see merchant B rows via `fl_api`). Command: `pnpm vitest run --project integration test/integration/db/provider-attempts.test.ts test/integration/db/provider-evidence.test.ts`.

**Non-goals** — Functions that write these tables (T13, T14).

**Handoff checklist**
- [ ] Grants are the last statements in the file.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-T12 — Migration: provider notifications, event claims, identity conflicts

**Task ID:** `P06-T12`
**Feature:** Verified-notification persistence
**Commit:** `feat(db): add provider notification, event claim, and identity conflict tables`
**Priority:** High
**Dependencies:** `P06-T11`
**Estimated complexity:** M
**Contract references:** docs/07 §`providers.provider_notifications`, §`providers.provider_event_claims`, §`providers.provider_identity_conflicts`, §Tenant isolation item 9; docs/06 §HTTP ingestion.
**Files:** create: `migrations/0620_provider_notifications.sql`, `test/integration/db/provider-notifications.test.ts`; must not touch: earlier migrations.

**Objective** — Create the notification-side tables now (docs/10 M6 persistence bullet) so evidence's source-shape FKs are complete; P09 writes them.

**Implementation instructions**
1. `providers.provider_notifications` per docs/07 (id `^pno_…$`): `UNIQUE (webhook_endpoint_id, provider_event_id)`; FK `webhook_endpoint_id → providers.webhook_endpoints(id)`; FK `(webhook_endpoint_id, webhook_secret_version) → providers.webhook_endpoint_secret_versions (webhook_endpoint_id, version)`; `CHECK ((merchant_id IS NULL) = (provider_account_id IS NULL))`; composite FK `(merchant_id, provider_account_id) → providers.provider_accounts (merchant_id, id)`; FK `(merchant_id, matched_operation_id) → payments.payment_operations (merchant_id, id)`; `processing_status IN ('RECEIVED','MATCHED','UNMATCHED','PROCESSED','CONFLICT')`; hashes 32 bytes; `(redacted_payload IS NULL) = (redacted_payload_bytes IS NULL)`; hot payload clearable only when `archived_payload_reference` is non-null; indexes `(received_at, id) WHERE processing_status IN ('RECEIVED','UNMATCHED')`, `(provider_account_id, matched_operation_id) WHERE matched_operation_id IS NOT NULL`. Immutability trigger: identity, hashes, `observed_provider_account_reference`, `received_at`, secret/signature versions immutable; only matching/processing/archive fields change; delete/truncate raise.
2. `providers.provider_event_claims` per docs/07: `PRIMARY KEY (provider_account_id, provider_event_id)`, `UNIQUE (notification_id)`, FK `notification_id → provider_notifications(id)`; insert-only (update/delete/truncate triggers raise).
3. `providers.provider_identity_conflicts` per docs/07: identity column, `identity_kind IN ('NOTIFICATION','EVIDENCE')`, hashes 32 bytes, `UNIQUE (identity_kind, scope_id, stable_identity, conflicting_hash)`; insert-only.
4. `ALTER TABLE providers.provider_evidence ADD CONSTRAINT provider_evidence_notification_fk FOREIGN KEY (provider_notification_id) REFERENCES providers.provider_notifications(id) DEFERRABLE INITIALLY DEFERRED`; extend `provider_evidence_subject_check` (CREATE OR REPLACE the trigger function) so `PROVIDER_WEBHOOK` evidence requires `notification.matched_operation_id = operation_id` and `notification.provider_account_id = provider_account_id`.
5. RLS on all three (`provider_notifications` merchant policy matches only non-null `merchant_id`); grants last: `SELECT` to `fl_webhook_worker`, `fl_reconciler`, `fl_payment_worker`, `fl_operator_readonly`; `SELECT, INSERT, UPDATE` to `payments_function_owner`; no runtime DML.

**Expected behavior** — Duplicate `(endpoint, event)` insert fails `23505`; merchant set without account fails `23514`.

**Acceptance criteria**
- [ ] Every listed constraint has a negative test; insert-only tables reject update/delete/truncate for every role.
- [ ] Webhook evidence pointing at a notification matched to a different operation fails at commit.

**Testing requirements** — `test/integration/db/provider-notifications.test.ts` (migration-owner fixtures for inserts). Command: `pnpm vitest run --project integration test/integration/db/provider-notifications.test.ts`.

**Non-goals** — Receiver/processor functions (P09).

**Handoff checklist**
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-T13 — Migration: claim, dispatch mark, deferral, and evidence staging functions

**Task ID:** `P06-T13`
**Feature:** Operation claim, lease, pre-call dispatch marker
**Commit:** `feat(db): add protected claim, dispatch, defer, and evidence staging functions`
**Priority:** Critical
**Dependencies:** `P06-T12`
**Estimated complexity:** L
**Contract references:** docs/07 §Protected payment transition functions (`claim_operation`, `mark_dispatch`, `defer_operation`), §`provider_attempts`, §`provider_evidence` (identity boundary, claim/read/compare), §Transaction and lock ownership ("Claim provider execution"), §`payment_operations` (operation version rules); docs/06 §Provider attempts and leases (worker claim rules 1–8); docs/03 §Aggregate and operation version rules; docs/05 §Request and correlation identifiers (line 499).
**Files:** create: `migrations/0630_execution_functions.sql`, `test/integration/db/execution-functions.test.ts`; must not touch: earlier migrations.

**Objective** — Install the only write paths for claiming work, fencing dispatch, deferring before dispatch, and durably staging a provider observation.

**Implementation instructions** (all functions: `LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, payments, providers, messaging, api, public`, owner `payments_function_owner`, no dynamic SQL; each first checks `session_user IN ('fl_payment_worker')` else `RAISE … MESSAGE='FORBIDDEN_ROLE'`; P08/P09 widen the list by `CREATE OR REPLACE`)
1. Helper `payments._operation_correlation_id(p_operation_id text) RETURNS text` (`STABLE`, not granted to runtime roles): `SELECT correlation_id FROM api.idempotency_records WHERE resource_type='PAYMENT_OPERATION' AND resource_id = p_operation_id` (exactly one row; raise `CORRELATION_NOT_FOUND` otherwise). Add `CREATE INDEX idempotency_records_resource ON api.idempotency_records (resource_id) WHERE resource_type = 'PAYMENT_OPERATION'`.
2. Helper `payments._execute_command_envelope(p_operation_id text, p_causation_id text) RETURNS jsonb` builds a complete `payment.operation.execute.v1` envelope: `id = gen_random_uuid()`, `kind 'COMMAND'`, `schemaVersion 1`, `source 'flowledger.payment'`, `occurredAt`/`recordedAt = to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, `merchantId`, `aggregateType 'payment'`, `aggregateId`/`orderingKey` = payment id, `aggregateVersion` = current `payments.version` (read, not locked), `correlationId` from step 1, `causationId = p_causation_id`, `data = {operationId, paymentId, provider: provider_accounts.provider_code, expectedPaymentVersion: payments.version}`. Inserted only via `messaging.insert_outbox`.
3. `payments.claim_operation(p_operation_id text, p_attempt_id text, p_worker_id text, p_lease_ms integer) RETURNS TABLE (claim_result text, operation_status text, operation_type text, operation_version bigint, attempt_id text, attempt_number integer, lease_token uuid, lease_expires_at timestamptz, merchant_id text, payment_id text, provider_code text, provider_account_id text, provider_account_version integer, provider_idempotency_key text, amount_minor bigint, currency text, provider_payment_id text, provider_authorization_id text, provider_capture_id text, payment_method_reference_ciphertext bytea, payment_method_key_version text)`:
   - Validate `p_lease_ms BETWEEN 1000 AND 600000`, `p_attempt_id` matches `^pat_…$`.
   - Read the operation's `payment_id` without lock; `SELECT … FROM payments.payments WHERE id = … FOR UPDATE`; then `SELECT … FROM payments.payment_operations WHERE id = p_operation_id FOR UPDATE` (lock order payment → operation, docs/07).
   - `SUCCEEDED|REJECTED|FAILED` → one row `claim_result='TERMINAL'`, other columns null except status/type. `PROCESSING|UNKNOWN|REQUIRES_REVIEW`, or `REQUESTED` with non-null `not_before` → `'NOT_CLAIMABLE'`. No mutation in either case.
   - Ready `REQUESTED`: read the ACTIVE `providers.provider_account_credentials.version` for the account (none → raise `PROVIDER_CREDENTIAL_UNAVAILABLE`); `UPDATE payment_operations SET status='PROCESSING', processing_started_at = COALESCE(processing_started_at, clock_timestamp()), lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + p_lease_ms * interval '1 millisecond', version = version + 1, updated_at = clock_timestamp()`; `PERFORM public.fault_point('claim.after_operation_update')`; insert the attempt (`attempt_number = COALESCE(max,0)+1`, `state='RESERVED'`, same lease token/expiry, `request_hash = digest(convert_to(op.id||'|'||op.type||'|'||op.amount_minor||'|'||op.currency||'|'||op.provider_idempotency_key,'UTF8'),'sha256')`, `reserved_at = clock_timestamp()`); `PERFORM public.fault_point('claim.after_attempt_insert')`; return `'CLAIMED'` with all columns. The ciphertext and key version are returned only when `operation_type='AUTHORIZE'`; otherwise null.
   - Payment version is not changed (docs/03 version rules).
4. `payments.mark_dispatch(p_attempt_id text, p_lease_token uuid) RETURNS timestamptz`: lock operation then attempt `FOR UPDATE`; require operation `PROCESSING`, `operation.lease_token = attempt.lease_token = p_lease_token`, and `attempt.lease_expires_at > clock_timestamp()`; else raise `LEASE_LOST`. If attempt already `DISPATCH_MARKED`, return its `dispatch_marked_at` (idempotent retry of a lost commit acknowledgement). Else require `RESERVED`, set `DISPATCH_MARKED`, `dispatch_marked_at = clock_timestamp()`; `PERFORM public.fault_point('dispatch.after_attempt_update')`; return it. Operation version unchanged (attempt-only mutation).
5. `payments.defer_operation(p_operation_id text, p_not_before timestamptz) RETURNS bigint` (new operation version, or null when no change): require `p_not_before > clock_timestamp()` and `<= clock_timestamp() + interval '1 hour'` else raise `INVALID_RETRY_SCHEDULE`; lock payment then operation; if status ≠ `REQUESTED` or `not_before IS NOT NULL` → return null (no-op); if any attempt for the operation is in `DISPATCH_MARKED|RESPONSE_RECEIVED` → raise `OPERATION_DISPATCHED`; else set `not_before = p_not_before`, `version = version + 1`, `updated_at`; `PERFORM public.fault_point('defer.after_operation_update')`. No attempt row, no payment change, no outbox row (the due scheduler enqueues later).
6. `providers.stage_attempt_evidence(p_attempt_id text, p_lease_token uuid, p_evidence jsonb) RETURNS TABLE (evidence_id text, stage_result text)` — `stage_result ∈ ('STAGED','DUPLICATE','CONFLICT')`:
   - `p_evidence` object keys (all present, values may be null): `id` (`pev_`), `observedOutcome`, `providerPaymentId`, `providerAuthorizationId`, `providerCaptureId`, `providerOperationId`, `authorizationExpiresAt`, `nextCheckNotBefore`, `amountMinor` (decimal string), `currency`, `errorCategory`, `errorCode`, `retryDirective`, `retryAfterMs`, `retryNotBefore`, `noEffectProofKind`, `noEffectProofDetail`, `providerObservedAt`, `evidenceHash` (64 hex chars), `httpStatus`, `providerRequestId`, `durationMs`. Unknown keys → raise `INVALID_EVIDENCE`.
   - Lock the attempt's operation `FOR UPDATE` then the attempt `FOR UPDATE`; require `attempt.lease_token = p_lease_token` (the lease may have expired — a worker that lost its lease may still submit evidence, docs/06 §Provider attempts and leases). Require attempt state `DISPATCH_MARKED`, or `RESERVED` only when `observedOutcome='FAILED'` and `noEffectProofKind='LOCAL_REJECTION_BEFORE_TRANSMISSION'`.
   - Evidence identity claim: `INSERT INTO providers.provider_evidence (…, source='API_RESPONSE', source_reference=p_attempt_id, provider_attempt_id=p_attempt_id, redacted_evidence_reference = id, received_at = clock_timestamp()) ON CONFLICT (provider_account_id, source, source_reference) DO NOTHING`. If no row inserted: read the existing row; equal `evidence_hash` → return `(existing.id,'DUPLICATE')`; different → `INSERT INTO providers.provider_identity_conflicts (identity_kind='EVIDENCE', scope_id=provider_account_id, stable_identity='API_RESPONSE:'||p_attempt_id, existing_hash, conflicting_hash, merchant_id, operation_id) ON CONFLICT DO NOTHING` and return `(existing.id,'CONFLICT')` (no raise, so the conflict row commits).
   - On `STAGED`: `UPDATE provider_attempts SET state='RESPONSE_RECEIVED', response_received_at = clock_timestamp(), response_hash = decode(evidenceHash,'hex'), http_status, provider_request_id, provider_operation_id, error_class = errorCategory, normalized_response = jsonb_build_object('durationMs', durationMs)`; fault points `stage.after_attempt_update`, `stage.after_evidence_insert`.
7. Grants last: `REVOKE ALL ON FUNCTION … FROM PUBLIC`; `GRANT EXECUTE` on `claim_operation`, `mark_dispatch`, `defer_operation`, `stage_attempt_evidence` to `fl_payment_worker`; `GRANT SELECT (provider_account_id, version, secret_reference, status) ON providers.provider_account_credentials TO fl_payment_worker` (references only, never secrets; used by P06-T15's credential resolver) and `GRANT SELECT (id, merchant_id, provider_account_id, type, status) ON payments.payment_operations TO fl_payment_worker` if P02 did not already grant it (P06-T16/T17 pre-claim read); grant `payments_function_owner` the table privileges these bodies need (`SELECT` on `api.idempotency_records`, `providers.provider_accounts`, `providers.provider_account_credentials`; `EXECUTE` on `messaging.insert_outbox`).

**Expected behavior** — Claim of a ready `REQUESTED` authorize: operation `PROCESSING` v+1, one `RESERVED` attempt #1, payment version unchanged, ciphertext returned. A second claim → `NOT_CLAIMABLE` and no change. `mark_dispatch` with a stale token → `LEASE_LOST`.

**Acceptance criteria**
- [ ] 50 concurrent `claim_operation` calls on one operation → exactly one `CLAIMED`, 49 `NOT_CLAIMABLE`, one attempt.
- [ ] Claim increments operation version exactly once and leaves payment version, totals, pointer, and reservation unchanged.
- [ ] `mark_dispatch` refuses after lease expiry and after a token mismatch; is idempotent for the owning token.
- [ ] `defer_operation` on a never-dispatched `REQUESTED` op increments version once; on a deferred op is a no-op; on `PROCESSING` returns null.
- [ ] Staging: duplicate hash → `DUPLICATE` with no new row; changed hash → `CONFLICT` with one committed `provider_identity_conflicts` row and no new evidence.
- [ ] Each SQL fault point aborts the whole transaction: after injection, no partial attempt/operation/evidence change is visible.
- [ ] Every function rejects `fl_api` (`FORBIDDEN_ROLE` or `42501`).

**Testing requirements** — `test/integration/db/execution-functions.test.ts` (connect as `fl_payment_worker`; set up payments/operations via `payments.create_payment` and `payments.accept_operation` through their P04/P05 wrappers): each bullet above; claim of each operation status (7 statuses) returning the right `claim_result`; boundary `p_lease_ms` 999/1000/600000/600001; `defer_operation` bounds; fault-point sweep (for each named point: set GUC, call, assert rollback). Command: `pnpm vitest run --project integration test/integration/db/execution-functions.test.ts`.

**Non-goals** — Terminal transitions, retry scheduling, due enqueue (T14); stale lease handling (P08).

**Handoff checklist**
- [ ] Lock order payment → operation → attempt in every function.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-T14 — Migration: authorization/cancellation resolution, retry scheduling, due enqueue

**Task ID:** `P06-T14`
**Feature:** Protected transitions for authorize/cancel outcomes and proven-no-effect retry
**Commit:** `feat(db): add evidence application for authorize/cancel and same-operation retry scheduling`
**Priority:** Critical
**Dependencies:** `P06-T13`
**Estimated complexity:** L
**Contract references:** docs/07 §Protected payment transition functions (`apply_provider_evidence`, `schedule_same_operation_retry`, `enqueue_due_operations`), §`provider_evidence` application rules; docs/03 §Authorize outcomes, §Cancel authorization outcomes, §Proven-no-effect same-operation retry, §Racing resolution signals, §Aggregate and operation version rules, §MVP policy decisions; docs/04 terminal events, §Envelope rules; schemas/events/payment-operation-terminal.v1.schema.json; schemas/common/provider-result-evidence.v1.schema.json; docs/06 §Normalized write results (authorization success shape).
**Files:** create: `migrations/0640_resolution_functions.sql`, `test/integration/db/resolution-functions.test.ts`; must not touch: earlier migrations.

**Objective** — Apply authorization and cancellation outcomes atomically with their terminal events, and turn proof-bearing `RETRYABLE_NO_EFFECT` into a durable, crash-safe delay of the same operation and key.

**Implementation instructions** (same function conventions as P06-T13)
1. Helper `payments._terminal_event_envelope(p_op payments.payment_operations, p_pay payments.payments, p_ev providers.provider_evidence, p_ledger_transaction_id text, p_fee_amount_minor bigint, p_fee_reversal_amount_minor bigint) RETURNS jsonb` (not granted to runtime roles): `type` from `(op.type, op.status)` — `AUTHORIZE`→`payment.authorization.{succeeded|rejected|failed}.v1`, `CANCEL`→`payment.authorization.cancellation.{…}.v1`, `CAPTURE`→`payment.capture.{…}.v1`, `REFUND`→`payment.refund.{…}.v1`; envelope fields as in P06-T13 step 2 with `kind 'EVENT'`, `aggregateVersion = p_pay.version` (the new version), `causationId = p_ev.id`; `data` exactly per the terminal schema: `operationId, paymentId, operationType, outcome, provider (provider_code), providerAccountId, providerIdempotencyKey, providerPaymentId (ev), providerOperationId (ev), providerAuthorizationId (AUTHORIZE only, ev), providerCaptureId (CAPTURE only, ev), amount {amountMinor: op.amount_minor::text, currency}, totalsAfter {requestedAmountMinor, authorizedAmountMinor, capturedAmountMinor, refundedAmountMinor, voidedAmountMinor (all ::text), currency}, resolutionSource (ev.source), resultCode (op.result_code), ledgerTransactionId, evidence {source, providerObservedAt, receivedAt, providerEventId (null for API_RESPONSE; notification's provider_event_id for PROVIDER_WEBHOOK), redactedEvidenceRef: ev.redacted_evidence_reference}, normalizedError (null for success; else {category, code, retryDirective, retryAfterMs, safeMessage: ev.normalized_error_code} — R-06-07), noEffectProof (null unless FAILED: {kind, ...no_effect_proof_detail})`, plus `feeAmountMinor` only for capture success and `feeReversalAmountMinor` only for refund success (omit keys otherwise; the schema forbids them).
2. `payments.apply_provider_evidence(p_evidence_id text) RETURNS TABLE (application_kind text, operation_status text, operation_version bigint, payment_version bigint, ledger_transaction_id text)`:
   1. Read evidence (no lock) → operation → payment. Lock payment `FOR UPDATE`, operation `FOR UPDATE`, evidence `FOR UPDATE` (docs/07 canonical order).
   2. If `evidence.applied_at IS NOT NULL` → return its recorded application (duplicate; no change).
   3. If `observed_outcome NOT IN ('SUCCEEDED','REJECTED','FAILED')` → raise `EVIDENCE_NOT_TERMINAL`.
   4. If the operation is terminal: agreement = same outcome as `operation.status` AND (`evidence.provider_operation_id IS NULL OR operation.provider_operation_id IS NULL OR equal`) AND (`observed_amount_minor IS NULL OR = amount_minor`) → set `applied_at = clock_timestamp(), application_kind = 'CORROBORATION'` and return (no version change). Otherwise raise `DISCREPANCY_NOT_SUPPORTED` (P07 converts this branch to a non-raising `UNAPPLIED_CONTRADICTION` return; P08-T17 replaces it with `record_discrepancy`).
   5. Require `operation.status = 'PROCESSING'` (P08 adds `UNKNOWN|REQUIRES_REVIEW`) else raise `OPERATION_NOT_RESOLVABLE`; require `operation.type IN ('AUTHORIZE','CANCEL')` else raise `OPERATION_TYPE_NOT_SUPPORTED` (P07 adds `CAPTURE|REFUND`).
   6. For `SUCCEEDED`: require `observed_amount_minor = amount_minor` and `currency = 'USD'`; for `AUTHORIZE` require non-null provider payment, operation, and authorization ids; for `CANCEL`, if `payment.provider_payment_id` and `evidence.provider_payment_id` are both non-null they must be equal. A violation raises `EVIDENCE_MISMATCH` and leaves the evidence unapplied (P07 converts it to a non-raising `UNAPPLIED_MISMATCH` return; P08-T17 records the discrepancy).
   7. Operation transition (one version): `status = observed_outcome`, `resolved_at = clock_timestamp()`, `resolution_source = evidence.source`, `resolution_evidence_id = evidence.id`, `provider_operation_id = COALESCE(evidence.provider_operation_id, provider_operation_id)` for success, `result_code = evidence.normalized_error_code` for `REJECTED|FAILED` (null for success), `lease_token = NULL, lease_expires_at = NULL, not_before = NULL`, `version + 1`, `updated_at`. Fault point `apply.after_operation_update`.
   8. Current non-completed attempt (if any): `RESPONSE_RECEIVED|DISPATCH_MARKED` → `COMPLETED` with `outcome_class` `SUCCESS|REJECTED|NO_EFFECT_FAILURE`, `completed_at`; `RESERVED` (no dispatch) → `ABANDONED`. Fault point `apply.after_attempt_update`.
   9. Payment update (one statement, `version + 1`, `updated_at`, `active_exclusive_operation_id = NULL`):
      - AUTHORIZE SUCCEEDED: `authorized_amount_minor = amount_minor`, `authorization_outcome = 'AUTHORIZED'`, `provider_payment_id`/`provider_authorization_id` set from evidence (both must currently be null, else `EVIDENCE_MISMATCH`).
      - AUTHORIZE REJECTED: `authorization_outcome = 'DECLINED'`.
      - AUTHORIZE FAILED: confirmed fields unchanged.
      - CANCEL SUCCEEDED: `authorization_outcome = 'CANCELED'`, `voided_amount_minor = authorized_amount_minor`.
      - CANCEL REJECTED/FAILED: confirmed fields unchanged.
      Fault point `apply.after_payment_update`.
   10. Evidence: `applied_at`, `application_kind = 'OPERATION_TRANSITION'`, `applied_operation_version`, `applied_payment_version`. Fault point `apply.after_evidence_update`.
   11. `PERFORM messaging.insert_outbox(payments._terminal_event_envelope(op, pay, ev, NULL, NULL, NULL))`.
   12. Return `('OPERATION_TRANSITION', status, op.version, pay.version, NULL)`.
   The `AUTHORIZATION_EXPIRY` case creation on authorization success is P08 (it replaces this function); P06 creates no case.
3. `payments.schedule_same_operation_retry(p_evidence_id text, p_retry_not_before timestamptz) RETURNS bigint` (new operation version): lock payment, operation, evidence (same order; payment row is not modified); if evidence already applied with `OPERATION_RETRY` → return `applied_operation_version` (idempotent); require `observed_outcome = 'RETRYABLE_NO_EFFECT'`, `no_effect_proof_kind IS NOT NULL`, `retry_directive = 'RETRY_SAME_OPERATION'`, `p_retry_not_before = evidence.retry_not_before`, `source = 'API_RESPONSE'`, `evidence.provider_attempt_id` = the operation's current non-completed attempt, `operation.status = 'PROCESSING'`; else raise `INVALID_RETRY_EVIDENCE`. Then: attempt → `COMPLETED`, `outcome_class = 'RETRYABLE_NO_EFFECT'` (fault `retry.after_attempt_update`); operation → `status='REQUESTED'`, `not_before = p_retry_not_before`, lease fields null, `result_code = evidence.normalized_error_code`, `version + 1` (fault `retry.after_operation_update`); evidence → applied `OPERATION_RETRY` with `applied_operation_version`. No payment update, no pointer/reservation change, no outbox row, no new operation or key.
4. `payments.enqueue_due_operations(p_batch_size integer) RETURNS TABLE (operation_id text, envelope_id uuid)`: require `p_batch_size BETWEEN 1 AND 500`; `FOR op IN SELECT … FROM payments.payment_operations WHERE status='REQUESTED' AND not_before IS NOT NULL AND not_before <= clock_timestamp() ORDER BY not_before, created_at, id LIMIT p_batch_size FOR UPDATE SKIP LOCKED LOOP`: `UPDATE … SET not_before = NULL, version = version + 1, updated_at`; `PERFORM public.fault_point('enqueue_due.after_clear')`; `env := payments._execute_command_envelope(op.id, op.id)`; `PERFORM messaging.insert_outbox(env)`; return `(op.id, (env->>'id')::uuid)`. Payment rows are read, never locked or written.
5. Grants last: `GRANT EXECUTE` on the three functions to `fl_payment_worker`; `REVOKE` from `PUBLIC`.

**Expected behavior** — Authorization success evidence on a `PROCESSING` authorize: operation `SUCCEEDED` v+1, payment `AUTHORIZED`, pointer null, payment v+1, one `payment.authorization.succeeded.v1` outbox row with `aggregateVersion` = new payment version. Re-applying → same return values, no new outbox row. `RETRYABLE_NO_EFFECT` evidence: operation `REQUESTED`, `not_before` set, v+1; payment version, pointer, reservation unchanged; `enqueue_due_operations` before `not_before` returns 0 rows; after it, one row and one execute envelope.

**Acceptance criteria**
- [ ] Each of the six AUTHORIZE/CANCEL outcomes produces exactly the docs/03 payment effect, one terminal event that validates against the terminal schema (Ajv in the test), and increments payment and operation version exactly once.
- [ ] Applying the same evidence 100 times concurrently → one transition, one outbox event (others return the duplicate result).
- [ ] `FAILED` evidence application is only possible with proof (the evidence check prevents staging without it; assert the transition records `noEffectProof`).
- [ ] Authorization success missing the authorization id is rejected at staging (constraint trigger) — the transition is never reached.
- [ ] Retry scheduling preserves payment version, confirmed totals, `active_exclusive_operation_id` (or refund reservation for a `REFUND` operation), operation id, and provider key; increments operation version exactly once; duplicate scheduling call is idempotent.
- [ ] `enqueue_due_operations`: future `not_before` not claimed; two concurrent calls never enqueue one operation twice; fault `enqueue_due.after_clear` leaves `not_before` intact and no outbox row.
- [ ] A later agreeing evidence on a terminal operation → `CORROBORATION`, no version changes.

**Testing requirements** — `test/integration/db/resolution-functions.test.ts` as `fl_payment_worker`, with evidence staged via `stage_attempt_evidence` after real `claim_operation` + `mark_dispatch`: the six outcome cases; duplicate/100× concurrency; corroboration; `DISCREPANCY_NOT_SUPPORTED`, `EVIDENCE_MISMATCH` (amount differs), `OPERATION_TYPE_NOT_SUPPORTED` (capture evidence) raised with evidence left unapplied; retry scheduling for an `AUTHORIZE` and a `REFUND` operation (refund reservation unchanged — refund set up through P05 acceptance); enqueue timing, concurrency, fault rollback; fault-point sweep over every `apply.*`/`retry.*` point asserting full rollback; terminal envelopes validated with the `@flowledger/contracts` Ajv validator. Command: `pnpm vitest run --project integration test/integration/db/resolution-functions.test.ts`.

**Non-goals** — Capture/refund transitions, ledger posting (P07); discrepancy recording (P08-T17); `UNKNOWN` handling and expiry cases (P08).

**Handoff checklist**
- [ ] Every branch that P07/P08 will replace carries a SQL comment `-- P07:` / `-- P08:`.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-T15 — Database wrappers, payment-method decryption, worker config

**Task ID:** `P06-T15`
**Feature:** TypeScript access to execution functions; authorization-only token decryption
**Commit:** `feat(worker): add execution function wrappers and payment-method decryption`
**Priority:** Critical
**Dependencies:** `P06-T14`
**Estimated complexity:** M
**Contract references:** CONVENTIONS §7 (wrappers, `DomainError`), §11 (secret references); docs/07 §`providers.provider_account_credentials` (`secret_reference` is a reference, never the secret); docs/07 §`payments.payments` (AEAD with AAD merchant/payment/provider-account; "Only the authorization-worker role may request decryption"); docs/06 `paymentMethodReference` rules; docs/03 §Canonical aggregate.
**Files:** create: `packages/config/src/secrets.ts`, `packages/config/src/secrets.test.ts`, `packages/database/src/functions/providers.ts`, `packages/database/src/functions/execution.test.ts`, `packages/config/src/payment-worker.ts` (or modify if P00 created it), `packages/config/src/payment-worker.test.ts`; modify: `packages/database/src/functions/payments.ts`, `packages/database/src/errors.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/**`.

**Objective** — Typed, number-free wrappers over the P06 SQL functions and a decryption function that exists only for the authorization path.

**Implementation instructions**
1. `payments.ts` add: `claimOperation(client, { operationId, attemptId, workerId, leaseMs }): Promise<ClaimResult>` (discriminated on `claimResult`, amounts as `MinorUnits`), `markDispatch(client, { attemptId, leaseToken }): Promise<Date>`, `deferOperation(client, { operationId, notBefore }): Promise<bigint | null>`, `applyProviderEvidence(client, evidenceId): Promise<{ applicationKind; operationStatus; operationVersion: bigint; paymentVersion: bigint | null; ledgerTransactionId: string | null }>`, `scheduleSameOperationRetry(client, { evidenceId, retryNotBefore }): Promise<bigint>`, `enqueueDueOperations(client, batchSize): Promise<Array<{ operationId; envelopeId }>>`. `providers.ts`: `stageAttemptEvidence(client, { attemptId, leaseToken, evidence: StagedEvidence }): Promise<{ evidenceId; stageResult: 'STAGED'|'DUPLICATE'|'CONFLICT' }>` where `StagedEvidence` mirrors the JSON keys in P06-T13 step 6.
2. `errors.ts`: map the new `P0001` messages to `DomainError` codes with the same names: `FORBIDDEN_ROLE`, `LEASE_LOST`, `PROVIDER_CREDENTIAL_UNAVAILABLE`, `INVALID_RETRY_SCHEDULE`, `OPERATION_DISPATCHED`, `INVALID_EVIDENCE`, `EVIDENCE_NOT_TERMINAL`, `EVIDENCE_MISMATCH`, `OPERATION_NOT_RESOLVABLE`, `OPERATION_TYPE_NOT_SUPPORTED`, `DISCREPANCY_NOT_SUPPORTED`, `INVALID_RETRY_EVIDENCE`, `CORRELATION_NOT_FOUND`, `FAULT_INJECTED`. These are internal worker codes, not HTTP problem codes (R-06-02).
3. Decryption: reuse P04's `decryptPaymentMethodRef(blob, aad, key)` from `packages/domain/src/payment-method-crypto.ts` unchanged (AES-256-GCM, `iv(12) ‖ ciphertext ‖ tag(16)`, AAD = UTF-8 `merchantId|paymentId|providerAccountId`). Add only `loadPaymentMethodKeys(env): ReadonlyMap<string, Buffer>` in `packages/config/src/payment-worker.ts`, parsing P04's `PAYMENT_METHOD_ENCRYPTION_KEYS` (`version:base64key`, 32 bytes each); the worker selects the key by the claim row's `payment_method_key_version` (unknown version → `PaymentMethodDecryptionError`). Authentication failure surfaces as `PaymentMethodDecryptionError` whose message contains no key, IV, or ciphertext bytes.
4. `packages/config/src/secrets.ts` — `resolveSecretReference(ref: string): Promise<Uint8Array>` exactly per CONVENTIONS §11: scheme `local-secret://<path>` → env var `FLOWLEDGER_SECRET_<PATH>` with `<PATH>` = `<path>` upper-cased and every non-alphanumeric character replaced by `_`; returns the UTF-8 bytes of the value (no base64). Unknown scheme or missing variable throws `SecretResolutionError` whose message names the reference and never a value. No other scheme (P13 injects Secret Manager values as `FLOWLEDGER_SECRET_*` env vars; `gsm://` is not implemented in the MVP). Add `FLOWLEDGER_SECRET_SIMULATOR_API_KEY` (synthetic, equal to the simulator's `SIMULATOR_API_KEY`) to `.env.example`/`docs/CONFIG.md`; the dev-seed credential rows are expected to carry `secret_reference = 'local-secret://simulator/api-key'` **[ASSUMPTION — P02 seed; if the seed uses another reference, add the matching `FLOWLEDGER_SECRET_*` variable instead]**.
5. Worker credential resolver (exported from `packages/database/src/functions/providers.ts` as `activeCredentialReference(client, providerAccountId): Promise<{ version: number; secretReference: string }>`, a plain `SELECT` on `providers.provider_account_credentials WHERE status = 'ACTIVE'` granted to `fl_payment_worker`); the worker composes it with `resolveSecretReference` and caches resolved bytes per `(account, version)` for 60 s.
6. `packages/config/src/payment-worker.ts`: `SIMULATOR_BASE_URL`, `PAYMENT_WORKER_CONCURRENCY` (default 32, range 1–512; reuse if P00 defined a worker concurrency variable), `DUE_SCHEDULER_INTERVAL_MS` (default 1000), `DUE_SCHEDULER_BATCH_SIZE` (default 100, max 500), `STAGED_EVIDENCE_SWEEP_INTERVAL_MS` (default 5000), `UNRELIABLE_PROVIDER_FAULT_SEED` (default `local`), `FLOWLEDGER_ENVIRONMENT` (reuse P05's variable if it already exists), and P04's `PAYMENT_METHOD_ENCRYPTION_KEYS` (worker only). Config for every other app must not include the payment-method key variable (assert in test).

**Expected behavior** — With keys from `loadPaymentMethodKeys`, `decryptPaymentMethodRef(encryptPaymentMethodRef(x, aad, k), aad, k) === x`; changing any AAD component or the key version throws.

**Acceptance criteria**
- [ ] No `Number(`/`parseInt(` on money in the wrappers (grep in review).
- [ ] Worker decrypts with P04's `decryptPaymentMethodRef` (no second crypto implementation); key-map parsing and wrong-key-version cases covered.
- [ ] Only `packages/config/src/payment-worker.ts` (and the API config that encrypts) reference the key variable.
- [ ] `resolveSecretReference('local-secret://simulator/api-key')` reads `FLOWLEDGER_SECRET_SIMULATOR_API_KEY`; `local-secret://a.b-c/d` maps to `FLOWLEDGER_SECRET_A_B_C_D`; unknown scheme and missing variable throw without printing any value.

**Testing requirements** — `packages/config/src/secrets.test.ts`: name mapping, UTF-8 bytes (non-ASCII value), missing variable, unknown scheme, error message contains no value. `packages/database/src/functions/execution.test.ts` (unit; `pg` client stub asserting SQL text and parameter order, bigint parsing). Key-map parsing and wrong-key-version tests in `packages/config/src/payment-worker.test.ts`; P04's `payment-method-crypto.test.ts` already covers round trip/tamper. Command: `pnpm test:unit`.

**Non-goals** — Worker orchestration (T16).

**Handoff checklist**
- [ ] `docs/CONFIG.md` updated.
- [ ] `pnpm check` green.

---

### P06-T16 — Payment worker execute handler

**Task ID:** `P06-T16`
**Feature:** Claim → dispatch mark → provider call → stage → apply/retry
**Commit:** `feat(worker): execute authorize and cancel operations against providers`
**Priority:** Critical
**Dependencies:** `P06-T15`, `P06-T10`
**Estimated complexity:** L
**Contract references:** docs/06 §Provider attempts and leases (claim rules 1–10), §Timeout and ambiguous-result policy, §Redaction; docs/07 §Transaction and lock ownership ("Claim provider execution", "Record provider response"), §`messaging.inbox_messages` (execution-command redelivery rules); docs/04 §Inbox consumption; docs/08 §Worker claim and provider dispatch, §No-blind-retry rule, §Durable provider evidence; docs/10 M6 bullets on decryption and "Execute provider calls without database locks".
**Files:** create: `apps/payment-worker/src/execute-handler.ts`, `apps/payment-worker/src/provider-registry.ts`, `apps/payment-worker/src/evidence-mapper.ts`, `apps/payment-worker/src/evidence-mapper.test.ts`, `test/integration/worker/execute-handler.test.ts`; modify: `packages/messaging/src/consumer.ts` (additive export of the parse/validate/DLQ helpers only, if P05 kept them private), `apps/payment-worker/src/main.ts` (or the P00 bootstrap module) to subscribe the handler to the `payment-worker` subscription of topic `flowledger-commands-v1` using the constants in `packages/messaging/src/topology.ts` (never a literal topic string); must not touch: `migrations/**`, `packages/providers/src/**`, other `packages/messaging/**` files.

**Objective** — Execute each operation at most once per proven-safe opportunity, with no lock held during I/O and every possibly transmitted write left for evidence rather than retried.

**Implementation instructions**
1. `provider-registry.ts`: builds `{ 'fake-provider': FakeProviderAdapter, 'unreliable-provider': UnreliableProviderAdapter }` from config with `resolveCredential = (accountId) => activeCredentialReference(...) → resolveSecretReference(...)` (P06-T15) and `resolveWebhookSecrets` unused by the worker (throws if called), runs `validateCapabilities` on each at startup (failure exits non-zero with the field name), exposes `get(providerCode)`; unknown code → `DomainError('PROVIDER_NOT_CONFIGURED')`, message nacked.
2. `execute-handler.ts` exports `EXECUTABLE_OPERATION_TYPES = ['AUTHORIZE','CANCEL'] as const` (P07 adds `CAPTURE`,`REFUND`) and `handleExecuteCommand(deps, envelope): Promise<'ack'|'nack'>`. Wiring: the worker cannot use P05 `processDelivery`'s `handle(tx, …)` callback as-is, because the provider call must run outside any transaction and docs/07 requires a duplicate execution-command inbox key to re-evaluate the operation instead of short-circuiting. So `main.ts` subscribes with `transport.subscribe(<payment-worker subscription from SUBSCRIPTIONS>, msg => …)`, and the subscriber reuses P05's parse/validate/DLQ steps 1, 2, 5, 6 of `processDelivery` (if they are not exported from `packages/messaging/src/consumer.ts`, export them additively — no behavior change) before calling `handleExecuteCommand` with the validated envelope. Steps:
   1. `crashPoint('worker.before_claim')`.
   2. Limiter check (P06-T17 adds it; in this task call a `deps.limiter.tryAcquire(...)` that always allows).
   3. Transaction A (`withTransaction` with `ctx.correlationId = envelope.correlationId`): `recordInboxMessage(tx, 'payment-worker', envelope)` (P05 wrapper over `messaging.record_inbox_message`; `DUPLICATE` does not short-circuit; continue to reload the operation, docs/07 inbox note), then `claimOperation({ operationId, attemptId: newId('pat'), workerId, leaseMs: adapter.capabilities.execution.processingLeaseMs })`.
   4. `TERMINAL` → ack. `NOT_CLAIMABLE` → ack (a live lease owner, a deferred schedule, or P08's sweepers own continuation). If the claimed `operation_type` is not in `EXECUTABLE_OPERATION_TYPES`: do not use this branch — instead check the type before claiming by reading `payments.payment_operations.type` (SELECT is granted) and ack without inbox insert or claim, logging `operation_type_not_yet_executable` (the P05 `REQUESTED` sweeper republishes it once P07 is deployed).
   5. `crashPoint('worker.after_claim_commit')`.
   6. Capability guard before dispatch: if `operation_type` ∉ `adapter.capabilities.supportedOperations`, build `FAILED`/`UNSUPPORTED_OPERATION`/`LOCAL_REJECTION_BEFORE_TRANSMISSION` evidence locally, skip `mark_dispatch` and the network call, and go to step 10.
   7. `markDispatch({ attemptId, leaseToken })` in its own short transaction. `LEASE_LOST` → ack without calling the provider. `crashPoint('worker.after_dispatch_mark')`.
   8. Build `ProviderOperationCommand` from the claim row: `paymentMethodReference` = `decryptPaymentMethodRef(ciphertext, { merchantId, paymentId, providerAccountId }, keys.get(keyVersion))` (P04) only when `operation_type === 'AUTHORIZE'`, otherwise `null`; `requestDeadline = new Date(Date.now() + requestTimeoutMs).toISOString()`; `correlationId = envelope.correlationId`. The plaintext lives only in this local variable; it is never passed to the logger, an error, the evidence mapper, or a span attribute.
   9. Call the adapter method matching `operation_type` with an `AbortSignal` tied to shutdown, with no database client checked out (assert in test by pool `totalCount - idleCount === 0` during the call via a test hook). `const p = adapter[method](cmd, signal); crashPoint('worker.during_provider_call'); const result = await p; crashPoint('worker.after_provider_response');`.
   10. `evidence-mapper.ts` `toStagedEvidence(result, { evidenceId: newId('pev'), durationMs }): StagedEvidence` maps `ProviderWriteResult` to the P06-T13 JSON keys (amount via `amount.amountMinor`; `nextCheckNotBefore = lookupHint.lookupNotBefore` for `UNKNOWN`; proof kind/detail; `evidenceHash` = hex SHA-256 of RFC 8785 JSON of the mapped object without `evidenceHash`). `stageAttemptEvidence(...)` in its own transaction. `CONFLICT` → log `evidence_identity_conflict` at error level and ack. `crashPoint('worker.after_evidence_staged')`.
   11. By outcome, in one transaction: `SUCCEEDED|REJECTED|FAILED` → `applyProviderEvidence(evidenceId)`; `RETRYABLE_NO_EFFECT` → `scheduleSameOperationRetry({ evidenceId, retryNotBefore })`; `UNKNOWN` → no transition: log `provider_outcome_ambiguous` with `reconciliationReasonFor(result)` and leave the operation `PROCESSING` with its attempt `RESPONSE_RECEIVED` (marked `// P08: mark_unknown` — no write retry is possible because `claim_operation` refuses `PROCESSING`). `DomainError` `EVIDENCE_MISMATCH`/`DISCREPANCY_NOT_SUPPORTED`/`OPERATION_TYPE_NOT_SUPPORTED` → log and ack (evidence stays staged; P07 turns these into `UNAPPLIED_*` returns, P08-T17 records discrepancies).
   12. `crashPoint('worker.after_result_commit')`; release limiter slot with the outcome; return `ack`.
   13. Database or transient errors before step 7 → `nack` (redelivery). Errors after step 7 → never re-call the provider in this invocation; `ack` after logging (durable state plus P08 sweepers own recovery).
3. Logging (pino via `@flowledger/observability`): `operationId`, `paymentId`, `attemptNumber`, operation type, normalized outcome/category/code, `durationMs`, provider code. Never the command object, token, ciphertext, API key, or raw response.

**Expected behavior** — Authorize with `pm_fake_approve*`: one attempt (`COMPLETED`/`SUCCESS`), payment `AUTHORIZED`, one success event; command redelivered afterwards → `TERMINAL`, no second simulator request. Directed `RATE_LIMITED` once: operation back to `REQUESTED` with `not_before`; no second provider request until the scheduler runs (T18).

**Acceptance criteria**
- [ ] Every attempt for an operation carries the operation's provider key (attempt rows and `sim.request_log` agree).
- [ ] No database connection is held while the adapter call is pending.
- [ ] Redelivery in each status — `REQUESTED` (claims), live `PROCESSING` (no provider call), terminal (no provider call), deferred `REQUESTED` (no claim) — behaves as docs/04 §Inbox consumption requires.
- [ ] `paymentMethodReference` is null for `CANCEL` commands (adapter spy) and the decrypt function is called only for `AUTHORIZE`.
- [ ] Token, ciphertext, and API key absent from logs, attempt rows, evidence rows, outbox envelopes, and `sim.*` tables after the suite.

**Testing requirements** — `apps/payment-worker/src/evidence-mapper.test.ts`: mapping for each outcome variant; hash stability. `test/integration/worker/execute-handler.test.ts` (Testcontainers PG + `startSimulator` + `InMemoryTransport`): authorize approve/decline/invalid; cancel success; directed `NOT_APPLIED` cancel → `FAILED` with proof; `RATE_LIMITED` → `REQUESTED` + `not_before`; capability-mismatch adapter (test registry with capabilities lacking `CANCEL`) → `FAILED` with zero simulator requests and null `dispatch_marked_at`; directed `TIMEOUT_AFTER_COMMIT` → operation stays `PROCESSING`, evidence `UNKNOWN` staged, one effect in truth, redelivery makes no second request; redelivery matrix; connection-held assertion; redaction scan with prohibited-data fixtures and the test token; a `CAPTURE` command acked without claim. Command: `pnpm vitest run --project integration test/integration/worker/execute-handler.test.ts`.

**Non-goals** — Limiter logic (T17), scheduler (T18), capture/refund (P07), stale/unknown handling (P08), metrics (P11).

**Handoff checklist**
- [ ] All eight `worker.*` crash points placed exactly where §Crash points says.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-T17 — Per-account concurrency, fairness, backoff, and circuit breaking

**Task ID:** `P06-T17`
**Feature:** Provider isolation
**Commit:** `feat(worker): add per-account limits, merchant fairness, and circuit breaking`
**Priority:** High
**Dependencies:** `P06-T16`
**Estimated complexity:** M
**Contract references:** docs/06 §Rate limits, fairness, and circuit breaking, §Capability model (`maxInFlightPerAccount`); docs/03 §Proven-no-effect same-operation retry (last paragraph: local limiter/circuit uses durable deferral); docs/08 §Runbook: provider outage or rate limiting; docs/10 M6 bullets "per-provider-account concurrency limits…" and tests "open circuit … safely queued", "slow/rate-limited provider account cannot consume another account's concurrency budget".
**Files:** create: `apps/payment-worker/src/limiter.ts`, `apps/payment-worker/src/limiter.test.ts`, `test/integration/worker/isolation.test.ts`; modify: `apps/payment-worker/src/execute-handler.ts`; must not touch: `migrations/**`.

**Objective** — Keep one slow, failing, or hot provider account or merchant from starving others, and queue work durably instead of sleeping or inventing outcomes.

**Implementation instructions**
1. `ExecutionLimiter` (in-process; `ponytail:` comment — limits are per worker instance; a shared limiter is needed only if measured multi-instance overshoot matters):
   - Per `(provider, providerAccountId)`: token bucket capacity 50, refill 100 tokens/s; in-flight ≤ `capabilities.execution.maxInFlightPerAccount`.
   - Per provider: in-flight ≤ `max(1, ceil(PAYMENT_WORKER_CONCURRENCY / 2))` so one provider can never hold every worker slot.
   - Per merchant: in-flight ≤ `max(1, floor(PAYMENT_WORKER_CONCURRENCY / 4))`.
   - Circuit per `(provider, providerAccountId)`: `CLOSED` → `OPEN` after 5 consecutive circuit failures; `OPEN` for 30 s → `HALF_OPEN` admits one probe; probe success → `CLOSED`, failure → `OPEN`. Circuit failure = outcome `UNKNOWN` with code `TIMEOUT_AFTER_SEND|CONNECTION_LOST_AFTER_SEND|PROVIDER_5XX_AMBIGUOUS`, or category `PROVIDER_UNAVAILABLE|TRANSPORT_PRE_SEND|TRANSPORT_AMBIGUOUS`. `BUSINESS_DECLINE` and other outcomes reset the failure count.
   - Provider retry hints: `penalize(account, retryAfterMs)` blocks the account bucket until `now + min(retryAfterMs, 60000)` whenever a `RETRYABLE_NO_EFFECT` with `RATE_LIMITED` arrives.
   - `tryAcquire({ provider, providerAccountId, merchantId, maxInFlightPerAccount }) → { ok: true; release(outcome: ProviderOutcome | null) } | { ok: false; retryAt: Date; reason: 'ACCOUNT_RATE'|'ACCOUNT_IN_FLIGHT'|'PROVIDER_IN_FLIGHT'|'MERCHANT_SHARE'|'CIRCUIT_OPEN' }`; `retryAt` = circuit reopen time, penalty end, or `now + 250..1000 ms` jitter.
2. Handler integration: the limiter needs the operation's merchant/account before claiming — read `merchant_id`, `provider_account_id`, `type`, `status` from `payments.payment_operations` (SELECT) at step 2. Denied → in one transaction insert the inbox row and call `deferOperation({ operationId, notBefore: retryAt })` (null result = not a ready `REQUESTED` op; nothing to do) → ack. No attempt is created, so no ambiguity can arise.
3. Release the slot after step 11 (or on any exit after acquiring), passing the outcome (null for exits without a provider call).

**Expected behavior** — Five consecutive `TIMEOUT_AFTER_COMMIT` faults on account A open A's circuit; the next command for A defers with `not_before ≈ now + 30 s`; commands for account B proceed.

**Acceptance criteria**
- [ ] Open circuit: operation stays `REQUESTED` with bounded `not_before`, no attempt row, no evidence, status never `FAILED`/`UNKNOWN`.
- [ ] Account A held slow (directed `LATENCY`/`TIMEOUT_BEFORE_COMMIT`) does not reduce account B throughput below its own limits.
- [ ] A hot merchant saturating its share does not block another merchant's operations.
- [ ] Business declines never open the circuit.

**Testing requirements** — `apps/payment-worker/src/limiter.test.ts` (fake clock): bucket refill; each in-flight cap; circuit transitions incl. half-open single probe; decline does not count; penalty bounded at 60 s. `test/integration/worker/isolation.test.ts`: two accounts, A faulted with `TIMEOUT_BEFORE_COMMIT` (hold 2 s), B healthy → all B authorizations complete within 3 s while A's are in flight/deferred; circuit-open deferral leaves no attempt; hot-merchant fairness with `PAYMENT_WORKER_CONCURRENCY=4`. Command: `pnpm vitest run --project unit apps/payment-worker/src/limiter.test.ts && pnpm vitest run --project integration test/integration/worker/isolation.test.ts`.

**Non-goals** — Metrics/dashboards (P11); distributed limiter.

**Handoff checklist**
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-T18 — Due-work scheduler and staged-evidence recovery

**Task ID:** `P06-T18`
**Feature:** Crash-safe delayed execution
**Commit:** `feat(worker): add due-work scheduler and staged evidence recovery loop`
**Priority:** Critical
**Dependencies:** `P06-T16`
**Estimated complexity:** M
**Contract references:** docs/06 §Provider attempts and leases (due scheduler paragraph), §Required contract tests "A proven-no-effect retry … crashes before or after due-command insertion…", "A future operation `notBefore` is unclaimable"; docs/03 §Proven-no-effect same-operation retry; docs/07 §Transaction and lock ownership ("Enqueue due provider operation"); docs/08 §Durable provider evidence ("A crash after staging but before application is recovered by scanning unapplied evidence"), §Worker claim row "Normalized result is stored but terminal payment transaction has not committed".
**Files:** create: `apps/payment-worker/src/scheduler.ts`, `test/integration/worker/scheduler.test.ts`; modify: `apps/payment-worker/src/main.ts`; must not touch: `migrations/**`.

**Objective** — Turn durable `not_before` schedules back into execution commands, and finish applying evidence a crashed worker already staged.

**Implementation instructions**
1. Due loop: every `DUE_SCHEDULER_INTERVAL_MS`, call `enqueueDueOperations(DUE_SCHEDULER_BATCH_SIZE)` in its own transaction; repeat immediately while the batch came back full; `crashPoint('scheduler.after_enqueue_commit')` after each commit. Multiple worker instances may run it concurrently (`SKIP LOCKED`).
2. Staged-evidence loop: every `STAGED_EVIDENCE_SWEEP_INTERVAL_MS`, `SELECT e.id, e.observed_outcome, e.retry_not_before FROM providers.provider_evidence e JOIN payments.payment_operations o ON o.id = e.operation_id WHERE e.applied_at IS NULL AND e.source = 'API_RESPONSE' AND e.received_at < clock_timestamp() - interval '5 seconds' AND o.status = 'PROCESSING' AND e.observed_outcome IN ('SUCCEEDED','REJECTED','FAILED','RETRYABLE_NO_EFFECT') ORDER BY e.received_at, e.id LIMIT 100`; for each, one transaction calling `applyProviderEvidence` or `scheduleSameOperationRetry` exactly as the handler would. Expected `DomainError`s (`EVIDENCE_MISMATCH`, `DISCREPANCY_NOT_SUPPORTED`, `OPERATION_TYPE_NOT_SUPPORTED`, `OPERATION_NOT_RESOLVABLE`, `INVALID_RETRY_EVIDENCE`) are logged at warn once per evidence id per process and skipped. `UNKNOWN` evidence is never touched here (P08).
3. Both loops stop on shutdown before the pool closes; neither calls a provider.

**Expected behavior** — Operation with `not_before = now + 2 s`: no execute envelope before 2 s; exactly one after. Worker killed at `worker.after_evidence_staged` with `SUCCEEDED` evidence: within ~10 s the sweep applies it and the payment is `AUTHORIZED`, with one terminal event and still one simulator effect.

**Acceptance criteria**
- [ ] The operation is never dispatched before `not_before` (attempt #2 `reserved_at >= not_before`).
- [ ] Crash before the enqueue commit (SQL fault) → schedule retained, later enqueued once; crash after commit (`scheduler.after_enqueue_commit`) → envelope exists, no duplicate on next pass; duplicate execute envelopes never produce two attempts in flight.
- [ ] Provider key identical on attempts #1 and #2.
- [ ] Staged-evidence recovery applies each staged evidence exactly once and never calls the provider.

**Testing requirements** — `test/integration/worker/scheduler.test.ts`: retry timing; two concurrent scheduler loops; SQL fault `enqueue_due.after_clear`; in-process `armCrashPoint('scheduler.after_enqueue_commit')` (expects `CrashPointError`, then `disarmCrashPoints()`); staged-evidence recovery after `armCrashPoint('worker.after_evidence_staged')` for `SUCCEEDED` and for `RETRYABLE_NO_EFFECT`; recovery skips `UNKNOWN`. Command: `pnpm vitest run --project integration test/integration/worker/scheduler.test.ts`.

**Non-goals** — Stale `REQUESTED`/`PROCESSING` sweeps (P05 republish / P08).

**Handoff checklist**
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-T19 — Timeline entries for attempts, evidence, and resolutions

**Task ID:** `P06-T19`
**Feature:** Payment timeline (M6 entry kinds)
**Commit:** `feat(api): add provider attempt, evidence, and resolution timeline entries`
**Priority:** Medium
**Dependencies:** `P06-T14`
**Estimated complexity:** S
**Contract references:** docs/05 §Retrieve a payment timeline (rules, `PROVIDER_ATTEMPT` example detail); openapi `PaymentTimelineEntry`; docs/10 M4 ("Entry kinds whose source tables arrive in later milestones are added as those milestones land").
**Files:** create: `migrations/0690_timeline_provider_entries.sql`, `test/integration/api/timeline-provider-entries.test.ts`; modify: `packages/contracts/src/timeline-detail.ts`, `packages/contracts/src/timeline-detail.test.ts`; must not touch: `openapi/openapi.yaml`, `migrations/0430_payment_timeline.sql`, earlier P05/P06 migrations.

**Objective** — Make provider execution visible through the merchant timeline without exposing anything sensitive.

**Implementation instructions**
1. In `0690`, `CREATE OR REPLACE FUNCTION payments.payment_timeline(text)` (same signature, owner, grants restated last) appending `UNION ALL` branches with P04's fixed `kind_rank`, and add each kind's closed detail schema to `TIMELINE_DETAIL_SCHEMAS` (same pattern as P05-T12). Kinds (merchant-scoped joins, ordered by database time with deterministic tiebreak `(recorded time, kind order, id)` as P04 established):
   - `PROVIDER_ATTEMPT` per attempt, time `reserved_at`, detail `{ attemptNumber, outcomeClass (nullable), dispatchMarked: dispatch_marked_at IS NOT NULL, durationMs: response_received_at - dispatch_marked_at in ms or null }` (docs/05 example shape).
   - `PROVIDER_EVIDENCE` per evidence row, time `received_at`, detail `{ evidenceId, source, observedOutcome, applicationKind }` **[ASSUMPTION — docs/05 does not enumerate this shape]**.
   - `OPERATION_RESOLVED` per terminal operation, time `resolved_at`, detail `{ operationType, status, resolutionSource, resultCode }` **[ASSUMPTION]**.
   `paymentVersion` for each entry = the payment version current at that time (use `applied_payment_version` for evidence/resolution; for attempts, the latest lifecycle version not after `reserved_at`, as P04's helper computes).
2. Detail objects are built from explicit column lists; never `to_jsonb(row)`.

**Expected behavior** — Timeline after an approved authorization contains `OPERATION_ACCEPTED`, `PROVIDER_ATTEMPT` (`dispatchMarked: true`, `outcomeClass: 'SUCCESS'`), `PROVIDER_EVIDENCE`, `OPERATION_RESOLVED` in that order.

**Acceptance criteria**
- [ ] Entries ordered by database time; provider timestamps never used for ordering.
- [ ] No detail contains `provider_idempotency_key`, ciphertext, token, account IDs, request hashes, or `normalized_response`.
- [ ] Cross-tenant payment ID → 404.

**Testing requirements** — `test/integration/api/timeline-provider-entries.test.ts`: approved authorize, declined authorize, rate-limited-then-approved (two attempts), prohibited-field scan of every detail, cross-tenant 404. Command: `pnpm vitest run --project integration test/integration/api/timeline-provider-entries.test.ts`.

**Non-goals** — `LEDGER_POSTING`, `DISCREPANCY` (P07); `RECONCILIATION_ACTIVITY` (P08).

**Handoff checklist**
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P06-GATE — Provider-ready milestone verification

**Task ID:** `P06-GATE`
**Feature:** M6 exit gate (Provider-ready)
**Commit:** `test(worker): add P06 provider-ready gate scenarios and evidence`
**Priority:** Critical
**Dependencies:** `P06-T01` … `P06-T19`
**Estimated complexity:** L
**Contract references:** docs/10 M6 (all bullets); docs/06 §Required contract tests; docs/08 §Required failure-injection tests "Worker and provider" (P06-reachable rows); docs/09 §Provider contract tests, §Messaging integration tests (redelivery row).
**Files:** create: `test/e2e/p06-authorize-cancel.test.ts`, `test/chaos/p06-worker-crash-points.test.ts`, `test/integration/worker/p06-gate.test.ts`, `docs/evidence/P06.md`; must not touch: any non-test source file.

**Objective** — Prove the M6 exit gate end to end, across real processes where the contract is about processes.

**Implementation instructions**
1. `test/e2e/p06-authorize-cancel.test.ts` — spawn built `apps/api`, `apps/outbox-relay`, `apps/payment-worker`, `apps/provider-simulator` against Testcontainers PG (+ sim DB) and the Pub/Sub emulator transport: create → authorize (approve) → `AUTHORIZED`; create → authorize → cancel → `CANCELED`, `voided = authorized`, zero journal transactions; decline → `AUTHORIZATION_FAILED` summary and a second authorization accepted and approved (first of the three-attempt ceiling); `invalid_payment_method` → `FAILED` with proof, retry allowed. Poll via `GET /v1/operations/{id}` (a local loop; P07 adds shared helpers).
2. `test/chaos/p06-worker-crash-points.test.ts` (`FLOWLEDGER_FAULT_HOOKS=1`, worker spawned with `FLOWLEDGER_CRASH_POINTS=<point>` (SIGKILL, exit 137), then restarted without it), one case per point, asserting the P06-reachable recovery and the no-duplicate property (`sim.effects` per key ≤ 1 in every case):
   - `worker.before_claim` → after restart + redelivery, operation resolves; 1 effect.
   - `worker.after_claim_commit` → operation `PROCESSING`, attempt `RESERVED`, `dispatch_marked_at` null, zero simulator requests (reclaim after expiry is P08).
   - `worker.after_dispatch_mark` and `worker.during_provider_call` → redelivery does not issue a request while the lease is live; after the lease expires, still no new request (P06 has no path from dispatched `PROCESSING` back to execution); effects ≤ 1.
   - `worker.after_provider_response` → no evidence; no second request; effects = 1 (resolution is P08).
   - `worker.after_evidence_staged` → staged-evidence loop applies it; final state terminal; 1 effect.
   - `worker.after_result_commit` → redelivery acks `TERMINAL`; 1 effect; one terminal event.
   - `scheduler.after_enqueue_commit` with a `RATE_LIMITED` override → operation executes once after restart, not before `not_before`.
3. `test/integration/worker/p06-gate.test.ts`: seeded unreliable run — 200 authorizations with `SIMULATOR_FAULT_WEIGHTS={"NONE":60,"RATE_LIMITED":10,"UNAVAILABLE_NOT_EXECUTED":5,"TIMEOUT_AFTER_COMMIT":5,"CONNECTION_LOSS_AFTER_COMMIT":5,"MALFORMED_SUCCESS":5,"PROVIDER_5XX_AFTER_COMMIT":5,"LATENCY":5}` and fixed seed `p06-gate`; assert: every operation is terminal or `PROCESSING` with `UNKNOWN` evidence staged; no operation is `FAILED` without proof; for every operation, `sim.effects` count ≤ 1; every terminal `SUCCEEDED` has exactly 1 effect; every `REJECTED`/`FAILED` has 0; every attempt's key equals its operation key; payment versions advanced exactly once per terminal operation (event count = version delta); reservation/pointer invariants hold (deferred trigger never fired). Record the seed and counts.
4. `docs/evidence/P06.md`: commands run, seeds, per-test counts, list of M6 bullets with their test locations, and the known deferrals (R-06-03).

**Expected behavior** — All three files green; evidence note committed.

**Acceptance criteria**
- [ ] Every docs/10 M6 test bullet maps to a passing test listed in `docs/evidence/P06.md`.
- [ ] Conformance suite (P06-T10) green for both adapters in the same CI run.
- [ ] `pnpm check && pnpm test:integration && pnpm test:e2e && pnpm test:chaos` green.

**Testing requirements** — Commands: `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:chaos`.

**Non-goals** — Feature code of any kind.

**Handoff checklist**
- [ ] Evidence note lists seeds and counts.
- [ ] No skipped tests.

---

## Parallelization

| Group | Tasks | Notes / conflicts |
| --- | --- | --- |
| A (start immediately) | T01, T02, T03 | Disjoint files. T02 and T11+ share `migrations/06xx` numbering only. |
| B (simulator chain) | T04 → T05 → T06 → T07 | Serial: all touch `apps/provider-simulator/src/server.ts`/`pg-store.ts`. |
| C (database chain) | T11 → T12 → T13 → T14 | Serial: single-owner `migrations/` range and SECURITY DEFINER bodies (README §5.4). Can run in parallel with group B. |
| D (adapters) | T08 → T09 → T10 | After T01 + T06 (T08), T07 (T09). Parallel with group C. |
| E (worker) | T15 → T16 → {T17, T18} | T17 and T18 both modify `execute-handler.ts`/`main.ts` (T17 touches the handler, T18 `main.ts`); run them sequentially or rebase carefully. |
| F | T19 | After T14; independent of D/E. |
| Gate | P06-GATE | Last. |

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| M6: provider-neutral interface and capability checks | T01, T08 | `packages/providers/src/capabilities.test.ts` :: each rule; `adapters.write.test.ts` :: capability guard |
| M6: deterministic fake with stable records keyed by provider idempotency key | T03, T04, T05 | `apps/provider-simulator/src/core.test.ts` :: replay identity; `http.test.ts` :: 100 concurrent identical |
| M6: unreliable simulator (latency, rate limits, timeouts, connection loss, malformed, duplicate/out-of-order webhooks) | T06, T07, T08 | `test/integration/provider-simulator/faults.test.ts` :: per fault; `webhooks.test.ts` :: duplicate / out-of-order |
| M6: claim, payment/operation locking, `REQUESTED -> PROCESSING`, `RESERVED` attempt, lease, dispatch marker | T13, T16 | `execution-functions.test.ts` :: 50 concurrent claims; `execute-handler.test.ts` :: approve |
| M6: attempt, notification, evidence persistence with tenant/operation-safe keys and source-shape constraints | T11, T12 | `provider-evidence.test.ts` :: source shape, cross-tenant FK; `provider-notifications.test.ts` |
| M6: `RETRYABLE_NO_EFFECT` proof-bearing nonterminal handling | T14, T16 | `resolution-functions.test.ts` :: retry scheduling preserves versions; `execute-handler.test.ts` :: rate limited |
| M6: due-work scheduler `SKIP LOCKED`, clears `notBefore` + inserts command atomically | T14, T18 | `scheduler.test.ts` :: timing, concurrent loops, fault rollback |
| M6: decrypt payment method only before authorization command | T15, T16 | crypto test :: AAD tamper; `execute-handler.test.ts` :: cancel null reference, redaction scan |
| M6: provider calls without locks; stage evidence before applying | T16 | `execute-handler.test.ts` :: connection-held assertion; `p06-worker-crash-points.test.ts` :: after_evidence_staged |
| M6: apply authorization/cancellation outcomes through protected transitions | T14 | `resolution-functions.test.ts` :: six outcomes |
| M6: per-account limits, backoff, circuit breaking, fairness | T17 | `limiter.test.ts`; `isolation.test.ts` |
| Test: fake and unreliable pass same conformance suite | T10 | `test/integration/providers/conformance.test.ts` (both adapters) |
| Test: capability mismatch fails before attempt/provider write | T08, T16 | `conformance.test.ts` :: unsupported op zero requests; `execute-handler.test.ts` :: capability mismatch |
| Test: every transport retry reuses stable key | T10, T16, T18 | `conformance.test.ts` :: key in request log; `scheduler.test.ts` :: attempts #1/#2 same key |
| Test: success/rejection/no-effect/rate limit/auth/malformed/timeout/connection loss map exactly | T08, T10 | `classify.test.ts` :: table rows; `conformance.test.ts` :: classification |
| Test: ambiguous observations map to closed reason vocabulary (5xx, SDK exception, missing correlation, stale dispatch, adapter defect) | T08 | `classify.test.ts` :: `reconciliationReasonFor` cases (stale dispatch → `STALE_PROCESSING` is emitted by P08's sweeper; vocabulary constant asserted here) |
| Test: open circuit before dispatch leaves work queued | T17 | `isolation.test.ts` :: circuit-open deferral |
| Test: safe retry cannot dispatch before `notBefore`; crashes around scheduling | T18, GATE | `scheduler.test.ts`; `p06-worker-crash-points.test.ts` :: scheduler point |
| Test: proven-no-effect retry preserves payment version, totals, pointer/reservation, op id, key; op version +1 | T14 | `resolution-functions.test.ts` :: retry for AUTHORIZE and REFUND |
| Test: slow account cannot consume another account's budget | T17 | `isolation.test.ts` :: two accounts |
| Test: credentials, tokens, raw bodies absent from telemetry/evidence | T05, T08, T16 | `http.test.ts` :: log scan; `adapters.write.test.ts` :: redaction; `execute-handler.test.ts` :: redaction scan |
| docs/06: FAILED only with NoEffectProof; RETRYABLE requires proof + directive + bounded retryNotBefore | T01, T08, T11 | `adapter.types.test.ts` :: ts-expect-error; `classify.test.ts` :: property; `provider-evidence.test.ts` :: proof checks |
| docs/06: same key with changed semantics → CONFLICT | T04, T08, T10 | `core.test.ts` :: conflict; `conformance.test.ts` :: changed amount/currency/type/reference |
| docs/06: 100 identical same-key requests → one provider effect | T05, T10 | `http.test.ts`; `conformance.test.ts` |
| docs/06: live lease prevents second dispatch | T13, T16 | `execution-functions.test.ts` :: concurrent claims; `execute-handler.test.ts` :: redelivery while live |
| docs/06: timeout after provider commit → UNKNOWN though ground truth success | T06, T10, T16 | `conformance.test.ts` :: TIMEOUT_AFTER_COMMIT; `execute-handler.test.ts` :: timeout |
| docs/06: lookup read-only; NOT_FOUND inconclusive until window passes | T09, T10 | `adapters.read.test.ts` :: window boundary; `conformance.test.ts` :: lookup |
| docs/06: valid signatures verify, tampered do not | T07, T09, T10 | `adapters.read.test.ts`; `conformance.test.ts` :: webhooks |
| docs/06: startup validation rejects inconsistent capabilities | T01 | `capabilities.test.ts` |
| docs/06: SAME_KEY_REPLAY returns original effect, key never substituted | T10 | `conformance.test.ts` :: same-key replay |
| docs/06: rate-limit hints respected without sleeping in worker | T17, T14 | `limiter.test.ts` :: penalty; `resolution-functions.test.ts` :: durable `not_before` |
| docs/06: one provider outage does not consume another provider's capacity | T17 | `limiter.test.ts` :: per-provider cap |
| docs/07: `mark_dispatch` compares lease token; stale worker cannot mark | T13 | `execution-functions.test.ts` :: LEASE_LOST |
| docs/07: lease consistency trigger | T11 | `provider-attempts.test.ts` :: lease consistency |
| docs/07: evidence identity claim/read/compare; changed hash → identity conflict, no evidence | T13 | `execution-functions.test.ts` :: CONFLICT |
| docs/07: resolution evidence FK tenant/operation safe | T11 | `provider-evidence.test.ts` :: other operation's evidence |
| docs/07: operation version +1 per protected mutation; attempts/evidence alone do not | T13, T14 | `execution-functions.test.ts`; `resolution-functions.test.ts` |
| docs/03: duplicate terminal results → one transition | T14 | `resolution-functions.test.ts` :: 100× concurrent apply |
| docs/08 worker crash points (before claim … after result commit) | T02, T16, GATE | `test/chaos/p06-worker-crash-points.test.ts` :: one case per point |
| docs/08: redeliver execution command in every status; no duplicate provider action | T16, GATE | `execute-handler.test.ts` :: redelivery matrix (UNKNOWN/REQUIRES_REVIEW rows added in P08) |
| docs/08: simulate provider commit then timeout; no blind retry | T16, GATE | `execute-handler.test.ts` :: timeout; `p06-gate.test.ts` :: effects ≤ 1 |
| docs/09 provider contract tests (all bullets) | T10 | `conformance.test.ts` |
| docs/09 messaging: redeliver execution commands per status | T16 | `execute-handler.test.ts` :: redelivery matrix |
| docs/05 timeline includes attempts/evidence | T19 | `timeline-provider-entries.test.ts` |
| CONVENTIONS §11 secret references (`resolveSecretReference`, `local-secret://`) | T15, T08, T16 | `secrets.test.ts`; `conformance.test.ts` :: wrong key → AUTHENTICATION |
| CONVENTIONS §16 simulator process, own DB, truth role, test endpoints gated | T03, T05 | `schema.test.ts`; `http.test.ts` :: gating |
| Cross-phase (P03): `truth.provider_financial_effects` relation + `--require-ground-truth` in CI | T03 | `schema.test.ts` :: truth view columns, duplicate count, access denied to other roles |

## Phase risks / open questions

| ID | Risk / question | Impact | Severity | Recommended resolution | Blocked tasks |
| --- | --- | --- | --- | --- | --- |
| R-06-01 | README §4.3 assigns `apply_provider_evidence` (direct-response path) to P07, but docs/10 M6 (`docs/10-IMPLEMENTATION_PLAN.md:339`) requires authorization/cancellation outcomes in M6. | Two phases could both "create" the function. | Medium | P06 creates it for AUTHORIZE/CANCEL (contract wins); P07 replaces it in full (`CREATE OR REPLACE`) adding capture/refund and `UNAPPLIED_*` returns for contradictions; P08-T17 adds discrepancy recording. Update README §4.3 wording. | T14 |
| R-06-02 | Contracts name no function for staging direct-response evidence and no internal SQL error codes. **[ASSUMPTION]** `providers.stage_attempt_evidence` and the `P0001` messages in P06-T15 step 2. | CONVENTIONS §14.2 says stop on missing names. | Medium | Accept these names (they implement docs/07 §Transaction and lock ownership "Complete attempt/evidence" and docs/08 §Durable provider evidence); record in CONVENTIONS if the coordinator agrees. | T13, T15 |
| R-06-03 | With `mark_unknown` in P08, an `UNKNOWN` adapter result in P06 leaves the operation `PROCESSING` (attempt `RESPONSE_RECEIVED`, evidence staged) and the exclusive pointer held until P08's sweeper exists. | Payments stay blocked in a P06-only deployment after an ambiguous result; never a duplicate effect. | Low | Accept for the phase; documented in `docs/evidence/P06.md`; P08 replaces the `// P08: mark_unknown` branch. | T16 |
| R-06-04 | `provider_evidence.reconciliation_case_id` FK cannot exist until cases exist (P08); discrepancy events need cases, so P07 only stages contradictory evidence unapplied and P08-T17 records discrepancies (see R-07-01). | None if the FK is added when cases are created. | Low | Added by P08-T02 (which creates `reconciliation.cases`). | T11 |
| R-06-05 | docs/06 line 414 requires `CONFLICT` for same-key/different-semantics, followed by discrepancy and operator review, but `CONFLICT` is not in the nine reconciliation reasons (docs/06 line 482). | Adapter must choose an outcome. | Low | Map to `UNKNOWN` (blocks, never guesses) with category `CONFLICT`, code `PROVIDER_IDEMPOTENCY_CONFLICT`, reason `ADAPTER_DEFECT`; P08 routes it to review. | T08 |
| R-06-06 | `VerifiedProviderWebhook` (docs/06 lines 110–124) has no invalid-signature variant and no verified secret version, yet docs/07 notifications store `webhook_secret_version`. | P09 cannot learn which secret version verified. | Medium | P06 throws `WebhookVerificationError`; P09 calls `resolveWebhookSecrets` per version (or the adapter adds a non-contract helper) — P09 decides; flagged for contract clarification. | T09 (P09) |
| R-06-07 | Terminal-event `normalizedError.safeMessage` is required (schema minLength 1) but `provider_evidence` stores no safe message. | Event construction in SQL needs a value. | Low | **[ASSUMPTION]** `safeMessage = normalized_error_code`; propose adding a column only if a human-readable message is required. | T14 |
| R-06-08 | Operation correlation ID is "propagated to its operation" (docs/05 line 499) but `payment_operations` has no correlation column (docs/07). | SQL-built envelopes need it. | Low | **[ASSUMPTION]** read it from `api.idempotency_records` by `resource_id` (new partial index in 0630). | T13 |
| R-06-09 | P04/P05 interface names (payment-method crypto, consumer framework, crash hooks). | Interface mismatch at integration. | Low | **Resolved:** names taken from P04/P05 "Interfaces provided" (`decryptPaymentMethodRef`, `recordInboxMessage`/`processDelivery` helpers, `crashPoint`/`armCrashPoint`). | T02, T15, T16 |
| R-06-10 | `entity-ids.v1.schema.json` omits prefixes `pev_`, `pno_` (and other docs/07 prefixes) that docs/07 defines as table checks; CONVENTIONS §6 calls the schema authoritative. | `newId('pev')` may be rejected by P01's prefix list. | Medium | docs/07 is also a contract and defines them; ensure P01's prefix list includes every docs/07 table prefix (`pev`, `pno`, `pat`, `pacc`, `pac`, `pwe`, `fee`, `lac`, `led`, `ltx`, `lcr`, `case`); propose adding them to the schema's documentation. | T13, T16 |
| R-06-12 | P03's ground-truth relation is keyed only by provider idempotency key; docs/09 `P` counts effects "under this operation's stable provider idempotency key", so a blind retry with a *substituted* key would not be attributed to the original operation by key alone. | A substituted-key duplicate would surface only as `P = 0`/`L = 1` style mismatches, not `P > 1`. | High | **Resolved:** the adapter sends `paymentRef` (FlowLedger `paymentId`) and the operation type (both already in docs/06 `ProviderOperationCommand`); the simulator records them per effect and `truth.provider_financial_effects` exposes `(provider_idempotency_key, payment_ref, operation_type, effect_count)`. P03's duplicate-effect class adds a per-payment cardinality check (>1 AUTHORIZE/CAPTURE/CANCEL success, or REFUND effects > REFUND operations) that catches substituted-key duplicates; docs/09 `P` per key is unchanged. | T03, T04, T08 |
| R-06-11 | Unreliable client-side pre-send fault is deterministic per process, not across processes. | Cross-process replay of a seeded run may differ in pre-send faults only. | Low | Accept (`ponytail:` note); server-side faults, which carry the ambiguity, are cross-process deterministic. | T08 |
