# P01 — Domain kernel

## Phase overview

**Goal.** Implement `packages/domain` as pure, dependency-free TypeScript: branded identifiers and value constructors, checked `bigint` money, the capture-fee and cumulative refund-fee formulas, canonical API request hashing and canonical ledger posting hashing, the payment/operation state machine (guards, transitions, version rules, derived summary status), normalized provider result unions, retry classification/backoff, and stable provider idempotency keys. Milestone M1 in `docs/10-IMPLEMENTATION_PLAN.md` §M1; exit = docs/09 "Domain-ready" gate.

**Entry criteria.** `P00-GATE` green (workspace, Vitest projects, ESLint money rule active on `packages/domain/src/money.ts` and `fees.ts`, contracts generated).

**Exit gate.** `pnpm check` green with: every golden vector in this file passing; fast-check properties (fixed seed in CI) proving monetary invariants after every generated step, fee non-negativity/no-over-reversal/exact full reversal, hash determinism; type tests proving `FAILED` without proof and `SUCCEEDED` without provider operation ID do not compile; domain enums equal their contract enums.

**Package rules (apply to every task).** `packages/domain` imports nothing internal and no npm package except `ulid` (P01-T02) and, as devDependency, `fast-check`. Crypto uses `node:crypto`. No HTTP, SQL, Pub/Sub, provider SDK, or logging concerns. Expected failures are returned as `Result`; invariant breaches throw `DomainError` with code `INTERNAL_ERROR`. `number` is allowed only for versions, counts, basis-point-free metadata and milliseconds — never money (lint-enforced in `money.ts`/`fees.ts`).

### Interfaces consumed from earlier phases
- P00: Vitest `unit` project (`packages/*/src/**/*.test.ts`), `test/tsconfig.json` type-checks co-located tests, ESLint money rule, `packages/contracts` generated enums (only used by the GATE parity test, never imported by `domain`).

### Interfaces provided to later phases (all exported from `@flowledger/domain`)
| Module | Key exports |
| --- | --- |
| `errors.ts` | `DomainError`, `DomainErrorCode`, `DomainErrorReason`, `Result<T>`, `ok`, `err` |
| `money.ts` | `MinorUnits`, `MAX_AMOUNT_MINOR`, `INT64_MAX`, `Currency`, `minorUnits`, `parseAmountMinor`, `parsePositiveAmountMinor`, `parseCurrency`, `parseMoney`, `parsePositiveMoney`, `toAmountString`, `checkedAdd`, `checkedSub` |
| `ids.ts` | `ID_PREFIXES`, `IdPrefix`, `EntityId<P>`, `PaymentId`, `OperationId`, …, `newId`, `parseId`, `isId` |
| `values.ts` | `ProviderName`, `IdempotencyKey`, `CorrelationId`, `Timestamp`, `parseProviderName`, `parseIdempotencyKey`, `parseCorrelationId`, `parseTimestamp`, `toTimestamp` |
| `fees.ts` | `FeePolicyInputs`, `FeeSnapshot`, `computeCaptureFee`, `checkCaptureMinimum`, `targetFeeReversed`, `incrementalFeeReversal` |
| `canonical-json.ts` | `JsonValue`, `canonicalJson`, `sha256` |
| `request-hash.ts` | `CommandType`, `CanonicalRequestInput`, `canonicalRequestJson`, `computeRequestHash`, `COMMAND_ROUTES` |
| `posting-hash.ts` | `PostingOperationType`, `PostingLine`, `CanonicalEntry`, `PostingHashInput`, `canonicalizeEntries`, `computePostingHash`, `POSTING_HASH_VERSION` |
| `payment.ts` | `OperationType`, `OperationStatus`, `AuthorizationOutcome`, `SummaryStatus`, `PaymentState`, `OperationState`, `isUnresolved`, `isTerminal`, `exclusionClass`, `checkPaymentInvariants`, `deriveSummaryStatus` |
| `commands.ts` | `CommandRequest`, `acceptCommand` |
| `transitions.ts` | `claimOperation`, `scheduleNoEffectRetry`, `releaseDueOperation`, `markUnknown`, `requireReview`, `resolveOperation`, `applyAuthorizationExpiry`, `recordDiscrepancy` |
| `provider.ts` | docs/06 types (`ProviderOutcome`, `ProviderWriteResult`, `NormalizedProviderError`, `NoEffectProof`, `ProviderEvidence`, `ProviderLookupResult`, `ProviderAuthorizationLookupResult`, `ProviderCapabilities`, `PaymentProvider`, …) plus constructors `succeeded`, `rejected`, `failed`, `retryableNoEffect`, `unknownOutcome` |
| `retry.ts` | `MESSAGE_RETRY_SCHEDULE_MS`, `RECONCILIATION_SCHEDULE_MS`, `MAX_RETRY_AFTER_MS`, `backoff`, `boundRetryHint`, `classifyMessageFailure`, `classifyObservation`, `ReconciliationReason` |
| `provider-key.ts` | `ProviderEnvironment`, `deriveProviderIdempotencyKey` |
| Golden files | `packages/domain/golden/capture-fee.v1.json`, `refund-fee.v1.json`, `request-hash.v1.json`, `posting-hash.v1.json`, `provider-key.v1.json` — shared with PostgreSQL tests in P02/P03/P07 |

---

### P01-T01 — Domain errors, checked money, and property-test harness

**Task ID:** `P01-T01`
**Feature:** Money kernel
**Commit:** `feat(domain): add domain errors, branded minor-unit money, and seeded property-test harness`
**Priority:** Critical
**Dependencies:** P00-GATE
**Estimated complexity:** M
**Contract references:** docs/02 §Money representation; docs/05 §Money encoding, §Canonical error format; docs/07 §Common types; docs/10 §M1 (bullets 2, 8; AC 1, 8); docs/09 §Unit tests, §Property tests (seed persistence); CONVENTIONS §5, §7 (DomainError codes)
**Files:** create: `packages/domain/src/errors.ts`, `packages/domain/src/money.ts`, `packages/domain/src/money.test.ts`, `packages/testkit/src/fast-check-setup.ts`; modify: `packages/domain/src/index.ts`, `packages/domain/package.json` (devDep `fast-check`), `packages/testkit/package.json` (dep `fast-check`), `vitest.config.ts` (unit project `setupFiles`), `infra/docker/.env.example`, `docs/CONFIG.md`, `docs/VERSIONS.md`; must not touch: other packages' `src`

**Objective** — Provide the error/result vocabulary and the only money type every later layer uses: `bigint` minor units, strict decimal-string parsing with bounds, USD-only currency, and overflow-checked arithmetic; plus reproducible property testing with persisted counterexamples.

**Implementation instructions**
1. `errors.ts`:
   ```ts
   export const DOMAIN_ERROR_CODES = [ // subset of openapi ProblemCode (P01-GATE asserts subset)
     'INVALID_REQUEST', 'INVALID_AMOUNT', 'INVALID_IDEMPOTENCY_KEY', 'INVALID_CORRELATION_ID',
     'ACTIVE_OPERATION_EXISTS', 'INVALID_PAYMENT_STATE', 'MONETARY_GUARD_FAILED',
     'CAPTURE_BELOW_MINIMUM', 'INTERNAL_ERROR'] as const;
   export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];
   export type DomainErrorReason =
     | 'AMOUNT_NOT_STRING' | 'AMOUNT_MALFORMED' | 'AMOUNT_OUT_OF_RANGE' | 'AMOUNT_NOT_POSITIVE' | 'CURRENCY_UNSUPPORTED'
     | 'AMOUNT_OVERFLOW' | 'AMOUNT_NEGATIVE' | 'ID_MALFORMED' | 'VALUE_MALFORMED'
     | 'FEE_POLICY_INVALID' | 'GROSS_INVALID' | 'FEE_EXCEEDS_GROSS' | 'FEE_SNAPSHOT_INVALID' | 'REFUND_EXCEEDS_CAPTURE'
     | 'EXCLUSIVE_OPERATION_UNRESOLVED' | 'REFUND_UNRESOLVED' | 'GUARD_FAILED' | 'AUTHORIZATION_ATTEMPTS_EXHAUSTED'
     | 'CAPTURE_EXCEEDS_AUTHORIZED' | 'REFUND_EXCEEDS_REFUNDABLE' | 'BELOW_MINIMUM_CAPTURE'
     | 'ILLEGAL_OPERATION_TRANSITION' | 'EXPIRY_NOT_APPLICABLE' | 'ENTRIES_INVALID' | 'UNBALANCED_POSTING'
     | 'REFERENCES_INVALID' | 'NON_CANONICAL_JSON' | 'PROVIDER_KEY_LIMIT_TOO_SMALL';
   export class DomainError extends Error {
     constructor(readonly code: DomainErrorCode, readonly reason: DomainErrorReason, readonly detail?: Readonly<Record<string, string>>);
   } // message = `${code}:${reason}`; detail never contains raw input values
   export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DomainError };
   export const ok: <T>(value: T) => Result<T>; export const err: <T = never>(e: DomainError) => Result<T>;
   ```
   Later tasks append reasons only to this union (single owner per commit). **[ASSUMPTION A-01]** `reason` is a domain-internal stable detail; only `code` crosses the HTTP boundary.
2. `money.ts` (no `number` type, no `Number()`/`parseInt`/`Math`, no decimal literals — lint enforced):
   ```ts
   export type MinorUnits = bigint & { readonly __brand: 'MinorUnits' };
   export type Currency = 'USD';
   export const MAX_AMOUNT_MINOR: MinorUnits; // 1000000000000n
   export const INT64_MAX: bigint;             // 9223372036854775807n
   export function minorUnits(value: bigint): MinorUnits; // throws INTERNAL_ERROR/AMOUNT_NEGATIVE if < 0n, AMOUNT_OVERFLOW if > INT64_MAX
   export function parseAmountMinor(input: unknown): Result<MinorUnits>;          // 0..MAX
   export function parsePositiveAmountMinor(input: unknown): Result<MinorUnits>;  // 1..MAX
   export function parseCurrency(input: unknown): Result<Currency>;
   export function parseMoney(input: unknown): Result<{ amount: MinorUnits; currency: Currency }>;         // object with exactly amountMinor, currency
   export function parsePositiveMoney(input: unknown): Result<{ amount: MinorUnits; currency: Currency }>;
   export function toAmountString(a: MinorUnits): string;
   export function checkedAdd(a: MinorUnits, b: MinorUnits, limit?: bigint): MinorUnits; // default limit MAX_AMOUNT_MINOR; throws INTERNAL_ERROR/AMOUNT_OVERFLOW
   export function checkedSub(a: MinorUnits, b: MinorUnits): MinorUnits;                 // throws INTERNAL_ERROR/AMOUNT_NEGATIVE
   ```
   Parsing order: not a string → `INVALID_AMOUNT/AMOUNT_NOT_STRING` (JSON numbers rejected); length > 13 → `AMOUNT_OUT_OF_RANGE` (checked before `BigInt` to bound work); not `/^(0|[1-9][0-9]*)$/` → `AMOUNT_MALFORMED`; `> MAX` → `AMOUNT_OUT_OF_RANGE`; positive variant `'0'` → `AMOUNT_NOT_POSITIVE`. Currency: exactly `'USD'` else `INVALID_AMOUNT/CURRENCY_UNSUPPORTED` (docs/05 maps currency errors to `INVALID_AMOUNT`). `parseMoney` rejects extra keys with `INVALID_REQUEST/VALUE_MALFORMED`.
3. `packages/testkit/src/fast-check-setup.ts` (registered as `setupFiles` of the `unit` project in `vitest.config.ts`):
   ```ts
   import fc from 'fast-check';
   fc.configureGlobal({
     seed: Number(process.env.FC_SEED ?? '20261108'),
     numRuns: Number(process.env.FC_NUM_RUNS ?? '200'),
     reporter(details) {
       if (!details.failed) return;
       // append one JSON line: { test: expect.getState().currentTestName, seed, path, counterexample: fc.stringify(details.counterexample) }
       // to reports/property-failures.jsonl (mkdir -p reports), then throw new Error(fc.defaultReportMessage(details));
     },
   });
   ```
   `fc.stringify` is required because counterexamples contain `bigint`. CI already uploads `reports/` (P00-T14).
4. Add `FC_SEED` and `FC_NUM_RUNS` to `infra/docker/.env.example` (commented "test-only") and rows to `docs/CONFIG.md` (Read by: unit tests; default `20261108` / `200`).

**Expected behavior**
| Input | `parseAmountMinor` | `parsePositiveAmountMinor` |
| --- | --- | --- |
| `'0'` | ok `0n` | `INVALID_AMOUNT/AMOUNT_NOT_POSITIVE` |
| `'1'` | ok `1n` | ok `1n` |
| `'1000000000000'` | ok | ok |
| `'1000000000001'` | `AMOUNT_OUT_OF_RANGE` | `AMOUNT_OUT_OF_RANGE` |
| `'99999999999999'` (14 chars) | `AMOUNT_OUT_OF_RANGE` | same |
| `10000` (number) | `AMOUNT_NOT_STRING` | same |
| `'01'`, `'+1'`, `'-1'`, `'1.0'`, `'1e3'`, `' 1'`, `'1 '`, `'1,000'`, `''`, `'١'` | `AMOUNT_MALFORMED` | same |
| `null`, `{}` | `AMOUNT_NOT_STRING` | same |
- `parseCurrency('EUR')`, `parseCurrency('usd')` → `INVALID_AMOUNT/CURRENCY_UNSUPPORTED`.
- `checkedAdd(MAX, 1n)` throws `INTERNAL_ERROR/AMOUNT_OVERFLOW`; `checkedAdd(MAX, 1n, INT64_MAX)` → `1000000000001n`; `checkedSub(1n, 2n)` throws `AMOUNT_NEGATIVE`.

**Acceptance criteria**
- [ ] Every row above is a test case.
- [ ] `toAmountString(parse(s)) === s` for every valid `s` (property).
- [ ] No `number` appears in `money.ts` (ESLint passes with the P00-T02 rule).
- [ ] A deliberately failing property writes one line to `reports/property-failures.jsonl` containing `seed`, `path`, and a minimized `counterexample` (verified once locally, not committed).

**Testing requirements**
- `packages/domain/src/money.test.ts`: the table cases; `non-USD rejected`; `parseMoney extra key rejected`; `parseMoney missing currency rejected`; `checkedAdd/checkedSub boundaries`; `minorUnits rejects negative`; property `round-trip for all bigint in [0, MAX]` (`fc.bigInt({ min: 0n, max: 1000000000000n })`); property `strings of arbitrary unicode never parse unless canonical`.
- Command: `pnpm vitest run --project unit packages/domain/src/money.test.ts` and `pnpm check`.

**Non-goals** — No fee math (T04); no DB OID-20 parser (P02); no JSON-number detection in raw HTTP bodies (P04 parses strings).

**Handoff checklist**
- [ ] Each malformed case observed passing only because of the regex (temporarily loosen the regex → tests fail).
- [ ] Commit body contains `Task: P01-T01` and `fast-check` (approved) noted.

---

### P01-T02 — Branded entity identifiers

**Task ID:** `P01-T02`
**Feature:** Identifiers
**Commit:** `feat(domain): add prefixed ULID identifiers with branded types`
**Priority:** Critical
**Dependencies:** P01-T01
**Estimated complexity:** S
**Contract references:** schemas/common/entity-ids.v1.schema.json; docs/07 §IDs and every table's `PK; <prefix>_ ULID check`; docs/05 §General conventions, §Request and correlation identifiers (`req_`); CONVENTIONS §6
**Files:** create: `packages/domain/src/ids.ts`, `packages/domain/src/ids.test.ts`; modify: `packages/domain/src/index.ts`, `packages/domain/package.json` (dep `ulid`), `docs/VERSIONS.md`; must not touch: `schemas/**`

