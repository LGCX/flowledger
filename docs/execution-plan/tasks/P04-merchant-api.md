# P04 — Merchant API and HTTP idempotency

## Phase overview

**Goal.** Ship the authenticated merchant HTTP surface for payment **creation and retrieval**: NestJS + Fastify bootstrap in `apps/api`, bearer authentication with constant-time digest verification and per-operation scopes, request defenses (size, media type, duplicate JSON keys, unknown fields, JSON-number money, prohibited payment data), the RFC 9457 problem-details mapping, the protected `payments.create_payment` boundary, `POST /v1/payments`, the four read endpoints with cursor pagination and ETag/conditional GET, the payment timeline (only the `PAYMENT_CREATED` kind exists at P04), and the complete API idempotency behavior (replay, in-progress, conflict, expired tombstone). Provider-backed command endpoints are P05.

**Entry criteria.** `P02-GATE` green (schemas, roles, tables, deferred triggers, `messaging.insert_outbox`, RLS, seed, `withTransaction`, Testcontainers fixture). P04 does **not** depend on P03 and must not reference any `ledger.*` object; P03 runs in parallel.

**Exit gate (`P04-GATE`, checkpoint C4 "API up").** `docs/10` M4 test and acceptance criteria all pass end to end against a spawned API process: create/query/replay/timeline scenarios, tenant isolation (`404`), scope (`403`), credential (`401`), concurrent identical creates (one payment, one `payment.created.v1`), invalid inputs creating no idempotency/business row, stable cross-tenant-safe pagination, timeline ordering/redaction/`404`, and provider-route selection/rollover.

**Migration range.** `0400`–`0499`, in task order: `0410` (T06), `0420` (T07), `0425` (T08, only if a defect fix is needed), `0430` (T12). `0400` is intentionally unused (P02 already ships credential lookup).

### Interfaces consumed from earlier phases

Exact export names are whatever `P00-GATE`/`P01-GATE`/`P02-GATE` shipped; the behavior below is binding. If a named export is missing, stop and report per CONVENTIONS §14.

| From | Interface |
| --- | --- |
| P00 | `apps/api` inert entry point with common config + graceful-shutdown module; `packages/observability` pino logger factory + `packages/observability/src/redaction.ts` allowlist; `packages/testkit/src/prohibited-data.ts` (synthetic PAN, CVV, bearer token, provider secret); `packages/contracts` generated OpenAPI types, `buildEnvelope()`, Ajv envelope validator + semantic validator. |
| P01 | `packages/domain/src/ids.ts` `newId(prefix)` + branded parsers; `packages/domain/src/money.ts` `MinorUnits` parse/format; `ID_PREFIXES` (incl. `request: 'req'`); `computeRequestHash({ commandType, pathParams, body, ifMatch })` (`docs/05` §Canonical request hash; route/method/API version derived from `commandType`); `computeCaptureFee`; `deriveSummaryStatus(payment, ops)`; `deriveProviderIdempotencyKey` and `ProviderEnvironment` (`'local' | 'test' | 'sandbox'`). |
| P02 | `packages/domain/src/credentials.ts` (`parseCredential`, `credentialDigest`, `verifyCredential`, `parsePeppers`, env `API_CREDENTIAL_PEPPERS`); `packages/database/src/repositories/identity.ts` `lookupCredential` (pre-tenant lookup via transaction-local `app.credential_key_prefix`, RLS-scoped); SQL `api.claim_idempotency_key(...)` (claim-first insert of the full record, `OWNER`/`REPLAY`/`CONFLICT`/`EXPIRED`, bounded wait → `IDEMPOTENCY_REQUEST_IN_PROGRESS`, deferred resource-integrity trigger), `providers.select_route(merchant, environment, provider_code)` (share-locks the current account version, raises `PROVIDER_ROUTE_UNAVAILABLE`), `public.fl_current_merchant_id()`, `public.fl_assign_function_owner(...)`; fixtures `createTestMerchant`, `fixtureInsertIdempotencyRecord`, `fixtureInsertPayment`, `fixtureInsertOperation`, `fixtureClaim`; tables exactly per `docs/07`: `identity.merchants`, `identity.merchant_api_credentials`, `providers.provider_accounts`, `providers.merchant_routes`, `providers.provider_account_versions`, `payments.fee_policies`, `payments.payments`, `payments.payment_operations`, `api.idempotency_records`, `messaging.outbox_messages`; `messaging.insert_outbox(envelope jsonb)`; roles from CONVENTIONS §7 (`payments_function_owner`, `fl_api`, …); RLS policies keyed on `current_setting('app.merchant_id', true)`; `packages/database/src/pool.ts`, `tx.ts` `withTransaction(pool, ctx, fn)`, `errors.ts` (`P0001` → `DomainError{code, detail}`); `packages/testkit/src/pg.ts` Testcontainers fixture exposing a superuser URL and per-role URLs, plus seed builders for a merchant with credential(s), provider account, active route, current account version, and current fee policy; `flowledger seed --profile dev`. |

### Interfaces provided to later phases

| Interface | Path / signature | Used by |
| --- | --- | --- |
| API app factory | `apps/api/src/app.ts` `createApiApp(config: ApiConfig): Promise<NestFastifyApplication>` | P05 (command endpoints), P11 |
| Operation table | `apps/api/src/http/operations.ts` `OPERATIONS` (operationId → method, path template, scopes, commandType) | P05 adds the four command entries, P09 |
| Problem mapping | `apps/api/src/errors/problem-map.ts` `PROBLEMS`, `ProblemError` (`apps/api/src/errors/problem.ts`) | P05 |
| Request pipeline | strict JSON parser, `validateRequest(operationId, parts)`, `assertNoProhibitedData(...)`, header parsers `parseIdempotencyKey`, `parsePaymentETag`, `parseIfNoneMatch` | P05 |
| Principal | `request.principal: { merchantId, credentialId, scopes }` set by the auth hook | P05 |
| Payment-method crypto | `packages/domain/src/payment-method-crypto.ts` `encryptPaymentMethodRef`, `decryptPaymentMethodRef`, `hashPaymentMethodRef` | P06 (authorize decrypt) |
| SQL read surface | `payments.payment_representation(text)`, `payments.operation_representation(text)`, `payments.list_payments(...)`, `payments.list_payment_operations(...)`, `payments.payment_timeline(text)` | P05 (replay bodies, timeline kinds), P06–P10 (timeline kinds) |
| Create boundary | `payments.begin_create_payment(...)`, `payments.create_payment(...)`; TS wrappers in `packages/database/src/functions/payments.ts` | P05 (pattern reused), P12 |
| Fault hook | `payments.fault_point(p_point text)` (no-op in migrations); `packages/testkit/src/sql-fault-hooks.ts` `installSqlFaultHooks(adminUrl)`, `armSqlFault(adminUrl, point)`, `disarmSqlFaults(adminUrl)` | P05, P07, P10 |
| Conformance helper | `packages/testkit/src/openapi-conformance.ts` `assertConformsToOpenApi(operationId, { status, headers, body })` | P05, P09 |
| Timeline detail validators | `packages/contracts/src/timeline-detail.ts` `TIMELINE_DETAIL_SCHEMAS`, `validateTimelineDetail(kind, detail)` | P05–P10 add kinds |
| Test API harness | `packages/testkit/src/api.ts` `startTestApi(opts)` → `{ app, inject, close }` | P05+ |

### Design decisions fixed by this phase (read before any task)

1. **Two-call create transaction.** CONVENTIONS §9 requires the outbox envelope to be built and Ajv-validated in TypeScript, but `payment.created.v1` needs `providerAccountId`/`feePolicyVersion` that only routing (inside PostgreSQL) knows. One `withTransaction` therefore runs: (a) `payments.begin_create_payment` — answers a committed replay via a read-only peek, otherwise calls P02 `providers.select_route` (share lock) and share-locks the current fee policy, then claims the key with P02 `api.claim_idempotency_key` and returns the snapshot; (b) TypeScript validates the token for the selected provider, encrypts it, builds and validates the envelope; (c) `payments.create_payment` — proves the claim was taken in this transaction, inserts the payment, verifies it equals the claimed replay body, and inserts the outbox row. Called without (a), `create_payment` fails closed (`INTERNAL_CLAIM_REQUIRED`).
2. **Idempotency claim (P02).** `api.claim_idempotency_key` inserts the complete record first (`ON CONFLICT DO NOTHING`, bounded `lock_timeout` 2 000 ms → `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`), so the replay body must be known at claim time; `payments.new_payment_representation` builds it from the request plus one database timestamp that the subsequent insert reuses, and `create_payment` asserts equality with the committed row. The claim precedes every payment-row lock (canonical lock order `docs/07` §Transaction and lock ownership); only read-only peeks and route/fee share locks come before it.
3. **Representations are built in SQL.** Replay bodies must be stored in the same transaction using database time, so `payments.payment_representation` / `payments.operation_representation` produce the exact public JSON; GET endpoints use the same functions. Replays and first responses send the stored `response_body::text` bytes verbatim, which makes them byte-identical.
4. **Expiry at read time.** Per README C-07, a record is expired when `tombstoned_at IS NOT NULL OR clock_timestamp() >= replay_expires_at`; no deletion job exists in P04.
5. **Fault injection.** Migrations install `payments.fault_point(p_point text)` as an empty `plpgsql VOLATILE` function called at named points. Only `packages/testkit/src/sql-fault-hooks.ts`, which refuses to run unless `FLOWLEDGER_FAULT_HOOKS=1`, replaces its body (as superuser) with one that raises when the point is armed in `public.testkit_fault_points`, and installs commit-time deferred fault triggers. Production databases never contain the raising body.
6. **Timeline kinds at P04.** Exactly one kind exists: `PAYMENT_CREATED` (source `payments.payments`). Later kinds and owners: `OPERATION_ACCEPTED` (P05), `PROVIDER_ATTEMPT`, `PROVIDER_EVIDENCE`, `OPERATION_RESOLVED` (P06), `LEDGER_POSTING` (P07), `RECONCILIATION_ACTIVITY`, `DISCREPANCY`, `AUTHORIZATION_EXPIRED` (P08), `WEBHOOK_DELIVERY` (P09), `SETTLEMENT` (P10).

---

### P04-T01 — API bootstrap, request context, and problem details

**Task ID:** `P04-T01`
**Feature:** HTTP bootstrap and canonical error format
**Commit:** `feat(api): bootstrap nest fastify api with request context and problem details`
**Priority:** Critical
**Dependencies:** `P02-GATE`
**Estimated complexity:** M
**Contract references:** `docs/05` §General conventions, §Request and correlation identifiers, §Canonical error format; `openapi/openapi.yaml` `components.schemas.ProblemCode`, `ProblemBase`, `Problem*`, `components.headers.RequestId`, `CorrelationId`; CONVENTIONS §10, §11; `docs/10` §Delivery safety
**Files:** create: `apps/api/src/app.ts`, `apps/api/src/app.module.ts`, `apps/api/src/http/request-context.ts`, `apps/api/src/http/operations.ts`, `apps/api/src/errors/problem-map.ts`, `apps/api/src/errors/problem.ts`, `apps/api/src/errors/problem-filter.ts`, `apps/api/src/errors/problem-map.test.ts`, `apps/api/src/http/request-context.test.ts`, `packages/config/src/api.ts`, `packages/testkit/src/api.ts`, `test/integration/api/bootstrap.test.ts`; modify: `apps/api/src/main.ts`, `packages/domain/src/ids.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/**`, `openapi/**`, `schemas/**`, `packages/domain/src/state/**`

**Objective** — Give every later API task one application factory, one request-context mechanism (request ID, correlation ID), one route table, and one problem-details error path so all responses carry the contracted headers and error shape.

**Implementation instructions**
1. `packages/config/src/api.ts`: export `ApiConfig` and `loadApiConfig(env)`; variables: `API_PORT` (default `3000`), `DATABASE_URL`, `DATABASE_POOL_MAX` (reuse P02 parsing). Frozen object; missing/invalid variable fails with its name only. Add `API_PORT` to `.env.example` and `docs/CONFIG.md` if P00 did not.
2. `packages/domain/src/ids.ts`: P01 already has `request: 'req'`; add `correlation: 'cor'` to `ID_PREFIXES` (source `docs/05` §Canonical error format example `cor_…`; the correlation contract itself is only `^[A-Za-z0-9._:-]{16,128}$`). Generated IDs: `newId(ID_PREFIXES.request)`, `newId(ID_PREFIXES.correlation)`. Do not add any other prefix.
3. `apps/api/src/app.ts`: `createApiApp(config)` builds `NestFactory.create(AppModule, new FastifyAdapter({ bodyLimit: 65536, logger: <observability pino instance> }), { bodyParser: false })`, registers the problem filter globally, the `onRequest` request-context hook, and returns the app without listening. `main.ts` loads config, calls `createApiApp`, `listen(API_PORT, '0.0.0.0')`, and keeps P00's graceful-shutdown wiring (`enableShutdownHooks`, close pool on shutdown). Keep P00's health/readiness endpoints; readiness runs `SELECT 1` on the pool.
4. `apps/api/src/http/request-context.ts`: Fastify `onRequest` hook (registered first) that:
   - sets `request.requestId = newId(ID_PREFIXES.request)` and always sends response header `X-Request-Id`;
   - reads `X-Correlation-Id`; if absent → `newId(ID_PREFIXES.correlation)`; if present and not matching `^[A-Za-z0-9._:-]{16,128}$` → generate a fresh `cor_…` for the response and throw `ProblemError('INVALID_CORRELATION_ID')`; otherwise use it verbatim. Always send `X-Correlation-Id` (replays override it later with the stored value).
5. `apps/api/src/http/operations.ts`: export
   ```ts
   export const OPERATIONS = {
     createPayment: { method: 'POST', path: '/v1/payments', scopes: ['payments:write'], commandType: 'CREATE_PAYMENT' },
     listPayments: { method: 'GET', path: '/v1/payments', scopes: ['payments:read'] },
     getPayment: { method: 'GET', path: '/v1/payments/{paymentId}', scopes: ['payments:read'] },
     listPaymentOperations: { method: 'GET', path: '/v1/payments/{paymentId}/operations', scopes: ['payments:read'] },
     getPaymentTimeline: { method: 'GET', path: '/v1/payments/{paymentId}/timeline', scopes: ['payments:read'] },
     getOperation: { method: 'GET', path: '/v1/operations/{operationId}', scopes: ['payments:read'] },
   } as const;
   export const NOT_YET_IMPLEMENTED = ['authorizePayment','capturePayment','cancelPaymentAuthorization','refundPayment','ingestProviderWebhook'] as const;
   export function operationFor(method: string, fastifyRouteUrl: string): OperationId | undefined; // maps '/v1/payments/:paymentId' style URLs
   ```