**Objective** — One branded type and one strict parser per public entity prefix so that a payment ID can never be passed where an operation ID is expected, and malformed IDs are rejected at the boundary.

**Implementation instructions**
1. `ID_PREFIXES` (union of `entity-ids.v1.schema.json` and docs/07 PK checks plus `req_` from openapi; see R-01):
   ```ts
   export const ID_PREFIXES = {
     merchant: 'mer', merchantCredential: 'mcr', providerAccount: 'pacc', providerAccountCredential: 'pac',
     providerWebhookEndpoint: 'pwe', feePolicy: 'fee', payment: 'pay', operation: 'op', providerAttempt: 'pat',
     providerNotification: 'pno', providerEvidence: 'pev', ledger: 'led', ledgerAccount: 'lac', ledgerTransaction: 'ltx',
     correctionRequest: 'lcr', settlementRun: 'srn', settlementBatch: 'sbt', webhookEndpoint: 'whe',
     webhookDelivery: 'whd', reviewCase: 'case', request: 'req',
   } as const;
   export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];
   export type EntityId<P extends IdPrefix> = string & { readonly __idPrefix: P };
   export type MerchantId = EntityId<'mer'>; export type PaymentId = EntityId<'pay'>; export type OperationId = EntityId<'op'>;
   // …one alias per entry: ProviderAccountId, ProviderAttemptId, ProviderEvidenceId, LedgerId, LedgerAccountId,
   // LedgerTransactionId, SettlementRunId, SettlementBatchId, WebhookEndpointId, WebhookDeliveryId, ReviewCaseId, RequestId, …
   export function newId<P extends IdPrefix>(prefix: P, nowMs?: number): EntityId<P>; // `${prefix}_${ulid(nowMs)}`
   export function parseId<P extends IdPrefix>(prefix: P, input: unknown): Result<EntityId<P>>; // INVALID_REQUEST/ID_MALFORMED
   export function isId<P extends IdPrefix>(prefix: P, input: unknown): input is EntityId<P>;
   ```
   Regex: `^<prefix>_[0-7][0-9A-HJKMNP-TV-Z]{25}$` (case-sensitive; first char `0`–`7`; `I`, `L`, `O`, `U` forbidden).
2. `newId` uses `ulid` (exact pin). `nowMs` exists only for deterministic tests.

**Expected behavior**
- `parseId('pay', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV')` → ok.
- `parseId('pay', 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV')`, `'pay_81ARZ3NDEKTSV4RRFFQ69G5FAV'` (overflow), `'pay_01arz3ndektsv4rrffq69g5fav'`, `'pay_01ARZ3NDEKTSV4RRFFQ69G5FAI'` (I), `'pay_01ARZ3NDEKTSV4RRFFQ69G5FA'` (25 chars), `'pay_01ARZ3NDEKTSV4RRFFQ69G5FAVV'` (27) → `INVALID_REQUEST/ID_MALFORMED`.
- `newId('op', 1730832271123)` matches the operation regex and starts with the timestamp-encoded ULID prefix.

**Acceptance criteria**
- [ ] Every prefix in `entity-ids.v1.schema.json` `$defs` patterns is present in `ID_PREFIXES` (asserted again at P01-GATE against generated schemas).
- [ ] Passing a `PaymentId` where `OperationId` is required is a compile error (type test).
- [ ] 10 000 generated IDs per prefix all parse.

**Testing requirements**
- `packages/domain/src/ids.test.ts`: the expected-behavior cases; `each prefix round-trips newId → parseId`; `non-string rejected`; type test block: `// @ts-expect-error PaymentId is not OperationId` assigning one to the other (type-checked by `test/tsconfig.json`); property: `any string not matching regex is rejected` (`fc.string()` filtered).
- Command: `pnpm vitest run --project unit packages/domain/src/ids.test.ts && pnpm typecheck`.

**Non-goals** — No ULID entropy/bucket derivation (P03 `ledger.bucket_for_payment` + its TS mirror); no UUID envelope IDs (`crypto.randomUUID()` used directly by producers).

**Handoff checklist**
- [ ] `docs/VERSIONS.md` records `ulid`.
- [ ] Commit body contains `Task: P01-T02`.

---

### P01-T03 — Strict value constructors (provider name, idempotency key, correlation ID, timestamp)

**Task ID:** `P01-T03`
**Feature:** Value types
**Commit:** `feat(domain): add strict constructors for provider name, idempotency key, correlation id, and timestamp`
**Priority:** High
**Dependencies:** P01-T01
**Estimated complexity:** S
**Contract references:** docs/05 §General conventions (millisecond UTC timestamps), §API idempotency contract (key format), §Request and correlation identifiers; openapi.yaml `ProviderName`, `IdempotencyKey`, `CorrelationId`, `Timestamp`; docs/10 §M1 bullet 1
**Files:** create: `packages/domain/src/values.ts`, `packages/domain/src/values.test.ts`; modify: `packages/domain/src/index.ts`; must not touch: `money.ts`

**Objective** — Close the remaining docs/10 §M1 "strict constructors" list with exact contract patterns and boundary-specific error codes.

**Implementation instructions**
```ts
export type ProviderName = string & { readonly __brand: 'ProviderName' };
export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };
export type CorrelationId = string & { readonly __brand: 'CorrelationId' };
export type Timestamp = string & { readonly __brand: 'Timestamp' }; // UTC, exactly milliseconds, 'Z'
export function parseProviderName(input: unknown): Result<ProviderName>;       // /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/, INVALID_REQUEST/VALUE_MALFORMED
export function parseIdempotencyKey(input: unknown): Result<IdempotencyKey>;   // /^[A-Za-z0-9._:-]{16,128}$/, INVALID_IDEMPOTENCY_KEY/VALUE_MALFORMED
export function parseCorrelationId(input: unknown): Result<CorrelationId>;     // /^[A-Za-z0-9._:-]{16,128}$/, INVALID_CORRELATION_ID/VALUE_MALFORMED
export function parseTimestamp(input: unknown): Result<Timestamp>;             // /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ AND new Date(s).toISOString() === s, INVALID_REQUEST/VALUE_MALFORMED
export function toTimestamp(date: Date): Timestamp;                             // date.toISOString(); throws INTERNAL_ERROR on invalid Date
```
Values are case-sensitive and never normalized (docs/05 §Canonical request hash).

**Expected behavior**
- Provider: `'fake-provider'` ok; `'a'` ok; `'Fake'`, `'-x'`, `'x-'`, 64-char name, `''` → error.
- Idempotency key: 16 chars ok, 128 ok, 15 and 129 rejected, `'0192f4e7-8b30-7c83-b462-c0d5fe8f132a'` ok, `'key with space....'` rejected.
- Timestamp: `'2026-11-05T18:44:31.123Z'` ok; `'2026-11-05T18:44:31Z'`, `'2026-11-05T18:44:31.12Z'`, `'2026-11-05T18:44:31.123+00:00'`, `'2026-02-30T00:00:00.000Z'` rejected.

**Acceptance criteria**
- [ ] Each expected-behavior case is a test.
- [ ] Error codes match the HTTP problem codes above.

**Testing requirements** — `packages/domain/src/values.test.ts` with the cases above plus property `toTimestamp(d)` always parses for `fc.date({ min: new Date('1970-01-01'), max: new Date('9999-12-31') })`. Command: `pnpm vitest run --project unit packages/domain/src/values.test.ts`.

**Non-goals** — No ETag parsing (request-hash validates `If-Match` text in T05); no payment-method token validation (P04).

**Handoff checklist**
- [ ] Commit body contains `Task: P01-T03`.

---

### P01-T04 — Capture fee and cumulative proportional refund-fee reversal

**Task ID:** `P01-T04`
**Feature:** Fee arithmetic
**Commit:** `feat(domain): implement capture fee and cumulative refund-fee reversal with golden vectors`
**Priority:** Critical
**Dependencies:** P01-T01
**Estimated complexity:** M
**Contract references:** docs/02 §Capture-fee calculation, §Minimum capture amount, §Refund accounting, §Required property tests "Fee allocation under concurrent refunds"; docs/07 §`payments.fee_policies` (basis points `0..10000`, fixed `0..1000000000000`, minimum ≥ max(fixed,1)); ADR-0008; docs/09 §Fee allocation; docs/10 §M1 bullet 4, AC 3–4
**Files:** create: `packages/domain/src/fees.ts`, `packages/domain/src/fees.test.ts`, `packages/domain/golden/capture-fee.v1.json`, `packages/domain/golden/refund-fee.v1.json`; modify: `packages/domain/src/index.ts`; must not touch: `money.ts`

**Objective** — Implement exactly
```text
percentageFee = floor((G * B + 5000) / 10000)
F             = percentageFee + K
targetFeeReversed(R)   = floor(F * R / G)
incrementalFeeReversal = targetFeeReversed(R0 + a) - targetFeeReversed(R0)
```
with checked `bigint` arithmetic, and lock it with golden vectors and properties.

**Implementation instructions**
1. API (no `number` anywhere in this file — lint enforced; basis points are `bigint`):
   ```ts
   export interface FeePolicyInputs { readonly basisPoints: bigint; readonly fixedAmount: MinorUnits; readonly minimumCaptureAmount: MinorUnits }
   export interface FeeSnapshot { readonly basisPoints: bigint; readonly fixedAmount: MinorUnits; readonly captureFee: MinorUnits; readonly captureGross: MinorUnits }
   export function computeCaptureFee(gross: MinorUnits, basisPoints: bigint, fixedAmount: MinorUnits): MinorUnits;
   export function checkCaptureMinimum(gross: MinorUnits, minimumCaptureAmount: MinorUnits): Result<void>;
   export function checkFeePolicy(policy: FeePolicyInputs): Result<void>; // INTERNAL_ERROR/FEE_POLICY_INVALID; see step 7 and R-12
   export function targetFeeReversed(captureFee: MinorUnits, cumulativeRefunded: MinorUnits, captureGross: MinorUnits): MinorUnits;
   export function incrementalFeeReversal(i: { captureFee: MinorUnits; captureGross: MinorUnits; confirmedRefundedBefore: MinorUnits; refundAmount: MinorUnits }): MinorUnits;
   ```
2. `computeCaptureFee` check order (all throw `DomainError('INTERNAL_ERROR', reason)` — these are invariant breaches, never client errors, and the fee is never capped):
   1. `basisPoints < 0n || basisPoints > 10000n || fixedAmount > MAX` → `FEE_POLICY_INVALID`.
   2. `gross < 1n || gross > MAX` → `GROSS_INVALID`.
   3. Compute `F` in unbounded `bigint`.
   4. `F > MAX_AMOUNT_MINOR` → `AMOUNT_OVERFLOW`.
   5. `F > gross` → `FEE_EXCEEDS_GROSS` (docs/02 "asserts `0 <= F <= G` as a protected invariant").
3. `checkCaptureMinimum`: `gross < minimumCaptureAmount` → `err(DomainError('CAPTURE_BELOW_MINIMUM', 'BELOW_MINIMUM_CAPTURE', { minimumAmountMinor: toAmountString(minimum) }))` (docs/05: the problem detail names the minimum).
4. `targetFeeReversed`: requires `0 <= F <= G`, `1 <= G <= MAX` (else `FEE_SNAPSHOT_INVALID`), `0 <= R <= G` (else `REFUND_EXCEEDS_CAPTURE`). Intermediate `F * R` reaches `10^24`; JavaScript `bigint` is exact. (PostgreSQL implementations must use `numeric`, not `bigint` — R-05.)
5. `incrementalFeeReversal`: `R1 = R0 + a` (unbounded), `a >= 1`, `R1 <= G` else `REFUND_EXCEEDS_CAPTURE`; return `target(R1) - target(R0)`.
6. `checkFeePolicy` (the policy-insertion rule P02 must mirror as a SQL `CHECK`, R-12): `0 <= basisPoints <= 10000`; `0 <= fixedAmount <= MAX`; `minimumCaptureAmount >= max(fixedAmount, 1)` (docs/07); **and** `floor((minimum * bp + 5000) / 10000) + fixed <= minimum`. Because `F(G) - G` is non-increasing in `G` for `bp <= 10000`, the last condition guarantees `F <= G` for every `G >= minimum` — the property the contract claims but its stated check alone does not ensure (e.g. bp 5000, fixed 30, minimum 30, G 40 → F 50 > 40).
7. Golden files (JSON, amounts as decimal strings) — contents exactly the vectors below; tests iterate the files. P07's PostgreSQL refund confirmation reuses `refund-fee.v1.json`.

**Golden vectors — capture fee** (`capture-fee.v1.json`; computed during planning from the docs/02 formula)
| id | G | B | K | G·B | percentageFee | Expected |
| --- | --- | --- | --- | --- | --- | --- |
| `below-half` | 8003 | 333 | 0 | 2664999 (266.4999 units) | 266 | F = **266** |
| `exact-half` | 5000 | 333 | 0 | 1665000 (166.5) | 167 | F = **167** (HALF_UP) |
| `above-half` | 1997 | 333 | 0 | 665001 (66.5001) | 67 | F = **67** |
| `docs-example` | 10000 | 300 | 0 | 3000000 | 300 | F = **300** (docs/02 USD 100 → USD 3.00) |
| `fixed-plus-percentage` | 10000 | 290 | 30 | 2900000 | 290 | F = **320** |
| `fixed-plus-half` | 5000 | 333 | 25 | 1665000 | 167 | F = **192** (rounding before fixed is added) |
| `zero-fee` | 10000 | 0 | 0 | 0 | 0 | F = **0** |
| `fee-equals-gross-fixed` | 30 | 0 | 30 | 0 | 0 | F = **30** = G (valid boundary) |
| `fee-equals-gross-percentage` | 1000000000000 | 10000 | 0 | 10^16 | 1000000000000 | F = **1000000000000** = G (valid) |
| `max-gross-typical` | 1000000000000 | 290 | 30 | 2.9·10^14 | 29000000000 | F = **29000000030** |
| `fee-greater-than-gross` | 29 | 0 | 30 | 0 | 0 | throws `INTERNAL_ERROR/FEE_EXCEEDS_GROSS` |
| `overflow` | 1000000000000 | 10000 | 1 | 10^16 | 1000000000000 | F would be 1000000000001 > MAX → throws `INTERNAL_ERROR/AMOUNT_OVERFLOW` (checked before step 5) |
| `basis-points-above-10000` | 100 | 10001 | 0 | — | — | throws `FEE_POLICY_INVALID` |
| `gross-zero` | 0 | 290 | 30 | — | — | throws `GROSS_INVALID` |
| `minimum-boundary` | `checkCaptureMinimum(30, 30)` ok; `checkCaptureMinimum(29, 30)` → `CAPTURE_BELOW_MINIMUM` with `detail.minimumAmountMinor = '30'` |

**Golden vectors — refund fee reversal** (`refund-fee.v1.json`; each row lists refunds in confirmation order and the expected incremental reversal per refund)
| id | F | G | Refund amounts (in order) | Expected increments | Sum |
| --- | --- | --- | --- | --- | --- |
| `docs-example` | 300 | 10000 | 5000 | 150 | 150 (docs/02 USD 50 → USD 1.50) |
| `thirds` | 320 | 10000 | 3333, 3333, 3334 | 106, 107, 107 | 320 = F |
| `order-a` | 7 | 10 | 3, 3, 4 | 2, 2, 3 (the 4-unit refund gets 3) | 7 |
| `order-b` | 7 | 10 | 4, 3, 3 | 2, 2, 3 (the 4-unit refund gets 2) | 7 — same set, single allocation differs by exactly 1 |
| `ten-singles` | 7 | 10 | 1 ×10 | 0, 1, 1, 0, 1, 1, 0, 1, 1, 1 | 7 |
| `fee-equals-gross` | 30 | 30 | 10, 20 | 10, 20 | 30 |
| `zero-fee` | 0 | 5000 | 2500, 2500 | 0, 0 | 0 |
| `max-values` | 1000000000000 | 1000000000000 | 1, 999999999999 | 1, 999999999999 | F (intermediate F·R = 10^24) |
| `rejected-refund-skipped` | 320 | 10000 | confirmed 2500; a 5000 refund is **rejected** (never passed to the function); then confirmed 7500 | 80, 240 | 320 |
| `exceeds-capture` | 320 | 10000 | 6000 then 4001 | 192, then throws `REFUND_EXCEEDS_CAPTURE` | — |

**Expected behavior** — every golden row reproduces exactly; errors carry the listed reason.

**Acceptance criteria**
- [ ] Every golden row is asserted from the JSON files (not duplicated literals).
- [ ] Properties below pass at the CI seed and 1 000 runs locally (`FC_NUM_RUNS=1000`).
- [ ] No floating point: lint passes; no `Number`, `Math`, or decimal literal in `fees.ts`.

**Testing requirements**
- `packages/domain/src/fees.test.ts`:
  - `capture-fee golden <id>` for each row; `refund-fee golden <id>` for each row.
  - Property `percentage component is HALF_UP`: for `G ∈ [1, MAX]`, `B ∈ [0, 10000]`, `F - K` equals the unique integer `p` with `|G·B - p·10000| ≤ 5000` and ties (`= 5000`) rounding up.
  - Property `checkFeePolicy guarantees F ≤ G`: for every generated policy with `checkFeePolicy(policy).ok` and every `G ∈ [minimum, MAX]`, `computeCaptureFee` does not throw `FEE_EXCEEDS_GROSS`.
  - `checkFeePolicy` cases: `bp 5000 / fixed 30 / minimum 30 rejected` (F(30)=45 > 30), `bp 290 / fixed 30 / minimum 31 accepted` (F(31)=31, so fee == gross at the boundary), `bp 290 / fixed 30 / minimum 30 rejected` (F(30)=31 > 30 — the case that the pre-D-07 rule wrongly accepted), `bp 10000 / fixed 0 / minimum 1 accepted`, `bp 10000 / fixed 1 / minimum 1000 rejected`, `minimum < fixed rejected`, `minimum 0 rejected`, `bp 10001 rejected`.
  - Property `FEE_EXCEEDS_GROSS thrown iff F > G` for unconstrained inputs.
  - Property `non-negative increments`: random `G ∈ [1, MAX]`, `F ∈ [0, G]`, random partition of `G` into 1–20 positive refunds, random permutation → every increment ≥ 0.
  - Property `no over-reversal at any prefix`: cumulative increments ≤ `F` and equal `target(prefix sum)`.
  - Property `exact full reversal`: increments over a full partition sum to `F` for every permutation.
  - Property `order independence of total, ≤1 per-refund variance`: two permutations of the same refund set → equal totals; each refund's allocation differs by ≤ 1.
  - Property `rejected refunds contribute nothing`: drop a random subset (rejected), confirm the rest → sum equals `target(sum of confirmed)`.
- Command: `pnpm vitest run --project unit packages/domain/src/fees.test.ts`.

**Non-goals** — No ledger recipes (P03); no fee-policy persistence (P02); no rounding-account postings (fee formula leaves no residual).

**Handoff checklist**
- [ ] Changing `+ 5000n` to `+ 4999n` makes `exact-half` fail; changing `floor` semantics in refund makes `thirds` fail (observed, restored).
- [ ] Commit body contains `Task: P01-T04`.

---

### P01-T05 — Canonical JSON (RFC 8785 subset) and canonical API request hash

**Task ID:** `P01-T05`
**Feature:** Idempotency hashing
**Commit:** `feat(domain): add canonical JSON and versioned API request hash with golden vectors`
**Priority:** Critical
**Dependencies:** P01-T02, P01-T03
**Estimated complexity:** M
**Contract references:** docs/05 §Canonical request hash (lines 414-434), §Optimistic version preconditions (`If-Match` participates), §API idempotency contract (`command_type` values); ADR-0006; openapi.yaml paths with `x-flowledger-command-type`, `PaymentETag`; docs/07 §`api.idempotency_records` (`request_hash bytea`, 32 bytes); docs/10 §M1 bullet 5, AC 5
**Files:** create: `packages/domain/src/canonical-json.ts`, `packages/domain/src/canonical-json.test.ts`, `packages/domain/src/request-hash.ts`, `packages/domain/src/request-hash.test.ts`, `packages/domain/golden/request-hash.v1.json`; modify: `packages/domain/src/index.ts`; must not touch: `fees.ts`

**Objective** — Produce a deterministic SHA-256 over a canonical semantic request so that identical commands replay and any semantic change (path ID, amount, currency, provider, payment-method reference, `If-Match`) conflicts.

**Implementation instructions**
1. `canonical-json.ts`:
   ```ts
   export type JsonValue = null | boolean | string | number | readonly JsonValue[] | { readonly [k: string]: JsonValue };
   export function canonicalJson(value: JsonValue): string;   // RFC 8785 serialization restricted to safe integers
   export function sha256(text: string): Uint8Array;          // node:crypto, UTF-8 bytes of text, 32-byte digest
   export function toHex(bytes: Uint8Array): string;          // lowercase
   ```
   Rules: object keys sorted by UTF-16 code units (`Object.keys(o).sort()` default comparator); no whitespace; strings serialized by `JSON.stringify` (identical to RFC 8785 for well-formed strings); numbers must satisfy `Number.isSafeInteger` and are written with `String(n)` (`-0` written as `0`); arrays keep order. Throw `DomainError('INTERNAL_ERROR','NON_CANONICAL_JSON')` for non-safe-integer numbers, `bigint`, `undefined`, functions, symbols, non-plain objects, and strings containing a lone surrogate (docs/05: invalid Unicode is rejected before hashing). **[ASSUMPTION A-02]** Restricting numbers to safe integers keeps TS and PostgreSQL byte-identical; contract money is always a string.
2. `request-hash.ts`:
   ```ts
   export type CommandType = 'CREATE_PAYMENT' | 'AUTHORIZE' | 'CAPTURE' | 'CANCEL' | 'REFUND';
   export const COMMAND_ROUTES: { readonly [C in CommandType]: { readonly method: 'POST'; readonly route: string; readonly pathParams: readonly string[] } } = {
     CREATE_PAYMENT: { method: 'POST', route: '/v1/payments', pathParams: [] },
     AUTHORIZE: { method: 'POST', route: '/v1/payments/{paymentId}/authorizations', pathParams: ['paymentId'] },
     CAPTURE:   { method: 'POST', route: '/v1/payments/{paymentId}/captures', pathParams: ['paymentId'] },
     CANCEL:    { method: 'POST', route: '/v1/payments/{paymentId}/cancellations', pathParams: ['paymentId'] },
     REFUND:    { method: 'POST', route: '/v1/payments/{paymentId}/refunds', pathParams: ['paymentId'] },
   };
   export interface CanonicalRequestInput {
     readonly commandType: CommandType;
     readonly pathParams: Readonly<Record<string, string>>; // exactly the keys in COMMAND_ROUTES[commandType].pathParams
     readonly body: JsonValue;                               // the schema-validated body (unknown fields already rejected upstream)
     readonly ifMatch: string | null;                        // exact header text incl. quotes, or null when omitted
   }
   export function canonicalRequestJson(input: CanonicalRequestInput): Result<string>;
   export function computeRequestHash(input: CanonicalRequestInput): Result<Uint8Array>; // sha256(canonicalRequestJson)
   ```
   **[ASSUMPTION A-03]** — docs/05 lists the six hash inputs but not their byte encoding. The canonical object is exactly:
   ```json
   {"apiVersion":"v1","body":<body>,"commandType":"<C>","hashVersion":1,"ifMatch":<string|null>,"method":"POST","pathParams":{...},"route":"<template>"}
   ```
   serialized with `canonicalJson`, hashed as UTF-8 with SHA-256. Validation before hashing (else `INVALID_REQUEST/VALUE_MALFORMED`): `pathParams` key set equals the template's; `paymentId` passes `parseId('pay', …)`; `ifMatch` is `null` or matches `^"payment-pay_[0-7][0-9A-HJKMNP-TV-Z]{25}-v[1-9][0-9]*"$` (strong single Payment ETag; weak tags and lists rejected). Merchant, idempotency key, credentials, request/correlation IDs, and `traceparent` are not inputs (docs/05).

**Golden vectors** (`request-hash.v1.json`; `P = pay_01ARZ3NDEKTSV4RRFFQ69G5FAV`; canonical JSON shown is the exact hashed UTF-8 text; SHA-256 lowercase hex computed during planning). The `pm_sandbox_123` value in the two `create` bodies is a synthetic byte sequence standing in for a payment-method reference: request hashing never validates the token, so these digests are unaffected by which token family the API accepts. Do not change those bodies without recomputing both digests.
| id | Input (commandType / pathParams / body / ifMatch) | Canonical JSON | SHA-256 |
| --- | --- | --- | --- |
| `create` | CREATE_PAYMENT / `{}` / `{"amount":{"amountMinor":"10000","currency":"USD"},"paymentMethodRef":"pm_sandbox_123","provider":"fake-provider"}` / null | `{"apiVersion":"v1","body":{"amount":{"amountMinor":"10000","currency":"USD"},"paymentMethodRef":"pm_sandbox_123","provider":"fake-provider"},"commandType":"CREATE_PAYMENT","hashVersion":1,"ifMatch":null,"method":"POST","pathParams":{},"route":"/v1/payments"}` | `8ad048fb808f257f1a6d7e0684728cc35648d9efc251977f8a4a457127fff893` |
| `create-provider-omitted` | same without `provider` | `{"apiVersion":"v1","body":{"amount":{"amountMinor":"10000","currency":"USD"},"paymentMethodRef":"pm_sandbox_123"},"commandType":"CREATE_PAYMENT","hashVersion":1,"ifMatch":null,"method":"POST","pathParams":{},"route":"/v1/payments"}` | `fb1dfc30967cc6700d1c68a60dc66641b9c4d0e24caac5977dafcc0fd06b3c31` |
| `authorize-no-if-match` | AUTHORIZE / `{paymentId:P}` / `{}` / null | `{"apiVersion":"v1","body":{},"commandType":"AUTHORIZE","hashVersion":1,"ifMatch":null,"method":"POST","pathParams":{"paymentId":"pay_01ARZ3NDEKTSV4RRFFQ69G5FAV"},"route":"/v1/payments/{paymentId}/authorizations"}` | `a1230cd21ed16a0405bf191af6e227a8fb15b968942b1adcbec6a88de492c378` |
| `authorize-if-match` | same, ifMatch `"payment-pay_01ARZ3NDEKTSV4RRFFQ69G5FAV-v1"` | `…"ifMatch":"\"payment-pay_01ARZ3NDEKTSV4RRFFQ69G5FAV-v1\"",…` (otherwise identical) | `87529151b8a259faf86f4879bb3b7fc309576ffa0b7a62d97236fa70abfe38b2` |
| `capture` | CAPTURE / `{paymentId:P}` / `{"amount":{"amountMinor":"10000","currency":"USD"}}` / `"payment-pay_01ARZ3NDEKTSV4RRFFQ69G5FAV-v3"` | `{"apiVersion":"v1","body":{"amount":{"amountMinor":"10000","currency":"USD"}},"commandType":"CAPTURE","hashVersion":1,"ifMatch":"\"payment-pay_01ARZ3NDEKTSV4RRFFQ69G5FAV-v3\"","method":"POST","pathParams":{"paymentId":"pay_01ARZ3NDEKTSV4RRFFQ69G5FAV"},"route":"/v1/payments/{paymentId}/captures"}` | `33451ce36d3080ffc06e2a3fb87d6fd5648fc6186d4244ece088a143270ed5a9` |
| `capture-amount-changed` | as `capture` with `amountMinor: "10001"` | (amount differs) | `7fd0ff71fe706f76a7e3127fe33af9d6664c11cb2ba73b814f13ba310dcd9061` |
| `refund` | REFUND / `{paymentId:P}` / `{"amount":{"amountMinor":"2500","currency":"USD"}}` / `"payment-pay_01ARZ3NDEKTSV4RRFFQ69G5FAV-v5"` | `{"apiVersion":"v1","body":{"amount":{"amountMinor":"2500","currency":"USD"}},"commandType":"REFUND","hashVersion":1,"ifMatch":"\"payment-pay_01ARZ3NDEKTSV4RRFFQ69G5FAV-v5\"","method":"POST","pathParams":{"paymentId":"pay_01ARZ3NDEKTSV4RRFFQ69G5FAV"},"route":"/v1/payments/{paymentId}/refunds"}` | `df88a3bd0f7469c0014c7bfad8abdab17f2a858a26f04fdb65a1957cae7ce942` |
| `cancel-no-if-match` | CANCEL / `{paymentId:P}` / `{}` / null | `{"apiVersion":"v1","body":{},"commandType":"CANCEL","hashVersion":1,"ifMatch":null,"method":"POST","pathParams":{"paymentId":"pay_01ARZ3NDEKTSV4RRFFQ69G5FAV"},"route":"/v1/payments/{paymentId}/cancellations"}` | `5dee2b77d014659d4bac2188fb85318856c3195bb022b8b7925348b41e9a4d15` |

**Canonical JSON vectors** (`canonical-json.test.ts`)
| Input (JS) | Output |
| --- | --- |
| `{ b: [1, 'x'], a: { d: null, c: true } }` | `{"a":{"c":true,"d":null},"b":[1,"x"]}` |
| `{ '😀': 1, '€': 2, a: 3 }` | `{"a":3,"€":2,"😀":1}` (U+20AC sorts before U+D83D) |
| `{ s: 'line\nbreak\u0001"' }` | `{"s":"line\nbreak\u0001\""}` |
| `-0` | `0` |
| `1.5`, `2 ** 53`, `1n`, `undefined`, `'\uD800'` | throws `NON_CANONICAL_JSON` |

**Expected behavior** — The same input objects built with different key insertion order produce identical bytes; each single semantic change produces a different hash.

**Acceptance criteria**
- [ ] All golden hashes reproduce from `request-hash.v1.json`.
- [ ] Changing any of: `paymentId`, `amountMinor`, `currency`, `provider`, `paymentMethodRef`, adding/removing/changing `ifMatch`, `commandType` → different hash (each a separate test).
- [ ] Credentials/correlation/idempotency key cannot be passed (type has no such field).
- [ ] Invalid `ifMatch` (`W/"payment-…-v1"`, `"payment-…-v1", "payment-…-v2"`, `"payment-…-v0"`) rejected.

**Testing requirements**
- `canonical-json.test.ts`: the table; property `canonicalJson(JSON.parse(canonicalJson(x))) === canonicalJson(x)` for `fc.jsonValue()` filtered to safe integers; property `key insertion order irrelevant` (shuffle keys).
- `request-hash.test.ts`: `golden <id>` × 8; `semantic change <field> alters hash` × 7; `insertion order does not alter hash`; `pathParams mismatch rejected` (create with paymentId; capture without); `invalid paymentId rejected`; `invalid ifMatch variants rejected`; property `hash is a pure function` (same input twice → equal bytes) and `distinct bodies → distinct hashes` over 1 000 generated amounts.
- Command: `pnpm vitest run --project unit packages/domain/src/canonical-json.test.ts packages/domain/src/request-hash.test.ts`.

**Non-goals** — No raw-body/duplicate-key JSON parsing (P04); no idempotency persistence (P02/P04).

**Handoff checklist**
- [ ] Removing the key sort makes golden tests fail (observed, restored).
- [ ] Commit body contains `Task: P01-T05`.

---

### P01-T06 — Canonical ledger posting hash