6. `apps/api/src/errors/problem-map.ts`: `PROBLEMS: Record<ProblemCode, { status: number; title: string }>` containing **exactly** the 27 codes of `openapi.yaml` `ProblemCode` with the HTTP status from `docs/05` §Canonical error format (`INVALID_PROVIDER_SIGNATURE` → 401 is included for completeness). `type` is derived: `urn:flowledger:problem:` + code lower-cased with `_` → `-`.
7. `apps/api/src/errors/problem.ts`: `class ProblemError extends Error { code; detail?; errors?: {pointer, reason}[]; resourceLocation?; headers?: Record<string,string> }`. `detail` defaults to the title.
8. `apps/api/src/errors/problem-filter.ts`: global Nest exception filter + Fastify `setErrorHandler`/`setNotFoundHandler` producing `application/problem+json` bodies with exactly the `ProblemBase` fields (`type,title,status,code,detail,instance,requestId,correlationId`, optional `errors`, optional `resourceLocation`). `instance` = request path without query string. Mapping rules:
   - `ProblemError` → its code.
   - `DomainError` (P02 `errors.ts`) whose `code` is a key of `PROBLEMS` → that code; `detail` from the domain `DETAIL` JSON only when the task that raises it says so.
   - Fastify `FST_ERR_CTP_BODY_TOO_LARGE` → `REQUEST_TOO_LARGE`; `FST_ERR_CTP_INVALID_MEDIA_TYPE` → `UNSUPPORTED_MEDIA_TYPE`; `FST_ERR_CTP_EMPTY_JSON_BODY` → `INVALID_REQUEST`.
   - Unknown route → `404 RESOURCE_NOT_FOUND`; known path with wrong method → `404 RESOURCE_NOT_FOUND` **[ASSUMPTION: openapi defines no 405]**.
   - `pg` connection errors (SQLSTATE class `08`, `57P01`, pool `timeout exceeded when trying to connect`) → `503 SERVICE_UNAVAILABLE` with `Retry-After: 1`.
   - Anything else → `500 INTERNAL_ERROR`; the original message is logged through the redaction allowlist and never placed in the body.
   - `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` always adds `Retry-After: 1`. `401` always adds `WWW-Authenticate` (value set by P04-T04).
9. `packages/testkit/src/api.ts`: `startTestApi({ databaseUrl, env? })` → `{ app, inject(opts), close() }` using `createApiApp` and Fastify `inject`.

**Expected behavior**
- `GET /v1/nope` → `404`, `Content-Type: application/problem+json`, body `{"type":"urn:flowledger:problem:resource-not-found","title":"…","status":404,"code":"RESOURCE_NOT_FOUND","detail":"…","instance":"/v1/nope","requestId":"req_…","correlationId":"cor_…"}`, headers `X-Request-Id`, `X-Correlation-Id`.
- `X-Correlation-Id: short` → `400 INVALID_CORRELATION_ID`; response `X-Correlation-Id` is a fresh `cor_…`, not `short`.
- `X-Correlation-Id: abcdefghijklmnop` → echoed verbatim.

**Acceptance criteria**
- [ ] `PROBLEMS` keys equal `openapi.yaml` `ProblemCode.enum` exactly, and each status equals the `docs/05` table.
- [ ] Every response (success or problem) carries `X-Request-Id` matching `^req_[0-7][0-9A-HJKMNP-TV-Z]{25}$` and an `X-Correlation-Id` matching the contract pattern.
- [ ] Problem bodies contain no field outside `ProblemBase` and never contain an exception message or stack.
- [ ] `503` and `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` carry `Retry-After: 1`.
- [ ] `createApiApp` does not register Nest's default body parser.

**Testing requirements**
- `apps/api/src/errors/problem-map.test.ts`: loads `openapi/openapi.yaml` with `@apidevtools/swagger-parser`, asserts key-set equality with `ProblemCode`, asserts each status against a literal copy of the `docs/05` table, asserts `type` derivation for `IDEMPOTENCY_CONFLICT` = `urn:flowledger:problem:idempotency-conflict`.
- `apps/api/src/http/request-context.test.ts`: correlation ID boundary cases — 15 chars (reject), 16 (accept), 128 (accept), 129 (reject), contains `/` (reject), absent (generated `cor_`).
- `test/integration/api/bootstrap.test.ts` (Testcontainers PG): unknown route 404 shape; wrong method 404; thrown generic `Error` in a test-only route registered by the test → 500 without message leakage (assert body does not contain the error text); stopped database (terminate pool) → `503` + `Retry-After: 1`; readiness endpoint 200 with DB, 503 without.
- Commands: `pnpm vitest run --project unit apps/api/src`, `pnpm vitest run --project integration test/integration/api/bootstrap.test.ts`, `pnpm check`.

**Non-goals** — No authentication, no body parsing, no endpoints beyond health/readiness, no rate limiting (`429 RATE_LIMITED` stays in the map but nothing emits it in P04).

**Handoff checklist**
- [ ] Only listed files changed; `.env.example`/`docs/CONFIG.md` updated for any new variable.
- [ ] Problem-map test observed failing after removing one code from `PROBLEMS`, then restored.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P04-T02 — Strict JSON body parsing, size bound, and media type

**Task ID:** `P04-T02`
**Feature:** Request defenses — size, content type, duplicate keys, invalid Unicode
**Commit:** `feat(api): add strict json parser with duplicate-key and size rejection`
**Priority:** Critical
**Dependencies:** `P04-T01`
**Estimated complexity:** M
**Contract references:** `docs/05` §General conventions (64 KiB bound before parsing, duplicate keys rejected, UTF-8), §Canonical request hash ("Reject malformed JSON, duplicate keys, … invalid Unicode"); `openapi.yaml` responses `Problem413Response`, `Problem415Response`, `Problem400Response`
**Files:** create: `apps/api/src/http/strict-json.ts`, `apps/api/src/http/strict-json.test.ts`, `apps/api/src/http/body-parser.ts`, `test/integration/api/body-defenses.test.ts`; modify: `apps/api/src/app.ts`; must not touch: `migrations/**`, `openapi/**`

**Objective** — Fastify's default JSON parser silently keeps the last duplicate key and accepts lone surrogates; the contract requires rejecting both before any hashing or effect. Replace it with a strict parser and enforce the 64 KiB bound and JSON-only media type.

**Implementation instructions**
1. `apps/api/src/http/strict-json.ts`: `export function parseStrictJson(bytes: Buffer): unknown` and `export class StrictJsonError extends Error { reason: 'INVALID_UTF8' | 'MALFORMED' | 'DUPLICATE_KEY' | 'INVALID_UNICODE_ESCAPE' | 'TOO_DEEP' }`.
   - Decode with `new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })`; a leading BOM is `MALFORMED`.
   - Hand-written recursive-descent scanner over the decoded string implementing RFC 8259 grammar exactly (objects, arrays, strings with escapes, numbers, `true/false/null`, insignificant whitespace `\t\n\r ` only). Build the value while scanning (do not call `JSON.parse`).
   - Per object, track keys in a `Set`; a repeated key (compared after escape decoding) → `DUPLICATE_KEY`.
   - `\uD800`–`\uDFFF` escapes must form a valid high+low pair, otherwise `INVALID_UNICODE_ESCAPE`.
   - Nesting depth > 32 → `TOO_DEEP`.
   - Numbers are kept as their **source text** wrapped in `class JsonNumber { constructor(readonly text: string) {} }` so no precision is lost and later validation can reject numeric money with the original digits available to the prohibited-data scanner (P04-T03). Ajv validation in P04-T03 treats `JsonNumber` as type `number` via a pre-validation conversion described there.
   - Trailing non-whitespace after the root value → `MALFORMED`.
2. `apps/api/src/http/body-parser.ts`: `registerStrictJsonParser(fastify)`:
   - `fastify.removeAllContentTypeParsers()`;
   - `fastify.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 65536 }, handler)`; the handler rejects a `charset` parameter other than `utf-8` (case-insensitive) with `ProblemError('UNSUPPORTED_MEDIA_TYPE')`, stores `request.rawBody = buffer`, and returns `parseStrictJson(buffer)`; `StrictJsonError` → `ProblemError('INVALID_REQUEST', { errors: [{ pointer: '', reason: <reason> }] })`.
   - Any other content type with a body → Fastify `FST_ERR_CTP_INVALID_MEDIA_TYPE` → `415 UNSUPPORTED_MEDIA_TYPE` (mapped in P04-T01).
   - Body larger than 65 536 bytes (declared `Content-Length` or streamed) → `413 REQUEST_TOO_LARGE`, never parsed.
3. Call `registerStrictJsonParser` from `createApiApp` before routes are registered.

**Expected behavior**
- `{"a":1,"a":2}` → `400 INVALID_REQUEST`, `errors:[{"pointer":"","reason":"DUPLICATE_KEY"}]`.
- `{"a":"\ud800"}` → `400 INVALID_REQUEST` reason `INVALID_UNICODE_ESCAPE`.
- Body `0xFF 0xFE …` → `400` reason `INVALID_UTF8`.
- 65 537-byte valid JSON → `413 REQUEST_TOO_LARGE`; 65 536 bytes → parsed.
- `Content-Type: text/plain` with body → `415`; `application/json; charset=ISO-8859-1` → `415`; `application/json; charset=UTF-8` → accepted.

**Acceptance criteria**
- [ ] No code path in `apps/api` calls `JSON.parse` on a request body.
- [ ] Duplicate keys at any depth (including inside arrays of objects) are rejected.
- [ ] The size bound is enforced before parsing (assert the parser handler is never invoked for a 65 537-byte body).
- [ ] Error bodies never echo request content.

**Testing requirements**
- `apps/api/src/http/strict-json.test.ts` (unit): valid RFC 8259 corpus (nested, escapes, `é`, surrogate pair `😀`, exponent numbers kept as `JsonNumber` text `1e3`); each `StrictJsonError` reason with a minimal input; duplicate key with escaped equivalent (`{"a":1,"a":2}` → `DUPLICATE_KEY`); depth 32 accepted, 33 rejected; fast-check property: for generated JSON values without duplicate keys, `parseStrictJson(Buffer.from(JSON.stringify(v)))` deep-equals `v` after `JsonNumber` → number conversion.
- `test/integration/api/body-defenses.test.ts`: register a test-only `POST /__test/echo` route in the test via `app.getHttpAdapter()` and assert the HTTP mappings above (`413`, `415`, `400` reasons, empty body with JSON content type → `400 INVALID_REQUEST`), plus `X-Request-Id`/`X-Correlation-Id` on each.
- Commands: `pnpm vitest run --project unit apps/api/src/http/strict-json.test.ts`, `pnpm vitest run --project integration test/integration/api/body-defenses.test.ts`.

**Non-goals** — Schema validation, money classification, prohibited-data scanning (P04-T03).

**Handoff checklist**
- [ ] Duplicate-key test observed failing when the `Set` check is removed.
- [ ] `pnpm check` green.

---

### P04-T03 — Schema validation, money encoding, header parsing, and prohibited payment data

**Task ID:** `P04-T03`
**Feature:** Request defenses — unknown fields, JSON-number money, credential/card data, header formats
**Commit:** `feat(api): validate requests against openapi and reject prohibited payment data`
**Priority:** Critical
**Dependencies:** `P04-T02`
**Estimated complexity:** L
**Contract references:** `docs/05` §General conventions, §Money encoding, §Required commands and key format, §Optimistic version preconditions (format only), §Retrieve a payment or operation (`If-None-Match`), §Pagination (`limit`, `cursor` shape), §Canonical error format; `openapi.yaml` `components.parameters.*`, `components.schemas.CreatePaymentRequest`, `EmptyRequest`, `AmountCommandRequest`, `PositiveMoney`, `PositiveAmountMinor`, `IdempotencyKey`, `PaymentETag`, `ValidationIssue`; CONVENTIONS §10, §12
**Files:** create: `packages/contracts/src/openapi-validators.ts`, `apps/api/src/http/validation.ts`, `apps/api/src/http/headers.ts`, `apps/api/src/http/prohibited-data.ts`, `apps/api/src/http/validation.test.ts`, `apps/api/src/http/headers.test.ts`, `apps/api/src/http/prohibited-data.test.ts`, `test/contract/openapi-validators.test.ts`; modify: `packages/contracts/src/index.ts`; must not touch: `openapi/**`, `migrations/**`

**Objective** — Reject every malformed, unknown, non-string-money, or prohibited input with the exact contracted problem code before authentication-scoped work touches the database.

**Implementation instructions**
1. `packages/contracts/src/openapi-validators.ts`: `export async function loadOpenApiValidators(openapiPath = <repo>/openapi/openapi.yaml): Promise<OpenApiValidators>` — `SwaggerParser.dereference` once; compile with `ajv/dist/2020` (`strict: true`, `allErrors: true`, `ajv-formats`) the request body schema, path parameter schemas, and header/query parameter schemas for every operation in `OPERATIONS`; register every `x-flowledger-*` key found in the document with `ajv.addKeyword(name)` so strict mode accepts them. Return `validateBody(operationId, value)`, `validateParam(operationId, location, name, value)`.
2. `apps/api/src/http/validation.ts`: `validateRequest(operationId, { params, query, body })`:
   - Convert `JsonNumber` instances to JS `number` **only for validation** (`Number(text)`) — money fields are typed `string`, so any number at a money path fails `type`.
   - Unknown query parameters (not declared for the operation) → `400 INVALID_REQUEST`, `errors:[{pointer:'/query', reason:'UNKNOWN_PARAMETER'}]` (do not echo the name).
   - Path parameter pattern failure (e.g. `paymentId` not `^pay_[0-7][0-9A-HJKMNP-TV-Z]{25}$`) → `400 INVALID_REQUEST` with `pointer: '/path/paymentId'`, reason `PATTERN`.
   - Body classification over Ajv errors (deterministic): if any error has keyword `additionalProperties` or `maxProperties` → `INVALID_REQUEST`; else if any error `instancePath` starts with `/amount` → `INVALID_AMOUNT`; else → `INVALID_REQUEST`. `errors[]` entries: `pointer` = `instancePath` (for `additionalProperties`, the parent path — never the offending key name), `reason` = Ajv keyword upper-snake (`PATTERN`, `TYPE`, `REQUIRED`, `CONST`, `ADDITIONAL_PROPERTY`), at most 100.
3. `apps/api/src/http/headers.ts`:
   - `parseIdempotencyKey(headers, method)`: on POST, missing → `400 IDEMPOTENCY_KEY_REQUIRED`; not `^[A-Za-z0-9._:-]{16,128}$` → `400 INVALID_IDEMPOTENCY_KEY`; present on GET → `400 INVALID_REQUEST` (docs/05: "not accepted on GET").
   - `parsePaymentETag(value)`: exactly one strong tag matching `^"payment-(pay_[0-7][0-9A-HJKMNP-TV-Z]{25})-v([1-9][0-9]*)"$`; weak (`W/`), lists (`,`), `*`, or anything else → `400 INVALID_REQUEST` reason `IF_MATCH_FORMAT`. Returns `{ raw, paymentId, version: bigint }`. Used by P05; on `POST /v1/payments` any `If-Match` → `400 INVALID_REQUEST` reason `IF_MATCH_NOT_ACCEPTED`.
   - `parseIfNoneMatch(value, kind: 'payment'|'operation')`: must match the `PaymentETag` or `OperationETag` pattern for that kind; else `400 INVALID_REQUEST` reason `IF_NONE_MATCH_FORMAT` **[ASSUMPTION: docs/10 "invalid conditional-GET ETags … fail"; openapi only bounds length 1–128]**.