**Task ID:** `P01-T06`
**Feature:** Ledger hashing
**Commit:** `feat(domain): add canonical ledger entry normalization and posting hash with golden vectors`
**Priority:** Critical
**Dependencies:** P01-T05
**Estimated complexity:** M
**Contract references:** docs/02 §Idempotent posting (posting keys, hash scope), §Posting invariants 1, 4, 5; docs/07 §`ledger.journal_entries` (normalization paragraph, line 887), §`ledger.journal_transactions` (`financial_hash`, operation types); ADR-0007 (golden vectors shared TS/PG); schemas/events/ledger-transaction-posted.v1.schema.json (`operationType` enum); docs/10 §M1 bullet 5, AC 6
**Files:** create: `packages/domain/src/posting-hash.ts`, `packages/domain/src/posting-hash.test.ts`, `packages/domain/golden/posting-hash.v1.json`; modify: `packages/domain/src/index.ts`, `packages/domain/src/errors.ts` (reasons only if missing); must not touch: `request-hash.ts`

**Objective** — Normalize entries exactly as the protected SQL routine will (combine duplicate account/side lines, sort by binary account ID then DEBIT before CREDIT, contiguous ordinals from 1) and hash a versioned canonical object, so TypeScript prechecks and PostgreSQL agree byte-for-byte and input entry order never changes the result.

**Implementation instructions**
1. API:
   ```ts
   export const POSTING_HASH_VERSION = 1;
   export const POSTING_OPERATION_TYPES = ['CAPTURE', 'REFUND', 'SETTLEMENT', 'REVERSAL', 'ADJUSTMENT'] as const;
   export type PostingOperationType = (typeof POSTING_OPERATION_TYPES)[number];
   export type Side = 'DEBIT' | 'CREDIT';
   export interface PostingLine { readonly accountId: LedgerAccountId; readonly side: Side; readonly amount: MinorUnits }
   export interface CanonicalEntry extends PostingLine { readonly ordinal: number }
   export interface PostingHashInput {
     readonly ledgerId: LedgerId; readonly merchantId: MerchantId; readonly operationType: PostingOperationType;
     readonly currency: 'USD'; readonly recipeVersion: number; // positive integer chosen by the P03 recipe
     readonly paymentId: PaymentId | null; readonly paymentOperationId: OperationId | null;
     readonly reversalOfTransactionId: LedgerTransactionId | null; readonly settlementBatchId: SettlementBatchId | null;
     readonly lines: readonly PostingLine[];
   }
   export function canonicalizeEntries(lines: readonly PostingLine[]): Result<readonly CanonicalEntry[]>;
   export function computePostingHash(input: PostingHashInput): Result<{ hash: Uint8Array; canonicalJson: string; entries: readonly CanonicalEntry[] }>;
   ```
2. `canonicalizeEntries`: reject empty input, non-positive or > MAX line amounts, invalid side (`INTERNAL_ERROR/ENTRIES_INVALID`); sum duplicates per `(accountId, side)` (DEBIT and CREDIT lines on the same account stay separate — never netted); a combined amount > MAX → `ENTRIES_INVALID`; sort by `accountId` using plain string comparison (`a < b`; IDs are ASCII so this equals PostgreSQL `COLLATE "C"` byte order), ties DEBIT first; ordinals `1..n`.
3. `computePostingHash` additionally requires (else `INTERNAL_ERROR/…`): ≥ 2 canonical entries and ≥ 2 distinct accounts, total debits = total credits (`UNBALANCED_POSTING`), `recipeVersion` positive safe integer, reference shape (`REFERENCES_INVALID`): `CAPTURE`/`REFUND` → `paymentId` and `paymentOperationId` non-null, `reversalOfTransactionId` and `settlementBatchId` null; `SETTLEMENT` → `settlementBatchId` non-null, the other three null; `REVERSAL` → `reversalOfTransactionId` non-null, `paymentOperationId` and `settlementBatchId` null; `ADJUSTMENT` → `paymentOperationId`, `reversalOfTransactionId`, `settlementBatchId` null.
4. **[ASSUMPTION A-04]** docs/02:187-193 and docs/07:887 name the hashed fields but not their JSON keys. The canonical object is exactly (keys shown in canonical order; every reference key is always present, `null` when absent; amounts are decimal strings; `ordinal` is a JSON integer):
   ```json
   {"currency":"USD","entries":[{"accountId":"…","amountMinor":"…","ordinal":1,"side":"DEBIT"},…],"hashVersion":1,"ledgerId":"…","merchantId":"…","operationType":"…","paymentId":…,"paymentOperationId":…,"recipeVersion":1,"reversalOfTransactionId":…,"settlementBatchId":…}
   ```
   Serialized with `canonicalJson`, hashed as UTF-8 SHA-256 → 32 bytes (`financial_hash bytea`). Posting key, correlation/causation IDs, timestamps, and metadata are **not** hashed. All values are ASCII, so P03 can build identical text in PL/pgSQL with fixed key order and `format()`.

**Golden vectors** (`posting-hash.v1.json`; computed during planning). Constants: `L=led_01ARZ3NDEKTSV4RRFFQ69G5FB0`, `M=mer_01ARZ3NDEKTSV4RRFFQ69G5FAZ`, `P=pay_01ARZ3NDEKTSV4RRFFQ69G5FAV`, `OP=op_01ARZ3NDEKTSV4RRFFQ69G5FAX`, `OP2=op_01ARZ3NDEKTSV4RRFFQ69G5FAY`, `LTX=ltx_01ARZ3NDEKTSV4RRFFQ69G5FA0`, `SBT=sbt_01ARZ3NDEKTSV4RRFFQ69G5FB5`, accounts `RECV=lac_01ARZ3NDEKTSV4RRFFQ69G5FB1` (processor receivable bucket), `CLR=lac_01ARZ3NDEKTSV4RRFFQ69G5FB2` (merchant clearing), `FEE=lac_01ARZ3NDEKTSV4RRFFQ69G5FB3` (fee revenue bucket), `PAYB=lac_01ARZ3NDEKTSV4RRFFQ69G5FB4` (merchant payable); `recipeVersion = 1` in all rows.
| id | operationType / refs | Input lines (in given order) | Canonical entries | SHA-256 |
| --- | --- | --- | --- | --- |
| `capture` | CAPTURE, P, OP | FEE C 300; RECV D 10000; CLR C 9700 | 1 RECV D 10000; 2 CLR C 9700; 3 FEE C 300 | `6ebffec82e65ce367bb31d04556277cab26cd878c36908d45f43ffe5e6200d13` |
| `capture-reordered` | same | CLR C 9700; FEE C 300; RECV D 10000 | same | `6ebffec8…0d13` (identical) |
| `capture-split-lines` | same | RECV D 4000; CLR C 9700; RECV D 6000; FEE C 300 | same (4000+6000 combined) | `6ebffec8…0d13` (identical) |
| `capture-amount-changed` | same | RECV D 10000; CLR C 9699; FEE C 301 | 1 RECV D 10000; 2 CLR C 9699; 3 FEE C 301 | `f451740380cf393468e508eea8839c8703f020df41282a6880b88a7bab6c623f` |
| `refund` | REFUND, P, OP2 | CLR D 4850; FEE D 150; RECV C 5000 | 1 RECV C 5000; 2 CLR D 4850; 3 FEE D 150 | `628c63f25cd9fa1e203e2a5a5c6a5f1df5943385a314c59d0b0234bfd0055d4a` |
| `settlement` | SETTLEMENT, SBT | CLR D 9700; PAYB C 9700 | 1 CLR D 9700; 2 PAYB C 9700 | `4d0de279c46d5eda090a9af9a0b480ce44151e954f00cebcbcde8a84c1981e94` |
| `reversal` | REVERSAL, P, reversalOf LTX | RECV C 10000; CLR D 9700; FEE D 300 | 1 RECV C 10000; 2 CLR D 9700; 3 FEE D 300 | `0c547a4b297d62e4b75c80cdc646a28a12b4e5c5c5efdb3bed313c1aefd10864` |
Exact canonical text of `capture` (store it in the golden file as `canonicalJson`):
```text
{"currency":"USD","entries":[{"accountId":"lac_01ARZ3NDEKTSV4RRFFQ69G5FB1","amountMinor":"10000","ordinal":1,"side":"DEBIT"},{"accountId":"lac_01ARZ3NDEKTSV4RRFFQ69G5FB2","amountMinor":"9700","ordinal":2,"side":"CREDIT"},{"accountId":"lac_01ARZ3NDEKTSV4RRFFQ69G5FB3","amountMinor":"300","ordinal":3,"side":"CREDIT"}],"hashVersion":1,"ledgerId":"led_01ARZ3NDEKTSV4RRFFQ69G5FB0","merchantId":"mer_01ARZ3NDEKTSV4RRFFQ69G5FAZ","operationType":"CAPTURE","paymentId":"pay_01ARZ3NDEKTSV4RRFFQ69G5FAV","paymentOperationId":"op_01ARZ3NDEKTSV4RRFFQ69G5FAX","recipeVersion":1,"reversalOfTransactionId":null,"settlementBatchId":null}
```
Negative vectors: unbalanced (`RECV D 10000; CLR C 9700`) → `UNBALANCED_POSTING`; one account only (`RECV D 1; RECV C 1`) → `ENTRIES_INVALID` (< 2 distinct accounts); zero amount line → `ENTRIES_INVALID`; CAPTURE with `settlementBatchId` set → `REFERENCES_INVALID`.

**Expected behavior** — input order and line splitting never change the hash; any change to account, side, amount, currency, operation type, references, ledger, merchant, or recipe version does.

**Acceptance criteria**
- [ ] All golden rows (positive and negative) asserted from `posting-hash.v1.json`.
- [ ] Property: shuffling and splitting lines never changes `hash`.
- [ ] Property: changing exactly one field changes `hash`.

**Testing requirements**
- `packages/domain/src/posting-hash.test.ts`: `golden <id>`; `negative <id>`; `DEBIT before CREDIT on same account` (`X D 5; X C 5; Y D 5; Y C 5` → ordinals X-D, X-C, Y-D, Y-C); `binary order uses code units` (`lac_0…` < `lac_A…`); property `order and split independence` (random balanced postings of 2–8 accounts, random permutation and random splits of lines); property `single-field change alters hash` (mutate one of account, side, amount, operationType, each reference, recipeVersion); property `canonicalizeEntries is idempotent`.
- Command: `pnpm vitest run --project unit packages/domain/src/posting-hash.test.ts`.

**Non-goals** — No recipe generation or bucket selection (P03); no SQL implementation (P03 consumes the golden file); no balance policy.

**Handoff checklist**
- [ ] Removing duplicate-line combination makes `capture-split-lines` fail (observed, restored).
- [ ] Commit body contains `Task: P01-T06`.

---

### P01-T07 — Payment and operation model, invariant checker, and derived summary status

**Task ID:** `P01-T07`
**Feature:** Payment state machine
**Commit:** `feat(domain): add payment aggregate model, invariant checker, and derived summary status`
**Priority:** Critical
**Dependencies:** P01-T02, P01-T04
**Estimated complexity:** M
**Contract references:** docs/03 §Canonical aggregate, §Payment operation, §Monetary invariants (lines 118-163), §Operation exclusion model, §Derived summary status (lines 375-395); docs/05 §Payment (summaryStatus enum, remaining refundable formula); openapi.yaml `Payment.summaryStatus`, `PaymentOperation.status`; docs/10 §M1 bullet 3
**Files:** create: `packages/domain/src/payment.ts`, `packages/domain/src/payment.test.ts`; modify: `packages/domain/src/index.ts`; must not touch: `fees.ts`

**Objective** — Define the canonical in-memory aggregate and operations (exactly the confirmed facts + reservation + pointer + versions), a checker that reports every violated monetary/state invariant by name, and the display-only summary status in contract precedence.

**Implementation instructions**
1. Types. Every closed union below is declared as `export const X = [...] as const; export type T = (typeof X)[number];` with runtime arrays named `OPERATION_TYPES`, `OPERATION_STATUSES`, `AUTHORIZATION_OUTCOMES`, `SUMMARY_STATUSES` (P01-GATE compares them with the contract enums):
   ```ts
   export type OperationType = 'AUTHORIZE' | 'CAPTURE' | 'CANCEL' | 'REFUND';
   export type OperationStatus = 'REQUESTED' | 'PROCESSING' | 'SUCCEEDED' | 'REJECTED' | 'FAILED' | 'UNKNOWN' | 'REQUIRES_REVIEW';
   export type AuthorizationOutcome = 'NOT_REQUESTED' | 'AUTHORIZED' | 'DECLINED' | 'CANCELED' | 'EXPIRED';
   export type SummaryStatus = 'REQUIRES_REVIEW' | 'OUTCOME_UNKNOWN' | 'PROCESSING' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'CAPTURED'
     | 'PARTIALLY_CAPTURED' | 'CANCELED' | 'EXPIRED' | 'AUTHORIZED' | 'AUTHORIZATION_FAILED' | 'REQUIRES_AUTHORIZATION';
   export interface PaymentState {
     readonly id: PaymentId; readonly requested: MinorUnits; readonly authorized: MinorUnits; readonly captured: MinorUnits;
     readonly refunded: MinorUnits; readonly voided: MinorUnits; readonly reservedRefund: MinorUnits;
     readonly unresolvedRefundCount: number; readonly authorizationOutcome: AuthorizationOutcome;
     readonly activeExclusiveOperationId: OperationId | null; readonly version: number;
   }
   export interface OperationState {
     readonly id: OperationId; readonly type: OperationType; readonly amount: MinorUnits; readonly status: OperationStatus;
     readonly notBefore: Timestamp | null; readonly version: number;
     readonly feeEffect: MinorUnits | null;        // CAPTURE: snapshotted F; REFUND: null until SUCCEEDED; AUTHORIZE/CANCEL: null
     readonly feeSnapshot: FeeSnapshot | null;     // CAPTURE and REFUND (refund copies the capture's); null otherwise
   }
   export function isUnresolved(s: OperationStatus): boolean; // REQUESTED | PROCESSING | UNKNOWN | REQUIRES_REVIEW
   export function isTerminal(s: OperationStatus): boolean;   // SUCCEEDED | REJECTED | FAILED
   export function exclusionClass(t: OperationType): 'EXCLUSIVE' | 'CONCURRENT'; // REFUND → CONCURRENT
   export type InvariantId = /* see table */;
   export function checkPaymentInvariants(p: PaymentState, ops: readonly OperationState[]): readonly InvariantId[]; // [] = valid; ops in creation order
   export function deriveSummaryStatus(p: PaymentState, ops: readonly OperationState[]): SummaryStatus;
   ```
2. `checkPaymentInvariants` returns every violated id (not just the first):
   | InvariantId | Rule (docs/03) |
   | --- | --- |
   | `REQUESTED_POSITIVE` | `requested > 0` |
   | `COUNT_NON_NEGATIVE` | `unresolvedRefundCount >= 0` (bigint fields are non-negative by type) |
   | `AUTHORIZED_LE_REQUESTED` | `authorized <= requested` |
   | `CAPTURED_LE_AUTHORIZED` | `captured <= authorized` |
   | `REFUNDED_LE_CAPTURED` | `refunded <= captured` |
   | `VOIDED_LE_AUTHORIZED_MINUS_CAPTURED` | `voided <= authorized - captured` |
   | `REFUNDED_PLUS_RESERVED_LE_CAPTURED` | `refunded + reservedRefund <= captured` |
   | `RESERVATION_ZERO_IFF_COUNT_ZERO` | `(reservedRefund = 0) = (unresolvedRefundCount = 0)` |
   | `RESERVATION_EQUALS_UNRESOLVED_REFUNDS` | `reservedRefund = Σ amount` of unresolved REFUND ops |
   | `COUNT_EQUALS_UNRESOLVED_REFUNDS` | `unresolvedRefundCount =` count of unresolved REFUND ops |
   | `AT_MOST_ONE_UNRESOLVED_EXCLUSIVE` | ≤ 1 unresolved AUTHORIZE/CAPTURE/CANCEL |
   | `EXCLUSIVE_POINTER_MATCHES` | pointer = id of that op, or null when none |
   | `UNAUTHORIZED_TOTALS_ZERO` | `NOT_REQUESTED`/`DECLINED` ⇒ authorized = captured = refunded = voided = 0 |
   | `CANCELED_OR_EXPIRED_VOIDS_ALL` | `CANCELED`/`EXPIRED` ⇒ captured = refunded = 0 and voided = authorized |
   | `CAPTURE_RELEASES_REMAINDER` | a SUCCEEDED CAPTURE exists ⇒ captured + voided = authorized |
   | `CAPTURED_IFF_ONE_SUCCEEDED_CAPTURE` | `captured > 0` ⇔ exactly one SUCCEEDED CAPTURE, and ≤ 1 SUCCEEDED CAPTURE ever |
   | `REFUND_FEE_ONLY_ON_SUCCESS` | REFUND `feeEffect` non-null ⇔ status SUCCEEDED |
   | `AT_MOST_THREE_AUTHORIZATIONS` | count of AUTHORIZE ops ≤ 3 |
3. `deriveSummaryStatus` (precedence exactly docs/03:377-389): 1 any unresolved op `REQUIRES_REVIEW` → `REQUIRES_REVIEW`; 2 any `UNKNOWN` → `OUTCOME_UNKNOWN`; 3 any `REQUESTED`/`PROCESSING` → `PROCESSING`; 4 `captured > 0 && refunded = captured` → `REFUNDED`; 5 `refunded > 0` → `PARTIALLY_REFUNDED`; 6 `captured > 0 && captured + voided = authorized` → `CAPTURED`; 7 `captured > 0 && captured + voided < authorized` → `PARTIALLY_CAPTURED`; 8 outcome `CANCELED`/`EXPIRED` → same; 9 `AUTHORIZED` → `AUTHORIZED`; 10 outcome `DECLINED`, or the **last** AUTHORIZE op in `ops` (creation order **[ASSUMPTION A-05]**) is `FAILED` → `AUTHORIZATION_FAILED`; 11 otherwise `REQUIRES_AUTHORIZATION`.

**Expected behavior**
- Fresh payment (requested 10000, all zero, `NOT_REQUESTED`, version 1, no ops) → `[]`, `REQUIRES_AUTHORIZATION`.
- `captured=10000, authorized=10000, refunded=6000, reservedRefund=5000, count=1` → includes `REFUNDED_PLUS_RESERVED_LE_CAPTURED`.
- `reservedRefund=0, count=1` → includes `RESERVATION_ZERO_IFF_COUNT_ZERO`.
- One unresolved REFUND (`UNKNOWN`) plus one `REQUESTED` refund → `OUTCOME_UNKNOWN` (rule 2 beats rule 3 regardless of array order).
- Completed partial capture (authorized 10000, captured 6000, voided 4000) → `CAPTURED` (rule 7 unreachable in the MVP, docs/03:393).

**Acceptance criteria**
- [ ] Each invariant has a minimal violating fixture that reports exactly that id (plus any logically implied id, listed in the test).
- [ ] Each of the 11 summary rules has a fixture that reaches it and proves precedence over the next rule.
- [ ] `SummaryStatus` union equals openapi `Payment.summaryStatus` enum (asserted at P01-GATE).

**Testing requirements**
- `packages/domain/src/payment.test.ts`: `invariant <id> violated` × 18; `valid lifecycle snapshots report no violations` (created, authorized, captured-full, captured-partial, refunded-partial-with-reservation, refunded-full, canceled, expired, declined); `summary rule <n>` × 11; `summary precedence REQUIRES_REVIEW over UNKNOWN over PROCESSING with mixed refunds`; `isUnresolved/isTerminal/exclusionClass tables`.
- Command: `pnpm vitest run --project unit packages/domain/src/payment.test.ts`.

**Non-goals** — No transitions (T08/T09); no persistence mapping (P02).

**Handoff checklist**
- [ ] Commit body contains `Task: P01-T07`.

---

### P01-T08 — Command acceptance guards and effects

**Task ID:** `P01-T08`
**Feature:** Payment state machine
**Commit:** `feat(domain): implement command acceptance guards, exclusion model, and refund reservation`
**Priority:** Critical
**Dependencies:** P01-T07
**Estimated complexity:** M
**Contract references:** docs/03 §Operation exclusion model, §Command acceptance steps 3–7, §Lifecycle transitions guards (Authorize, Capture, Cancel, Refund), §Aggregate and operation version rules, §MVP policy decisions (three authorization operations); docs/02 §Minimum capture amount; docs/05 §Canonical error format (409/422 codes); ADR-0003; docs/10 §M1 bullet 3, §M5 (consumer of these guards)
**Files:** create: `packages/domain/src/commands.ts`, `packages/domain/src/commands.test.ts`; modify: `packages/domain/src/index.ts`; must not touch: `payment.ts` (except adding exports if needed)

**Objective** — Pure function that decides whether a command may be accepted against the current aggregate and, if so, returns the next aggregate and the new `REQUESTED` operation — the exact logic P05's protected SQL acceptance function must mirror.

**Implementation instructions**
1. API:
   ```ts
   export type CommandRequest =
     | { readonly type: 'AUTHORIZE' }
     | { readonly type: 'CAPTURE'; readonly amount: MinorUnits; readonly feePolicy: FeePolicyInputs }
     | { readonly type: 'CANCEL' }
     | { readonly type: 'REFUND'; readonly amount: MinorUnits; readonly captureFeeSnapshot: FeeSnapshot };
   export function acceptCommand(p: PaymentState, ops: readonly OperationState[], req: CommandRequest, newOperationId: OperationId)
     : Result<{ payment: PaymentState; operation: OperationState }>;
   ```
2. Guard order **[ASSUMPTION A-06]** (contract defines codes, not precedence):
   1. `p.activeExclusiveOperationId !== null` → `ACTIVE_OPERATION_EXISTS / EXCLUSIVE_OPERATION_UNRESOLVED`.
   2. `req.type !== 'REFUND' && p.unresolvedRefundCount > 0` → `ACTIVE_OPERATION_EXISTS / REFUND_UNRESOLVED`.
   3. Lifecycle guards → `INVALID_PAYMENT_STATE / GUARD_FAILED` unless noted:
      - AUTHORIZE: outcome ∈ {`NOT_REQUESTED`, `DECLINED`}; authorized = captured = refunded = voided = 0; AUTHORIZE ops count < 3 else `INVALID_PAYMENT_STATE / AUTHORIZATION_ATTEMPTS_EXHAUSTED`; if a previous AUTHORIZE op exists the last one is `REJECTED` or `FAILED` (docs/03:441).
      - CAPTURE: outcome `AUTHORIZED`; captured = refunded = 0; no `SUCCEEDED` CAPTURE op.
      - CANCEL: outcome `AUTHORIZED`; captured = refunded = 0.
      - REFUND: `captured > 0` (a capture succeeded).
   4. Monetary guards:
      - CAPTURE: `amount > authorized` → `MONETARY_GUARD_FAILED / CAPTURE_EXCEEDS_AUTHORIZED`; then `checkCaptureMinimum(amount, feePolicy.minimumCaptureAmount)` → `CAPTURE_BELOW_MINIMUM / BELOW_MINIMUM_CAPTURE`.
      - REFUND: `refunded + reservedRefund + amount > captured` → `MONETARY_GUARD_FAILED / REFUND_EXCEEDS_REFUNDABLE`.
3. Effects on success (payment version +1 in every case — docs/03 "Operation acceptance … increments the payment version"):
   - New operation: `{ id: newOperationId, status: 'REQUESTED', version: 1, notBefore: null }`; amount: AUTHORIZE → `p.requested`; CAPTURE → `req.amount`; CANCEL → `p.authorized - p.captured` (= authorized); REFUND → `req.amount`.
   - CAPTURE: `feeEffect = computeCaptureFee(amount, bp, fixed)`, `feeSnapshot = { basisPoints, fixedAmount, captureFee: feeEffect, captureGross: amount }`.
   - REFUND: `feeEffect = null`, `feeSnapshot = req.captureFeeSnapshot` (copied, no incremental fee at acceptance — ADR-0008).
   - AUTHORIZE/CANCEL: `feeEffect = null`, `feeSnapshot = null`.
   - Exclusive types set `activeExclusiveOperationId = newOperationId`; REFUND sets `reservedRefund += amount` (checked), `unresolvedRefundCount += 1`.
   - Confirmed totals and `authorizationOutcome` never change at acceptance.
4. On any error the inputs are returned untouched (functions never mutate arguments; all state objects are new frozen objects).

**Expected behavior** (start: authorized 10000, captured 10000, refunded 0, reserved 0)
- REFUND 6000 → ok, reserved 6000, count 1, version +1; then REFUND 4000 → ok (reserved 10000, count 2); then REFUND 1 → `MONETARY_GUARD_FAILED / REFUND_EXCEEDS_REFUNDABLE`.
- With one unresolved refund, CANCEL → `ACTIVE_OPERATION_EXISTS / REFUND_UNRESOLVED`.
- With an unresolved CAPTURE pointer, REFUND → `ACTIVE_OPERATION_EXISTS / EXCLUSIVE_OPERATION_UNRESOLVED`.
- CAPTURE 29 with policy `{ bp 0, fixed 30, minimum 30 }` → `CAPTURE_BELOW_MINIMUM`; CAPTURE 30 → ok with `feeEffect 30`.
- CAPTURE 10001 on authorized 10000 → `MONETARY_GUARD_FAILED / CAPTURE_EXCEEDS_AUTHORIZED`.
- Fourth AUTHORIZE after three `REJECTED` → `INVALID_PAYMENT_STATE / AUTHORIZATION_ATTEMPTS_EXHAUSTED`; AUTHORIZE after a `FAILED` authorization (outcome still `NOT_REQUESTED`) → ok.

**Acceptance criteria**
- [ ] Every expected-behavior case asserts `error.code` **and** `error.reason` (the refund race loser is proven to fail on `REFUND_EXCEEDS_REFUNDABLE`, the monetary guard — docs/03:425).
- [ ] After every successful acceptance `checkPaymentInvariants(next, [...ops, operation])` is `[]`.
- [ ] Inputs are deep-equal before and after every call (no mutation).

**Testing requirements**
- `packages/domain/src/commands.test.ts`: the expected-behavior cases; `authorize guards` (each outcome value; nonzero totals); `capture guards` (not authorized, already captured, refunded > 0, succeeded capture exists); `cancel guards`; `refund requires captured > 0`; `refund boundary equal to remaining accepted`; `exclusive while refund unresolved rejected for AUTHORIZE, CAPTURE, CANCEL`; `capture fee snapshot equals computeCaptureFee`; `refund copies snapshot and has null fee`; `version increments by exactly 1`; property `acceptance never violates invariants` (random valid prior states from T07 fixtures, random requests).
- Command: `pnpm vitest run --project unit packages/domain/src/commands.test.ts`.

**Non-goals** — No idempotency, `If-Match` version comparison, or persistence (P04/P05); no event payload construction (P05).

**Handoff checklist**
- [ ] Removing guard 4 for REFUND makes the over-refund test fail with a *different* reason (proves the assertion targets the monetary guard).
- [ ] Commit body contains `Task: P01-T08`.

---

### P01-T09 — Operation execution and resolution transitions

**Task ID:** `P01-T09`
**Feature:** Payment state machine
**Commit:** `feat(domain): implement operation claim, ambiguity, resolution, expiry, and discrepancy transitions`
**Priority:** Critical
**Dependencies:** P01-T08
**Estimated complexity:** L
**Contract references:** docs/03 §Lifecycle transitions outcome tables, §Authorization-expiry workflow (guards), §Ambiguous outcomes, §Proven-no-effect same-operation retry, §Racing resolution signals, §Aggregate and operation version rules (lines 397-418); docs/06 §Normalized write results (verify amount/type before SUCCEEDED; mismatch → discrepancy); ADR-0004; docs/10 §M1 bullet 3
**Files:** create: `packages/domain/src/transitions.ts`, `packages/domain/src/transitions.test.ts`; modify: `packages/domain/src/index.ts`; must not touch: `commands.ts`

**Objective** — Pure transitions for every post-acceptance state change with the contract's exact payment-version and operation-version effects, so P06–P08 SQL functions have an executable reference model.

**Implementation instructions**
1. API (all return new frozen objects; errors are `INVALID_PAYMENT_STATE / ILLEGAL_OPERATION_TRANSITION` unless noted):
   ```ts
   export function claimOperation(op: OperationState): Result<OperationState>;                       // REQUESTED & notBefore null → PROCESSING; op.version+1
   export function scheduleNoEffectRetry(op: OperationState, notBefore: Timestamp): Result<OperationState>; // PROCESSING → REQUESTED, notBefore set; op.version+1
   export function releaseDueOperation(op: OperationState): Result<OperationState>;                  // REQUESTED & notBefore non-null → notBefore null; op.version+1
   export function markUnknown(p: PaymentState, op: OperationState): Result<{ payment: PaymentState; operation: OperationState }>;  // PROCESSING → UNKNOWN; p.version+1; op.version+1
   export function requireReview(p: PaymentState, op: OperationState): Result<{ payment: PaymentState; operation: OperationState }>; // UNKNOWN → REQUIRES_REVIEW; p.version+1; op.version+1
   export type ResolutionEvidence = { readonly outcome: 'SUCCEEDED'; readonly amount: MinorUnits } | { readonly outcome: 'REJECTED' } | { readonly outcome: 'FAILED' };
   export type ResolutionResult =
     | { readonly kind: 'APPLIED'; readonly payment: PaymentState; readonly operation: OperationState }
     | { readonly kind: 'CORROBORATING' }   // no change at all
     | { readonly kind: 'CONTRADICTORY' };  // caller records discrepancy via recordDiscrepancy
   export function resolveOperation(p: PaymentState, op: OperationState, ev: ResolutionEvidence): Result<ResolutionResult>;
   export function applyAuthorizationExpiry(p: PaymentState): Result<PaymentState>;                   // INVALID_PAYMENT_STATE / EXPIRY_NOT_APPLICABLE
   export function recordDiscrepancy(p: PaymentState): PaymentState;                                   // p.version+1 only
   ```
2. `resolveOperation`:
   - `op.status` terminal: same outcome (and for SUCCEEDED same amount) → `CORROBORATING`; otherwise `CONTRADICTORY`. Terminal states are one-way.
   - `op.status === 'REQUESTED'` → error (no provider call can have happened).
   - From `PROCESSING`, `UNKNOWN`, `REQUIRES_REVIEW`: SUCCEEDED with `ev.amount !== op.amount` → `CONTRADICTORY` (docs/06: mismatch creates discrepancy, no confirmed effect). Otherwise APPLIED with `op.status = ev.outcome`, `op.version+1`, `p.version+1` and:
     | Type | SUCCEEDED | REJECTED | FAILED |
     | --- | --- | --- | --- |
     | AUTHORIZE | `authorized = op.amount`, outcome `AUTHORIZED`, pointer null | outcome `DECLINED`, pointer null | pointer null |
     | CAPTURE | `captured = op.amount`, `voided = authorized - captured`, pointer null | pointer null | pointer null |
     | CANCEL | outcome `CANCELED`, `voided = authorized`, pointer null | pointer null | pointer null |
     | REFUND | `reserved -= amount`, `refunded += amount`, `count -= 1`, `op.feeEffect = incrementalFeeReversal({ captureFee: op.feeSnapshot.captureFee, captureGross: op.feeSnapshot.captureGross, confirmedRefundedBefore: p.refunded, refundAmount: op.amount })` | `reserved -= amount`, `count -= 1`, `feeEffect` stays null | same as REJECTED |