4. `apps/api/src/http/prohibited-data.ts`: `assertNoProhibitedData({ body, query, headers })` throws `ProblemError('PROHIBITED_PAYMENT_DATA')` with **no** `errors` array. Rules:
   - Scan every object key, every string value, and every `JsonNumber.text` in the body recursively; every query value; headers `idempotency-key` and `x-correlation-id`.
   - **PAN rule:** any run of 13–19 digits, where digits may be separated by single spaces or single hyphens, that passes the Luhn check.
   - **Field-name rule:** a key whose lower-cased form with `_`/`-` removed is one of `cardnumber, pan, primaryaccountnumber, cvv, cvv2, cvc, cvc2, securitycode, cardverificationvalue, accountnumber, routingnumber, iban, bankaccount, track1, track2, pin`.
5. Pipeline order for every merchant route (enforced by the route handler helper P04-T09/T10 use): `onRequest` (request context → auth, P04-T04) → body parse (P04-T02) → `assertNoProhibitedData` → `validateRequest` → header parsers → handler. Prohibited data therefore wins over unknown-field errors.

**Expected behavior**
- Create body `{"amount":{"amountMinor":10000,"currency":"USD"},"paymentMethodRef":"pm_fake_abc"}` → `400 INVALID_AMOUNT`, `errors:[{"pointer":"/amount/amountMinor","reason":"TYPE"}]`.
- `"amountMinor":"010"`, `"0"`, `"1000000000001"`, `"1e3"`, `" 1"`, `"1,000"` → `400 INVALID_AMOUNT`; `"1000000000000"` → passes validation.
- `"currency":"EUR"` → `400 INVALID_AMOUNT`.
- `{"amount":{…},"paymentMethodRef":"pm_fake_a","merchantId":"mer_…"}` → `400 INVALID_REQUEST` reason `ADDITIONAL_PROPERTY`, pointer `""`.
- `{"cardNumber":"x", …}` → `400 PROHIBITED_PAYMENT_DATA`; `"paymentMethodRef":"4111 1111 1111 1111"` → `400 PROHIBITED_PAYMENT_DATA`.
- `Idempotency-Key: abc` → `400 INVALID_IDEMPOTENCY_KEY`.

**Acceptance criteria**
- [ ] Request schemas are compiled from `openapi.yaml`, not hand-written.
- [ ] Every Ajv-based rejection maps per the deterministic rule; a JSON number in any money position yields `INVALID_AMOUNT`.
- [ ] Prohibited-data problem bodies contain no pointer, value, or key name.
- [ ] Prohibited-data detection runs before schema validation.

**Testing requirements**
- `apps/api/src/http/validation.test.ts`: every money boundary listed above for both `CreatePaymentRequest` and `AmountCommandRequest`; `EmptyRequest` with one property → `INVALID_REQUEST`; mixed unknown-field + bad-amount body → `INVALID_REQUEST` (rule precedence); unknown query param; malformed `limit` (`0`, `101`, `abc`) → `INVALID_REQUEST`.
- `apps/api/src/http/headers.test.ts`: key length 15/16/128/129, disallowed char `/`; If-Match strong ok, `W/"payment-…-v1"`, list of two, `*`, `v0`; If-None-Match per kind.
- `apps/api/src/http/prohibited-data.test.ts`: each fixture from `packages/testkit/src/prohibited-data.ts`; PAN with spaces/hyphens; 16-digit non-Luhn string passes; PAN inside a key name; PAN as a JSON number; PAN in `Idempotency-Key`; field-name variants (`card_number`, `CVV`, `security-code`); ULID-like and UUID strings pass.
- `test/contract/openapi-validators.test.ts`: validators load from the checked-in document; every `examples` value of `CreatePaymentRequest`-referenced component schemas validates; strict mode does not throw on `x-flowledger-*` keywords.
- Commands: `pnpm vitest run --project unit apps/api/src/http`, `pnpm vitest run --project contracts test/contract/openapi-validators.test.ts`.

**Non-goals** — Authentication, database access, request hashing.

**Handoff checklist**
- [ ] Luhn test observed failing when the Luhn check is replaced by `true`.
- [ ] `pnpm check` green.

---

### P04-T04 — Bearer authentication, scopes, and merchant context