3. `applyAuthorizationExpiry` guards (docs/03:268-276): outcome `AUTHORIZED`; captured = refunded = voided = 0; pointer null; `unresolvedRefundCount = 0`. Effect: outcome `EXPIRED`, `voided = authorized`, `p.version+1`. The authorization operation is not passed in and never changes.
4. No transition other than those marked changes `p.version` (claim, retry scheduling, due release, corroboration do not).

**Expected behavior**
- REFUND golden linkage: capture snapshot F=320, G=10000; confirm refunds 3333, 3333, 3334 in that order → `feeEffect` 106, 107, 107; `reservedRefund` returns to 0; `refunded` = 10000.
- UNKNOWN refund keeps its reservation: `markUnknown` leaves `reservedRefund`/`count` unchanged and `p.version+1`.
- Duplicate SUCCEEDED for a captured operation → `CORROBORATING`, versions unchanged.
- REJECTED arriving after SUCCEEDED → `CONTRADICTORY`; `recordDiscrepancy` then bumps only `p.version`.
- `scheduleNoEffectRetry` keeps pointer/reservation, `p` untouched, `op.version+1`; `claimOperation` on that op fails until `releaseDueOperation`.
- Expiry after a capture → `EXPIRY_NOT_APPLICABLE`.

**Acceptance criteria**
- [ ] Every cell of the resolution table is a test.
- [ ] Every transition asserts the exact `p.version` and `op.version` deltas from docs/03 §Aggregate and operation version rules.
- [ ] `refunded + reservedRefund` never increases across any resolution (docs/09 §Refund reservation).
- [ ] After every successful transition `checkPaymentInvariants` is `[]` for a consistent op list.

**Testing requirements**
- `packages/domain/src/transitions.test.ts`: `resolve <TYPE> <OUTCOME> from <PROCESSING|UNKNOWN|REQUIRES_REVIEW>` (4×3×3); `REQUESTED cannot resolve`; `terminal same outcome corroborates`; `terminal different outcome contradicts`; `success amount mismatch contradicts`; `claim requires null notBefore`; `retry/release version deltas`; `markUnknown only from PROCESSING`; `requireReview only from UNKNOWN`; `UNKNOWN/REQUIRES_REVIEW cannot return to REQUESTED or PROCESSING` (no blind retry: assert `scheduleNoEffectRetry` and `claimOperation` fail from both); `expiry guards each fail`; `expiry success effects`; `refund fee linkage to golden thirds`; `refunded+reserved non-increasing`.
- Command: `pnpm vitest run --project unit packages/domain/src/transitions.test.ts`.

**Non-goals** — No evidence persistence/deduplication, leases, or timestamps of resolution (P06–P08); no event emission.

**Handoff checklist**
- [ ] Commit body contains `Task: P01-T09`.

---

### P01-T10 — Model-based property tests for the payment lifecycle

**Task ID:** `P01-T10`
**Feature:** Payment state machine verification
**Commit:** `test(domain): add model-based lifecycle, reservation, and fee properties`
**Priority:** Critical
**Dependencies:** P01-T09
**Estimated complexity:** M
**Contract references:** docs/03 §Required model tests; docs/09 §Property and model-based tests (Payment lifecycle, Fee allocation, Refund reservation); docs/02 §Fee allocation under concurrent refunds; docs/10 §M1 AC 2, 4, 8
**Files:** create: `packages/domain/src/lifecycle.property.test.ts`; modify: none; must not touch: production `src` files

**Objective** — Generate random valid and invalid command/result sequences and prove, after every step, every monetary invariant, version rule, and fee property — with persisted seeds and minimized counterexamples (harness from P01-T01).

**Implementation instructions**
1. Model: state `{ payment, ops }` starting from a created payment with `requested ∈ [1, MAX]`, a fee policy `{ bp ∈ [0,10000], fixed ∈ [0, 1000], minimum = max(fixed, 1) }`.
2. Actions (fast-check `fc.oneof` over a discriminated union; indices reference existing ops modulo length): `Accept(AUTHORIZE)`, `Accept(CAPTURE, amount)`, `Accept(CANCEL)`, `Accept(REFUND, amount)` (amounts drawn from `[1, MAX]` and biased toward the remaining refundable/authorized amount ±1), `Claim(i)`, `RetryNoEffect(i)`, `ReleaseDue(i)`, `MarkUnknown(i)`, `RequireReview(i)`, `Resolve(i, outcome, amountDelta ∈ {0, 0, 0, +1})`, `Expire`, `Duplicate(i)` (re-resolve a terminal op with its own outcome). Sequences of length 1–60.
3. Step oracle after every action:
   - Error result ⇒ `payment` and `ops` deep-equal to before (invalid commands create no confirmed change and no operation — docs/03:423).
   - Success ⇒ `checkPaymentInvariants` is `[]`.
   - `p.version` delta is 1 for Accept, MarkUnknown, RequireReview, APPLIED Resolve, Expire, and discrepancy recording on CONTRADICTORY; 0 for Claim, RetryNoEffect, ReleaseDue, CORROBORATING.
   - `op.version` delta 1 for the mutated op on Claim, RetryNoEffect, ReleaseDue, MarkUnknown, RequireReview, APPLIED Resolve; 0 otherwise.
   - `refunded + reservedRefund` never increases on a Resolve.
   - At most one unresolved exclusive op; any accepted exclusive command implies no unresolved refunds at acceptance.
4. End-of-sequence fee oracle: Σ `feeEffect` of SUCCEEDED refunds `<= captureFee`; if `refunded == captured > 0` then Σ equals `captureFee` exactly.
5. Targeted properties: `refund race for the last refundable amount` (two refunds each ≤ remaining, sum > remaining: the second returns `MONETARY_GUARD_FAILED / REFUND_EXCEEDS_REFUNDABLE`); `several fitting refunds all accepted and reserved total equals their sum`; `UNKNOWN refund keeps reservation while later refunds against the remainder succeed`; `same refund set confirmed in two orders: equal fee totals, per-refund diff ≤ 1`.
6. Use `fc.assert(fc.property(...))` with global config (seed/numRuns/reporter from P01-T01); do not override the seed in-file.

**Expected behavior** — 200 runs (CI seed `20261108`) pass; a deliberately injected bug (e.g. `resolveOperation` REFUND success not decrementing `reservedRefund`) is caught with a minimized counterexample written to `reports/property-failures.jsonl`.

**Acceptance criteria**
- [ ] All oracles in steps 3–5 implemented.
- [ ] Injected-bug check performed for three bugs (reservation not released, payment version not incremented on markUnknown, refund guard using `>=`), each caught, then reverted (record in commit body).
- [ ] Runtime < 30 s at 200 runs.

**Testing requirements** — File above, cases: `random sequences preserve invariants and version rules`, `invalid actions are no-ops`, `fee reversal bounded and exact on full refund`, plus the four targeted properties. Command: `pnpm vitest run --project unit packages/domain/src/lifecycle.property.test.ts` and `FC_NUM_RUNS=2000 pnpm vitest run --project unit packages/domain/src/lifecycle.property.test.ts` locally.

**Non-goals** — No concurrency against a database (P05/P07 integration tests).

**Handoff checklist**
- [ ] Commit body lists the three injected bugs and the seeds/paths that caught them.
- [ ] Commit body contains `Task: P01-T10`.

---

### P01-T11 — Normalized provider result, error, and evidence types

**Task ID:** `P01-T11`
**Feature:** Provider-neutral contract types
**Commit:** `feat(domain): add provider result discriminated unions and proof-enforcing constructors`
**Priority:** High
**Dependencies:** P01-T02, P01-T03
**Estimated complexity:** M
**Contract references:** docs/06 §Provider-neutral TypeScript interface, §Capability model, §Normalized write results, §Error taxonomy, §Reconciliation lookup and evidence (result types); schemas/common/provider-result-evidence.v1.schema.json; docs/10 §M1 bullet 6, AC 7
**Files:** create: `packages/domain/src/provider.ts`, `packages/domain/src/provider.test.ts`; modify: `packages/domain/src/index.ts`; must not touch: `transitions.ts`

**Objective** — Encode docs/06 types verbatim as TypeScript so that a `FAILED` outcome without `NoEffectProof`, a `RETRYABLE_NO_EFFECT` without proof/`RETRY_SAME_OPERATION`/`retryNotBefore`, or a `SUCCEEDED` without provider payment/operation IDs cannot be constructed.

**Implementation instructions**
1. Copy every type from docs/06 §Provider-neutral TypeScript interface, §Capability model, §Normalized write results, §Error taxonomy, §Reconciliation lookup and evidence exactly (names and fields): `ProviderName` (reuse T03 brand), `OperationType` (reuse T07), `ProviderMoney`, `ProviderOperationCommand`, `ProviderLookup`, `ProviderLookupHint`, `ProviderAuthorizationLookup`, `ProviderWebhookRequest`, `VerifiedProviderWebhook`, `PaymentProvider`, `ProviderCapabilities`, `ResolutionSource`, `ProviderEvidence`, `ProviderOutcome`, `ProviderTerminalOutcome`, `ProviderWriteResult`, `ProviderErrorCategory`, `RetryDirective`, `NormalizedProviderError`, `NoEffectProof`, `ProviderLookupResult`, `ProviderAuthorizationLookupResult`. All fields `readonly`. Keep docs/06's `string` for opaque provider references and timestamps.
2. Constructors (runtime checks for what types cannot express; throw `DomainError('INTERNAL_ERROR','VALUE_MALFORMED')` on violation — adapter defects, never client errors):
   ```ts
   export function succeeded(x: { operationType: OperationType; providerPaymentId: string; providerOperationId: string; providerAuthorizationId: string | null; providerCaptureId: string | null; authorizationExpiresAt: string | null; amount: ProviderMoney }): Extract<ProviderOutcome, { outcome: 'SUCCEEDED' }>;
   export function rejected(x: { providerPaymentId: string | null; providerOperationId: string | null; error: NormalizedProviderError }): …;
   export function failed(x: { …; error: NormalizedProviderError; noEffectProof: NoEffectProof }): …;
   export function retryableNoEffect(x: { …; error: NormalizedProviderError & { retryDirective: 'RETRY_SAME_OPERATION' }; noEffectProof: NoEffectProof; retryNotBefore: string; now: string; maxDelayMs: number }): …;
   export function unknownOutcome(x: { …; error: NormalizedProviderError; lookupHint: ProviderLookupHint }): …;
   export function evidence(x: ProviderEvidence): ProviderEvidence;
   ```
   Runtime rules: `succeeded` — non-empty IDs; AUTHORIZE requires non-null `providerAuthorizationId`; non-AUTHORIZE requires `authorizationExpiresAt === null`; non-CAPTURE requires `providerCaptureId === null` (docs/06 §Normalized write results). `retryableNoEffect` — `retryNotBefore` parses as a timestamp, is strictly after `now`, and at most `maxDelayMs` after it ("bounded"). `evidence` — `providerEventId` non-null exactly when `source === 'PROVIDER_WEBHOOK'`. `NormalizedProviderError.safeMessage` length 1–500, `code` length 1–128 (schema bounds).
3. Export runtime arrays `PROVIDER_ERROR_CATEGORIES`, `RETRY_DIRECTIVES`, `NO_EFFECT_PROOF_KINDS`, `RESOLUTION_SOURCES` (`as const`) and derive the corresponding unions from them (P01-GATE parity).
4. Note: the domain `OperationType` constructor input field `operationType` is not part of `ProviderOutcome` (docs/06 shape); it is used only for validation.

**Expected behavior**
- `failed({ …, error })` without `noEffectProof` → **compile error**.
- Object literal `{ outcome: 'SUCCEEDED', providerPaymentId: 'p', providerOperationId: null, … }` typed as `ProviderOutcome` → compile error.
- `retryableNoEffect` with `retryDirective: 'DO_NOT_RETRY'` → compile error; with `retryNotBefore <= now` → runtime `INTERNAL_ERROR`.
- `succeeded({ operationType: 'AUTHORIZE', providerAuthorizationId: null, … })` → runtime error.
- `evidence({ source: 'API_RESPONSE', providerEventId: 'evt_1', … })` → runtime error.

**Acceptance criteria**
- [ ] `@ts-expect-error` type tests exist for each impossible construction and `pnpm typecheck` passes (an unused `@ts-expect-error` fails the build, so the tests prove the error exists).
- [ ] Runtime constructor rules each have a negative test.
- [ ] `ProviderErrorCategory`, `RetryDirective`, `NoEffectProof.kind`, `ResolutionSource` unions equal the schema enums (asserted at P01-GATE).

**Testing requirements**
- `packages/domain/src/provider.test.ts`: type block with `// @ts-expect-error` cases: `FAILED without noEffectProof`, `SUCCEEDED with null providerOperationId`, `SUCCEEDED with null providerPaymentId`, `RETRYABLE_NO_EFFECT without retryNotBefore`, `RETRYABLE_NO_EFFECT with DO_NOT_RETRY`, `REJECTED without error`, `lookup NOT_FOUND conclusive with non-null nextCheckNotBefore`; runtime cases listed in Expected behavior; positive construction of each variant.
- Command: `pnpm typecheck && pnpm vitest run --project unit packages/domain/src/provider.test.ts`.

**Non-goals** — No adapter implementations, capability startup validation, or webhook verification (P06/P09).

**Handoff checklist**
- [ ] Removing `noEffectProof` from the `FAILED` variant makes `pnpm typecheck` fail on the unused `@ts-expect-error` (observed, restored).
- [ ] Commit body contains `Task: P01-T11`.

---

### P01-T12 — Retry classification, observation normalization, and backoff

**Task ID:** `P01-T12`
**Feature:** Retry policy
**Commit:** `feat(domain): add retry classification, provider observation normalization, and jittered backoff`
**Priority:** High
**Dependencies:** P01-T11
**Estimated complexity:** M
**Contract references:** docs/04 §Retry and dead-letter policy (delays, classification table), §Reconciliation messages; docs/08 §Retry classification (schedules, jitter), §No-blind-retry rule; docs/06 §Error taxonomy (observation table), §Timeout and ambiguous-result policy (closed reason vocabulary); schemas/events/payment-operation-reconciliation-required.v1.schema.json `reason` enum; docs/09 §Unit tests ("Provider error normalization", "Retry classification and backoff calculations"); docs/10 §M1 bullet 7
**Files:** create: `packages/domain/src/retry.ts`, `packages/domain/src/retry.test.ts`; modify: `packages/domain/src/index.ts`; must not touch: `provider.ts`

**Objective** — Single pure source for: which failures retry and how, how long to wait, and how a transport observation maps to a normalized outcome and the closed reconciliation-reason vocabulary.

**Implementation instructions**
1. Schedules and backoff:
   ```ts
   export const MESSAGE_RETRY_SCHEDULE_MS = [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000] as const; // then DLQ
   export const RECONCILIATION_SCHEDULE_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000] as const;                // then REQUIRES_REVIEW
   export const MAX_RETRY_AFTER_MS = 3_600_000;
   export type BackoffDecision = { readonly kind: 'RETRY'; readonly delayMs: number } | { readonly kind: 'EXHAUSTED' };
   export function backoff(schedule: readonly number[], failuresSoFar: number, random: () => number): BackoffDecision;
   export function boundRetryHint(hintMs: number | null, fallbackMs: number, maxMs: number): number;
   ```
   `backoff`: `failuresSoFar` is 1-based; `> schedule.length` → `EXHAUSTED`; else `base = schedule[failuresSoFar-1]`, `delayMs = base + Math.floor((2 * r - 1) * base / 5)` with `r = random()` in `[0,1)` → range `[0.8·base, 1.2·base)`. **[ASSUMPTION A-07]** ±20 % uniform jitter (docs/08:199 says "Delays include jitter" without magnitude). `random` is injected (no global `Math.random` inside). `boundRetryHint`: `null`/negative → `fallbackMs`; else `min(hintMs, maxMs)`.