**Task ID:** `P04-T04`
**Feature:** Merchant authentication and authorization
**Commit:** `feat(api): authenticate bearer credentials with constant-time digest and scopes`
**Priority:** Critical
**Dependencies:** `P04-T01`
**Estimated complexity:** M
**Contract references:** `docs/05` §Authentication, authorization, and tenant scope; `docs/07` §`identity.merchant_api_credentials`, §Transaction and lock ownership ("Authenticate API request"), §Tenant isolation; `openapi.yaml` `x-required-scopes`, `MerchantProblem401Response` (`x-flowledger-required-headers: [WWW-Authenticate, …]`), `Problem403Response`; P02 `packages/domain/src/credentials.ts`, `packages/database/src/repositories/identity.ts` `lookupCredential`
**Files:** create: `apps/api/src/auth/credential-auth.ts`, `apps/api/src/auth/principal.ts`, `test/contract/api-operations.test.ts`, `test/integration/api/auth.test.ts`; modify: `apps/api/src/app.ts`, `packages/config/src/api.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `openapi/**`, `migrations/**`, `packages/domain/src/credentials.ts`, `packages/database/src/repositories/identity.ts`

**Objective** — Map `Authorization: Bearer fl_test_<locator>_<secret>` to exactly one merchant principal with explicit scopes, verified in constant time, rejecting missing/invalid/expired/revoked credentials with `401` and insufficient scope with `403`, before any body is parsed. P02 already ships the credential format, digest, pepper parsing, and pre-tenant lookup; this task only wires them into the HTTP boundary.

**Implementation instructions**
1. `packages/config/src/api.ts`: add `API_CREDENTIAL_PEPPERS` parsed with P02's `parsePeppers` (same variable P02's seed uses; synthetic value already in `.env.example` from P02 — add to `docs/CONFIG.md` only if missing).
2. `apps/api/src/auth/credential-auth.ts`: Fastify `onRequest` hook registered after request context, applied to every route in `OPERATIONS` (skip health/readiness):
   - Header missing, not `Bearer <token>` (case-insensitive scheme, single space), or P02 `parseCredential` returns null → `401 AUTHENTICATION_REQUIRED`.
   - In a short `withTransaction(pool, {}, …)` (no merchant context) call P02 `lookupCredential(client, locator)`; it returns only `ACTIVE`, unexpired rows (it filters `status` and `expires_at > clock_timestamp()`) and sets `app.merchant_id` only for that transaction.
   - Always compute `credentialDigest` (P02) — with the pepper for the row's `digestVersion`, or with the current pepper when no row is found — and compare against the row digest or a fixed 32-byte zero buffer with `crypto.timingSafeEqual`, so hit and miss paths do equivalent work.
   - Reject with `401` when: no row, unknown `digestVersion`, digest mismatch, or `merchantStatus <> 'ACTIVE'` **[ASSUMPTION: a suspended/closed merchant cannot authenticate; risk R-04]**.
   - `401` sets `WWW-Authenticate: Bearer realm="flowledger"` when the header was absent, else `Bearer realm="flowledger", error="invalid_token"`.
   - Resolve the operation with `operationFor(request.method, request.routeOptions.url)`; if `scopes` lack any `OPERATIONS[op].scopes` entry → `403 FORBIDDEN`.
   - Set `request.principal = { merchantId, credentialId, scopes }` (`principal.ts` declares the type and the Fastify request augmentation). Merchant identity is **never** read from body, query, or any other header (`X-Merchant-Id` is ignored).
   - Do not update `last_used_at`.
3. Downstream code obtains merchant context only via `withTransaction(pool, { merchantId: request.principal.merchantId, correlationId }, fn)`.

**Expected behavior**
- No `Authorization` → `401 AUTHENTICATION_REQUIRED`, `WWW-Authenticate: Bearer realm="flowledger"`.
- Valid read-only credential on `POST /v1/payments` → `403 FORBIDDEN` (a malformed JSON body still yields `403`: the body is never parsed).
- Revoked, expired (one second in the past), wrong secret with right locator, unknown locator → `401`.
- Two active credentials of one merchant (rotation overlap) both authenticate.

**Acceptance criteria**
- [ ] Digest comparison uses `timingSafeEqual` on equal-length buffers on both hit and miss paths.
- [ ] `401`/`403` happen in `onRequest`, before body parsing.
- [ ] `OPERATIONS[*].scopes` equal `x-required-scopes` for every implemented operation (contract test).
- [ ] Raw credentials are never stored and never logged (logging verified in P04-T13).

**Testing requirements**
- `test/contract/api-operations.test.ts`: every `OPERATIONS` entry matches openapi `operationId`, method, path, `x-required-scopes`, and `x-flowledger-command-type` (when present); every openapi operation with `x-required-scopes` is in `OPERATIONS` or `NOT_YET_IMPLEMENTED`; `ingestProviderWebhook` has `security: []` and is not in `OPERATIONS`.
- `test/integration/api/auth.test.ts` (via `startTestApi`, P02 `createTestMerchant` credentials and P02 `issueCredential`/`revokeCredential`): missing header, `Basic …`, malformed token, unknown locator, wrong secret, revoked, expired, suspended merchant, read-only on write route, valid read + write, two overlapping credentials; `X-Merchant-Id` of another merchant has no effect (re-run against list endpoints in P04-GATE); `WWW-Authenticate` present on every `401`.
- Commands: `pnpm vitest run --project contracts test/contract/api-operations.test.ts`, `pnpm vitest run --project integration test/integration/api/auth.test.ts`.

**Non-goals** — Credential issuance/rotation tooling (P02/P11), `last_used_at` tracking, rate limiting, operator authentication.

**Handoff checklist**
- [ ] Wrong-secret test observed failing when the digest comparison is replaced by `true`.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P04-T05 — Payment-method token validation, encryption, and supported providers

**Task ID:** `P04-T05`
**Feature:** Encrypted sandbox token storage and provider name boundary
**Commit:** `feat(domain): encrypt payment method references and validate sandbox tokens`
**Priority:** High
**Dependencies:** `P02-GATE`
**Estimated complexity:** S
**Contract references:** `docs/05` §Create a payment, §MVP API decisions (`pm_fake_…` family for both simulators); `docs/07` §`payments.payments` (ciphertext, key version, keyed hash; AEAD with AAD = merchant, payment, provider-account IDs); `docs/03` §Canonical aggregate (`paymentMethodReference` private); README §4.5; ADR-0011
**Files:** create: `packages/domain/src/payment-method-crypto.ts`, `packages/domain/src/payment-method-crypto.test.ts`, `apps/api/src/payments/provider-codes.ts`, `apps/api/src/payments/provider-codes.test.ts`; modify: `packages/config/src/api.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/**`

**Objective** — Provide the exact encryption and validation primitives `POST /v1/payments` needs and P06's authorize path will reuse to decrypt.

**Implementation instructions**
1. `packages/domain/src/payment-method-crypto.ts` (`node:crypto` only):
   - `encryptPaymentMethodRef(plain: string, aad: { merchantId; paymentId; providerAccountId }, key: Buffer /*32 bytes*/): Buffer` — AES-256-GCM, random 12-byte IV, AAD = UTF-8 of `merchantId + '|' + paymentId + '|' + providerAccountId`; output layout `iv(12) || ciphertext || tag(16)`.
   - `decryptPaymentMethodRef(blob, aad, key): string` — throws on tag/AAD mismatch.
   - `hashPaymentMethodRef(plain, hashKey: Buffer): Buffer` — HMAC-SHA-256, 32 bytes.
2. `packages/config/src/api.ts`: `PAYMENT_METHOD_ENCRYPTION_KEYS` (comma-separated `version:base64key`, each exactly 32 bytes), `PAYMENT_METHOD_ENCRYPTION_KEY_VERSION` (must exist in the map; stored as `payments.payment_method_key_version` text), `PAYMENT_METHOD_HASH_KEY` (base64, ≥ 32 bytes), `PROVIDER_ENVIRONMENT` (`SANDBOX` | `SIMULATOR`, the `providers.merchant_routes.environment` this deployment routes in; `.env.example` value `SIMULATOR`) **[ASSUMPTION: variable names; P06 must read the same ones]**.
3. `apps/api/src/payments/provider-codes.ts`:
   ```ts
   export const SUPPORTED_PROVIDER_CODES = ['fake-provider', 'unreliable-provider'] as const; // [ASSUMPTION] second code, risk R-05
   export function isSupportedProvider(code: string): boolean;
   export function isValidPaymentMethodRef(providerCode: string, ref: string): boolean; // both codes: /^pm_fake_[A-Za-z0-9]{1,247}$/
   ```

**Expected behavior** — `decrypt(encrypt(x, aad, k), aad, k) === x`; decrypting with a different `paymentId` in AAD throws; `isValidPaymentMethodRef('fake-provider','pm_sandbox_123') === false`; `isSupportedProvider('stripe') === false`.

**Acceptance criteria**
- [ ] Ciphertext never contains the plaintext bytes; two encryptions of the same input differ (random IV).
- [ ] Config rejects a 31-byte or 33-byte encryption key and an active version absent from the map.

**Testing requirements**
- `packages/domain/src/payment-method-crypto.test.ts`: round trip; AAD tamper (each of the three IDs); tag tamper; IV uniqueness over 1 000 encryptions; hash golden vector.
- `apps/api/src/payments/provider-codes.test.ts`: token family boundaries (`pm_fake_` alone rejected, 255 total chars accepted, 256 rejected, `pm_fake_a-b` rejected).
- Command: `pnpm vitest run --project unit packages/domain/src/payment-method-crypto.test.ts apps/api/src/payments/provider-codes.test.ts`.

**Non-goals** — Key rotation tooling, KMS integration (P13), decryption call sites (P06).

**Handoff checklist**
- [ ] AAD-tamper test observed failing when AAD is omitted from `setAAD`.
- [ ] `pnpm check` green.

---

### P04-T06 — SQL read surface: representations, summary status, and list functions

**Task ID:** `P04-T06`
**Feature:** Merchant-scoped read model shared by GET, replay, and timeline
**Commit:** `feat(db): add merchant-scoped payment and operation representation functions`
**Priority:** Critical
**Dependencies:** `P02-GATE`
**Estimated complexity:** L
**Contract references:** `docs/05` §Resource representations (Payment, Payment operation, ETag forms), §Pagination; `openapi.yaml` `Payment`, `PaymentOperation`, `Timestamp`, `PageInfo`; `docs/03` §Derived summary status, §Payment operation (fee fields per type); `docs/07` §`payments.payments`, §`payments.payment_operations`, §Tenant isolation; CONVENTIONS §7, §8
**Files:** create: `migrations/0410_payment_read_surface.sql`, `packages/database/src/functions/payments.ts`, `test/integration/db/payment-representation.test.ts`; modify: `packages/database/src/index.ts`; must not touch: `migrations/02*`, `migrations/03*`, `packages/domain/src/state/**`

**Objective** — One SQL definition of the public Payment and PaymentOperation JSON, used by replay storage (P04-T07, P05) and every GET, so stored and live representations cannot drift.

**Implementation instructions**
1. All functions: `LANGUAGE plpgsql` or `sql`, `STABLE`, `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`, fully qualified names, owner `payments_function_owner`, and filter by `v_merchant := current_setting('app.merchant_id', true)`; a NULL/empty merchant returns no rows (never raises a different error, so tenant probing learns nothing).
2. `payments.format_ts(t timestamptz) RETURNS text` (`IMMUTABLE`, not security definer): `to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.
3. `payments.summary_status(p_payment payments.payments) RETURNS text` implementing `docs/03` §Derived summary status rules 1–11 in order, scanning **all** unresolved operations (`status IN ('REQUESTED','PROCESSING','UNKNOWN','REQUIRES_REVIEW')`); rule 10 is true when `authorization_outcome = 'DECLINED'` or the latest `AUTHORIZE` operation by `(created_at, id)` has status `FAILED`.
4. `payments.payment_representation(p_payment_id text) RETURNS jsonb` — `NULL` when not visible; otherwise `jsonb_build_object` with exactly the `openapi.yaml` `Payment` properties: `id`, `currency`, `provider` (= `providers.provider_accounts.provider_code` of the bound account), `requestedAmountMinor`…`voidedAmountMinor`, `reservedRefundAmountMinor` (all `bigint::text`), `unresolvedRefundCount` (integer), `authorizationOutcome`, `summaryStatus`, `activeExclusiveOperationId` (JSON null when NULL), `version` (integer), `createdAt`, `updatedAt` (via `format_ts`). Never include `payment_method_*`, provider account IDs, fee-policy IDs, or `merchant_id`.
5. `payments.operation_representation(p_operation_id text) RETURNS jsonb` — exactly `PaymentOperation` properties: `id`, `paymentId`, `type`, `amountMinor`, `currency`, `status`, `provider`, `providerOperationId`, `resultCode`, `feePolicyVersion` (NULL for `AUTHORIZE`/`CANCEL`), `feeAmountMinor` (= `fee_effect_amount_minor::text`, NULL when NULL), `version`, `createdAt`, `resolvedAt`. Never include `provider_idempotency_key`, lease fields, `resolution_evidence_id`, fee snapshot inputs other than the version.
6. `payments.list_payments(p_snapshot_at timestamptz, p_after_created_at timestamptz, p_after_id text, p_limit integer) RETURNS TABLE (representation jsonb, created_at timestamptz, id text, snapshot_at timestamptz)`:
   - `snapshot_at` = `COALESCE(p_snapshot_at, clock_timestamp())`, echoed on every row;
   - `WHERE merchant_id = v_merchant AND created_at <= snapshot_at AND (p_after_id IS NULL OR (created_at, id) < (p_after_created_at, p_after_id)) ORDER BY created_at DESC, id DESC LIMIT p_limit` (`p_limit` 1–101; the caller asks for `limit+1`).
7. `payments.list_payment_operations(p_payment_id text, p_snapshot_at, p_after_created_at, p_after_id, p_limit)` — same shape; first verifies the payment belongs to `v_merchant` and otherwise raises `RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='RESOURCE_NOT_FOUND'`; orders `(created_at DESC, id DESC)` over `payments.payment_operations WHERE merchant_id = v_merchant AND payment_id = p_payment_id`.
8. Migration tail: `REVOKE ALL ON FUNCTION … FROM PUBLIC` for each; `GRANT EXECUTE … TO fl_api`; `GRANT SELECT ON payments.payments, payments.payment_operations, providers.provider_accounts TO payments_function_owner` (no-op if P02 already granted). If P02 RLS hides rows from `payments_function_owner`, these functions still filter by `v_merchant`, so an RLS policy matching `app.merchant_id` is sufficient.
9. `packages/database/src/functions/payments.ts`: typed wrappers `paymentRepresentation(client, id)`, `operationRepresentation(client, id)`, `listPayments(client, args)`, `listPaymentOperations(client, args)`; JSON returned as parsed objects; `created_at` returned as `Date` plus a microsecond epoch string via `SELECT …, (extract(epoch from created_at) * 1000000)::bigint::text AS created_at_us` (add that column to both list functions' result).

**Expected behavior** — For a freshly seeded payment: `{"id":"pay_…","currency":"USD","provider":"fake-provider","requestedAmountMinor":"10000","authorizedAmountMinor":"0",…,"unresolvedRefundCount":0,"authorizationOutcome":"NOT_REQUESTED","summaryStatus":"REQUIRES_AUTHORIZATION","activeExclusiveOperationId":null,"version":1,"createdAt":"…Z","updatedAt":"…Z"}`; another merchant's context → `NULL`.

**Acceptance criteria**
- [ ] Representations validate against `openapi.yaml` `Payment` / `PaymentOperation` (Ajv from P04-T03 loader) for every operation type and status.
- [ ] `summary_status` equals P01's `deriveSummaryStatus` for every generated state (property test).
- [ ] Cross-tenant calls return `NULL` / empty / `RESOURCE_NOT_FOUND` and never another merchant's row.
- [ ] No representation contains `payment_method`, `provider_account`, `provider_idempotency_key`, or `merchant_id` keys.

**Testing requirements**
- `test/integration/db/payment-representation.test.ts` (Testcontainers; rows inserted with P02's `fixtureInsertPayment`/`fixtureInsertOperation`/`fixtureUpdatePayment`, which write consistent pointer/reservation fields so P02's deferred trigger passes):
  - schema validation of payment and operation representations for each of the 4 types × 7 statuses that the P02 constraints admit (terminal rows need a fixture `resolution_evidence_id`; if P02 adds the evidence FK only in P06, a placeholder `pev_` text is acceptable here);
  - fast-check property (≥ 200 runs, seed persisted): random payment totals/outcome + random unresolved operation statuses → SQL `summary_status` equals `deriveSummaryStatus`;
  - cross-tenant: merchant B context reading merchant A's payment/operation → `NULL`; `list_payment_operations` for A's payment under B → `RESOURCE_NOT_FOUND`; missing `app.merchant_id` → `NULL`/empty;
  - `list_payments` ordering and `snapshot_at` exclusion (row inserted with `created_at` after snapshot is excluded); limit boundaries 1 and 101.
- Command: `pnpm vitest run --project integration test/integration/db/payment-representation.test.ts`.

**Non-goals** — Cursor encoding (P04-T11), timeline (P04-T12), writes.

**Handoff checklist**
- [ ] Property test observed failing when rule order 2/3 is swapped in SQL.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P04-T07 — Protected `payments.create_payment` boundary and SQL fault hooks

**Task ID:** `P04-T07`
**Feature:** Atomic payment creation with idempotency and outbox
**Commit:** `feat(db): add protected create_payment with idempotent replay and outbox`
**Priority:** Critical
**Dependencies:** `P04-T06`
**Estimated complexity:** L
**Contract references:** `docs/05` §Create a payment, §API idempotency contract (all subsections), §Request and correlation identifiers; `docs/07` §Protected payment transition functions (`create_payment`), §`api.idempotency_records`, §`providers.merchant_routes`, §`payments.fee_policies`, §`messaging.outbox_messages`, §Transaction and lock ownership, §Tenant isolation; `docs/03` §Create payment; `docs/04` §Envelope; `schemas/events/payment-created.v1.schema.json`; `docs/08` §API acceptance; ADR-0009; README C-07; P02 `api.claim_idempotency_key`, `providers.select_route`
**Files:** create: `migrations/0420_create_payment.sql`, `packages/testkit/src/sql-fault-hooks.ts`, `test/integration/db/create-payment-function.test.ts`, `test/chaos/create-payment-faults.test.ts`; modify: `packages/database/src/functions/payments.ts`, `packages/database/src/errors.ts`, `packages/testkit/src/index.ts`; must not touch: `migrations/02*`, `migrations/03*`, `apps/**`

**Objective** — Implement the only write path for payments on top of P02's claim and routing functions: replay or conflict deterministically, claim the key first (canonical lock order), derive the route snapshot, and commit payment + `payment.created.v1` + replay record atomically, with named fault points proving all-or-nothing.

**Implementation instructions**
1. `payments.fault_point(p_point text) RETURNS void LANGUAGE plpgsql VOLATILE AS $$ BEGIN END $$;` — owner `payments_function_owner` (`public.fl_assign_function_owner`), `REVOKE ALL … FROM PUBLIC`.
2. Private helper `payments.peek_idempotency(p_merchant text, p_command_type text, p_key text, p_request_hash bytea) RETURNS TABLE (http_status smallint, response_body text, response_headers jsonb)` (SECURITY DEFINER, no runtime grants): reads the record without locking. None → zero rows. Expired (`tombstoned_at IS NOT NULL OR clock_timestamp() >= replay_expires_at`) → raise `IDEMPOTENCY_KEY_EXPIRED` with `DETAIL json_build_object('resourceLocation', CASE resource_type WHEN 'PAYMENT' THEN '/v1/payments/' ELSE '/v1/operations/' END || resource_id)::text`; hash differs → raise `IDEMPOTENCY_CONFLICT`; else return the stored row (`response_body::text`). Expiry is checked first, matching P02 `claim_idempotency_key`. It exists so a committed replay is answered before route evaluation (a disabled route never blocks an exact replay).
3. Private helper `payments.new_payment_representation(p_payment_id text, p_provider_code text, p_requested_amount_minor bigint, p_now timestamptz) RETURNS jsonb IMMUTABLE` — the exact object `payments.payment_representation` (P04-T06) returns for a just-created payment (zero totals, `NOT_REQUESTED`, `REQUIRES_AUTHORIZATION`, null pointer, version 1, `createdAt = updatedAt = payments.format_ts(p_now)`). Needed because P02's claim stores the replay body at claim time, before the payment row exists.
4. `payments.begin_create_payment(p_idempotency_key text, p_request_hash bytea, p_payment_id text, p_requested_amount_minor bigint, p_provider_code text /*NULL = default route*/, p_environment text, p_correlation_id text, p_credential_id text) RETURNS TABLE (outcome text, http_status smallint, response_body text, response_headers jsonb, provider_code text, provider_account_id text, provider_account_version integer, fee_policy_id text, fee_policy_version integer, created_at timestamptz)`; SECURITY DEFINER, fixed `search_path`, owner `payments_function_owner`; statements in order:
   1. Merchant = `public.fl_current_merchant_id()` (NULL → raise `AUTHENTICATION_REQUIRED`); `pg_has_role(session_user, 'fl_api', 'MEMBER')` else raise `FORBIDDEN`.
   2. `payments.peek_idempotency(…, 'CREATE_PAYMENT', …)` row → return `outcome='REPLAY'`.
   3. `providers.select_route(v_merchant, p_environment, p_provider_code)` (P02; share-locks the current account version; raises `PROVIDER_ROUTE_UNAVAILABLE`, never falls back). Current fee policy: `payments.fee_policies WHERE merchant_id = v_merchant AND currency = 'USD' AND superseded_at IS NULL FOR SHARE`; none → raise `INTERNAL_FEE_POLICY_UNAVAILABLE` **[ASSUMPTION, risk R-07]**.
   4. `v_now := clock_timestamp()`; `v_body := payments.new_payment_representation(p_payment_id, route.provider_code, p_requested_amount_minor, v_now)`; `v_headers := jsonb_build_object('Location','/v1/payments/'||p_payment_id,'ETag','"payment-'||p_payment_id||'-v1"','Content-Type','application/json','X-Correlation-Id',p_correlation_id)`.
   5. `api.claim_idempotency_key(v_merchant, 'CREATE_PAYMENT', p_idempotency_key, p_request_hash, 'PAYMENT', p_payment_id, 201, v_body, v_headers, sha256(convert_to(v_body::text,'UTF8')), p_correlation_id, p_credential_id, 2000)` — bounded wait 2 000 ms → P02 raises `IDEMPOTENCY_REQUEST_IN_PROGRESS`. Outcome `REPLAY` (raced owner committed) → return `outcome='REPLAY'` with its stored values; `CONFLICT` → raise `IDEMPOTENCY_CONFLICT`; `EXPIRED` → raise `IDEMPOTENCY_KEY_EXPIRED` with `resourceLocation`; `OWNER` → continue. `PERFORM payments.fault_point('create.after_idempotency_claim')`.
   6. Return `outcome='NEW'` with the route snapshot, fee policy, and `created_at = v_now`.
5. `payments.create_payment(p_idempotency_key text, p_payment_id text, p_requested_amount_minor bigint, p_provider_account_id text, p_provider_account_version integer, p_fee_policy_id text, p_fee_policy_version integer, p_created_at timestamptz, p_payment_method_ciphertext bytea, p_payment_method_key_version text, p_payment_method_hash bytea, p_correlation_id text, p_credential_id text, p_created_event jsonb) RETURNS TABLE (outcome text, http_status smallint, response_body text, response_headers jsonb)`, statements in order:
   1. Merchant + role check as above.
   2. **Claim proof:** the `CREATE_PAYMENT` record for `(v_merchant, p_idempotency_key)` must exist with `resource_id = p_payment_id` **and** no `payments.payments` row with that ID may exist. A committed record always has its payment (P02 deferred resource trigger), so this proves the claim was made in the current transaction; otherwise raise `INTERNAL_CLAIM_REQUIRED`.
   3. `INSERT INTO payments.payments (id, merchant_id, currency, payment_method_reference_ciphertext, payment_method_key_version, payment_method_reference_hash, provider_account_id, provider_account_version, fee_policy_id, fee_policy_version, requested_amount_minor, authorized_amount_minor, captured_amount_minor, refunded_amount_minor, voided_amount_minor, reserved_refund_amount_minor, unresolved_refund_count, authorization_outcome, active_exclusive_operation_id, version, created_by_credential_id, created_at, updated_at) VALUES (…, 'USD', …, 0,0,0,0,0,0, 'NOT_REQUESTED', NULL, 1, p_credential_id, p_created_at, p_created_at)`. `PERFORM payments.fault_point('create.after_payment_insert')`.
   4. `payments.payment_representation(p_payment_id) <> record.response_body` → raise `INTERNAL_REPRESENTATION_MISMATCH` (proves the claimed replay body equals the committed state).
   5. Verify `p_created_event`: `type='payment.created.v1'`, `kind='EVENT'`, `merchantId = v_merchant`, `aggregateType='payment'`, `aggregateId = orderingKey = data.paymentId = p_payment_id`, `aggregateVersion = 1`, `correlationId = p_correlation_id`, `data.requestedAmount = {"amountMinor": p_requested_amount_minor::text, "currency":"USD"}`, `data.provider` = the bound account's `provider_code`, `data.providerAccountId = p_provider_account_id`, `data.feePolicyVersion = p_fee_policy_version`; mismatch → `INTERNAL_ENVELOPE_MISMATCH`. `PERFORM messaging.insert_outbox(p_created_event)`. `PERFORM payments.fault_point('create.after_outbox_insert')`.
   6. Return `('CREATED', 201, record.response_body::text, record.response_headers)`.
6. Migration tail: owners via `fl_assign_function_owner`; `GRANT INSERT, SELECT ON payments.payments TO payments_function_owner` and `GRANT SELECT ON payments.fee_policies TO payments_function_owner` (no-ops if P02 granted); `REVOKE ALL ON FUNCTION … FROM PUBLIC`; `GRANT EXECUTE ON FUNCTION payments.begin_create_payment(…), payments.create_payment(…) TO fl_api`.
7. `packages/database/src/errors.ts`: register `INTERNAL_FEE_POLICY_UNAVAILABLE`, `INTERNAL_CLAIM_REQUIRED`, `INTERNAL_REPRESENTATION_MISMATCH`, `INTERNAL_ENVELOPE_MISMATCH`, `INTERNAL_FAULT_INJECTED` (CONVENTIONS §7). `packages/database/src/functions/payments.ts`: `beginCreatePayment(client, args)`, `createPayment(client, args)` — `bigint` money, `Buffer` for bytea, typed discriminated results.
8. `packages/testkit/src/sql-fault-hooks.ts` (throws `Error('FLOWLEDGER_FAULT_HOOKS=1 required')` unless `process.env.FLOWLEDGER_FAULT_HOOKS === '1'`):
   - `installSqlFaultHooks(adminUrl)`: as superuser `CREATE TABLE IF NOT EXISTS public.testkit_fault_points (point text PRIMARY KEY)`, `GRANT SELECT ON public.testkit_fault_points TO PUBLIC`; `CREATE OR REPLACE FUNCTION payments.fault_point(p_point text) RETURNS void LANGUAGE plpgsql VOLATILE AS $$ BEGIN IF EXISTS (SELECT 1 FROM public.testkit_fault_points WHERE point = p_point) THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INTERNAL_FAULT_INJECTED', DETAIL=p_point; END IF; END $$` (owner unchanged); commit-time hook `public.testkit_commit_fault()` + `CREATE CONSTRAINT TRIGGER testkit_commit_fault AFTER INSERT ON api.idempotency_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.testkit_commit_fault()` calling `payments.fault_point('commit')`.
   - `armSqlFault(adminUrl, point)`, `disarmSqlFaults(adminUrl)`.
   Production migrations never contain the raising body or the table.