2. Message failure classification (docs/04 table):
   ```ts
   export type MessageFailureClass = 'TRANSIENT_INFRASTRUCTURE' | 'HANDLER_RATE_LIMITED' | 'SCHEMA_INVALID' | 'UNSUPPORTED_VERSION' | 'INVARIANT_VIOLATION' | 'DUPLICATE_DELIVERY';
   export type MessageFailureAction = 'RETRY_WITH_BACKOFF' | 'RETRY_AFTER_HINT' | 'DLQ_AND_ALERT' | 'DLQ_DISCREPANCY_AND_REVIEW' | 'ACK_AFTER_DEDUPE';
   export function classifyMessageFailure(c: MessageFailureClass): MessageFailureAction;
   ```
   Mapping: TRANSIENT → RETRY_WITH_BACKOFF; HANDLER_RATE_LIMITED → RETRY_AFTER_HINT; SCHEMA_INVALID → DLQ_AND_ALERT; UNSUPPORTED_VERSION → DLQ_AND_ALERT; INVARIANT_VIOLATION → DLQ_DISCREPANCY_AND_REVIEW; DUPLICATE_DELIVERY → ACK_AFTER_DEDUPE.
3. Provider observation normalization (docs/06 §Error taxonomy + §Timeout policy):
   ```ts
   export const RECONCILIATION_REASONS = ['TIMEOUT_AFTER_SEND', 'CONNECTION_LOST_AFTER_SEND', 'PROVIDER_5XX_AMBIGUOUS', 'SDK_EXCEPTION_AFTER_SEND',
     'MALFORMED_PROVIDER_RESPONSE', 'MISSING_PROVIDER_CORRELATION', 'WORKER_CRASH_AFTER_SEND', 'STALE_PROCESSING', 'ADAPTER_DEFECT'] as const;
   export type ReconciliationReason = (typeof RECONCILIATION_REASONS)[number];
   export type TransportObservation =
     | 'CONFIRMED_MATCHING_SUCCESS' | 'BUSINESS_DECLINE' | 'LOCAL_VALIDATION_FAILED' | 'AUTHENTICATED_NO_EFFECT_REJECTION'
     | 'PRE_SEND_FAILURE_RETRYABLE' | 'PRE_SEND_FAILURE_FINAL' | 'RATE_LIMITED_NOT_EXECUTED'
     | 'TIMEOUT_AFTER_SEND' | 'CONNECTION_LOST_AFTER_SEND' | 'PROVIDER_5XX' | 'SDK_EXCEPTION_AFTER_SEND'
     | 'MALFORMED_SUCCESS' | 'MISSING_CORRELATION' | 'WORKER_CRASH_AFTER_SEND' | 'STALE_PROCESSING' | 'ADAPTER_DEFECT';
   export function classifyObservation(o: TransportObservation): { readonly outcome: ProviderOutcome['outcome']; readonly reconciliationReason: ReconciliationReason | null };
   ```
   | Observation | outcome | reason |
   | --- | --- | --- |
   | CONFIRMED_MATCHING_SUCCESS | SUCCEEDED | null |
   | BUSINESS_DECLINE | REJECTED | null |
   | LOCAL_VALIDATION_FAILED, AUTHENTICATED_NO_EFFECT_REJECTION, PRE_SEND_FAILURE_FINAL | FAILED | null |
   | PRE_SEND_FAILURE_RETRYABLE, RATE_LIMITED_NOT_EXECUTED | RETRYABLE_NO_EFFECT | null |
   | TIMEOUT_AFTER_SEND | UNKNOWN | TIMEOUT_AFTER_SEND |
   | CONNECTION_LOST_AFTER_SEND | UNKNOWN | CONNECTION_LOST_AFTER_SEND |
   | PROVIDER_5XX | UNKNOWN | PROVIDER_5XX_AMBIGUOUS |
   | SDK_EXCEPTION_AFTER_SEND | UNKNOWN | SDK_EXCEPTION_AFTER_SEND |
   | MALFORMED_SUCCESS | UNKNOWN | MALFORMED_PROVIDER_RESPONSE |
   | MISSING_CORRELATION | UNKNOWN | MISSING_PROVIDER_CORRELATION |
   | WORKER_CRASH_AFTER_SEND | UNKNOWN | WORKER_CRASH_AFTER_SEND |
   | STALE_PROCESSING | UNKNOWN | STALE_PROCESSING |
   | ADAPTER_DEFECT | UNKNOWN | ADAPTER_DEFECT |
   Invariant: no observation after possible transmission maps to `FAILED` or `RETRYABLE_NO_EFFECT` (docs/08 §No-blind-retry rule).

**Expected behavior**
- `backoff(MESSAGE_RETRY_SCHEDULE_MS, 1, () => 0)` → `{RETRY, 800}`; `(…, 1, () => 0.999999)` → `{RETRY, 1199}`; `(…, 7, () => 0.5)` → `{RETRY, 3600000}`; `(…, 8, …)` → `EXHAUSTED`.
- `backoff(RECONCILIATION_SCHEDULE_MS, 5, () => 0.5)` → `{RETRY, 3600000}`; `(…, 6, …)` → `EXHAUSTED` (caller moves to `REQUIRES_REVIEW`).
- `boundRetryHint(7_200_000, 1_000, MAX_RETRY_AFTER_MS)` → `3_600_000`; `boundRetryHint(null, 1_000, …)` → `1_000`.

**Acceptance criteria**
- [ ] Every table row and expected-behavior value is a test.
- [ ] Property: for every attempt within schedule and `r ∈ [0,1)`, `0.8·base <= delay < 1.2·base`.
- [ ] `ReconciliationReason` equals the schema enum (P01-GATE).

**Testing requirements** — `packages/domain/src/retry.test.ts`: `message schedule exact`, `reconciliation schedule exact`, `jitter bounds property`, `exhaustion after last step`, `failuresSoFar 0 rejected (throws INTERNAL_ERROR)`, `retry hint bounded`, `message failure classification table`, `observation table`, `post-send observations never FAILED or RETRYABLE_NO_EFFECT`. Command: `pnpm vitest run --project unit packages/domain/src/retry.test.ts`.

**Non-goals** — No scheduler, DB `notBefore` persistence, circuit breaker, or token bucket (P05/P06/P08).

**Handoff checklist**
- [ ] Commit body contains `Task: P01-T12`.

---

### P01-T13 — Stable provider idempotency key derivation

**Task ID:** `P01-T13`
**Feature:** Provider idempotency
**Commit:** `feat(domain): derive stable provider idempotency keys with versioned hashed fallback`
**Priority:** High
**Dependencies:** P01-T02, P01-T03
**Estimated complexity:** S
**Contract references:** docs/06 §Stable provider idempotency (lines 392-414), §Capability model (`writeIdempotency.maxKeyLength`); docs/03 §Provider attempt; docs/04 §Capture event example (`flowledger:test:fake-provider:op_…`); docs/07 §`payments.payment_operations` (`provider_idempotency_key`); docs/10 §M1 bullet 7
**Files:** create: `packages/domain/src/provider-key.ts`, `packages/domain/src/provider-key.test.ts`, `packages/domain/golden/provider-key.v1.json`; modify: `packages/domain/src/index.ts`; must not touch: `retry.ts`

**Objective** — Deterministic key per operation, never containing attempt numbers or timestamps, with the versioned hashed form when the provider's key limit is shorter.