9. Aging records for expiry tests uses P02's `fixtureInsertIdempotencyRecord` (past `committed_at`, README C-07); no new helper.

**Expected behavior**
- Same key + same hash twice (sequential) → second `begin_create_payment` returns `REPLAY` (via peek) with identical body text and headers; one payment row, one outbox row.
- Same key + different hash → `P0001 IDEMPOTENCY_CONFLICT`; no new rows.
- Record committed 91 days ago + same hash → `P0001 IDEMPOTENCY_KEY_EXPIRED`, `DETAIL {"resourceLocation":"/v1/payments/pay_…"}`.
- Owner transaction open after its claim + second caller same key → after ~2 s `P0001 IDEMPOTENCY_REQUEST_IN_PROGRESS`; after owner rollback the second caller becomes owner and creates.

**Acceptance criteria**
- [ ] Payment, `payment.created.v1` outbox row, and idempotency record commit together or not at all (fault points `create.after_idempotency_claim`, `create.after_payment_insert`, `create.after_outbox_insert`, `commit`).
- [ ] The idempotency claim is the first lock taken after the read-only peek and route share locks; the stored replay body equals the committed payment representation.
- [ ] An exact replay is answered before route evaluation.
- [ ] `create_payment` without a same-transaction claim raises `INTERNAL_CLAIM_REQUIRED` and writes nothing.
- [ ] No runtime role can `INSERT` into `payments.payments` or `api.idempotency_records` directly (`42501`).

**Testing requirements**
- `test/integration/db/create-payment-function.test.ts` (as `fl_api` with merchant context; envelopes built with `buildEnvelope` in a test helper):
  - happy path row contents (totals 0, `NOT_REQUESTED`, version 1, bound account/version/fee policy equal to seeded current rows, ciphertext ≠ plaintext, `created_at` equals the body's `createdAt` to the millisecond);
  - sequential replay; conflict; expired at 91 days via `fixtureInsertIdempotencyRecord`, not expired at 89 days;
  - replay after the route was disabled still returns `REPLAY`;
  - same key in two merchants → two payments;
  - 100 concurrent identical begin+create transactions → exactly one `CREATED`, the rest `REPLAY` or `IDEMPOTENCY_REQUEST_IN_PROGRESS`; one payment and one outbox row;
  - 10 different hashes under one key concurrently → one `CREATED`, others `IDEMPOTENCY_CONFLICT`/`IN_PROGRESS`;
  - held owner → `IN_PROGRESS` in 1.8–4 s; owner rollback → retry creates;
  - `create_payment` alone → `INTERNAL_CLAIM_REQUIRED`; envelope mismatch (wrong `aggregateVersion`, wrong `providerAccountId`) → `INTERNAL_ENVELOPE_MISMATCH`, no rows;
  - direct `INSERT` into `payments.payments` and `api.idempotency_records` as `fl_api` → `42501`.
- `test/chaos/create-payment-faults.test.ts` (`FLOWLEDGER_FAULT_HOOKS=1`): for each point `create.after_idempotency_claim`, `create.after_payment_insert`, `create.after_outbox_insert`, `commit`: arm, call, expect `INTERNAL_FAULT_INJECTED`, assert zero payment/outbox/idempotency rows for that key and payment ID, disarm, retry same key → `CREATED`.
- Commands: `pnpm vitest run --project integration test/integration/db/create-payment-function.test.ts`, `pnpm test:chaos`.

**Non-goals** — HTTP endpoint (P04-T09), route-selection matrix (P04-T08), tombstoning job (no deletion in MVP per C-07), changes to P02's claim/route functions.

**Handoff checklist**
- [ ] Representation-equality check observed failing when `new_payment_representation` emits a different `summaryStatus`.
- [ ] Each fault-point test observed failing when its `PERFORM payments.fault_point(…)` line is removed.
- [ ] `pnpm check`, `pnpm test:integration`, `pnpm test:chaos` green.

---

### P04-T08 — Provider route selection and rollover tests

**Task ID:** `P04-T08`
**Feature:** Deterministic routing snapshot at payment creation
**Commit:** `test(db): prove deterministic provider route selection and rollover safety`
**Priority:** High
**Dependencies:** `P04-T07`
**Estimated complexity:** M
**Contract references:** `docs/05` §Create a payment (routing bullets, `UNSUPPORTED_PROVIDER`, `PROVIDER_ROUTE_UNAVAILABLE`); `docs/07` §`providers.merchant_routes`, §`providers.provider_account_versions`, §`providers.provider_accounts`; `docs/10` M4 last acceptance bullet
**Files:** create: `test/integration/db/route-selection.test.ts`, `packages/testkit/src/fixtures/routing.ts`; modify: none (a defect found here is fixed by a new migration `0425_*` in this task); must not touch: `apps/**`, `migrations/02*`

**Objective** — Prove that exactly one route/account/configuration/fee-policy snapshot is chosen, or creation fails before any idempotency or business row commits.

**Implementation instructions**
1. `packages/testkit/src/fixtures/routing.ts` (superuser, clearly named fixture helpers): `addRoute(adminUrl, {merchantId, providerCode, environment, isDefault, status})`, `disableRoute`, `disableAccount`, `rolloverAccountVersion(adminUrl, providerAccountId)` (in one transaction: set `superseded_at` on the current version, insert version+1), `supersedeFeePolicy(adminUrl, merchantId)` (same pattern with `minimum_capture_amount_minor >= GREATEST(fixed,1)`).
2. Cases in `test/integration/db/route-selection.test.ts` (call `begin_create_payment` + `create_payment` exactly as P04-T09 will (route selection itself is P02's `providers.select_route`; these tests prove its use inside creation)):
   - explicit `fake-provider` with active route → that account and its current version;
   - omitted provider with one active default → default route;
   - omitted provider and no default → `PROVIDER_ROUTE_UNAVAILABLE`;
   - explicit provider whose route is `DISABLED` → `PROVIDER_ROUTE_UNAVAILABLE` (no fallback to the default route of another provider);
   - route active but account `DISABLED` → `PROVIDER_ROUTE_UNAVAILABLE`;
   - route for another environment only → `PROVIDER_ROUTE_UNAVAILABLE`;
   - another merchant's route never selected;
   - **rollover race:** open transaction T1 runs `begin_create_payment` (share-locks version v1); concurrently `rolloverAccountVersion` blocks; T1 commits `create_payment` with v1; rollover then completes; the next create binds v2. Reverse ordering: rollover commits first → create binds v2.
   - **rollover committed while waiting:** T1 blocked in `begin_create_payment` behind an uncommitted rollover that then commits → T1 either binds v2 or fails with `PROVIDER_ROUTE_UNAVAILABLE`; never binds the superseded v1; zero rows on failure.
   - after every failure case: zero rows in `api.idempotency_records`, `payments.payments`, outbox for the key.

**Expected behavior** — As listed; all failures leave no rows.

**Acceptance criteria**
- [ ] Every case asserts both the chosen snapshot (or error code) and the absence of rows on failure.
- [ ] The rollover race test fails if the `FOR SHARE` in `providers.select_route` is removed (scratch change, then restored).

**Testing requirements** — `pnpm vitest run --project integration test/integration/db/route-selection.test.ts`.

**Non-goals** — HTTP mapping of these codes (P04-T09 asserts `409 PROVIDER_ROUTE_UNAVAILABLE` and `400 UNSUPPORTED_PROVIDER`).

**Handoff checklist**
- [ ] Rollover test observed failing without the share lock.
- [ ] `pnpm test:integration` green.

---

### P04-T09 — `POST /v1/payments` endpoint and HTTP idempotency behavior

**Task ID:** `P04-T09`
**Feature:** Payment creation endpoint
**Commit:** `feat(api): add idempotent payment creation endpoint`
**Priority:** Critical
**Dependencies:** `P04-T03`, `P04-T04`, `P04-T05`, `P04-T07`
**Estimated complexity:** L
**Contract references:** `docs/05` §Create a payment, §API idempotency contract, §Response replay, §Which responses are stored, §Retention and expired replay, §Request and correlation identifiers; `openapi.yaml` `paths./v1/payments.post`, `components.responses.PaymentCreated`, `Problem400Response`, `MerchantProblem401Response`, `Problem403Response`, `Problem409Response` (conditional `Retry-After`), `Problem413Response`, `Problem415Response`, `Problem429Response`, `Problem500Response`, `Problem503Response`; `docs/04` §Envelope; `schemas/events/payment-created.v1.schema.json`; `docs/08` §API acceptance
**Files:** create: `apps/api/src/payments/payments.controller.ts`, `apps/api/src/payments/create-payment.service.ts`, `apps/api/src/payments/payments.module.ts`, `apps/api/src/http/route-pipeline.ts`, `test/integration/api/create-payment.test.ts`, `test/integration/api/create-payment-idempotency.test.ts`; modify: `apps/api/src/app.module.ts`; must not touch: `migrations/**`, `openapi/**`

**Objective** — Commit a payment and return `201` only after the PostgreSQL transaction commits, with exact replay, conflict, in-progress, and expired semantics.

**Status codes, headers, and problem codes (from `openapi.yaml` `createPayment`)**

| Status | Headers | `code` values emitted |
| --- | --- | --- |
| `201` | `Location` (`^/v1/payments/pay_…$`), `ETag` (`"payment-<id>-v1"`), `X-Request-Id`, `X-Correlation-Id`, `Idempotent-Replay: true` only on replay; `Content-Type: application/json` | — |
| `400` | `X-Request-Id`, `X-Correlation-Id` | `INVALID_REQUEST`, `INVALID_AMOUNT`, `PROHIBITED_PAYMENT_DATA`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_CORRELATION_ID`, `UNSUPPORTED_PROVIDER`, `INVALID_PAYMENT_METHOD_REFERENCE` |
| `401` | + `WWW-Authenticate` | `AUTHENTICATION_REQUIRED` |
| `403` | | `FORBIDDEN` |
| `409` | + `Retry-After: 1` when `IDEMPOTENCY_REQUEST_IN_PROGRESS` | `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_REQUEST_IN_PROGRESS`, `IDEMPOTENCY_KEY_EXPIRED` (+ body `resourceLocation`), `PROVIDER_ROUTE_UNAVAILABLE` |
| `413` / `415` | | `REQUEST_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| `429` | | `RATE_LIMITED` — not emitted in P04 (no limiter) |
| `500` / `503` | `503` + `Retry-After: 1` | `INTERNAL_ERROR` / `SERVICE_UNAVAILABLE` |

**Implementation instructions**
1. `apps/api/src/http/route-pipeline.ts`: `preparePost(request, operationId)` runs, in order: `assertNoProhibitedData`, `validateRequest`, `parseIdempotencyKey`, rejects `If-Match` on `createPayment` (`INVALID_REQUEST`), and returns `{ body, idempotencyKey, correlationId, principal }`. P05 reuses it.
2. `create-payment.service.ts` `createPayment(req)`:
   1. If `body.provider` present and `!isSupportedProvider(body.provider)` → `400 UNSUPPORTED_PROVIDER` (no DB access).
   2. `requestHash = computeRequestHash({ commandType: 'CREATE_PAYMENT', pathParams: {}, body, ifMatch: null })` (P01; route/method/API version are derived from `commandType` inside P01).
   3. `paymentId = newId(ID_PREFIXES.payment)`; one `withTransaction(pool, { merchantId, correlationId }, …)`:
      - `beginCreatePayment(client, { key, requestHash, paymentId, amount, providerCode: body.provider ?? null, environment: PROVIDER_ENVIRONMENT, correlationId, credentialId })`; `REPLAY` → return stored result.
      - `isValidPaymentMethodRef(snapshot.providerCode, body.paymentMethodRef)` false → throw `ProblemError('INVALID_PAYMENT_METHOD_REFERENCE')` (rolls back the claim; nothing stored).
      - Encrypt with AAD `{merchantId, paymentId, providerAccountId}`; hash the ref.
      - `envelope = buildEnvelope({ id: randomUUID(), kind: 'EVENT', type: 'payment.created.v1', schemaVersion: 1, source: 'flowledger.payment', occurredAt: now, recordedAt: now, merchantId, aggregateType: 'payment', aggregateId: paymentId, aggregateVersion: 1, orderingKey: paymentId, correlationId, causationId: request.requestId, data: { paymentId, requestedAmount: body.amount, provider: snapshot.providerCode, providerAccountId, feePolicyVersion } })`; validate with the contracts Ajv + semantic validator (throws → `500`). `causationId` = the HTTP request ID **[ASSUMPTION, risk R-08]**.
      - `createPayment(client, { …, createdAt: snapshot.createdAt })` → `CREATED`.
      The route/fee share locks and the claim are held for the whole transaction, so no snapshot retry loop exists.
   4. Reply only after `withTransaction` resolves (commit done): status from the result; headers `Location`, `ETag`, `Content-Type`, `X-Correlation-Id` **from `response_headers`** (overrides the request-context value); `Idempotent-Replay: true` when outcome is `REPLAY`; body = `response_body` text sent verbatim (`reply.type('application/json').send(text)`).
3. Domain error mapping (via P04-T01 filter): `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_REQUEST_IN_PROGRESS`, `PROVIDER_ROUTE_UNAVAILABLE` → their codes; `IDEMPOTENCY_KEY_EXPIRED` → `409` with `resourceLocation` from the domain `DETAIL` JSON; every `INTERNAL_*` code → `500 INTERNAL_ERROR`.
4. The conflict/expired problem bodies never include the stored body, hash, or another tenant's data.

**Expected behavior**
- New request → `201`, `Location: /v1/payments/pay_X`, `ETag: "payment-pay_X-v1"`, body Payment v1.
- Same key, same body reformatted (different whitespace/key order) → `201`, `Idempotent-Replay: true`, **byte-identical** body, identical `Location`, `ETag`, `Content-Type`, original `X-Correlation-Id` even if the retry sent a different one; new `X-Request-Id`.
- Same key, amount changed (or `provider` added/removed, or `paymentMethodRef` changed) → `409 IDEMPOTENCY_CONFLICT`.
- `provider: "stripe"` → `400 UNSUPPORTED_PROVIDER`; `paymentMethodRef: "pm_sandbox_123"` → `400 INVALID_PAYMENT_METHOD_REFERENCE`; no default route → `409 PROVIDER_ROUTE_UNAVAILABLE`; none of them create an idempotency row, so a later valid retry with the same key and same body succeeds.

**Acceptance criteria**
- [ ] `201` is sent only after commit (proved by the `commit` fault point returning `500`, not `201`).
- [ ] Every response passes `assertConformsToOpenApi('createPayment', …)` (wired when P04-T14 lands; until then assert the header list above directly).
- [ ] Rejected requests (every `4xx`) leave zero `api.idempotency_records`, `payments.payments`, and outbox rows.
- [ ] The created outbox envelope validates against `payment-created.v1` and contains no `paymentMethodRef`.

**Testing requirements**
- `test/integration/api/create-payment.test.ts`: happy path (DB rows + outbox envelope validation); omitted provider uses default; explicit provider; each `400` code above with a zero-row assertion; `409 PROVIDER_ROUTE_UNAVAILABLE`; raw-card fixtures (body field, PAN in `paymentMethodRef`, PAN in `Idempotency-Key`) → `400 PROHIBITED_PAYMENT_DATA` with zero rows; payment-method plaintext absent from `payments.payments` (bytea scan), `api.idempotency_records.response_body`, and outbox `envelope`; smuggling `merchantId`/`providerAccountId` in body → `400 INVALID_REQUEST`; `X-Merchant-Id` header of merchant B → payment owned by authenticated merchant A.
- `test/integration/api/create-payment-idempotency.test.ts`: byte-identical replay (compare raw `payload` strings); differently formatted JSON replay; each semantic change (amount, currency **[not representable: only USD — assert changed amount instead]**, provider present vs absent, provider value, `paymentMethodRef`) → `409 IDEMPOTENCY_CONFLICT`; replay returns original `X-Correlation-Id`; 100 concurrent identical `inject` calls → one payment, one `payment.created.v1`, all `201` bodies identical, every non-`201` is `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` with `Retry-After: 1`; race of 10 different bodies under one key → one payment, others `409`; held owner via a direct `fl_api` connection running `begin_create_payment` → HTTP `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` + `Retry-After: 1`, then owner rollback → HTTP retry `201`; aged record (P02 `fixtureInsertIdempotencyRecord`, committed 91 days ago) → `409 IDEMPOTENCY_KEY_EXPIRED` with `resourceLocation: "/v1/payments/pay_…"` and still exactly one payment; same key across two merchants → two payments; lost response: call, discard the response, call again → same `id`, one payment.
- `test/chaos/create-payment-faults.test.ts` (extend): HTTP-level `commit` fault → `500 INTERNAL_ERROR`, zero rows, retry → `201`.
- Commands: `pnpm vitest run --project integration test/integration/api/create-payment.test.ts test/integration/api/create-payment-idempotency.test.ts`, `pnpm test:chaos`.

**Non-goals** — Merchant-specific amount limits (no column exists in `docs/07`), rate limiting, provider calls.

**Handoff checklist**
- [ ] Byte-equality test observed failing when the reply re-serializes the parsed object with a different key order.
- [ ] `pnpm check`, `pnpm test:integration`, `pnpm test:chaos` green.

---

### P04-T10 — `GET /v1/payments/{paymentId}` and `GET /v1/operations/{operationId}` with ETags

**Task ID:** `P04-T10`
**Feature:** Resource retrieval with conditional GET
**Commit:** `feat(api): add payment and operation retrieval with etag conditional get`
**Priority:** High
**Dependencies:** `P04-T06`, `P04-T09`
**Estimated complexity:** M
**Contract references:** `docs/05` §Resource representations (ETag rules), §Retrieve a payment or operation; `openapi.yaml` `getPayment`, `getOperation`, responses `PaymentFound`, `OperationFound`, `NotModified`, `IfNoneMatch` parameter
**Files:** create: `apps/api/src/payments/payment-queries.service.ts`, `apps/api/src/operations/operations.controller.ts`, `apps/api/src/operations/operations.module.ts`, `test/integration/api/get-resources.test.ts`; modify: `apps/api/src/payments/payments.controller.ts`, `apps/api/src/app.module.ts`; must not touch: `migrations/**`

**Objective** — Return current committed state with strong ETags derived from aggregate/operation versions and `304` on a matching `If-None-Match`.

**Status codes, headers, and problem codes (`getPayment`, `getOperation`)**

| Status | Headers | `code` values |
| --- | --- | --- |
| `200` | `ETag` (`"payment-<id>-v<version>"` / `"operation-<id>-v<version>"`), `X-Request-Id`, `X-Correlation-Id` | — |
| `304` | `ETag`, `X-Request-Id`, `X-Correlation-Id`; **no body** | — |
| `400` | | `INVALID_REQUEST` (malformed path ID, malformed `If-None-Match`, `Idempotency-Key` present, unknown query), `INVALID_CORRELATION_ID` |
| `401` / `403` / `404` | `401` + `WWW-Authenticate` | `AUTHENTICATION_REQUIRED` / `FORBIDDEN` / `RESOURCE_NOT_FOUND` |
| `429` / `500` / `503` | | `RATE_LIMITED` (not emitted) / `INTERNAL_ERROR` / `SERVICE_UNAVAILABLE` |

**Implementation instructions**
1. Controller handlers run `validateRequest` (path param), reject `Idempotency-Key` on GET, parse `If-None-Match` with `parseIfNoneMatch(value, 'payment' | 'operation')`.
2. In `withTransaction(pool, { merchantId, correlationId }, …)` (read-only work in a transaction so `app.merchant_id` is set) call `paymentRepresentation` / `operationRepresentation`; `NULL` → `404 RESOURCE_NOT_FOUND` (same response for absent and foreign IDs).
3. `etag = '"payment-' + rep.id + '-v' + rep.version + '"'` (operation analog). If `If-None-Match === etag` → `304` with `ETag` and no body; else `200` with body and `ETag`.

**Expected behavior** — Matching ETag → `304`; ETag for the same payment with an older version → `200`; ETag of a different payment (well-formed) → `200`; `W/"payment-…"` → `400 INVALID_REQUEST`; merchant B requesting A's payment → `404`.

**Acceptance criteria**
- [ ] ETag changes exactly when `version` changes (operation ETag independent of payment ETag).
- [ ] Foreign and absent IDs produce byte-identical problem bodies except `requestId`/`correlationId`.
- [ ] `304` has an empty body.

**Testing requirements**
- `test/integration/api/get-resources.test.ts`: 200 + ETag for payment; 304 on match; 200 after P02 `fixtureUpdatePayment` bumps `payments.version` with new ETag; operation retrieval via P02 `fixtureInsertOperation`; malformed IDs (`pay_123`, lower-case ULID) → `400`; foreign IDs → `404`; read-only credential succeeds; credential without `payments:read` → `403`.
- Command: `pnpm vitest run --project integration test/integration/api/get-resources.test.ts`.

**Non-goals** — Lists (P04-T11), timeline (P04-T12).

**Handoff checklist**
- [ ] 304 test observed failing when the comparison uses the previous version.
- [ ] `pnpm test:integration` green.

---

### P04-T11 — Encrypted cursor pagination for `GET /v1/payments` and `GET /v1/payments/{paymentId}/operations`

**Task ID:** `P04-T11`
**Feature:** Tenant-safe snapshot pagination
**Commit:** `feat(api): add encrypted snapshot cursor pagination for payment lists`
**Priority:** High
**Dependencies:** `P04-T06`, `P04-T09`
**Estimated complexity:** M
**Contract references:** `docs/05` §Pagination; `openapi.yaml` `listPayments`, `listPaymentOperations`, `Limit`, `Cursor`, `PageInfo`, `PaymentPage`, `OperationPage`
**Files:** create: `apps/api/src/payments/cursor.ts`, `apps/api/src/payments/cursor.test.ts`, `test/integration/api/list-pagination.test.ts`; modify: `apps/api/src/payments/payments.controller.ts`, `apps/api/src/payments/payment-queries.service.ts`, `packages/config/src/api.ts`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/**`

**Objective** — Opaque, integrity-protected, merchant/endpoint/filter-bound cursors that expire after 24 h and give duplicate-free snapshot traversal.

**Status codes, headers, and problem codes**

| Operation | Status | `code` values |
| --- | --- | --- |
| `listPayments` | `200` (`X-Request-Id`, `X-Correlation-Id`, body `PaymentPage`) | — |
| | `400` | `INVALID_REQUEST`, `INVALID_CORRELATION_ID`, `INVALID_CURSOR` |
| | `401` / `403` / `429` / `500` / `503` | as P04-T10 (no `404` for this operation) |
| `listPaymentOperations` | `200` (body `OperationPage`) | — |
| | `400` / `401` / `403` / `404` (`RESOURCE_NOT_FOUND` for absent or foreign payment, never an empty page) / `429` / `500` / `503` | |

**Implementation instructions**
1. `packages/config/src/api.ts`: `API_CURSOR_KEY` (base64, exactly 32 bytes).
2. `apps/api/src/payments/cursor.ts`:
   - Payload `{ v: 1, m: merchantId, e: 'listPayments' | 'listPaymentOperations', f: { paymentId?: string }, s: snapshotAtUs: string, c: lastCreatedAtUs: string, i: lastId: string, t: issuedAtMs: number }`.
   - `encodeCursor(payload, key)`: AES-256-GCM with random 12-byte IV and AAD `'flowledger-cursor-v1'`; token = base64url(`iv || ciphertext || tag`); must be ≤ 4096 chars.
   - `decodeCursor(token, key, expect: { merchantId, endpoint, filters, nowMs })`: any decode/auth failure, `v !== 1`, merchant/endpoint/filter mismatch, or `nowMs - t > 86_400_000` → `ProblemError('INVALID_CURSOR')`.
3. Handlers: `limit` default 50 (1–100 validated by P04-T03); without cursor → `list_*(NULL, NULL, NULL, limit + 1)`; with cursor → pass decoded `s`, `c`, `i` (convert microsecond strings to `timestamptz` via `to_timestamp(c::numeric / 1e6)` inside the wrapper SQL). Return `data` = first `limit` representations; `hasMore = rows.length > limit`; `nextCursor` = cursor from the last returned row and the same `snapshot_at` when `hasMore`, else `null`.
4. `listPaymentOperations` relies on the SQL function's `RESOURCE_NOT_FOUND` for absent/foreign payments, checked before an empty page is possible.

**Expected behavior** — Three pages of 2 over 5 payments return all 5 exactly once newest-first; a payment created after page 1 never appears in that traversal; a status change between pages neither duplicates nor drops an item; tampering one character → `400 INVALID_CURSOR`; merchant B using A's cursor → `400 INVALID_CURSOR`; a `listPayments` cursor on `listPaymentOperations` → `400 INVALID_CURSOR`; an operations cursor for payment P1 used on P2 → `400 INVALID_CURSOR`; a 24 h + 1 ms old cursor → `400 INVALID_CURSOR`.

**Acceptance criteria**
- [ ] Cursor tokens contain no plaintext merchant ID, payment ID, or timestamp (base64url-decoded bytes do not contain them).
- [ ] Traversal never crosses tenants (RLS + explicit predicate + cursor binding).
- [ ] `PageInfo` satisfies the `hasMore`/`nextCursor` conditional schema.

**Testing requirements**
- `apps/api/src/payments/cursor.test.ts`: round trip; each tamper (IV, ciphertext byte, tag byte); wrong key; expiry boundary at exactly 24 h (accepted) and +1 ms (rejected); each binding mismatch; token length ≤ 4096.
- `test/integration/api/list-pagination.test.ts`: the expected-behavior cases above; operations list ordering; `404` for foreign payment on operations list; `limit=1`, `limit=100`; unknown query param → `400 INVALID_REQUEST`; empty merchant → `{"data":[],"page":{"nextCursor":null,"hasMore":false}}`; interleaved inserts and fixture status changes during traversal produce no duplicates/omissions among pre-snapshot rows.
- Commands: `pnpm vitest run --project unit apps/api/src/payments/cursor.test.ts`, `pnpm vitest run --project integration test/integration/api/list-pagination.test.ts`.

**Non-goals** — Filters other than the path `paymentId` (none are defined in openapi).

**Handoff checklist**
- [ ] Cross-merchant cursor test observed failing when the merchant binding check is removed.
- [ ] `pnpm check`, `pnpm test:integration` green.

---

### P04-T12 — `GET /v1/payments/{paymentId}/timeline` with closed per-kind details

**Task ID:** `P04-T12`
**Feature:** Payment timeline (P04 kind set: `PAYMENT_CREATED`)
**Commit:** `feat(api): add bounded payment timeline endpoint`
**Priority:** High
**Dependencies:** `P04-T06`, `P04-T09`
**Estimated complexity:** M
**Contract references:** `docs/05` §Retrieve a payment timeline (all rules); `openapi.yaml` `getPaymentTimeline`, `PaymentTimeline`, `PaymentTimelineEntry`, `PaymentTimelineFound`; CONVENTIONS §12
**Files:** modify (commit 1, contract update): `docs/05-API_AND_IDEMPOTENCY_CONTRACT.md`; create (commit 2): `migrations/0430_payment_timeline.sql`, `packages/contracts/src/timeline-detail.ts`, `packages/contracts/src/timeline-detail.test.ts`, `apps/api/src/payments/timeline.ts`, `apps/api/src/payments/timeline.test.ts`, `test/integration/api/timeline.test.ts`; modify: `apps/api/src/payments/payments.controller.ts`, `packages/database/src/functions/payments.ts`, `packages/contracts/src/index.ts`; must not touch: `openapi/**`, `migrations/02*`, `migrations/03*`

**Commits.** This task is two commits: first `docs(contracts): enumerate timeline detail shapes and fix timeline example` (human-approved contract update, README §10.5), then the feature commit above. Do not start commit 2 until commit 1 is approved.

**Objective** — Provide the single read-only explanation surface that later phases extend kind by kind, with ordering by database-recorded time, a 500-entry bound, and closed merchant-safe details.

**Status codes, headers, and problem codes** — `200` (`X-Request-Id`, `X-Correlation-Id`, body `PaymentTimeline`, **no `ETag`**); `400` (`INVALID_REQUEST`, `INVALID_CORRELATION_ID`); `401` (+ `WWW-Authenticate`); `403`; `404 RESOURCE_NOT_FOUND` (absent or foreign payment); `429` (not emitted); `500`; `503`.

**Implementation instructions**
0. **Contract-update step (commit 1).** In `docs/05` §Retrieve a payment timeline: (a) `truncated` is already present — D-08 fix 2 added `"truncated": false` before P00, so add nothing here and verify none is needed; (b) add a "Detail shapes" table listing, for each kind that exists so far, its closed field set — at P04 only `PAYMENT_CREATED` → `{ requestedAmountMinor: PositiveAmountMinor, currency: "USD" }` — and the rule that each later kind is added to this table in the same phase that adds it. No other contract text changes.
1. `migrations/0430_payment_timeline.sql`: `payments.payment_timeline(p_payment_id text) RETURNS TABLE (kind text, occurred_at timestamptz, payment_version bigint, operation_id text, detail jsonb, kind_rank integer)`, `STABLE SECURITY DEFINER`, fixed `search_path`, owner `payments_function_owner`, merchant from `app.merchant_id`; absent/foreign payment → raise `RESOURCE_NOT_FOUND`. Body at P04:
   ```sql
   RETURN QUERY
   SELECT * FROM (
     SELECT 'PAYMENT_CREATED'::text, p.created_at, 1::bigint, NULL::text,
            jsonb_build_object('requestedAmountMinor', p.requested_amount_minor::text, 'currency', p.currency), 1
     FROM payments.payments p WHERE p.merchant_id = v_merchant AND p.id = p_payment_id
     -- later phases append UNION ALL branches here via CREATE OR REPLACE in their own migration
   ) t(kind, occurred_at, payment_version, operation_id, detail, kind_rank)
   ORDER BY occurred_at, kind_rank, COALESCE(operation_id, ''), detail::text
   LIMIT 501;
   ```
   Fixed `kind_rank` table (documented in a SQL comment so later phases reuse it): `PAYMENT_CREATED 1, OPERATION_ACCEPTED 2, PROVIDER_ATTEMPT 3, PROVIDER_EVIDENCE 4, OPERATION_RESOLVED 5, LEDGER_POSTING 6, RECONCILIATION_ACTIVITY 7, DISCREPANCY 8, AUTHORIZATION_EXPIRED 9, SETTLEMENT 10, WEBHOOK_DELIVERY 11`. Revoke from PUBLIC; grant EXECUTE to `fl_api`.
2. `packages/contracts/src/timeline-detail.ts`: `TIMELINE_DETAIL_SCHEMAS: Partial<Record<TimelineKind, JsonSchema>>` with, at P04, only
   `PAYMENT_CREATED: { type:'object', additionalProperties:false, required:['requestedAmountMinor','currency'], properties:{ requestedAmountMinor:{ type:'string', pattern:'^(?:[1-9][0-9]{0,11}|1000000000000)$' }, currency:{ const:'USD' } } }` (as enumerated by step 0; risk R-09); `validateTimelineDetail(kind, detail)` throws for an unknown kind or any schema failure.
3. `apps/api/src/payments/timeline.ts`: `buildTimeline(paymentId, paymentVersion, rows)` → `{ paymentId, paymentVersion, entries, truncated }`: `truncated = rows.length > 500`; `entries = rows.slice(0, 500)` mapped to `{ sequence: index + 1, kind, occurredAt: formatTs(occurred_at) /*ms precision UTC*/, paymentVersion, operationId, detail }`; each `detail` passes `validateTimelineDetail` (failure → `500 INTERNAL_ERROR`, never a partially redacted response).
4. Handler: in one `withTransaction`, call `paymentRepresentation` (for `paymentVersion`; `NULL` → `404`) and `payment_timeline`; reply `200` without `ETag`.

**Expected behavior** — New payment → `{"paymentId":"pay_…","paymentVersion":1,"entries":[{"sequence":1,"kind":"PAYMENT_CREATED","occurredAt":"…Z","paymentVersion":1,"operationId":null,"detail":{"requestedAmountMinor":"10000","currency":"USD"}}],"truncated":false}`; foreign payment → `404`.

**Acceptance criteria**
- [ ] Response validates against `PaymentTimeline` and every `detail` against its closed kind schema.
- [ ] No `ETag` header on timeline responses.
- [ ] Ordering is by `occurred_at` (database time) then `kind_rank`; no provider timestamp participates.
- [ ] `detail` never contains payment-method references, provider account IDs, or merchant IDs (prohibited-data fixtures scan).

**Testing requirements**
- `apps/api/src/payments/timeline.test.ts` (unit, synthetic rows): 500 rows → `truncated:false`; 501 rows → 500 entries, `truncated:true`, the omitted row is the newest; sequences 1..n; out-of-order input rows are not re-sorted by TS (SQL owns ordering) — assert `buildTimeline` preserves input order; unknown kind → throws.
- `packages/contracts/src/timeline-detail.test.ts`: `PAYMENT_CREATED` valid; extra field rejected; `"0"` amount rejected; `paymentMethodRef` field rejected.
- `test/integration/api/timeline.test.ts`: happy path shape + `PaymentTimeline` schema; no `ETag`; foreign and absent `404`; missing scope `403`; response bytes contain none of the `prohibited-data` fixtures nor the created payment's `paymentMethodRef`.
- Commands: `pnpm vitest run --project unit apps/api/src/payments/timeline.test.ts packages/contracts/src/timeline-detail.test.ts`, `pnpm vitest run --project integration test/integration/api/timeline.test.ts`.

**Non-goals** — Any kind other than `PAYMENT_CREATED` (owners listed in the phase overview); integration-level truncation (P05-T13 creates > 500 entries).

**Handoff checklist**
- [ ] Truncation unit test observed failing when the bound is changed to 501.
- [ ] `pnpm check`, `pnpm test:integration` green.

---

### P04-T13 — Request logging and redaction for the API surface

**Task ID:** `P04-T13`
**Feature:** Logs record request/correlation IDs, never credentials or payment-method references
**Commit:** `feat(obs): log api requests through the redaction allowlist`
**Priority:** High
**Dependencies:** `P04-T09`
**Estimated complexity:** S
**Contract references:** `docs/05` §Authentication (credentials redacted), §General conventions (no echo/log of raw card data), Normative acceptance criterion 10; `docs/10` M4 last feature bullet; CONVENTIONS §12; `docs/04` §Sensitive data
**Files:** create: `test/integration/api/logging-redaction.test.ts`, `packages/testkit/src/log-capture.ts`; modify: `apps/api/src/app.ts`, `packages/observability/src/redaction.ts`; must not touch: `migrations/**`

**Objective** — Every request produces one structured completion log with request/correlation IDs and safe routing data; no header, body, credential, or payment-method value is ever logged.

**Implementation instructions**
1. Configure the Fastify pino instance with `serializers.req = (req) => ({ method: req.method, route: req.routeOptions?.url, requestId: req.requestId })` and `serializers.res = (res) => ({ statusCode: res.statusCode })`; disable Fastify's default request logging and add one `onResponse` log: `{ requestId, correlationId, merchantId?, operationId?, method, route, statusCode, responseTimeMs, problemCode? }`, passed through the redaction allowlist.
2. `packages/observability/src/redaction.ts`: add exactly these allowlisted log fields if absent: `requestId`, `correlationId`, `merchantId`, `operationId`, `method`, `route`, `statusCode`, `responseTimeMs`, `problemCode`, `paymentId`. Do not add `headers`, `body`, `authorization`, `paymentMethodRef`, `url`.
3. Error logs from the problem filter log `{ requestId, problemCode, errorClass: err.constructor.name }` and the redacted error message only for `500`.
4. `packages/testkit/src/log-capture.ts`: `captureLogs()` returns a writable destination + `lines()` for injecting into `createApiApp` in tests.

**Expected behavior** — A create request with `Authorization: Bearer fl_test_…` and `paymentMethodRef: pm_fake_secret123` logs a line containing `requestId` and `correlationId` but neither string.

**Acceptance criteria**
- [ ] Captured logs for the full P04 request matrix contain no bearer token, credential secret, `paymentMethodRef` value, or any `prohibited-data` fixture.
- [ ] Every completion log line has `requestId` and `correlationId`.

**Testing requirements**
- `test/integration/api/logging-redaction.test.ts`: run create (success, replay, conflict), prohibited-data rejection, `401` with a malformed token containing a PAN, `500` via a test-only throwing route whose error message contains a PAN; assert absence of every sensitive string in captured output and presence of IDs.
- Command: `pnpm vitest run --project integration test/integration/api/logging-redaction.test.ts`.

**Non-goals** — OTel traces and metrics (P11).

**Handoff checklist**
- [ ] Test observed failing when `serializers.req` is reverted to Fastify's default (headers logged).
- [ ] `pnpm check`, `pnpm test:integration` green.

---

### P04-T14 — OpenAPI response conformance helper and suite

**Task ID:** `P04-T14`
**Feature:** Request/response conformance for every implemented status and header
**Commit:** `test(api): add openapi response conformance suite for p04 operations`
**Priority:** High
**Dependencies:** `P04-T10`, `P04-T11`, `P04-T12`
**Estimated complexity:** M
**Contract references:** `docs/05` §Required implementation tests (Endpoint and schema tests); `openapi.yaml` all `components.responses.*`, `x-flowledger-required-headers`, `x-flowledger-conditional-required-headers`, `x-flowledger-http-status-must-equal-body-status`; `docs/09` §Static checks (response status/problem-code/header probes)
**Files:** create: `packages/testkit/src/openapi-conformance.ts`, `test/contract/openapi-conformance-helper.test.ts`, `test/integration/api/openapi-conformance.test.ts`; modify: `test/integration/api/create-payment.test.ts`, `test/integration/api/auth.test.ts`; must not touch: `openapi/**`, `apps/**`

**Objective** — Make every implemented response mechanically checkable against the checked-in contract, including the custom `x-flowledger` header rules that plain schema validation misses.

**Implementation instructions**
1. `packages/testkit/src/openapi-conformance.ts`: `assertConformsToOpenApi(operationId, { status, headers, body })`:
   - status must be a declared response for the operation;
   - every header declared `required: true` in that response must be present and validate against its schema (integer headers parsed from strings);
   - `x-flowledger-required-headers` all present;
   - `x-flowledger-conditional-required-headers`: when the JSON-pointer condition matches the body, the header must exist and match its schema (e.g. `Retry-After: 1` for `IDEMPOTENCY_REQUEST_IN_PROGRESS`);
   - body validates against the response content schema (`application/json` or `application/problem+json`, matching the response `Content-Type`); `304` must have no body;
   - problem bodies: `body.status === status` and `body.code` is in that status's `Problem*` enum.
   - `Problem422` validates through `components.schemas.Problem` like every other status: D-08 fix 3 added it to `Problem.oneOf` before P00, so R-10 needs no workaround.
2. Wire the helper into existing integration tests for every response they produce (create, auth, get, list, timeline).
3. `test/integration/api/openapi-conformance.test.ts`: one case per (operationId, status) that P04 can emit: `createPayment` 201/201-replay/400/401/403/409(each code)/413/415/500/503; `getPayment` and `getOperation` 200/304/400/401/403/404; `listPayments` 200/400/401/403; `listPaymentOperations` 200/400/401/403/404; `getPaymentTimeline` 200/400/401/403/404. `429` is documented as not emitted in P04.

**Expected behavior** — A `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` without `Retry-After` fails the helper; a `401` without `WWW-Authenticate` fails.

**Acceptance criteria**
- [ ] Helper rejects each of: missing required header, wrong header type, undeclared status, body/status mismatch, wrong code for status, body on `304`.
- [ ] Every P04-emittable (operation, status) pair has a passing integration case.

**Testing requirements**
- `test/contract/openapi-conformance-helper.test.ts`: synthetic responses exercising each rejection rule above and positive cases built from openapi examples.
- `pnpm vitest run --project contracts test/contract/openapi-conformance-helper.test.ts`, `pnpm vitest run --project integration test/integration/api/openapi-conformance.test.ts`.

**Non-goals** — Command endpoints (P05-T03 extends), provider webhook ingress (P09).

**Handoff checklist**
- [ ] Conditional-header rule observed failing when `Retry-After` is stripped from the in-progress response.
- [ ] `pnpm check`, `pnpm test:integration` green.

---

### P04-GATE — Merchant API milestone verification

**Task ID:** `P04-GATE`
**Feature:** M4 exit gate (checkpoint C4 "API up")
**Commit:** `test(api): verify p04 merchant api milestone end to end`
**Priority:** Critical
**Dependencies:** `P04-T01` … `P04-T14`
**Estimated complexity:** M
**Contract references:** `docs/10` M4 §Test and acceptance criteria (every bullet); `docs/05` §Normative acceptance criteria 1–4, 8–11, 13; `docs/08` §Required failure-injection tests "API and outbox" (create rows); `docs/09` §PostgreSQL integration tests (idempotency rows)
**Files:** create: `test/e2e/api/p04-gate.test.ts`, `docs/evidence/P04.md`, `test/fixtures/db/P04.sql`; modify: none; must not touch: `apps/**`, `packages/**` (no feature code), `migrations/**`

**Objective** — Prove the milestone exit gate against a **spawned** API process (real HTTP, real PostgreSQL), not just merged tasks.

**Implementation instructions**
1. `test/e2e/api/p04-gate.test.ts`: start Testcontainers PG, run all migrations, run `flowledger seed --profile dev` (two merchants A/B with read and write credentials, fake-provider routes), spawn `node apps/api/dist/main.js` with `.env.example` values only (proves no undocumented secret), and drive it with `fetch`:
   - create → get → list → operations list (empty page) → timeline; every response through `assertConformsToOpenApi`;
   - byte-identical replay; changed-body conflict with no new effect (row counts);
   - 100 concurrent identical creates → one payment, one `payment.created.v1` outbox row;
   - cross-tenant matrix: B's credential against A's payment on `getPayment`, `listPaymentOperations`, `getPaymentTimeline` → `404`; A's cursor used by B → `400 INVALID_CURSOR`; `X-Merchant-Id: <A>` sent by B has no effect;
   - missing scope → `403`; invalid/expired/revoked credential → `401` with `WWW-Authenticate`;
   - invalid inputs: malformed `If-None-Match`, malformed cursor, `EUR`, JSON-number amount, unknown field, raw-card fixture → `400` with zero new rows in `api.idempotency_records` and `payments.payments`;
   - provider selection: explicit, default, missing default → `409 PROVIDER_ROUTE_UNAVAILABLE`, disabled route → `409`, unknown provider → `400 UNSUPPORTED_PROVIDER` (rollover race is covered by P04-T08; re-run that file in this gate's command list);
   - kill the API process (`SIGKILL`) after a successful create response is received but before reading it fully, restart, replay → same `pay_` ID.
2. Generate `test/fixtures/db/P04.sql` (`pg_dump --schema-only` + seed data) for the next phase's "apply from previous fixture" test, per README §9.2.
3. `docs/evidence/P04.md`: commands run, pass counts, and the mapping from each `docs/10` M4 bullet to the test case name.

**Expected behavior** — All cases pass; evidence note lists every bullet.

**Acceptance criteria**
- [ ] Every `docs/10` M4 acceptance bullet maps to at least one passing case named in `docs/evidence/P04.md`.
- [ ] The spawned API starts with only `.env.example` variables.
- [ ] No feature code changed in this task.

**Testing requirements**
- `pnpm test:e2e -- test/e2e/api/p04-gate.test.ts`, `pnpm test:integration`, `pnpm test:chaos`, `pnpm check`.

**Non-goals** — Command endpoints, messaging.

**Handoff checklist**
- [ ] Evidence note committed; fixture dump committed.
- [ ] All lanes listed above green.

---

## Parallelization

| Can run concurrently | Notes / shared files that conflict |
| --- | --- |
| `P04-T02`, `P04-T04`, `P04-T05`, `P04-T06` after `P04-T01` | T02 and T04 both modify `apps/api/src/app.ts` (register hooks/parsers) — merge T02 first or rebase; T04 and T05 both modify `packages/config/src/api.ts`, `.env.example`, `docs/CONFIG.md`. T06 (`0410`), T07 (`0420`), T12 (`0430`) are the phase's only SQL (README §5.4 single-owner): one agent at a time. |
| `P04-T03` after `P04-T02` | Independent of T04–T06. |
| `P04-T07` → `P04-T08` | Sequential (same migration/function). |
| `P04-T10`, `P04-T11`, `P04-T12` after `P04-T09` | All modify `apps/api/src/payments/payments.controller.ts` and `payment-queries.service.ts`; run sequentially or rebase carefully. T12 owns migration `0430`. |
| `P04-T13` after `P04-T09` | Edits `packages/observability/src/redaction.ts` (single-owner surface). |
| `P04-T14` after T10–T12 | Edits existing test files only. |

Critical path: T01 → T02 → T03 → (T04, T05, T06 → T07) → T09 → T10/T11/T12 → T14 → GATE.

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| docs/10 M4 F1: bearer parsing, constant-time digest, scopes, revocation/expiry, merchant context | T04 (P02 credentials/lookup) | `test/integration/api/auth.test.ts` :: revoked / expired / wrong secret / read-only on write / overlapping credentials |
| docs/10 M4 F2: request-size, content-type, duplicate keys, unknown fields, credential shape, prohibited data | T02, T03, T04 | `test/integration/api/body-defenses.test.ts` :: 413/415/duplicate; `apps/api/src/http/validation.test.ts` :: unknown field; `apps/api/src/http/prohibited-data.test.ts` :: PAN/field names |
| docs/10 M4 F3: `POST /v1/payments` routing, encrypted token, fee/config snapshot, idempotency, `payment.created.v1` | T05, T07, T09 | `test/integration/api/create-payment.test.ts` :: happy path rows + envelope; `test/integration/db/create-payment-function.test.ts` :: bound snapshot |
| docs/10 M4 F4: retrieval/listing, tenant scope, cursor pagination, ETags, conditional GET | T06, T10, T11 | `get-resources.test.ts` :: 304/ETag change; `list-pagination.test.ts` :: snapshot traversal |
| docs/10 M4 F5: timeline closed details, DB ordering, bound + truncated, redaction | T12 | `timeline.test.ts` (unit + integration) :: truncation / no ETag / prohibited scan |
| docs/10 M4 F6: problem details incl. `422 CAPTURE_BELOW_MINIMUM` mapping | T01, T14 | `problem-map.test.ts` :: code set + statuses (422 emitted in P05) |
| docs/10 M4 F7: replay, in-progress wait, conflict, expired tombstone | T07, T09 | `create-payment-idempotency.test.ts` :: replay / held owner / aged 91 days |
| docs/10 M4 F8: logs have request/correlation IDs, never credentials or PM refs | T13 | `logging-redaction.test.ts` |
| docs/10 M4 A1: OpenAPI conformance for every create/query status and header | T14 | `test/integration/api/openapi-conformance.test.ts` :: per (operation, status) |
| docs/10 M4 A2: identical creates replay byte-equivalent status, headers, body | T09 | `create-payment-idempotency.test.ts` :: byte-identical replay |
| docs/10 M4 A3: changed body same key → conflict, no effect | T07, T09 | `create-payment-idempotency.test.ts` :: each semantic change |
| docs/10 M4 A4: concurrent identical creates → one payment, one event | T07, T09, GATE | `create-payment-function.test.ts` :: 100 concurrent; `p04-gate.test.ts` :: 100 concurrent |
| docs/10 M4 A5: wrong tenant 404, missing scope 403, invalid credential 401 | T04, T10, T11, T12, GATE | `p04-gate.test.ts` :: cross-tenant matrix |
| docs/10 M4 A6: invalid ETags, cursors, non-USD, JSON-number money, unknown fields, raw card fail with no rows | T03, T09, T11, GATE | `p04-gate.test.ts` :: invalid inputs zero rows |
| docs/10 M4 A7: pagination stable, cannot cross tenants | T11 | `list-pagination.test.ts` :: cross-merchant cursor / interleaved inserts |
| docs/10 M4 A8: timeline ordering, truncation, no prohibited field, cross-tenant 404 | T12 (truncation integration in P05-T13) | `timeline.test.ts` :: all cases |
| docs/10 M4 A9: explicit/default/missing/disabled/rollover route tests | T08, GATE | `route-selection.test.ts` :: all cases |
| docs/05 §General: 64 KiB bound before parsing | T02 | `body-defenses.test.ts` :: 65 537 bytes |
| docs/05 §Auth: identity only from principal; foreign → 404 not 403 | T04, T10 | `auth.test.ts` :: `X-Merchant-Id` ignored; `get-resources.test.ts` :: foreign 404 |
| docs/05 §Auth: `401` with `WWW-Authenticate` | T04, T14 | `openapi-conformance.test.ts` :: 401 cases |
| docs/05 §Money: string-only, positive, ≤ 1e12, USD only, overflow rejected before effects | T03, T09 | `validation.test.ts` :: boundaries |
| docs/05 §Key format: 16–128 `[A-Za-z0-9._:-]`, required on POST, rejected on GET | T03 | `headers.test.ts` |
| docs/05 §Uniqueness `(merchant, command_type, key)`; cross-merchant isolation | T07 | `create-payment-function.test.ts` :: same key two merchants |
| docs/05 §Canonical hash: formatting-independent, semantic changes differ | T09 (P01 hash) | `create-payment-idempotency.test.ts` :: reformatted JSON replay |
| docs/05 §Atomic ownership 1–5 (one owner; bounded wait → `409 IN_PROGRESS` + `Retry-After: 1`; rollback lets waiter own) | T07, T09 | `create-payment-function.test.ts` :: held owner; `create-payment-idempotency.test.ts` :: held owner HTTP |
| docs/05 §Response replay: status, body, Location, content type, ETag, original correlation ID, `Idempotent-Replay` | T09 | `create-payment-idempotency.test.ts` :: replay headers |
| docs/05 §Which responses are stored: only 201/202 | T07, T09 | `create-payment.test.ts` :: each 4xx zero rows then same-key success |
| docs/05 §Retention / ADR-0009: tombstone → `409 IDEMPOTENCY_KEY_EXPIRED` + `resourceLocation` | T07, T09 | `create-payment-idempotency.test.ts` :: aged 91 days |
| docs/05 §Correlation IDs: invalid → `400 INVALID_CORRELATION_ID`; replay returns original | T01, T09 | `request-context.test.ts`; `create-payment-idempotency.test.ts` |
| docs/05 §Pagination: limit 1–100 default 50; `(createdAt DESC, id DESC)`; bound cursor; 24 h expiry; operations list 404 | T06, T11 | `cursor.test.ts`; `list-pagination.test.ts` |
| docs/05 §Timeline rules (no ETag, `payments:read`, 404) | T12 | `timeline.test.ts` |
| docs/05 Normative 8: no secondary unscoped lookup | T06, T10 | `payment-representation.test.ts` :: cross-tenant NULL |
| docs/07 §`create_payment` atomic payment + idempotency + event | T07 | `create-payment-faults.test.ts` :: per fault point |
| docs/07 §`merchant_routes`: one exact snapshot, no fallback | T07, T08 | `route-selection.test.ts` |
| docs/07 §`api.idempotency_records`: 90-day replay, hashes 32 bytes, tombstone semantics | T07 | `create-payment-function.test.ts` :: row contents / 89 vs 91 days |
| docs/07 §`merchant_api_credentials`: lookup before tenant context; expiry checked per request | T04 | `auth.test.ts` :: expired / revoked |
| docs/07 §`payments.payments`: encrypted PM reference with AAD | T05, T09 | `payment-method-crypto.test.ts`; `create-payment.test.ts` :: plaintext absent |
| docs/07 §Tenant isolation 3–5 (SET LOCAL, RLS, explicit predicate) | T06, T10, T11 | `payment-representation.test.ts` :: missing merchant setting |
| docs/08 §API acceptance: crash after create commit → same-key retry returns same `pay_` | T09, GATE | `create-payment-idempotency.test.ts` :: lost response; `p04-gate.test.ts` :: SIGKILL + replay |
| docs/08 §API acceptance: response never before commit | T07, T09 | `create-payment-faults.test.ts` :: `commit` point → 500 |
| docs/08 Required failure tests "Crash before and after payment-creation commit" | T07, GATE | `create-payment-faults.test.ts`; `p04-gate.test.ts` |
| docs/09 §PostgreSQL integration: failure after each statement leaves no partial effect (create) | T07 | `create-payment-faults.test.ts` |
| docs/09 §PostgreSQL integration: conflicting idempotency payloads deterministic conflict | T07 | `create-payment-function.test.ts` :: race of 10 hashes |
| docs/09 §Unit tests: derived summary status | T06 | `payment-representation.test.ts` :: property SQL vs TS |
| docs/09 §Static checks: response status/problem-code/header probes | T14 | `openapi-conformance-helper.test.ts` |

## Phase risks / open questions

| ID | Risk / question | Impact | Severity | Recommended resolution | Blocked tasks |
| --- | --- | --- | --- | --- | --- |
| R-01 | Replay bodies must be stored at claim time (P02 `api.claim_idempotency_key` inserts the full record first), before the payment row exists. | Stored body could diverge from committed state. | Medium | `new_payment_representation` + one shared DB timestamp + equality assertion (`INTERNAL_REPRESENTATION_MISMATCH`) in `create_payment`; requires P02 triggers to accept an explicit `created_at`/`updated_at` equal to a function-computed `clock_timestamp()` — if a P02 trigger overrides them, stop and report. | T07 |
| R-02 | CONVENTIONS §9 requires TS-built, Ajv-validated envelopes, while route snapshot values exist only inside PostgreSQL; `docs/07` describes `create_payment` as one function. | Single-call `create_payment` cannot satisfy both. | Medium | Two-call transaction (Design decision 1); share locks and the claim persist to commit, so no retry loop is needed. Record the pattern in `docs/07` via a contract-update commit. | T07, T09 |
| R-03 | P02 implements pre-tenant credential lookup with a transaction-local GUC (`app.credential_key_prefix`) under RLS rather than a `SECURITY DEFINER` function (P02 risk R3). | A caller setting that GUC can read only the row whose locator it already holds; digest verification still authenticates. | Low | Reuse P02 `lookupCredential` unchanged; P11 threat model reviews it. | T04 |
| R-04 | Contracts do not say whether a `SUSPENDED`/`CLOSED` merchant's active credential authenticates. | Security posture ambiguity. | Low | Treat as `401` (fail closed). | T04 |
| R-05 | The unreliable simulator's provider code is not named anywhere (`docs/06` §Unreliable provider; `docs/07` line 166 names only `fake-provider`). | `UNSUPPORTED_PROVIDER` set and seed routes must agree with P02/P06. | Medium | Use `unreliable-provider`; P02 seed and P06 adapters must use the same string. | T05, T09 |
| R-06 | Precedence between `IDEMPOTENCY_CONFLICT` and `IDEMPOTENCY_KEY_EXPIRED` for a changed request on an expired key is unspecified (`docs/05` lines 469, 484). | Different `409` code; no effect either way. | Low | Expired first, matching P02 `api.claim_idempotency_key`; `peek_idempotency` uses the same order. | T07 |
| R-07 | No problem code exists for a merchant with no current fee policy at creation. | Config defect surfaces as `500`. | Low | `INTERNAL_FEE_POLICY_UNAVAILABLE` internal → `500 INTERNAL_ERROR`; seed always creates a policy. | T07 |
| R-08 | `causationId` for API-originated messages is undefined; `docs/04` line 50 shows a `cmd_` prefix absent from `schemas/common/entity-ids.v1.schema.json`. | Inconsistent causation chains across phases. | Low | Use the HTTP `X-Request-Id` (`req_…`) as `causationId`; P05 does the same. | T09 |
| R-09 | `openapi.yaml` lines 1303–1306 say per-kind timeline detail shapes are enumerated in `docs/05`, but `docs/05` lines 314–363 only show examples for 3 of 11 kinds. The separate `truncated` gap is closed (D-08 fix 2). | Each phase may invent a different shape. | Medium | P04-T12 step 0 makes a contract-update commit first: adds a detail-shape table (`PAYMENT_CREATED` = `{requestedAmountMinor, currency}`); every later phase extends that table in a contract commit before adding its kind. | T12 (and P05–P10) |
| R-10 | **Resolved before P00** by D-08 fix 3: `Problem422` is now a member of `components.schemas.Problem.oneOf`, so a `422` body validates against `Problem`. | — | Closed | No action, and no direct-to-`Problem422` special case: validating every problem body through `Problem` is the whole point of the `oneOf`. | T14 |
| R-11 | `req_` (openapi line 911), `mcr_`, `fee_` (docs/07) prefixes are absent from `schemas/common/entity-ids.v1.schema.json`, which CONVENTIONS §6 calls authoritative. | `newId('req')` may be rejected by P01's typed prefix list. | Low | Add `req`/`cor` in T01 citing openapi; propose adding them to the entity-ID schema. | T01 |
| R-12 | P04 depends on P02/P01 export names (`lookupCredential`, `claim_idempotency_key`, `select_route`, `computeRequestHash`, `deriveSummaryStatus`, fixtures) exactly as written in their phase files. | Rename in an earlier phase breaks these tasks. | Low | Names copied from `P01-domain-kernel.md`/`P02-database-foundation.md`; if a shipped name differs, stop and report (CONVENTIONS §14). | T04, T06, T07, T09 |
| R-13 | Terminal-status operation fixtures need `resolution_evidence_id` before the evidence table exists (P06). | Representation tests for terminal statuses may need placeholder IDs. | Low | Placeholder `pev_` text in superuser fixtures until P06 adds the FK; P06 re-runs these tests. | T06, T10 |