**Implementation instructions**
```ts
export type ProviderEnvironment = 'local' | 'test' | 'sandbox';
export interface ProviderKeyDerivation {
  readonly key: string; readonly form: 'PLAIN' | 'HASHED_V1';
  readonly inputs: { readonly environment: ProviderEnvironment; readonly provider: ProviderName; readonly operationId: OperationId };
}
export function deriveProviderIdempotencyKey(i: { environment: ProviderEnvironment; provider: ProviderName; operationId: OperationId; maxKeyLength: number }): ProviderKeyDerivation;
```
- Plain: `flowledger:{environment}:{provider}:{operationId}`; used when `plain.length <= maxKeyLength`.
- Hashed **[ASSUMPTION A-08]** (docs/06 shows `fl:v1:{base32(sha256(environment | provider | operationId))}` without byte details): SHA-256 over the UTF-8 bytes of `${environment}|${provider}|${operationId}` (literal `|`, 0x7C), encoded RFC 4648 base32, **lowercase alphabet `abcdefghijklmnopqrstuvwxyz234567`, no padding** → 52 chars; key = `fl:v1:` + that = 58 chars.
- `maxKeyLength < 58` → throw `DomainError('INTERNAL_ERROR','PROVIDER_KEY_LIMIT_TOO_SMALL')` (capability is ineligible).
- **[ASSUMPTION A-09]** environment values are lowercase `local|test|sandbox` (docs/07 ledger `environment` uses upper case `LOCAL/TEST/SANDBOX`; docs/04's example key uses `test`). Callers lower-case explicitly.
- `inputs` are returned so P05 persists "the complete derivation inputs and resulting key" (docs/06).

**Golden vectors** (`provider-key.v1.json`; computed during planning)
| id | environment / provider / operationId / maxKeyLength | Expected key | form |
| --- | --- | --- | --- |
| `plain-docs-example` | test / fake-provider / `op_01ARZ3NDEKTSV4RRFFQ69G5FAX` / 255 | `flowledger:test:fake-provider:op_01ARZ3NDEKTSV4RRFFQ69G5FAX` (59 chars; equals docs/04 example) | PLAIN |
| `plain-boundary` | same / 59 | same | PLAIN |
| `hashed-boundary` | same / 58 | `fl:v1:wdvfqkxvjpsybp7mdoamfihok3t4yc5eyhcem2juu72ibpqwhwha` (SHA-256 hex `b0ea582af54be580bfec1b80c2a0ee56e7cc0ba4c1c4466934a7f480be163d8e`) | HASHED_V1 |
| `plain-unreliable` | sandbox / unreliable-provider / `op_7ZZZZZZZZZZZZZZZZZZZZZZZZZ` / 255 | `flowledger:sandbox:unreliable-provider:op_7ZZZZZZZZZZZZZZZZZZZZZZZZZ` (68 chars) | PLAIN |
| `hashed-unreliable` | same / 64 | `fl:v1:wniil6l4sg4ccn5yzfswi6cmhaglmy5r236kuuws65gh5d3j4ozq` | HASHED_V1 |
| `limit-too-small` | test / fake-provider / `op_01ARZ3NDEKTSV4RRFFQ69G5FAX` / 57 | throws `PROVIDER_KEY_LIMIT_TOO_SMALL` | — |

**Expected behavior** — same inputs → same key across calls/processes; different operation IDs → different keys.

**Acceptance criteria**
- [ ] All golden rows pass from the JSON file.
- [ ] Property: distinct `operationId`s (generated via `newId('op')`) produce distinct keys in both forms over 10 000 samples.
- [ ] Key never contains digits beyond those in its inputs (no attempt counters/timestamps): property `key is a pure function of the three inputs`.

**Testing requirements** — `packages/domain/src/provider-key.test.ts`: `golden <id>` × 6; `determinism`; `distinctness property`; `hashed key length is 58`; `base32 alphabet lowercase and unpadded`. Command: `pnpm vitest run --project unit packages/domain/src/provider-key.test.ts`.

**Non-goals** — No persistence of the key (P05); no adapter use (P06).

**Handoff checklist**
- [ ] Commit body contains `Task: P01-T13`.

---

### P01-GATE — Domain-ready gate (M1)

**Task ID:** `P01-GATE`
**Feature:** Milestone gate
**Commit:** `test(domain): verify M1 domain-ready gate and domain/contract parity`
**Priority:** Critical
**Dependencies:** P01-T01 … P01-T13
**Estimated complexity:** S
**Contract references:** docs/10 §M1 Test and acceptance criteria (all 8 bullets); docs/09 §Quality gates "Domain-ready", §Unit tests, §Property tests; openapi.yaml `ProblemCode`, `Payment.summaryStatus`, `PaymentOperation.status`/`type`, `Payment.authorizationOutcome`; schemas/common/provider-result-evidence.v1.schema.json; schemas/common/entity-ids.v1.schema.json; reconciliation-required `reason` enum
**Files:** create: `test/contract/domain-contract-parity.test.ts`, `docs/evidence/P01.md`; modify: none; must not touch: `packages/domain/src/**`

**Objective** — Prove M1 as a whole: the domain package's closed vocabularies equal the machine contracts, the golden files are complete, and the full unit/property suite passes at the CI seed.

**Implementation instructions**
1. `test/contract/domain-contract-parity.test.ts` (imports `@flowledger/domain` and `@flowledger/contracts` generated objects — allowed in tests):
   - `DomainErrorCode ⊆ openApiComponentsSchema.$defs.ProblemCode.enum` (export a runtime `DOMAIN_ERROR_CODES` array from `errors.ts` in T01 to make this checkable — if missing, this gate reopens T01).
   - Runtime arrays exported by domain (`OPERATION_TYPES`, `OPERATION_STATUSES`, `AUTHORIZATION_OUTCOMES`, `SUMMARY_STATUSES`, `PROVIDER_ERROR_CATEGORIES`, `RETRY_DIRECTIVES`, `NO_EFFECT_PROOF_KINDS`, `RESOLUTION_SOURCES`, `RECONCILIATION_REASONS`, `POSTING_OPERATION_TYPES`) equal, as sets, the corresponding enums in openapi (`PaymentOperation.type`, `.status`, `Payment.authorizationOutcome`, `.summaryStatus`) and schemas (`normalizedError.category`, `.retryDirective`, `noEffectProof` kinds, `providerEvidence.source`, reconciliation-required `reason`, ledger-posted `operationType`). Each of T07/T11/T12/T06 exports its array next to its union (`as const` + `typeof X[number]`).
   - Every `^<prefix>_` in `entity-ids.v1.schema.json` `$defs` is in `ID_PREFIXES`.
   - `MAX_AMOUNT_MINOR` equals the maximum allowed by `common/money.v1.schema.json` pattern (`1000000000000`).
   - Every golden file under `packages/domain/golden/` parses and has ≥ the row counts specified in T04/T05/T06/T13.
2. Run the full gate: `pnpm check`, then `FC_NUM_RUNS=1000 pnpm test:unit`, then `FC_SEED=$RANDOM pnpm test:unit` three times (record seeds).
3. `docs/evidence/P01.md`: table mapping each docs/10 §M1 acceptance bullet and each docs/09 "Domain-ready" item to the test file :: case that proves it; seeds used; commit SHA; CI run link.

**Expected behavior** — All parity checks pass; random-seed runs pass.

**Acceptance criteria**
- [ ] Every docs/10 §M1 AC bullet is mapped to a passing test in `docs/evidence/P01.md`.
- [ ] Parity test passes; it fails if any enum gains/loses a value on either side (verified by a temporary edit).
- [ ] Three random-seed runs recorded.

**Testing requirements** — `test/contract/domain-contract-parity.test.ts` cases as listed. Command: `pnpm check && FC_NUM_RUNS=1000 pnpm test:unit`.

**Non-goals** — No feature code; failures reopen the owning task.

**Handoff checklist**
- [ ] Commit body contains `Task: P01-GATE`.

---

## Parallelization

| Wave | Concurrent tasks | Shared files that conflict |
| --- | --- | --- |
| 1 | P01-T01 | — |
| 2 | P01-T02, P01-T03, P01-T04 | all append to `packages/domain/src/index.ts`; T02 also `package.json`/`pnpm-lock.yaml`/`docs/VERSIONS.md`; reasons appended to `errors.ts` |
| 3 | P01-T05 (after T02, T03), P01-T07 (after T02, T04), P01-T11 (after T02, T03), P01-T13 (after T02, T03) | `index.ts`, `errors.ts` |
| 4 | P01-T06 (after T05), P01-T08 (after T07), P01-T12 (after T11) | `index.ts`, `errors.ts` |
| 5 | P01-T09 (after T08) | `index.ts` |
| 6 | P01-T10 (after T09) | none |
| 7 | P01-GATE | — |

`errors.ts` (`DomainErrorReason`, `DOMAIN_ERROR_CODES`) and `index.ts` are append-only single-owner-per-commit surfaces: rebase and append, never reorder.

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| docs/10 M1: branded types for every entity ID | T02 | `ids.test.ts :: each prefix round-trips`, type test `PaymentId is not OperationId` |
| docs/10 M1: strict constructors for currency, amount, provider name, idempotency key, timestamp | T01, T03 | `money.test.ts`, `values.test.ts` |
| docs/10 M1: decimal-string ↔ bigint with bounds and checked arithmetic | T01 | `money.test.ts :: table cases`, `:: checkedAdd/checkedSub boundaries` |
| docs/10 M1: payment states, operation states, guards, version increments, derived summary status as pure functions | T07, T08, T09 | `payment.test.ts`, `commands.test.ts`, `transitions.test.ts` |
| docs/10 M1: capture fee + cumulative proportional refund-fee allocation | T04 | `fees.test.ts :: golden *` |
| docs/10 M1: canonical API request hashing + canonical ledger posting hashing | T05, T06 | `request-hash.test.ts :: golden *`, `posting-hash.test.ts :: golden *` |
| docs/10 M1: normalized provider result/error/evidence as discriminated unions | T11 | `provider.test.ts` |
| docs/10 M1: retry classification, backoff, stable provider key | T12, T13 | `retry.test.ts`, `provider-key.test.ts` |
| docs/10 M1: domain errors as codes; no HTTP/PubSub/SDK/SQL in domain | T01, P00-T02 | `lint-rules.test.ts :: boundary/domain/forbidden`; `domain-contract-parity.test.ts :: DomainErrorCode ⊆ ProblemCode` |
| docs/10 M1 AC: min, max, zero, malformed, overflow, non-USD amounts | T01 | `money.test.ts` table rows |
| docs/10 M1 AC: property tests over valid/invalid sequences check every monetary invariant after each step | T10 | `lifecycle.property.test.ts :: random sequences preserve invariants…`, `:: invalid actions are no-ops` |
| docs/10 M1 AC: capture-fee golden vectors (below/exact/above half, fixed+pct, overflow, zero, fee==gross, fee>gross) | T04 | `fees.test.ts :: capture-fee golden below-half / exact-half / above-half / fixed-plus-percentage / overflow / zero-fee / fee-equals-gross-* / fee-greater-than-gross` |
| docs/10 M1 AC: fee properties (non-negative, no over-reversal, exact full reversal) | T04, T10 | `fees.test.ts :: non-negative increments`, `:: no over-reversal at any prefix`, `:: exact full reversal`; `lifecycle.property.test.ts :: fee reversal bounded…` |
| docs/10 M1 AC: same canonical API input hashes identically; semantic changes alter hash | T05 | `request-hash.test.ts :: insertion order does not alter hash`, `:: semantic change <field> alters hash` |
| docs/10 M1 AC: posting hashes independent of entry order; match golden vectors | T06 | `posting-hash.test.ts :: order and split independence`, `:: golden *` |
| docs/10 M1 AC: impossible to construct FAILED without proof or SUCCEEDED without provider operation ID | T11 | `provider.test.ts` `@ts-expect-error` block |
| docs/10 M1 AC: randomized tests persist seed + minimized counterexample | T01, T10 | `fast-check-setup.ts` reporter; `lifecycle.property.test.ts` injected-bug evidence in commit body |
| docs/09 Domain-ready gate (money, fee, state-machine, idempotency unit/property) | GATE | `docs/evidence/P01.md` |
| docs/09 Unit: decimal parsing; range/currency/precision | T01 | `money.test.ts` |
| docs/09 Unit: fee calculation + proportional refund allocation | T04 | `fees.test.ts` |
| docs/09 Unit: canonical API request hashing | T05 | `request-hash.test.ts` |
| docs/09 Unit: posting-hash canonicalization | T06 | `posting-hash.test.ts` |
| docs/09 Unit: provider error normalization | T12 | `retry.test.ts :: observation table` |
| docs/09 Unit: retry classification and backoff | T12 | `retry.test.ts :: message failure classification table`, `:: jitter bounds property` |
| docs/09 Unit: derived payment summary status | T07 | `payment.test.ts :: summary rule <n>` |
| docs/09 Unit: event and webhook signature construction | Deferred to P09 (merchant webhook signing) | — |
| docs/09 Property: payment lifecycle (valid sequences, invalid no-ops, one unresolved blocks conflicting, terminal/duplicate/late/contradictory evidence, refunds ≤ captured) | T09, T10 | `lifecycle.property.test.ts`; `transitions.test.ts :: terminal * corroborates/contradicts` |
| docs/09 Property: fee allocation (5 bullets) | T04, T10 | `fees.test.ts` properties |
| docs/09 Property: refund reservation (4 bullets) | T08, T09, T10 | `lifecycle.property.test.ts :: refunded+reserved never increases`, `:: UNKNOWN refund keeps reservation…` |
| docs/09 Property: ledger bullets (balanced postings, rebuild, bucket stability) | Deferred to P03 (DB-backed) | — |
| docs/09: reproducible seed; persist minimal counterexample | T01 | `fast-check-setup.ts` |
| docs/02 Money rules (integers, string encoding, bigint, USD, max) | T01 | `money.test.ts` |
| docs/02 Capture fee formula HALF_UP, checked arithmetic, `0 <= F <= G` invariant | T04 | `fees.test.ts :: percentage component is HALF_UP`, `:: fee-greater-than-gross` |
| docs/02 Minimum capture amount → `422 CAPTURE_BELOW_MINIMUM` naming minimum | T04, T08 | `fees.test.ts :: minimum-boundary`; `commands.test.ts :: CAPTURE 29…` |
| docs/02 Refund fee computed at confirmation from confirmed cumulative refunds | T04, T09 | `transitions.test.ts :: refund fee linkage to golden thirds` |
| docs/02 Fee allocation under concurrent refunds (4 property bullets) | T04, T10 | as above |
| docs/02 Posting hash: versioned SHA-256 over JCS; combine/sort/ordinal; excludes timestamps/traces | T05, T06 | `posting-hash.test.ts`; `canonical-json.test.ts` |
| docs/03 Monetary invariants (all lines 122-141) | T07 | `payment.test.ts :: invariant <id> violated` |
| docs/03 State-dependent invariants (lines 150-155) | T07 | `:: UNAUTHORIZED_TOTALS_ZERO`, `:: CANCELED_OR_EXPIRED_VOIDS_ALL`, `:: CAPTURE_RELEASES_REMAINDER`, `:: CAPTURED_IFF_ONE_SUCCEEDED_CAPTURE` |
| docs/03 Exclusion model rules 1–3 and error codes | T08 | `commands.test.ts :: exclusive while refund unresolved rejected…`, `:: REFUND 1 → MONETARY_GUARD_FAILED` |
| docs/03 Guards per transition (authorize/capture/cancel/refund) | T08 | `commands.test.ts :: authorize/capture/cancel guards` |
| docs/03 Outcome tables per operation type | T09 | `transitions.test.ts :: resolve <TYPE> <OUTCOME> …` |
| docs/03 Authorization-expiry guards and effects | T09 | `transitions.test.ts :: expiry guards each fail`, `:: expiry success effects` |
| docs/03 Proven-no-effect retry (no payment version change; op version +1) | T09 | `transitions.test.ts :: retry/release version deltas` |
| docs/03 Racing signals (first wins; corroborating no effect; contradictory → discrepancy + version) | T09 | `transitions.test.ts :: terminal same outcome corroborates`, `:: terminal different outcome contradicts` |
| docs/03 Derived summary status precedence | T07 | `payment.test.ts :: summary precedence…` |
| docs/03 Aggregate and operation version rules | T08, T09, T10 | `lifecycle.property.test.ts` version oracle |
| docs/03 Required model test: refund race rejected by MONETARY_GUARD_FAILED not uniqueness | T08, T10 | `commands.test.ts` (asserts reason `REFUND_EXCEEDS_REFUNDABLE`); DB half in P05 |
| docs/03 Required model test: confirm same refund set in several orders | T04, T10 | `fees.test.ts :: order independence…` |
| docs/03 Required model test: capture below minimum → 422 with no operation | T08 (domain half) | `commands.test.ts :: CAPTURE 29…`; persistence half P05 |
| docs/03 MVP policy: max three authorization operations; UNKNOWN/REVIEW never permit replacement | T08 | `commands.test.ts :: Fourth AUTHORIZE…` |
| docs/05 Canonical request hash inputs (6 items), exclusions, case-sensitivity | T05 | `request-hash.test.ts` |
| docs/05 Money encoding (string regex, no numbers/signs/exponent/leading zero, positive commands, USD, max) | T01 | `money.test.ts` |
| docs/05 If-Match: strong single Payment ETag, participates in hash | T05 | `request-hash.test.ts :: invalid ifMatch variants rejected`, `:: semantic change ifMatch alters hash` |
| docs/06 TS interface, capability model, normalized results, error taxonomy, lookup results | T11 | `provider.test.ts` |
| docs/06 SUCCEEDED shape rules (authorize IDs, expiry only on authorize, capture ID only on capture) | T11 | `provider.test.ts :: succeeded runtime rules` |
| docs/06 RETRYABLE_NO_EFFECT requires proof, RETRY_SAME_OPERATION, bounded future retryNotBefore | T11 | `provider.test.ts` type + runtime cases |
| docs/06 Observation → outcome table; closed reconciliation reasons | T12 | `retry.test.ts :: observation table` |
| docs/06 Stable provider idempotency key + hashed fallback | T13 | `provider-key.test.ts :: golden *` |
| docs/04/08 Message retry delays and classification; reconciliation schedule | T12 | `retry.test.ts :: message schedule exact`, `:: reconciliation schedule exact` |
| docs/08 No-blind-retry rule (domain half) | T09, T12 | `transitions.test.ts :: UNKNOWN/REQUIRES_REVIEW cannot return…`; `retry.test.ts :: post-send observations never FAILED…` |
| docs/08 required failure-injection tests | none in M1 (no I/O) | — |

## Phase risks / open questions

| ID | Risk / conflict | Impact | Severity | Recommended resolution | Blocked tasks |
| --- | --- | --- | --- | --- | --- |
| R-01 | CONVENTIONS §6 says `schemas/common/entity-ids.v1.schema.json` is the authoritative prefix list, but docs/07 defines nine more PK prefixes (`mcr` :132, `pac` :218, `pwe` :240, `fee` :290, `pno` :636, `pev` :707, `led` :771, `lac` :783, `lcr` :917) and openapi defines `req_` (`openapi.yaml` `RequestId`). | A strict reading would block P01-T02 and P02. | Medium | Contracts outrank CONVENTIONS: P01-T02 includes all docs/07 + openapi prefixes. Coordinator should amend CONVENTIONS §6 to "entity-ids schema ∪ docs/07 PK checks ∪ openapi". | none |
| R-02 | docs/05 §Canonical request hash (lines 414-434) does not fix a byte encoding. | TS/PG or future implementations could disagree. | Medium | **[ASSUMPTION A-03]** exact canonical object in P01-T05 with `hashVersion: 1`; golden file is the contract for P02/P04. Contract owner should copy the object shape into docs/05. | none |
| R-03 | docs/02:187-193 and docs/07:887 name posting-hash fields but not JSON keys or null handling. | P03 PL/pgSQL could hash different bytes. | High | **[ASSUMPTION A-04]** exact object in P01-T06 (all reference keys present, `null` when absent; ASCII-only values) + `posting-hash.v1.json` shared with P03. Contract owner should record it in docs/07. | P03 posting routine depends on it |
| R-04 | docs/06:404 fallback key leaves separator bytes and base32 alphabet/padding unspecified; environment case differs (docs/07 `LOCAL/TEST/SANDBOX` vs docs/04 example `test`). | Key mismatch across restarts if two implementations differ. | Medium | **[ASSUMPTION A-08/A-09]** literal `\|` separator, RFC 4648 lowercase unpadded, lowercase environment; golden file. | none |
| R-05 | Refund fee `F * R` reaches 10^24, beyond PostgreSQL `bigint`. | A SQL implementation using `bigint` overflows (error, not silent) at large amounts. | Medium | P07's confirming SQL must compute with `numeric` and cast the result back to `bigint`; `refund-fee.v1.json` row `max-values` must be part of P07 integration tests. | P07 |
| R-06 | Domain error *reasons* and guard precedence are not in the contracts (docs/05 only lists codes). | P05 SQL may return a different code when several guards fail simultaneously. | Medium | **[ASSUMPTION A-06]** precedence in P01-T08 (active exclusive → refund-unresolved → lifecycle → monetary/minimum); P05 SQL mirrors it and reuses the same test fixtures. | none |
| R-07 | Jitter magnitude unspecified (docs/04:183, docs/08:199). | Benchmarks/tests may assume a different spread. | Low | **[ASSUMPTION A-07]** ±20 % uniform; single constant in `retry.ts`. | none |
| R-08 | Summary rule 10 "latest authorization" needs an operation order the aggregate does not carry. | Ambiguous when ops are passed unordered. | Low | **[ASSUMPTION A-05]** callers pass ops in creation order (`created_at, id`); P04 query must `ORDER BY created_at, id`. | none |
| R-09 | `fee > gross` has no problem code; docs/02:268 calls it an internal invariant breach. | Code choice. | Low | **[ASSUMPTION A-01]** `INTERNAL_ERROR` with reason `FEE_EXCEEDS_GROSS`; never capped. | none |
| R-10 | Canonical JSON restricted to safe integers (A-02); RFC 8785 number formatting for non-integers is not implemented. | A future body with a JSON non-integer number cannot be hashed. | Low | Current contracts carry money as strings and no float fields; revisit if a schema adds one. | none |
| R-12 | `docs/02-MONEY_AND_LEDGER_CONTRACT.md:266-268`, `docs/07-DATA_MODEL.md` §`payments.fee_policies` CHECK (`minimum_capture_amount_minor >= GREATEST(fixed_amount_minor, 1)`) and `docs/10-IMPLEMENTATION_PLAN.md:427` claim `fee <= gross` holds for every accepted capture "by construction". It does not when `basis_points > 0`: bp 5000, fixed 30, minimum 30, gross 40 → F = 20 + 30 = 50 > 40. | An accepted capture could hit the protected `0 <= F <= G` invariant (500 at acceptance) instead of a client-visible rule. | High | Add to the fee-policy insertion CHECK: `floor((minimum_capture_amount_minor * basis_points + 5000) / 10000) + fixed_amount_minor <= minimum_capture_amount_minor` (sufficient because `F(G) - G` is non-increasing). P01-T04 `checkFeePolicy` implements it and proves sufficiency by property; P02's `payments.fee_policies` migration should mirror it; contract owner should amend docs/02/07. | P02 fee-policy migration (recommended change) |
| R-11 | docs/09:85 money lint vs CONVENTIONS §5 (see P00 R-05). The P00 rule constrains `money.ts`/`fees.ts` to contain no `number`, so `basisPoints` is `bigint` in `fees.ts` while persistence uses `integer`. | Minor conversions at the DB boundary. | Low | P02 repositories convert `integer` basis points with `BigInt(row.basis_points)`. | none |
