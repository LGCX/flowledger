# P03 — Ledger core, striping, and the invariant checker

## Phase overview

**Goal (docs/10 §M3).** An immutable double-entry ledger in PostgreSQL: ledgers, accounts (with striped platform buckets), journal headers/entries, a synchronous balance projection, the private canonical posting routine, the dual-control correction/reversal entry point, pure capture/refund recipes with golden vectors, balance-rebuild tooling, and `flowledger verify` — the continuous invariant checker covering every assertion class in docs/09 §Continuous invariant checker, wired into CI.

**Entry criteria.** `P02-GATE` green (roles from CONVENTIONS §7, `flowledger migrate` runner, `withTransaction`, payments/operations/idempotency/messaging tables, `messaging.insert_outbox(envelope jsonb)`, Testcontainers fixture). `P01-GATE` green for T05 and T07 (ledger posting-hash and fee golden vectors in `@flowledger/domain`).

**Exit gate (docs/10 §M3, docs/09 Ledger-ready).** Every M3 acceptance bullet passes in `pnpm test:integration`; `flowledger verify` reports zero findings against a populated database at bucket count N=1 and N=32; each assertion class detects its deliberately corrupted fixture; `pnpm verify:ledger` runs in the CI integration job.

**Out of scope (owned elsewhere).** `ledger.post_payment_operation` (P07), payment transitions that call the ledger (P07), settlement tables and `settlement.post_batch` (P10), reconciliation tables (P08), provider simulator ground-truth schema (P06), operator CLI for corrections and audit records (`audit.operator_actions` created in P10-T11; operator commands P10/P11), rebalancing migration for a changed bucket count (not in MVP).

### Interfaces consumed from earlier phases

| From | Interface |
| --- | --- |
| P02 | Roles: `fl_migration_owner`, `ledger_function_owner`, `messaging_function_owner`, `fl_api`, `fl_correction`, `fl_operator_readonly`, `fl_operator_command`, and every other role in CONVENTIONS §7. Extension `pgcrypto`. Schemas `ledger`, `settlement`, `reconciliation`, `identity`, `payments`, `messaging`. |
| P02 | Tables `identity.merchants(id)`, `payments.payments`, `payments.payment_operations` (columns per docs/07), `messaging.outbox_messages`, `messaging.dead_letter_records`. |
| P02 | `messaging.insert_outbox(envelope jsonb)` (registered type `ledger.transaction.posted.v1`, rule "a ledger event uses its ledger transaction as aggregate"). |
| P02 | `packages/database/src/migrate.ts` (runner `migrate({ connectionString, dir?, upTo?, ledgerBucketCount, ledgerEnvironment?, expectedOwner? })`; sets `flowledger.ledger_bucket_count` / `flowledger.ledger_environment` from `LEDGER_BUCKET_COUNT` / `LEDGER_ENVIRONMENT`), `packages/database/src/tx.ts` (`withTransaction`), `packages/database/src/errors.ts` (`DomainError`), `packages/database/src/pool.ts`. |
| P02 | Testcontainers PostgreSQL 17 fixture and seed builders in `packages/testkit` (merchant, payment, payment-operation builders); `apps/cli` with `migrate` and `seed --profile dev`. |
| P01 | `@flowledger/domain`: `computePostingHash(input: PostingHashInput)` (`posting-hash.ts`, golden file `packages/domain/golden/posting-hash.v1.json`) and `incrementalFeeReversal({ captureFee, captureGross, confirmedRefundedBefore, refundAmount })` (`fees.ts`, golden `refund-fee.v1.json`), per P01 "Interfaces provided". |
| P06 (later, consumed by T14 at runtime only) | Ground truth `truth.provider_financial_effects(provider_idempotency_key text, payment_ref text, operation_type text, effect_count int)` in `flowledger_sim`, read via `SIMULATOR_DATABASE_URL` (role `fl_simulator_truth`); created by P06-T03. Until P06 the class reports `0 rows checked (ground truth unavailable)` (CONVENTIONS §16). |

### Interfaces provided to later phases

SQL (all in schema `ledger`, owner `ledger_function_owner` unless noted):

| Object | Kind | Executable by | Consumer |
| --- | --- | --- | --- |
| `ledger.bucket_for_payment(p_payment_id text, p_bucket_count integer) RETURNS smallint` | IMMUTABLE | `ledger_function_owner`, `fl_operator_readonly`, `payments_function_owner`, `settlement_function_owner` | P07, P12 benchmark |
| `ledger.generate_id(p_prefix text) RETURNS text` | VOLATILE, private | owner only | P03 seed |
| `ledger.jcs(p_value jsonb) RETURNS text` | IMMUTABLE | owner only | P03 hashes |
| types `ledger.posting_line(account_id text, side text, amount_minor bigint)`, `ledger.canonical_line(entry_ordinal smallint, account_id text, side text, amount_minor bigint)`, `ledger.recipe_line(logical_code text, side text, amount_minor bigint)` | composite types | — | P07, P10 |
| `ledger.canonicalize_lines(p_lines ledger.posting_line[]) RETURNS ledger.canonical_line[]` | IMMUTABLE | owner only | internal |
| `ledger.posting_hash(...) RETURNS bytea` (signature in T05) | IMMUTABLE | owner only | internal |
| `ledger.create_account(...) RETURNS text` (signature in T02) | SECURITY DEFINER | `fl_migration_owner` | seed |
| `ledger.open_merchant_accounts(p_merchant_id text) RETURNS void` | SECURITY DEFINER | `fl_migration_owner`, `fl_operator_command` | P02 dev seed (modified here), P11 |
| `ledger.post_journal_internal(...) RETURNS text` (signature in T06) | SECURITY DEFINER, **private** | no role; called only by other `ledger_function_owner` functions | P07 `post_payment_operation`, P10 `settlement.post_batch` (via a `ledger` wrapper they add) |
| `ledger.capture_recipe(p_gross_minor bigint, p_fee_minor bigint) RETURNS ledger.recipe_line[]` | IMMUTABLE | owner only | P07 |
| `ledger.refund_recipe(p_refund_minor bigint, p_fee_reversal_minor bigint) RETURNS ledger.recipe_line[]` | IMMUTABLE | owner only | P07 |
| `ledger.incremental_fee_reversal(p_fee_minor bigint, p_gross_minor bigint, p_confirmed_refunded_minor bigint, p_refund_minor bigint) RETURNS bigint` | IMMUTABLE | owner, `payments_function_owner` | P07 `apply_provider_evidence` |
| `ledger.resolve_recipe(p_ledger_id text, p_merchant_id text, p_payment_id text, p_lines ledger.recipe_line[]) RETURNS ledger.posting_line[]` | STABLE, private | owner only | P07 |
| `ledger.request_correction`, `ledger.decide_correction`, `ledger.post_approved_correction` (signatures in T09) | SECURITY DEFINER | `fl_correction` | P11 operator CLI |
| `ledger.rebuild_balance_projection(p_account_id text) RETURNS boolean` | SECURITY DEFINER | `fl_operator_command` | P11 runbook CLI |
| view `ledger.logical_account_balances` | view | `fl_operator_readonly` | P11 dashboards |

TypeScript:

- `packages/database/src/functions/ledger.ts`: `openMerchantAccounts`, `requestCorrection`, `decideCorrection`, `postApprovedCorrection`, `rebuildBalanceProjection` (one wrapper per SQL function, CONVENTIONS §7).
- `packages/database/src/errors.ts`: new `DomainError` codes `LEDGER_INVARIANT_VIOLATION`, `LEDGER_CORRECTION_REJECTED` (**[ASSUMPTION]**, risk R-08); `IDEMPOTENCY_CONFLICT` reused for posting-key hash mismatch.
- `packages/database/src/verify/index.ts`: `runVerify(pool: Pool, opts: VerifyOptions): Promise<VerifyReport>`; `formatHuman(report): string`; `formatJson(report): string` (JSON = `JSON.stringify(VerifyReport, null, 2)`, shape fixed in P03-T11: `{ schemaVersion: 1, result: 'PASS'|'FAIL', failureReasons: ('FINDINGS'|'GROUND_TRUTH_REQUIRED')[], bucketCount: number|null, classes: [{ name, status: 'OK'|'FINDINGS'|'SKIPPED', rowsChecked, findings, skipReason: null|'TABLE_ABSENT'|'GROUND_TRUTH_UNAVAILABLE', absentTables: string[], samples: [{ subject, detail }] }], gauges: { unresolvedAmbiguity: number|null } }`; P12 parses this). Each later phase whose tables a class depends on keeps that class's corrupted-fixture test green.
- `packages/testkit/src/ledger.ts`: `createLedgerDatabase`, `postJournalAsOwner`, `ledgerAccounts`; `packages/testkit/src/ledger-corruption.ts`: corruption helpers.
- `apps/cli`: `flowledger verify [--json] [--require-ground-truth]`.

### Fixed names used throughout this phase

- Logical account codes **[ASSUMPTION]** beyond the two docs/07 names (risk R-05): `platform.processor_receivable` (striped), `platform.fee_revenue` (striped), `platform.rounding_expense`, `platform.rounding_revenue`, `merchant.clearing`, `merchant.payable`.
- Posting keys (docs/02 §Idempotent posting): `payment:{paymentId}:capture:{operationId}`, `payment:{paymentId}:refund:{operationId}`, `settlement:{settlementBatchId}`, `ledger:{transactionId}:reversal:{correctionRequestId}`, and **[ASSUMPTION]** `ledger:adjustment:{correctionRequestId}` (risk R-04).
- ID prefixes from docs/07: `led_` (ledger), `lac_` (account), `ltx_` (journal transaction), `lcr_` (correction request). `led_`, `lac_`, `lcr_` are absent from `schemas/common/entity-ids.v1.schema.json` (risk R-02); they are used only inside SQL and the operator path, never on the merchant wire.
- Domain error raising (CONVENTIONS §7): `RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '<CODE>', DETAIL = '<json>'` where DETAIL for ledger errors is `{"rule":"<RULE>", ...}`. Rule values are listed in each task.
- Bucket count GUC: `flowledger.ledger_bucket_count` (CONVENTIONS §8), default 32, valid 1..100 (two-digit physical code suffix).

---

### P03-T01 — Ledger SQL helpers: ID generator, JCS serializer, bucket derivation

**Task ID:** `P03-T01`
**Feature:** Striping derivation and canonical hashing primitives
**Commit:** `feat(ledger): add id generator, jcs serializer, and bucket_for_payment`
**Priority:** Critical
**Dependencies:** `P02-GATE`
**Estimated complexity:** M
**Contract references:** docs/07 §Striped platform accounts, §IDs, §ledger.journal_entries (hash paragraph); docs/02 §Striped platform accounts, §Idempotent posting; ADR-0010; CONVENTIONS §6, §8
**Files:** create: `migrations/0300_ledger_helpers.sql`, `test/integration/ledger/helpers.test.ts`; modify: none; must not touch: `migrations/02*`, `packages/domain/**`

**Objective** — Provide the three pure/near-pure SQL primitives every later ledger object depends on: a ULID-format ID generator usable inside migrations, an RFC 8785 (JCS) serializer for the restricted JSON shapes the ledger hashes, and the `IMMUTABLE` bucket derivation that decides which platform bucket a payment's postings use.

**Implementation instructions**
1. In `migrations/0300_ledger_helpers.sql` (runs as `fl_migration_owner`), create:
   ```sql
   CREATE FUNCTION ledger.generate_id(p_prefix text) RETURNS text
   LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
   DECLARE
     alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
     ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
     bits bit(130);
     result text := '';
   BEGIN
     IF p_prefix IS NULL OR p_prefix !~ '^[a-z][a-z0-9]{1,15}$' THEN
       RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LEDGER_INVARIANT_VIOLATION',
         DETAIL = '{"rule":"INVALID_ID_PREFIX"}';
     END IF;
     bits := B'00' || ms::bit(48) || ('x' || encode(gen_random_bytes(10), 'hex'))::bit(80);
     FOR i IN 0..25 LOOP
       result := result || substr(alphabet, substring(bits FROM i * 5 + 1 FOR 5)::integer + 1, 1);
     END LOOP;
     RETURN p_prefix || '_' || result;
   END $$;
   ```
   The leading `B'00'` makes the first character `0`–`7` (CONVENTIONS §6 regex).
2. Create `ledger.jcs(p_value jsonb) RETURNS text`, `LANGUAGE plpgsql IMMUTABLE STRICT`, fixed `search_path = pg_catalog`:
   - object → `'{' || string_agg(to_json(key)::text || ':' || ledger.jcs(value), ',' ORDER BY key COLLATE "C") || '}'` (empty object → `{}`); raise `LEDGER_INVARIANT_VIOLATION` rule `JCS_NON_ASCII_KEY` if any key `!~ '^[\x20-\x7E]*$'` (C-collation order equals JCS UTF-16 order only for ASCII).
   - array → `'[' || string_agg(ledger.jcs(value), ',' ORDER BY ordinality) || ']'` using `jsonb_array_elements(...) WITH ORDINALITY`.
   - string → `to_json(p_value #>> '{}')::text` (PostgreSQL's JSON escaping matches JCS for `"`, `\`, `\b\f\n\r\t`, and lower-case `\u00XX` controls).
   - number → only integers `^-?(0|[1-9][0-9]{0,15})$` with absolute value ≤ 9007199254740991; otherwise rule `JCS_UNSUPPORTED_NUMBER`. Output the digits unchanged.
   - boolean → `true`/`false`; null → `null`.
3. Create the bucket derivation. **Exact definition** (docs/07 §Striped platform accounts says "decodes the Crockford ULID entropy … modulo bucket_count"; the entropy span is fixed here as **[ASSUMPTION]**, risk R-03): the ULID is the 26 characters after `pay_`; its entropy is ULID characters 11–26 (the 16 characters after the 10-character timestamp), i.e. `substr(payment_id, 15, 16)`. Decode those 16 characters as a big-endian base-32 integer over alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (value = index), using `numeric`, and return `mod(value, bucket_count)`.
   ```sql
   CREATE FUNCTION ledger.bucket_for_payment(p_payment_id text, p_bucket_count integer)
   RETURNS smallint LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
   SET search_path = pg_catalog AS $$
   DECLARE v numeric := 0; c text;
   BEGIN
     IF p_payment_id !~ '^pay_[0-7][0-9A-HJKMNP-TV-Z]{25}$' THEN
       RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LEDGER_INVARIANT_VIOLATION',
         DETAIL = '{"rule":"INVALID_PAYMENT_ID"}';
     END IF;
     IF p_bucket_count < 1 OR p_bucket_count > 100 THEN
       RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LEDGER_INVARIANT_VIOLATION',
         DETAIL = '{"rule":"INVALID_BUCKET_COUNT"}';
     END IF;
     FOREACH c IN ARRAY regexp_split_to_array(substr(p_payment_id, 15, 16), '') LOOP
       v := v * 32 + (strpos('0123456789ABCDEFGHJKMNPQRSTVWXYZ', c) - 1);
     END LOOP;
     RETURN mod(v, p_bucket_count)::smallint;
   END $$;
   ```
4. Ownership and grants (last in the file): `ALTER FUNCTION ... OWNER TO ledger_function_owner` for all three; `REVOKE ALL ON FUNCTION ... FROM PUBLIC` for all three; `GRANT EXECUTE ON FUNCTION ledger.bucket_for_payment(text, integer) TO fl_operator_readonly, payments_function_owner, settlement_function_owner, fl_migration_owner`; `GRANT EXECUTE ON FUNCTION ledger.generate_id(text), ledger.jcs(jsonb) TO fl_migration_owner`.

**Expected behavior** — Golden vectors (bucket = `ledger.bucket_for_payment(id, N)`):

| payment id | entropy chars | N=32 | N=7 | N=1 |
| --- | --- | --- | --- | --- |
| `pay_01ARZ3NDEKTSV4RRFFQ69G5FAV` | `TSV4RRFFQ69G5FAV` | 27 | 1 | 0 |
| `pay_00000000000000000000000000` | `0000000000000000` | 0 | 0 | 0 |
| `pay_7ZZZZZZZZZZZZZZZZZZZZZZZZZ` | `ZZZZZZZZZZZZZZZZ` | 31 | 3 | 0 |
| `pay_01J9Z8Y7X6W5V4T3S2R1Q0P9N8` | `W5V4T3S2R1Q0P9N8` | 8 | 0 | 0 |
| `pay_01HZX4K2M3N5P6Q7R8S9T0V1W2` | `N5P6Q7R8S9T0V1W2` | 2 | 4 | 0 |
| `pay_0000000000ZZZZZZZZZZZZZZZZ` | `ZZZZZZZZZZZZZZZZ` | 31 | 3 | 0 |
| `pay_01JC0000000000000000000001` | `0000000000000001` | 1 | 1 | 0 |
| `pay_01JC000000000000000000000Z` | `000000000000000Z` | 31 | 3 | 0 |

The N=7 column exists so an implementation that only reads the last character (correct for powers of two only) fails. `ledger.jcs('{"b":1,"a":[true,null,"x\n"]}')` → `{"a":[true,null,"x\n"],"b":1}`. `ledger.jcs('1.5')` raises rule `JCS_UNSUPPORTED_NUMBER`. `ledger.generate_id('lac')` matches `^lac_[0-7][0-9A-HJKMNP-TV-Z]{25}$`.

**Acceptance criteria**
- [ ] All eight golden vectors return the listed bucket at N=32, N=7, N=1.
- [ ] `bucket_for_payment` is declared `IMMUTABLE` (`pg_proc.provolatile = 'i'`) and rejects a non-`pay_` ID and N=0/N=101 with the listed rules.
- [ ] `generate_id` output matches the CONVENTIONS §6 regex for 1000 calls and all 1000 are distinct.
- [ ] `jcs` sorts keys in C order, has no insignificant whitespace, rejects non-integers and non-ASCII keys.
- [ ] `PUBLIC` and `fl_api` cannot execute any of the three functions.

**Testing requirements** — `test/integration/ledger/helpers.test.ts` (default fixture):
- golden vector table above (positive); two separate pool connections compute the same bucket for 200 random generated `pay_` IDs (stability across sessions); a fast-check property comparing SQL with a test-local `BigInt` reference decoder for 500 random valid IDs and N ∈ {1, 7, 32, 100}.
- negative: invalid ID, `N=0`, `N=101`; `SET ROLE fl_api; SELECT ledger.bucket_for_payment(...)` fails with SQLSTATE `42501`.
- jcs: key ordering (`"B"` sorts before `"a"`), nested arrays, control-character escape, `1.5`, `1e3`, `2^53` rejection, non-ASCII key rejection.
- Command: `pnpm vitest run --project integration test/integration/ledger/helpers.test.ts`.

**Non-goals** — No tables. No TypeScript bucket function (the bucket is derived only in the database, docs/07). No posting hash yet (T05).

**Handoff checklist**
- [ ] Changing `substr(p_payment_id, 15, 16)` to `substr(p_payment_id, 30, 1)` was observed to fail the N=7 vectors, then restored.
- [ ] Grants are the last statements in the file.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P03-T02 — Ledgers, accounts, balance projection, account creation, logical-balance view

**Task ID:** `P03-T02`
**Feature:** Ledger account model with striping columns
**Commit:** `feat(ledger): add ledgers, accounts, account_balances, and logical balance view`
**Priority:** Critical
**Dependencies:** `P03-T01`
**Estimated complexity:** L
**Contract references:** docs/07 §ledger.ledgers, §ledger.accounts, §Striped platform accounts, §ledger.account_balances, §Mutability rules, §Tenant isolation item 7; docs/02 §Ledger account, §Balance semantics; ADR-0005, ADR-0010
**Files:** create: `migrations/0310_ledger_accounts.sql`, `test/integration/ledger/accounts.test.ts`; modify: none; must not touch: `migrations/0300_ledger_helpers.sql`

**Objective** — Create the account model exactly as docs/07 defines it, with the striping identity and code-derivation checks, the one-balance-row-per-account guarantee, immutability triggers, and the operator-only logical-balance view.

**Implementation instructions** (file order: tables → constraints/indexes → triggers → functions → view → grants)
1. `ledger.ledgers`: `id text COLLATE "C" PRIMARY KEY CHECK (id ~ '^led_[0-7][0-9A-HJKMNP-TV-Z]{25}$')`, `legal_entity_code text NOT NULL CHECK (legal_entity_code ~ '^[A-Z][A-Z0-9_]{1,63}$')`, `environment text NOT NULL CHECK (environment IN ('LOCAL','TEST','SANDBOX'))`, `currency text NOT NULL CHECK (currency = 'USD')`, `created_at timestamptz NOT NULL DEFAULT clock_timestamp()`, `UNIQUE (legal_entity_code, environment, currency)`, `UNIQUE (id, currency)`.
2. `ledger.accounts` with columns exactly per docs/07 (`id`, `ledger_id`, `owner_type`, `owner_id`, `logical_code`, `bucket_index smallint`, `bucket_count smallint`, `code`, `account_class`, `normal_side`, `currency`, `status`, `allow_negative`, `merchant_postable`, `created_at DEFAULT clock_timestamp()`, `closed_at`). Constraints:
   - `id` check `^lac_[0-7][0-9A-HJKMNP-TV-Z]{25}$`; FK `(ledger_id, currency) REFERENCES ledger.ledgers (id, currency)`; FK `owner_id REFERENCES identity.merchants (id)`; index on `owner_id`.
   - `UNIQUE (ledger_id, id, currency)`; `UNIQUE (ledger_id, id, normal_side)`; `UNIQUE NULLS NOT DISTINCT (ledger_id, owner_type, owner_id, code, currency)`; `UNIQUE NULLS NOT DISTINCT (ledger_id, owner_type, owner_id, logical_code, bucket_index, currency)`.
   - `CHECK (owner_type IN ('PLATFORM','MERCHANT'))`; `CHECK ((owner_type = 'MERCHANT') = (owner_id IS NOT NULL))`.
   - `CHECK (logical_code ~ '^(platform|merchant)\.[a-z][a-z0-9_]{0,62}$')` and `CHECK (split_part(logical_code, '.', 1) = lower(owner_type))` **[ASSUMPTION]** (the prefix names the owner; risk R-05).
   - Striping: `CHECK ((bucket_index IS NULL) = (bucket_count IS NULL))`, `CHECK (bucket_count IS NULL OR (bucket_count BETWEEN 1 AND 100 AND bucket_index >= 0 AND bucket_index < bucket_count))`, `CHECK (owner_type = 'PLATFORM' OR bucket_index IS NULL)`.
   - Code derivation: `CHECK (code = CASE WHEN bucket_index IS NULL THEN logical_code ELSE logical_code || '.' || lpad(bucket_index::text, 2, '0') END)` (docs/07 writes `lpad(bucket_index, 2)`; zero padding is **[ASSUMPTION]**, risk R-06).
   - `CHECK (account_class IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE'))`; `CHECK (normal_side = CASE WHEN account_class IN ('ASSET','EXPENSE') THEN 'DEBIT' ELSE 'CREDIT' END)`.
   - `CHECK (currency = 'USD')`; `CHECK (status IN ('OPEN','CLOSED'))`; `CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))`; `CHECK (owner_type = 'PLATFORM' OR NOT merchant_postable)`.
   - Partial indexes: `UNIQUE (owner_id, code) WHERE owner_type = 'MERCHANT'`; `(ledger_id, logical_code, bucket_index) WHERE owner_type = 'PLATFORM'`.
3. `ledger.account_balances`: `account_id text COLLATE "C" PRIMARY KEY`, `ledger_id`, `normal_side`, `debit_total_minor bigint NOT NULL DEFAULT 0 CHECK (>= 0)`, `credit_total_minor bigint NOT NULL DEFAULT 0 CHECK (>= 0)`, `normal_balance_minor bigint NOT NULL DEFAULT 0`, `version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)`, `updated_at timestamptz NOT NULL DEFAULT clock_timestamp()`; FK `(ledger_id, account_id, normal_side) REFERENCES ledger.accounts (ledger_id, id, normal_side)`; `CHECK (normal_balance_minor = CASE normal_side WHEN 'DEBIT' THEN debit_total_minor - credit_total_minor ELSE credit_total_minor - debit_total_minor END)`.
4. Triggers (functions `ledger.trg_*`, owner `ledger_function_owner`, fixed `search_path = pg_catalog`; they fire for every role including the table owner):
   - `accounts_guard` BEFORE UPDATE: reject (`LEDGER_INVARIANT_VIOLATION`, rule `ACCOUNT_IMMUTABLE`) any change to any column except `status`/`closed_at`; only `OPEN → CLOSED` with nonnull `closed_at` is allowed (one-way, rule `ACCOUNT_CLOSE_ONE_WAY`). docs/07 permits changes before the first posting; this task forbids them always (stricter, simpler).
   - `accounts_no_delete` BEFORE DELETE and `accounts_no_truncate` BEFORE TRUNCATE (statement): raise rule `ACCOUNT_IMMUTABLE`.
   - `accounts_require_balance`: `CREATE CONSTRAINT TRIGGER ... AFTER INSERT ON ledger.accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW` raising rule `ACCOUNT_WITHOUT_BALANCE` when no `account_balances` row exists for `NEW.id` at commit.
   - `account_balances_guard` BEFORE UPDATE: reject changes to `account_id`, `ledger_id`, `normal_side` (rule `BALANCE_IDENTITY_IMMUTABLE`); BEFORE DELETE / BEFORE TRUNCATE: raise rule `BALANCE_IMMUTABLE`.
5. `ledger.create_account(p_ledger_id text, p_owner_type text, p_owner_id text, p_logical_code text, p_bucket_index smallint, p_bucket_count smallint, p_account_class text, p_allow_negative boolean, p_merchant_postable boolean) RETURNS text` — `SECURITY DEFINER`, `SET search_path = pg_catalog, ledger`, owner `ledger_function_owner`. Reads the ledger's currency, derives `normal_side` and `code`, inserts the account with `ledger.generate_id('lac')` and status `OPEN`, inserts its zeroed `account_balances` row, returns the account ID. Constraint violations propagate unchanged.
6. View `ledger.logical_account_balances` (owner `fl_migration_owner`, `security_barrier`):
   ```sql
   SELECT a.ledger_id, a.owner_type, a.owner_id, a.logical_code, a.currency, a.normal_side,
          count(*)::integer AS bucket_rows,
          sum(b.debit_total_minor)::numeric AS debit_total_minor,
          sum(b.credit_total_minor)::numeric AS credit_total_minor,
          sum(b.normal_balance_minor)::numeric AS normal_balance_minor
   FROM ledger.accounts a JOIN ledger.account_balances b ON b.account_id = a.id
   GROUP BY a.ledger_id, a.owner_type, a.owner_id, a.logical_code, a.currency, a.normal_side;
   ```
   (`numeric` sums cannot overflow; consumers convert with `BigInt`.)
7. Grants (last): `REVOKE ALL ON ledger.ledgers, ledger.accounts, ledger.account_balances, ledger.logical_account_balances FROM PUBLIC` and from every runtime role in CONVENTIONS §7; `GRANT SELECT ON ledger.ledgers, ledger.accounts TO ledger_function_owner`; `GRANT INSERT, UPDATE ON ledger.accounts TO ledger_function_owner`; `GRANT SELECT, INSERT, UPDATE ON ledger.account_balances TO ledger_function_owner`; `GRANT SELECT ON ledger.ledgers, ledger.accounts, ledger.account_balances, ledger.logical_account_balances TO fl_operator_readonly`; `REVOKE ALL ON FUNCTION ledger.create_account(...) FROM PUBLIC; GRANT EXECUTE ... TO fl_migration_owner`. No grant to `fl_api` (striped platform buckets are never merchant-readable, docs/07 §Tenant isolation item 7).

**Expected behavior** — `create_account(led, 'PLATFORM', NULL, 'platform.fee_revenue', 3, 32, 'REVENUE', true, true)` → account with `code = 'platform.fee_revenue.03'`, `normal_side = 'CREDIT'`, and a balance row with version 0. A direct `INSERT INTO ledger.accounts` by `fl_migration_owner` without a balance row fails at `COMMIT` with rule `ACCOUNT_WITHOUT_BALANCE`.

**Acceptance criteria**
- [ ] Every docs/07 check listed above rejects an invalid direct insert (one negative test per check).
- [ ] A merchant-owned account with nonnull `bucket_index` is rejected.
- [ ] `code` disagreeing with `logical_code`/`bucket_index` is rejected.
- [ ] `bucket_index = bucket_count` and `bucket_count = 0` are rejected; `bucket_count = 100, bucket_index = 99` accepted.
- [ ] Account update of any immutable column, account delete/truncate, balance delete/truncate fail even as `fl_migration_owner`.
- [ ] `OPEN → CLOSED` with `closed_at` succeeds; `CLOSED → OPEN` fails.
- [ ] Account inserted without a balance row fails at commit; via `create_account` succeeds.
- [ ] `fl_api` and every other runtime role (except `fl_operator_readonly`) get `42501` on `SELECT` from the four relations.

**Testing requirements** — `test/integration/ledger/accounts.test.ts`, run on a fresh fixture database. Fixture creates a ledger row directly as `fl_migration_owner` (`INSERT INTO ledger.ledgers` is allowed to the table owner) and a merchant through the P02 builder. Cases: one negative per check (assert SQLSTATE `23514`/`23505`/`23503` and the constraint name), trigger rejections (assert `P0001` + rule in `DETAIL`), deferred trigger at commit, `create_account` positive for striped and unstriped, the role-privilege matrix looping over every role in CONVENTIONS §7 via `SET ROLE`. Boundary: `bucket_count` 1 and 100. Command: `pnpm vitest run --project integration test/integration/ledger/accounts.test.ts`.

**Non-goals** — No seed data (T03). No journal tables (T04). No account-closing function (closing is exercised in tests through a named fixture helper; an audited close command is P11).

**Handoff checklist**
- [ ] Removing the code-derivation check was observed to fail its test, then restored.
- [ ] Grants last; `pnpm check` and `pnpm test:integration` green.

---

### P03-T03 — Ledger seed: striped platform buckets at the configured bucket count, merchant accounts, N=1/N=32 fixture

**Task ID:** `P03-T03`
**Feature:** Striped bucket seed
**Commit:** `feat(ledger): seed ledger and striped platform buckets from ledger_bucket_count`
**Priority:** Critical
**Dependencies:** `P03-T02`
**Estimated complexity:** M
**Contract references:** docs/07 §Striped platform accounts, §Migration order step 18, §Schema acceptance tests (striped rows); docs/02 §Ledger account (initial account types), §MVP implementation decisions (Bucket count); ADR-0010; CONVENTIONS §8
**Files:** create: `migrations/0320_ledger_seed.sql`, `packages/testkit/src/ledger.ts`, `packages/database/src/functions/ledger.ts`, `test/integration/ledger/seed.test.ts`; modify: `packages/testkit/src/index.ts`, the P02 dev-seed implementation in `apps/cli` (the file that implements `flowledger seed --profile dev`); must not touch: `migrations/0300*`, `migrations/0310*`, `packages/database/src/migrate.ts` (P02-owned; already sets both GUCs)

**Objective** — Seed the one ledger and its platform accounts, with `processor_receivable` and `fee_revenue` striped into exactly N buckets where N comes from `flowledger.ledger_bucket_count`; provide merchant clearing/payable creation; and give tests a way to build a database at any N.

**Implementation instructions**
1. `migrations/0320_ledger_seed.sql`:
   - Function `ledger.open_merchant_accounts(p_merchant_id text) RETURNS void`, `SECURITY DEFINER`, `SET search_path = pg_catalog, ledger`, owner `ledger_function_owner`. Idempotent: for each of `merchant.clearing` (`LIABILITY`, `allow_negative = true`) and `merchant.payable` (`LIABILITY`, `allow_negative = false`), create via `ledger.create_account(...)` (merchant_postable `false`, unstriped) unless an account with that `(owner_id, code)` already exists. Uses the single ledger row (raise rule `LEDGER_NOT_SEEDED` if count ≠ 1). Grant EXECUTE to `fl_migration_owner`, `fl_operator_command`; revoke from `PUBLIC`.
   - A `DO $$ ... $$` block:
     ```sql
     n := coalesce(nullif(current_setting('flowledger.ledger_bucket_count', true), ''), '32');
     IF n !~ '^[0-9]{1,3}$' OR n::int NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'flowledger.ledger_bucket_count must be 1..100, got %', n; END IF;
     env := coalesce(nullif(current_setting('flowledger.ledger_environment', true), ''), 'LOCAL');
     IF env NOT IN ('LOCAL','SANDBOX') THEN RAISE EXCEPTION 'flowledger.ledger_environment must be LOCAL or SANDBOX, got %', env; END IF;
     INSERT INTO ledger.ledgers (id, legal_entity_code, environment, currency)
       VALUES (ledger.generate_id('led'), 'FLOWLEDGER_PLATFORM', env, 'USD') RETURNING id INTO led;
     FOR i IN 0 .. n::int - 1 LOOP
       PERFORM ledger.create_account(led, 'PLATFORM', NULL, 'platform.processor_receivable', i::smallint, n::smallint, 'ASSET', true, true);
       PERFORM ledger.create_account(led, 'PLATFORM', NULL, 'platform.fee_revenue', i::smallint, n::smallint, 'REVENUE', true, true);
     END LOOP;
     PERFORM ledger.create_account(led, 'PLATFORM', NULL, 'platform.rounding_expense', NULL, NULL, 'EXPENSE', true, true);
     PERFORM ledger.create_account(led, 'PLATFORM', NULL, 'platform.rounding_revenue', NULL, NULL, 'REVENUE', true, true);
     PERFORM ledger.open_merchant_accounts(m.id) FROM identity.merchants m;
     ```
     `legal_entity_code 'FLOWLEDGER_PLATFORM'` is **[ASSUMPTION]** (risk R-09); `environment` comes from GUC `flowledger.ledger_environment` (set by the P02 runner from `LEDGER_ENVIRONMENT`, default `LOCAL`, CONVENTIONS §8). `fee_revenue` uses `allow_negative = true` **[ASSUMPTION]** (docs/02 table says "allowed through explicit adjustments", which a single boolean cannot express; risk R-07). The rounding pair is the docs/02 "expense or revenue pair" (risk R-07).
2. Bucket count and environment come from the P02 runner (`migrate({ connectionString, ledgerBucketCount, ledgerEnvironment? })`, P02-T01), which sets `flowledger.ledger_bucket_count` and `flowledger.ledger_environment` before each file; this task does not modify the runner. The seed's own 1..100 check above is stricter than the runner's range (two-digit physical code suffix).
3. `packages/testkit/src/ledger.ts` (new):
   ```ts
   export interface LedgerTestDb { url: string; pool: Pool; bucketCount: number; ledgerId: string; drop(): Promise<void> }
   export async function createLedgerDatabase(opts: { bucketCount: number }): Promise<LedgerTestDb>;
   export async function ledgerAccounts(pool: Pool, merchantId?: string): Promise<{
     ledgerId: string;
     receivable: string[];   // index = bucket_index
     feeRevenue: string[];
     roundingExpense: string; roundingRevenue: string;
     merchantClearing?: string; merchantPayable?: string;
   }>;
   ```
   `createLedgerDatabase` uses the P02 Testcontainers container (the shared container exported by the P02 fixture), runs `CREATE DATABASE fl_n<bucketCount>_<8 hex chars>` as the container superuser, runs the P02 migration runner with `{ ledgerBucketCount: opts.bucketCount }`, and returns a pool connected as the container superuser. `drop()` ends the pool and drops the database. Tests that need N=1 call `createLedgerDatabase({ bucketCount: 1 })`; tests that need N=32 call `createLedgerDatabase({ bucketCount: 32 })`. The default P02 fixture database is N=32 because `LEDGER_BUCKET_COUNT` is unset in test (CONVENTIONS §8 default). Re-export from `packages/testkit/src/index.ts`.
4. `packages/database/src/functions/ledger.ts` (new): `export async function openMerchantAccounts(client: PoolClient, merchantId: MerchantId): Promise<void>` calling `SELECT ledger.open_merchant_accounts($1)`.
5. P02 dev seed: after each merchant is created, call `openMerchantAccounts(client, merchantId)` in the same transaction.

**Expected behavior** — With env unset: 32 rows `platform.processor_receivable.00` … `.31` and 32 `platform.fee_revenue.NN`, each with `bucket_count = 32`. With `ledgerBucketCount: 1`: one row `platform.processor_receivable.00` (`bucket_index 0`, `bucket_count 1`). With `LEDGER_BUCKET_COUNT=0` the migration fails with the GUC message and nothing is applied.

**Acceptance criteria**
- [ ] At N=1 and N=32 each striped logical account has exactly N rows numbered contiguously `0..N-1`, all with `bucket_count = N`, all `merchant_postable = true`.
- [ ] Every physical `code` equals `logical_code || '.' || lpad(bucket_index, 2, '0')`.
- [ ] Each balance row exists with zero totals and version 0.
- [ ] `open_merchant_accounts` is idempotent (second call creates nothing), creates clearing with `allow_negative = true` and payable with `allow_negative = false`.
- [ ] Merchants created before migration 0320 receive accounts from the migration; merchants created by `flowledger seed --profile dev` receive them from the seed.
- [ ] Bucket count 0 and 101 abort the migration.
- [ ] Ledger `environment` is `LOCAL` when `LEDGER_ENVIRONMENT` is unset and `SANDBOX` when the runner is called with `ledgerEnvironment: 'SANDBOX'`.

**Testing requirements** — `test/integration/ledger/seed.test.ts`: `createLedgerDatabase({ bucketCount: 1 })` and `({ bucketCount: 32 })` — assert completeness/contiguity/code derivation per logical account (query `array_agg(bucket_index ORDER BY bucket_index) = array(SELECT generate_series(0, N-1))`); `createLedgerDatabase({ bucketCount: 0 })` rejects; `open_merchant_accounts` twice → 2 accounts; `fl_api` cannot execute it (`42501`). Command: `pnpm vitest run --project integration test/integration/ledger/seed.test.ts`.

**Non-goals** — No rebalancing migration for a changed N. No merchant onboarding API. No account-template table (the template is the code in `open_merchant_accounts`).

**Handoff checklist**
- [ ] Changing the loop bound to `n - 2` was observed to fail the contiguity test, then restored.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P03-T04 — Journal transactions and entries: constraints, immutability, deferred balance check, RLS, grants

**Task ID:** `P03-T04`
**Feature:** Immutable journal storage
**Commit:** `feat(ledger): add journal_transactions and journal_entries with immutability`
**Priority:** Critical
**Dependencies:** `P03-T02`
**Estimated complexity:** M
**Contract references:** docs/07 §ledger.journal_transactions, §ledger.journal_entries, §Tenant isolation, §Mutability rules, §Migration order step 11; docs/02 §Journal transaction, §Ledger entry, §Immutability, §Database enforcement; ADR-0007
**Files:** create: `migrations/0330_ledger_journal.sql`, `test/integration/ledger/journal-tables.test.ts`; modify: none; must not touch: `migrations/0300*`–`0320*`

**Objective** — Create insert-only journal tables whose rows no runtime role can write, and that reject an unbalanced transaction at commit even for the table owner.

**Implementation instructions**
1. `ledger.journal_transactions` with docs/07 columns: `id` (`^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$`), `ledger_id`, `merchant_id NOT NULL`, `posting_key text COLLATE "C" NOT NULL CHECK (length(posting_key) BETWEEN 1 AND 255)`, `financial_hash bytea NOT NULL CHECK (octet_length(financial_hash) = 32)`, `operation_type`, `currency CHECK (currency = 'USD')`, `payment_id`, `payment_operation_id`, `correlation_id CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{16,128}$')`, `causation_id CHECK (length(causation_id) BETWEEN 1 AND 128)`, `reversal_of_transaction_id`, `metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object')`, `recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()`.
   Constraints:
   - `PRIMARY KEY (id)`; `UNIQUE (id, ledger_id, currency)`; `UNIQUE (ledger_id, posting_key)` named `journal_transactions_posting_key`.
   - FK `(ledger_id, currency) REFERENCES ledger.ledgers (id, currency)`; FK `merchant_id REFERENCES identity.merchants (id)`.
   - `CHECK (operation_type IN ('CAPTURE','REFUND','SETTLEMENT','REVERSAL','ADJUSTMENT'))`.
   - `CHECK ((operation_type IN ('CAPTURE','REFUND')) = (payment_operation_id IS NOT NULL))`; `CHECK (operation_type NOT IN ('CAPTURE','REFUND') OR payment_id IS NOT NULL)`; `CHECK (operation_type <> 'SETTLEMENT' OR payment_id IS NULL)`; `CHECK ((operation_type = 'REVERSAL') = (reversal_of_transaction_id IS NOT NULL))`; `CHECK (reversal_of_transaction_id IS DISTINCT FROM id)`.
   - FK `(merchant_id, payment_id) REFERENCES payments.payments (merchant_id, id)`; FK `(merchant_id, payment_id, payment_operation_id) REFERENCES payments.payment_operations (merchant_id, payment_id, id)` (tenant- and payment-safe; MATCH SIMPLE so it applies only when all are nonnull).
   - FK `(reversal_of_transaction_id, ledger_id, currency) REFERENCES ledger.journal_transactions (id, ledger_id, currency)`.
   - `CREATE UNIQUE INDEX journal_transactions_one_per_operation ON ledger.journal_transactions (payment_operation_id) WHERE payment_operation_id IS NOT NULL`; `CREATE UNIQUE INDEX journal_transactions_one_reversal ON ledger.journal_transactions (reversal_of_transaction_id) WHERE reversal_of_transaction_id IS NOT NULL`; indexes `(merchant_id, recorded_at DESC, id)`, `(payment_id, recorded_at, id)`.
2. `ledger.journal_entries`: `transaction_id`, `entry_ordinal smallint CHECK (entry_ordinal > 0)`, `ledger_id`, `currency CHECK (= 'USD')`, `account_id`, `side CHECK (side IN ('DEBIT','CREDIT'))`, `amount_minor bigint CHECK (amount_minor BETWEEN 1 AND 1000000000000)`; `PRIMARY KEY (transaction_id, entry_ordinal)`; FK `(transaction_id, ledger_id, currency) REFERENCES ledger.journal_transactions (id, ledger_id, currency)`; FK `(ledger_id, account_id, currency) REFERENCES ledger.accounts (ledger_id, id, currency)`; index `(account_id, transaction_id)`.
3. Triggers (fire for every role):
   - `journal_transactions_immutable` / `journal_entries_immutable`: BEFORE UPDATE OR DELETE FOR EACH ROW and BEFORE TRUNCATE FOR EACH STATEMENT → `LEDGER_INVARIANT_VIOLATION` rule `JOURNAL_IMMUTABLE`.
   - `journal_transactions_balanced`: `CREATE CONSTRAINT TRIGGER ... AFTER INSERT ON ledger.journal_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW` → at commit, for `NEW.id`, require ≥ 2 entries, ≥ 2 distinct accounts, `sum(DEBIT) = sum(CREDIT)`; else rule `JOURNAL_UNBALANCED_AT_COMMIT`. This is defense in depth under the posting routine (T06), which raises earlier with specific rules.
4. RLS: `ALTER TABLE ledger.journal_transactions ENABLE ROW LEVEL SECURITY`; policies: `journal_transactions_tenant` `FOR SELECT TO fl_api USING (merchant_id = current_setting('app.merchant_id', true))`; `journal_transactions_operator` `FOR SELECT TO fl_operator_readonly USING (true)`; `journal_transactions_function_owner` `FOR ALL TO ledger_function_owner USING (true) WITH CHECK (true)`. `journal_entries` has no merchant grant (internal child, docs/07 §Tenant isolation item 2).
5. Grants (last): revoke all on both tables from `PUBLIC` and every runtime role; `GRANT SELECT, INSERT ON ledger.journal_transactions, ledger.journal_entries TO ledger_function_owner`; `GRANT SELECT ON ledger.journal_transactions, ledger.journal_entries TO fl_operator_readonly`; `GRANT SELECT (id, merchant_id, payment_id, payment_operation_id, operation_type, currency, recorded_at) ON ledger.journal_transactions TO fl_api`.

**Expected behavior** — As `fl_migration_owner`, inserting a header plus one entry and committing fails with rule `JOURNAL_UNBALANCED_AT_COMMIT`; inserting a balanced two-entry transaction succeeds (owner only), after which `UPDATE`/`DELETE`/`TRUNCATE` fail with rule `JOURNAL_IMMUTABLE`. `fl_api` with `app.merchant_id` set to merchant A sees only A's headers; with no setting sees zero rows.

**Acceptance criteria**
- [ ] `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` on both tables fail with `42501` for every runtime role in CONVENTIONS §7 (loop via `SET ROLE`).
- [ ] `UPDATE`, `DELETE`, `TRUNCATE` fail with rule `JOURNAL_IMMUTABLE` for `fl_migration_owner`.
- [ ] Each docs/07 check/FK/unique rejects an invalid direct owner insert (operation-type/reference shape, self-reversal, cross-tenant payment operation, duplicate posting key, second reversal of one target, second transaction for one operation, non-positive and > 1e12 entry amounts).
- [ ] Deferred balanced trigger rejects zero-entry, one-entry, single-account, and unbalanced transactions at commit.
- [ ] RLS: cross-tenant header invisible to `fl_api`; missing `app.merchant_id` sees none.

**Testing requirements** — `test/integration/ledger/journal-tables.test.ts`, using owner-direct inserts in a fixture helper named `insertJournalRowsAsOwner` local to the test file (direct table mutation is allowed only in constraint tests, docs/10 §Financial safety). Payment/operation rows from the P02 builders (two merchants). Assert SQLSTATE + constraint name or rule. Command: `pnpm vitest run --project integration test/integration/ledger/journal-tables.test.ts`.

**Non-goals** — No posting function (T06). No settlement FK (P10).

**Handoff checklist**
- [ ] Dropping the deferred trigger was observed to fail the unbalanced-at-commit test, then restored.
- [ ] Grants last; `pnpm check` and `pnpm test:integration` green.

---

### P03-T05 — Canonical line combination and database-computed posting hash with shared golden vectors

**Task ID:** `P03-T05`
**Feature:** Canonical posting hash in SQL
**Commit:** `feat(ledger): add canonicalize_lines and posting_hash with golden vectors`
**Priority:** Critical
**Dependencies:** `P03-T01`, `P01-GATE`
**Estimated complexity:** M
**Contract references:** docs/07 §ledger.journal_entries (canonicalization/hash paragraph); docs/02 §Idempotent posting; ADR-0007 (golden vectors in both languages); docs/10 §M1 (ledger posting hash vectors)
**Files:** create: `migrations/0340_ledger_posting_hash.sql`, `test/integration/ledger/posting-hash.test.ts`; modify: none; must not touch: `packages/domain/**`

**Objective** — Compute the canonical financial hash inside PostgreSQL so the posting routine never trusts a caller-supplied hash, and prove it equals the P01 TypeScript implementation on the same golden vectors.

**Implementation instructions**
1. Types: `CREATE TYPE ledger.posting_line AS (account_id text, side text, amount_minor bigint)`; `CREATE TYPE ledger.canonical_line AS (entry_ordinal smallint, account_id text, side text, amount_minor bigint)`.
2. `ledger.canonicalize_lines(p_lines ledger.posting_line[]) RETURNS ledger.canonical_line[]`, IMMUTABLE, `search_path = pg_catalog, ledger`:
   - Reject (`LEDGER_INVARIANT_VIOLATION`) null/empty array (rule `ENTRY_COUNT`), any `account_id !~ '^lac_[0-7][0-9A-HJKMNP-TV-Z]{25}$'` (`INVALID_ACCOUNT_ID`), `side NOT IN ('DEBIT','CREDIT')` (`INVALID_SIDE`), `amount_minor IS NULL OR amount_minor < 1` (`NON_POSITIVE_AMOUNT`), `amount_minor > 1000000000000` (`AMOUNT_RANGE`).
   - Combine duplicate `(account_id, side)` by summing in `numeric`; a combined amount > 1000000000000 raises `AMOUNT_RANGE`.
   - Order by `account_id COLLATE "C"`, then `CASE side WHEN 'DEBIT' THEN 0 ELSE 1 END`; assign `entry_ordinal` 1..n with `row_number()`.
3. `ledger.posting_hash(p_ledger_id text, p_merchant_id text, p_payment_id text, p_payment_operation_id text, p_reversal_of_transaction_id text, p_correction_request_id text, p_operation_type text, p_currency text, p_lines ledger.canonical_line[]) RETURNS bytea`, IMMUTABLE:
   ```sql
   SELECT sha256(convert_to(ledger.jcs(jsonb_build_object(
     'hashVersion', 1, 'recipeVersion', 1,
     'ledgerId', p_ledger_id, 'merchantId', p_merchant_id,
     'paymentId', p_payment_id, 'paymentOperationId', p_payment_operation_id,
     'reversalOfTransactionId', p_reversal_of_transaction_id,
     'correctionRequestId', p_correction_request_id,
     'operationType', p_operation_type, 'currency', p_currency,
     'entries', (SELECT jsonb_agg(jsonb_build_object('accountId', l.account_id, 'side', l.side,
                   'amountMinor', l.amount_minor::text, 'ordinal', l.entry_ordinal) ORDER BY l.entry_ordinal)
                 FROM unnest(p_lines) l))), 'UTF8'));
   ```
   Null references serialize as JSON `null` (keys are always present). This object is the canonical definition for both languages; it must equal the object P01's `computePostingHash` hashes. If P01's object differs in any key or value form, stop: `BLOCKED: P03-T05 — ledger hash object differs from P01 — docs/07 §ledger.journal_entries` (risk R-01).
4. Ownership `ledger_function_owner`; revoke EXECUTE from `PUBLIC`; no runtime grants.

**Expected behavior** — Anchor vector V1 (JCS bytes):
```text
{"correctionRequestId":null,"currency":"USD","entries":[{"accountId":"lac_01ARZ3NDEKTSV4RRFFQ69G5FB1","amountMinor":"10000","ordinal":1,"side":"DEBIT"},{"accountId":"lac_01ARZ3NDEKTSV4RRFFQ69G5FB2","amountMinor":"9700","ordinal":2,"side":"CREDIT"},{"accountId":"lac_01ARZ3NDEKTSV4RRFFQ69G5FB3","amountMinor":"300","ordinal":3,"side":"CREDIT"}],"hashVersion":1,"ledgerId":"led_01ARZ3NDEKTSV4RRFFQ69G5FA1","merchantId":"mer_01ARZ3NDEKTSV4RRFFQ69G5FAZ","operationType":"CAPTURE","paymentId":"pay_01ARZ3NDEKTSV4RRFFQ69G5FAV","paymentOperationId":"op_01ARZ3NDEKTSV4RRFFQ69G5FAX","recipeVersion":1,"reversalOfTransactionId":null}
```
SHA-256 = `df092e45ff17fe25df2a20747cef1150d4fc93ff1f9e0c9d8c1a1186cff22efa`. V2 (same but entry amounts `10001`/`9701`/`300`) = `ae23abcc6df3c3f2d25180d9e36b5a91a924f0317b836f05a2a929945bfe1025` — note V2 is unbalanced; the hash function does not check balance. V3: V1's lines supplied in reverse order → V1 digest. V4: V1 with the 10000 debit split into 6000 + 4000 debit lines → V1 digest. V5: a line set with the same account on both sides (`A DEBIT 5`, `A CREDIT 3`, `B CREDIT 2`) keeps two lines for `A` with `DEBIT` ordinal 1 before `CREDIT` ordinal 2.

**Acceptance criteria**
- [ ] V1, V2 digests match exactly; V3 and V4 equal V1; V5 ordering as stated.
- [ ] Every vector in P01's checked-in ledger posting-hash vector file produces the identical digest in SQL.
- [ ] Changing any of account, side, amount, currency, operation type, merchant, payment, operation, reversal, or correction reference changes the digest (one case each).
- [ ] Invalid lines raise the listed rules.

**Testing requirements** — `test/integration/ledger/posting-hash.test.ts`: V1–V5; iterate P01's vector file (import path from `P01-GATE`) calling `ledger.canonicalize_lines` then `ledger.posting_hash` as `ledger_function_owner` (`SET ROLE`); fast-check property (300 runs): random line sets → SQL digest equals P01 `computePostingHash` digest, and digest is invariant under shuffling input lines. Command: `pnpm vitest run --project integration test/integration/ledger/posting-hash.test.ts`.

**Non-goals** — No posting. No change to P01 code.

**Handoff checklist**
- [ ] Swapping the side ordering (`CREDIT` first) was observed to fail V1 and V5, then restored.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P03-T06 — Private canonical posting routine `ledger.post_journal_internal` and owner harness

**Task ID:** `P03-T06`
**Feature:** Canonical posting primitive
**Commit:** `feat(ledger): add private post_journal_internal with locking, balances, and outbox`
**Priority:** Critical
**Dependencies:** `P03-T03`, `P03-T04`, `P03-T05`
**Estimated complexity:** L
**Contract references:** docs/07 §Protected posting function (internal routine steps 1–9), §ledger.account_balances, §Transaction and lock ownership (canonical lock order); docs/02 §Posting invariants, §Idempotent posting, §Concurrency, §Balance semantics; docs/04 §Envelope; `schemas/events/ledger-transaction-posted.v1.schema.json`; ADR-0005, ADR-0007
**Files:** create: `migrations/0350_ledger_post_journal.sql`, `test/integration/ledger/post-journal.test.ts`; modify: `packages/testkit/src/ledger.ts`, `packages/database/src/errors.ts`; must not touch: `migrations/0300*`–`0340*`

**Objective** — Implement the single routine through which every journal transaction is created: it validates, claims the posting key idempotently, locks balance rows in ascending account-ID order, enforces balance policies, inserts entries, updates the projection, and inserts exactly one `ledger.transaction.posted.v1` outbox envelope — all in the caller's transaction.

**Implementation instructions**
1. Signature (owner `ledger_function_owner`, `SECURITY DEFINER`, `SET search_path = pg_catalog, ledger, messaging`, no dynamic SQL):
   ```sql
   CREATE FUNCTION ledger.post_journal_internal(
     p_transaction_id text, p_posting_key text, p_operation_type text,
     p_ledger_id text, p_merchant_id text, p_currency text,
     p_payment_id text, p_payment_operation_id text,
     p_reversal_of_transaction_id text, p_correction_request_id text,
     p_correlation_id text, p_causation_id text, p_metadata jsonb,
     p_lines ledger.posting_line[], p_envelope_id uuid,
     p_allow_closed_accounts boolean
   ) RETURNS text
   ```
   `REVOKE ALL ON FUNCTION ... FROM PUBLIC`; grant EXECUTE to **no** role. Later entry points owned by `ledger_function_owner` call it as owner.
2. Steps, in this order (all errors `MESSAGE = 'LEDGER_INVARIANT_VIOLATION'` with `DETAIL` rule unless stated):
   1. Scalar validation: `p_transaction_id` `ltx_` regex (`INVALID_TRANSACTION_ID`); `p_currency = 'USD'` (`CURRENCY_MISMATCH`); `p_merchant_id` nonnull (`MERCHANT_REQUIRED`); `p_operation_type` in the five types (`OPERATION_TYPE`); ledger exists and its currency equals `p_currency` (`LEDGER_MISMATCH`).
   2. `v_lines := ledger.canonicalize_lines(p_lines)`; require `cardinality ≥ 2` (`ENTRY_COUNT`), ≥ 2 distinct accounts (`DISTINCT_ACCOUNTS`), `sum(DEBIT) = sum(CREDIT)` (`UNBALANCED`), `sum(DEBIT) ≤ 1000000000000` (`AMOUNT_RANGE`; keeps `totalDebitsMinor` within the event schema).
   3. Read every referenced account (no lock yet): missing → `ACCOUNT_NOT_FOUND`; `ledger_id <> p_ledger_id` → `LEDGER_MISMATCH`; `currency <> p_currency` → `CURRENCY_MISMATCH`; `owner_type = 'MERCHANT' AND owner_id <> p_merchant_id` → `CROSS_MERCHANT`; `owner_type = 'PLATFORM' AND NOT merchant_postable` → `PLATFORM_NOT_POSTABLE`; `status = 'CLOSED' AND NOT p_allow_closed_accounts` → `ACCOUNT_CLOSED`. A posting may touch zero or one merchant (**[ASSUMPTION]**: docs/02 says "exactly one merchant", but a capture whose fee equals gross has no merchant line; risk R-10).
   4. If `p_operation_type = 'REVERSAL'`: load the target header; require it exists, `operation_type <> 'REVERSAL'` (`REVERSAL_OF_REVERSAL`), same `merchant_id` (`CROSS_MERCHANT`), `payment_id IS NOT DISTINCT FROM p_payment_id` (`REVERSAL_SCOPE_MISMATCH`); require `v_lines` equals the target's entries with sides swapped, compared as sets of `(account_id, side, amount_minor)` (`REVERSAL_MISMATCH`).
   5. `v_hash := ledger.posting_hash(p_ledger_id, p_merchant_id, p_payment_id, p_payment_operation_id, p_reversal_of_transaction_id, p_correction_request_id, p_operation_type, p_currency, v_lines)`.
   6. Replay check: `SELECT id, financial_hash FROM ledger.journal_transactions WHERE ledger_id = p_ledger_id AND posting_key = p_posting_key`. Found and equal hash → `RETURN` that id (no entries, balances, or outbox). Found and different → `RAISE ... MESSAGE = 'IDEMPOTENCY_CONFLICT', DETAIL = '{"scope":"ledger_posting","postingKey":"…","existingTransactionId":"…"}'`.
   7. Pre-check unique boundaries: an existing header with `payment_operation_id = p_payment_operation_id` → `DUPLICATE_OPERATION_POSTING`; with `reversal_of_transaction_id = p_reversal_of_transaction_id` → `DUPLICATE_REVERSAL`.
   8. Claim: `INSERT INTO ledger.journal_transactions (...) VALUES (...) ON CONFLICT (ledger_id, posting_key) DO NOTHING RETURNING id, recorded_at`. If no row: re-run step 6's select (the concurrent owner has committed by now under READ COMMITTED) and return or raise exactly as step 6. A concurrent claim racing on a different unique index (operation/reversal) surfaces as SQLSTATE `23505`; this is acceptable because a correct caller derives one posting key per operation/reversal.
   9. Lock: `FOR v_acct IN SELECT DISTINCT account_id FROM unnest(v_lines) ORDER BY account_id COLLATE "C" LOOP SELECT ... FROM ledger.account_balances WHERE account_id = v_acct FOR UPDATE; END LOOP;` — one row at a time in ascending binary order (docs/07 lock order).
   10. For each account compute aggregated deltas `d = Σ DEBIT`, `c = Σ CREDIT`; new totals; new normal balance per `normal_side`; if `NOT allow_negative AND new_normal < 0` → `NEGATIVE_PROTECTED_BALANCE` with `DETAIL` including `accountId`. Bigint overflow surfaces as SQLSTATE `22003`.
   11. Insert entries from `v_lines` with their ordinals; `UPDATE ledger.account_balances SET debit_total_minor, credit_total_minor, normal_balance_minor, version = version + 1, updated_at = v_recorded_at` once per account.
   12. Build and insert the envelope via `PERFORM messaging.insert_outbox(v_env)` where:
       ```json
       {"id": p_envelope_id, "kind":"EVENT", "type":"ledger.transaction.posted.v1", "schemaVersion":1,
        "source":"flowledger.ledger", "occurredAt": T, "recordedAt": T,
        "merchantId": p_merchant_id, "aggregateType":"ledger_transaction", "aggregateId": tx_id,
        "aggregateVersion":1, "orderingKey": tx_id, "correlationId": p_correlation_id, "causationId": p_causation_id,
        "data": {"ledgerTransactionId": tx_id, "paymentId": p_payment_id|null, "paymentOperationId": p_payment_operation_id|null,
                 "postingKey": p_posting_key, "operationType": p_operation_type, "currency":"USD",
                 "entryCount": n, "totalDebitsMinor": "<decimal>", "totalCreditsMinor": "<decimal>", "recordedAt": T}}
       ```
       `T = to_char(v_recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`. `source` value is **[ASSUMPTION]** (risk R-11). `settlementBatchId` is omitted (optional in the schema); P10 adds it for `SETTLEMENT` (risk R-12).
   13. `RETURN` the new transaction ID.
3. Grants in the same file (last): `GRANT EXECUTE ON FUNCTION messaging.insert_outbox(jsonb) TO ledger_function_owner` (requires `fl_migration_owner` membership in `messaging_function_owner`, provided by P02's role migration; if P02 already granted it the statement is a no-op). If `messaging.insert_outbox` checks its invoker role, it must accept `ledger_function_owner` (risk R-13).
4. `packages/database/src/errors.ts`: add `LEDGER_INVARIANT_VIOLATION` to the `DomainError` code union (DETAIL parsed into `detail.rule`). Not mapped to any HTTP problem; if it ever reaches the API it maps to `500 INTERNAL_ERROR`.
5. `packages/testkit/src/ledger.ts`: add
   ```ts
   export interface PostJournalInput { transactionId?: string; postingKey: string; operationType: 'CAPTURE'|'REFUND'|'SETTLEMENT'|'REVERSAL'|'ADJUSTMENT';
     ledgerId: string; merchantId: string; paymentId?: string; paymentOperationId?: string; reversalOfTransactionId?: string;
     correctionRequestId?: string; correlationId?: string; causationId?: string;
     lines: { accountId: string; side: 'DEBIT'|'CREDIT'; amountMinor: bigint }[]; envelopeId?: string; allowClosedAccounts?: boolean }
   export async function postJournalAsOwner(client: PoolClient, input: PostJournalInput): Promise<string>;
   ```
   It runs `SET LOCAL ROLE ledger_function_owner` on a superuser client inside the caller's open transaction and calls `ledger.post_journal_internal` (the "migration-owner integration harness" of docs/10 §M3). Defaults: new `ltx_` via `newId`, `randomUUID()` envelope, correlation `cor_` + 26 chars. Also `closeAccountForTest(client, accountId)` (direct owner `UPDATE ... SET status = 'CLOSED', closed_at = now()`).

**Expected behavior** — Posting `[(clearing CREDIT 9700), (receivable.27 DEBIT 10000), (fee.27 CREDIT 300)]` as `CAPTURE` returns a new `ltx_`; entries have ordinals ordered by account ID; each of the three balance rows has version 1; one outbox row with `message_type = 'ledger.transaction.posted.v1'`, `aggregate_id = ltx`. Re-calling with the same posting key and the same lines (any order, new proposed `ltx_` and envelope) returns the first `ltx_` and changes nothing. Same key with 9701/10001 raises `IDEMPOTENCY_CONFLICT`.

**Acceptance criteria**
- [ ] Rejections, each asserted by `P0001` + `MESSAGE` + `detail.rule` (not a constraint SQLSTATE): unbalanced (`UNBALANCED`), zero lines and one line (`ENTRY_COUNT`), two lines on one account (`DISTINCT_ACCOUNTS`), cross-currency (`CURRENCY_MISMATCH`), cross-ledger using a second fixture ledger (`LEDGER_MISMATCH`), merchant B's clearing in merchant A's posting (`CROSS_MERCHANT`), a platform account with `merchant_postable = false` (`PLATFORM_NOT_POSTABLE`), closed account (`ACCOUNT_CLOSED`) and the same with `allowClosedAccounts = true` succeeds, payable driven below zero (`NEGATIVE_PROTECTED_BALANCE`), non-positive amount (`NON_POSITIVE_AMOUNT`).
- [ ] After every rejection: zero new headers, entries, balance changes, and outbox rows.
- [ ] Clearing may go negative; payable may not.
- [ ] Replay with identical financial content returns the original ID with no new rows; changed account, amount, side, or currency raises `IDEMPOTENCY_CONFLICT`.
- [ ] The outbox envelope validates against `schemas/events/ledger-transaction-posted.v1.schema.json` via the `packages/contracts` Ajv validator and the semantic validator.
- [ ] Every runtime role gets `42501` executing `ledger.post_journal_internal`.
- [ ] Balance version increments exactly once per account per transaction even when an account appears in two combined lines.

**Testing requirements** — `test/integration/ledger/post-journal.test.ts` (default N=32 fixture; merchants A and B with accounts; payment/operation rows from P02 builders for `CAPTURE` headers): every acceptance case; normal-side arithmetic for all five classes using a fixture-created `EQUITY` account (`create_account` as owner); outbox schema validation; execute-privilege matrix. Command: `pnpm vitest run --project integration test/integration/ledger/post-journal.test.ts`.

**Non-goals** — No capture/refund recipe derivation (T07). No concurrency/property suite (T08). No discrepancy event on hash conflict (P07/P08 own the discrepancy path). No `ledger.post_payment_operation` (P07).

**Handoff checklist**
- [ ] Removing the `NEGATIVE_PROTECTED_BALANCE` check was observed to fail its test, then restored.
- [ ] Replacing step 9's sorted loop with unsorted iteration is caught in T08 (note in commit body).
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P03-T07 — Pure capture/refund recipes, fee reversal, and bucket-resolved account lines

**Task ID:** `P03-T07`
**Feature:** Capture/refund posting recipes with golden vectors
**Commit:** `feat(ledger): add capture/refund recipes, fee reversal, and recipe resolution`
**Priority:** High
**Dependencies:** `P03-T06`, `P01-GATE`
**Estimated complexity:** M
**Contract references:** docs/02 §Capture accounting, §Refund accounting, §Capture-fee calculation, §Striped platform accounts; docs/07 §Striped platform accounts, §Protected posting function; ADR-0008, ADR-0010
**Files:** create: `migrations/0360_ledger_recipes.sql`, `test/integration/ledger/recipes.test.ts`; modify: none; must not touch: `migrations/0300*`–`0350*`, `packages/domain/**`

**Objective** — Define, inside the database, the exact capture and refund journal shapes and the proportional fee reversal, so P07's evidence-bound wrapper derives postings from authoritative rows without any caller-chosen accounts, sides, amounts, or buckets.

**Implementation instructions**
1. `CREATE TYPE ledger.recipe_line AS (logical_code text, side text, amount_minor bigint)`.
2. `ledger.capture_recipe(p_gross_minor bigint, p_fee_minor bigint) RETURNS ledger.recipe_line[]` IMMUTABLE: require `1 ≤ G ≤ 1000000000000` (`AMOUNT_RANGE`) and `0 ≤ F ≤ G` (`FEE_OUT_OF_RANGE`; an internal invariant breach, never capped). Return, omitting any zero-amount line: `('platform.processor_receivable','DEBIT',G)`, `('merchant.clearing','CREDIT',G-F)`, `('platform.fee_revenue','CREDIT',F)`.
3. `ledger.refund_recipe(p_refund_minor bigint, p_fee_reversal_minor bigint) RETURNS ledger.recipe_line[]` IMMUTABLE: require `1 ≤ R ≤ 1e12` and `0 ≤ X ≤ R`. Return, omitting zero lines: `('merchant.clearing','DEBIT',R-X)`, `('platform.fee_revenue','DEBIT',X)`, `('platform.processor_receivable','CREDIT',R)`.
4. `ledger.incremental_fee_reversal(p_fee_minor bigint, p_gross_minor bigint, p_confirmed_refunded_minor bigint, p_refund_minor bigint) RETURNS bigint` IMMUTABLE: require `G ≥ 1`, `0 ≤ F ≤ G`, `R0 ≥ 0`, `refund ≥ 1`, `R0 + refund ≤ G` (`FEE_INPUT_RANGE`); return `div(F::numeric * (R0 + refund), G) - div(F::numeric * R0, G)` cast to bigint (floor for nonnegative operands; docs/02 §Refund accounting).
5. `ledger.resolve_recipe(p_ledger_id text, p_merchant_id text, p_payment_id text, p_lines ledger.recipe_line[]) RETURNS ledger.posting_line[]` STABLE, private: for `platform.*` codes select the PLATFORM account(s) with that `logical_code` in the ledger; if striped, require all rows share one `bucket_count` N and that exactly N rows exist (`BUCKET_SET_INCONSISTENT`), then choose `bucket_index = ledger.bucket_for_payment(p_payment_id, N)` (N read from the rows, never from a setting, docs/07); for `merchant.*` codes select the account with `owner_id = p_merchant_id`. Missing account → `ACCOUNT_NOT_FOUND`. A caller cannot choose a bucket.
6. Ownership `ledger_function_owner`; revoke from `PUBLIC`; `GRANT EXECUTE ON FUNCTION ledger.incremental_fee_reversal(bigint,bigint,bigint,bigint) TO payments_function_owner`.

**Expected behavior** — Golden vectors:

| Call | Result |
| --- | --- |
| `capture_recipe(10000, 300)` | receivable DEBIT 10000; clearing CREDIT 9700; fee_revenue CREDIT 300 |
| `capture_recipe(10000, 0)` | receivable DEBIT 10000; clearing CREDIT 10000 |
| `capture_recipe(10000, 10000)` | receivable DEBIT 10000; fee_revenue CREDIT 10000 |
| `capture_recipe(10000, 10001)` | `FEE_OUT_OF_RANGE` |
| `incremental_fee_reversal(300, 10000, 0, 5000)` | 150 |
| `refund_recipe(5000, 150)` | clearing DEBIT 4850; fee_revenue DEBIT 150; receivable CREDIT 5000 |
| `incremental_fee_reversal(333, 1000, 0, 500)` / `(333, 1000, 500, 500)` | 166 / 167 (total 333) |
| `incremental_fee_reversal(333, 1000, 0, 300)` / `(333, 1000, 300, 700)` | 99 / 234 (total 333) |
| `incremental_fee_reversal(333, 1000, 0, 700)` / `(333, 1000, 700, 300)` | 233 / 100 (total 333) |
| `incremental_fee_reversal(0, 1000, 0, 1000)` | 0 |
| `incremental_fee_reversal(1000, 1000, 0, 400)` | 400 |
| `incremental_fee_reversal(300, 10000, 6000, 5000)` | `FEE_INPUT_RANGE` |

For payment `pay_01ARZ3NDEKTSV4RRFFQ69G5FAV` at N=32, `resolve_recipe` maps both platform lines to bucket 27 (`platform.processor_receivable.27`, `platform.fee_revenue.27`); at N=1 to bucket 0.

**Acceptance criteria**
- [ ] Every golden vector above holds.
- [ ] For any F ≤ G and any refund sequence summing to G, Σ `incremental_fee_reversal` = F, every value ≥ 0, and every prefix sum ≤ F (fast-check, 1000 runs, seeded).
- [ ] For any two orderings of the same refund set, per-refund allocations differ by at most 1 (fast-check).
- [ ] SQL `incremental_fee_reversal` equals P01's TypeScript function for 1000 generated inputs.
- [ ] Capture and refund for the same payment resolve to the same bucket index at N=1, 7 (fixture database), and 32.
- [ ] A capture then full refund posted through `resolve_recipe` + `postJournalAsOwner` nets every touched account to zero.

**Testing requirements** — `test/integration/ledger/recipes.test.ts`: golden table; fast-check properties above (persist seed on failure, docs/10 §M1); bucket resolution on `createLedgerDatabase({ bucketCount: 1 })`, `({ bucketCount: 7 })`, and the default N=32; end-to-end capture+refund posting via the harness with P02 payment/operation rows. Command: `pnpm vitest run --project integration test/integration/ledger/recipes.test.ts`.

**Non-goals** — No production entry point for capture/refund (P07 adds `ledger.post_payment_operation`). No capture fee computation (P01/P05 own the capture fee at acceptance).

**Handoff checklist**
- [ ] Replacing `div` with `round` was observed to fail the 333/1000 vectors, then restored.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P03-T08 — Concurrency, retry, and property suite for posting and striping

**Task ID:** `P03-T08`
**Feature:** Posting concurrency and accounting properties
**Commit:** `test(ledger): add concurrency, retry, and property tests for posting and buckets`
**Priority:** Critical
**Dependencies:** `P03-T07`
**Estimated complexity:** L
**Contract references:** docs/02 §Concurrency, §Required property tests; docs/09 §Property tests Ledger, §PostgreSQL integration tests; docs/10 §M3 test bullets; docs/07 §Transaction and lock ownership; CONVENTIONS §7 (`withTransaction` retries)
**Files:** create: `test/integration/ledger/concurrency.test.ts`, `test/integration/ledger/properties.test.ts`; modify: none; must not touch: `migrations/**`

**Objective** — Prove under real concurrency that posting is idempotent, deadlock-free, overspend-proof, contention-isolated by bucket, and that projections rebuild exactly from entries at N=1 and N=32.

**Implementation instructions**
1. All tests use `postJournalAsOwner` inside `withTransaction` on separate pool clients (pool max ≥ 110). Capture/refund lines come from `resolve_recipe(capture_recipe(...))` executed as `ledger_function_owner`.
2. Deadlock detection: read `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()` before and after; the delta must be 0. Surface retries: wrap the callback to count `40001`/`40P01` attempts.
3. Blocking detection: from a third client, poll `pg_stat_activity` for the second posting's backend `wait_event_type = 'Lock'` (max 2 s).

**Expected behavior / cases**
- `concurrency.test.ts`:
  1. 100 concurrent identical postings (same key, same lines, distinct proposed `ltx_`/envelope) → all return one `ltx_`; 1 header, 1 entry set, each balance version +1, 1 outbox row.
  2. 50 concurrent postings with one key, half with a changed amount → exactly one commits; every loser with different content gets `IDEMPOTENCY_CONFLICT`; identical losers get the winner's ID.
  3. Competing protected debits: payable funded with 100 (owner-posted ADJUSTMENT-type harness posting from `platform.rounding_expense`), 20 concurrent postings each debiting payable 10 → exactly 10 commit, 10 get `NEGATIVE_PROTECTED_BALANCE`, final payable normal balance 0.
  4. Different buckets: client A opens a transaction and posts a capture for a payment in bucket 3 (N=32) without committing; client B posts a capture (different merchant) for a payment in bucket 5 with `lock_timeout = '2s'` → B commits before A commits.
  5. Same bucket: as 4 but B's payment is in bucket 3 → B is observed waiting on a lock, completes after A commits; both committed.
  6. Interleavings: 20 workers × 10 random captures/refunds over 6 payments chosen to share bucket 3 and 3 merchants (shared clearing rows), random order → zero deadlocks (stats delta 0), all postings committed, verify-equivalent rebuild equals projection.
  7. Retry convergence: a `withTransaction` callback that posts then throws an error with `code = '40001'` on its first attempt → retried with the same posting key → one transaction, balances applied once.
  8. Lost commit acknowledgement: commit a posting, discard the result, re-post the same key in a new transaction → original ID, no new rows.
  9. N=1: on `createLedgerDatabase({ bucketCount: 1 })`, case 6 also completes with zero deadlocks (all platform postings serialize on bucket 0).
- `properties.test.ts` (fast-check, fixed seed recorded in the file, counterexample persisted on failure):
  1. Random balanced postings (2–6 lines over a fixed account pool, amounts 1..1e6) → after each run, for every account, rebuild (`Σ entries`) equals `account_balances` totals, normal balance, and `version = count(DISTINCT transaction_id)`.
  2. Random retry order: a generated list of postings with duplicates shuffled → one header per key; final balances equal applying each unique posting once.
  3. Bucket stability: for random `pay_` IDs, `resolve_recipe` chooses the same bucket in two separate sessions and for capture vs refund.
  4. Bucket aggregation at N=1 and N=32 (two databases via `createLedgerDatabase`): after random capture/refund traffic, for each striped logical account Σ bucket balance rows = `ledger.logical_account_balances` = rebuild from entries.
  5. Normal-side calculation for all five classes.

**Acceptance criteria**
- [ ] Cases 1–9 and properties 1–5 pass.
- [ ] Case 3 rejections come from `NEGATIVE_PROTECTED_BALANCE` (asserted on `detail.rule`), not a constraint.
- [ ] Case 6 and 9 report a deadlock delta of 0.

**Testing requirements** — Commands: `pnpm vitest run --project integration test/integration/ledger/concurrency.test.ts` and `... test/integration/ledger/properties.test.ts`. Break checks: temporarily replace `ORDER BY account_id COLLATE "C"` in `post_journal_internal` with `ORDER BY account_id DESC` for half the calls (local edit, not committed) → case 6 observes deadlocks; remove the balance check → case 3 fails.

**Non-goals** — No benchmark (P12). No crash-point suite (T10).

**Handoff checklist**
- [ ] Both break checks observed failing, then restored.
- [ ] Suite runtime < 3 minutes locally.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P03-T09 — Dual-control corrections: requests, decisions, and `ledger.post_approved_correction`

**Task ID:** `P03-T09`
**Feature:** Protected correction/reversal entry point
**Commit:** `feat(ledger): add correction_requests and post_approved_correction`
**Priority:** Critical
**Dependencies:** `P03-T06`
**Estimated complexity:** L
**Contract references:** docs/07 §ledger.correction_requests, §Protected posting function (second paragraph), §ledger.journal_transactions (reversal rules); docs/02 §Reversals and adjustments, §MVP implementation decisions (closed-account corrections); CONVENTIONS §7 (`fl_correction`)
**Files:** create: `migrations/0370_ledger_corrections.sql`, `test/integration/ledger/corrections.test.ts`; modify: `packages/database/src/functions/ledger.ts`, `packages/database/src/errors.ts`; must not touch: `migrations/0300*`–`0360*`

**Objective** — Provide the only runtime-reachable posting entry point in P03: a durable dual-control correction (full reversal or adjustment) that is requested by one operator, approved by a different operator against the exact request hash, and executed atomically through `ledger.post_journal_internal`.

**Implementation instructions**
1. `ledger.correction_requests` columns per docs/07 (`id` `^lcr_[0-7][0-9A-HJKMNP-TV-Z]{25}$`, `merchant_id`, `request_type`, `target_transaction_id`, `canonical_request jsonb`, `request_hash bytea`, `reason`, `requested_by`, `approved_by`, `status`, `requested_at DEFAULT clock_timestamp()`, `approved_at`, `executed_transaction_id`, `executed_at`). Checks: `request_type IN ('FULL_REVERSAL','ADJUSTMENT')`; `(request_type = 'FULL_REVERSAL') = (target_transaction_id IS NOT NULL)`; `jsonb_typeof(canonical_request) = 'object'`; `octet_length(request_hash) = 32`; `length(reason) BETWEEN 1 AND 1000`; `length(requested_by) BETWEEN 1 AND 200`; `approved_by IS NULL OR approved_by <> requested_by`; status shape: `PENDING` ⇒ approved_*/executed_* null; `APPROVED`/`REJECTED` ⇒ approved_* nonnull, executed_* null; `EXECUTED` ⇒ all nonnull. FKs: `merchant_id → identity.merchants`, `target_transaction_id → ledger.journal_transactions(id)`, `executed_transaction_id → ledger.journal_transactions(id)` (indexes on both). `CREATE UNIQUE INDEX correction_requests_one_live_reversal ON ledger.correction_requests (target_transaction_id) WHERE request_type = 'FULL_REVERSAL' AND status IN ('PENDING','APPROVED','EXECUTED')`.
2. Trigger `correction_requests_guard` BEFORE UPDATE: content columns (`id`, `merchant_id`, `request_type`, `target_transaction_id`, `canonical_request`, `request_hash`, `reason`, `requested_by`, `requested_at`) immutable; allowed transitions only `PENDING → APPROVED|REJECTED` and `APPROVED → EXECUTED`; BEFORE DELETE/TRUNCATE forbidden. Rule `CORRECTION_IMMUTABLE` under `LEDGER_CORRECTION_REJECTED`.
3. Canonical request shapes (exact keys, nothing else):
   - `{"requestType":"FULL_REVERSAL","targetTransactionId":"ltx_…"}`
   - `{"requestType":"ADJUSTMENT","entries":[{"accountId":"lac_…","side":"DEBIT"|"CREDIT","amountMinor":"<^(0|[1-9][0-9]*)$ string>"}, …]}` with ≥ 2 entries.
   `request_hash = sha256(convert_to(ledger.jcs(canonical_request), 'UTF8'))`.
4. Functions (all `SECURITY DEFINER`, owner `ledger_function_owner`, `SET search_path = pg_catalog, ledger, messaging`; each first checks `pg_has_role(session_user, 'fl_correction', 'MEMBER')` else `LEDGER_CORRECTION_REJECTED` rule `INVOKER_NOT_ALLOWED`; errors use `MESSAGE = 'LEDGER_CORRECTION_REJECTED'` with the listed rule):
   - `ledger.request_correction(p_request_id text, p_merchant_id text, p_canonical_request jsonb, p_reason text, p_requested_by text) RETURNS bytea` — validates shape (`INVALID_REQUEST`); for `FULL_REVERSAL` requires the target exists with the same merchant (`MERCHANT_MISMATCH`), `operation_type <> 'REVERSAL'` (`TARGET_IS_REVERSAL`), not already reversed and no live request (`TARGET_ALREADY_REVERSED`); for `ADJUSTMENT` validates the entries through `ledger.canonicalize_lines` and balance (`UNBALANCED` passes through as `LEDGER_INVARIANT_VIOLATION`). Inserts `PENDING`, returns the hash.
   - `ledger.decide_correction(p_request_id text, p_decision text, p_decided_by text, p_expected_request_hash bytea) RETURNS text` — `SELECT ... FOR UPDATE`; requires `PENDING` (`NOT_PENDING`), `p_decision IN ('APPROVED','REJECTED')`, `p_decided_by <> requested_by` (`SAME_PRINCIPAL`), stored hash = recomputed hash = `p_expected_request_hash` (`HASH_MISMATCH`); sets status, `approved_by = p_decided_by`, `approved_at = clock_timestamp()`; returns the new status.
   - `ledger.post_approved_correction(p_request_id text, p_transaction_id text, p_envelope_id uuid, p_correlation_id text) RETURNS text` — `SELECT ... FOR UPDATE` on the request (lock order: correction request → balance rows → outbox). If `EXECUTED`, return `executed_transaction_id` (lost-response retry). Requires `APPROVED` (`NOT_APPROVED`), `approved_by <> requested_by` (`SAME_PRINCIPAL`), recomputed hash = stored (`HASH_MISMATCH`). Derives everything from rows:
     - `FULL_REVERSAL`: target header's `ledger_id`, `merchant_id`, `currency`, `payment_id`; lines = target entries with sides swapped; posting key `ledger:{target}:reversal:{request_id}`; operation type `REVERSAL`; `p_allow_closed_accounts = true` (docs/02 privileged closed-account path); `payment_operation_id` null.
     - `ADJUSTMENT`: the single ledger; lines from `canonical_request.entries`; posting key `ledger:adjustment:{request_id}`; operation type `ADJUSTMENT`; `payment_id` null; `p_allow_closed_accounts = false`.
     - `causation_id = p_request_id`; `metadata = {"correctionRequestId": p_request_id}`; `correction_request_id = p_request_id` in the hash.
     Calls `ledger.post_journal_internal(...)`, then sets `status = 'EXECUTED'`, `executed_transaction_id`, `executed_at`; returns the transaction ID.
5. Grants (last): table — revoke all from `PUBLIC` and runtime roles; `GRANT SELECT, INSERT, UPDATE ON ledger.correction_requests TO ledger_function_owner`; `GRANT SELECT ON ledger.correction_requests TO fl_operator_readonly`. Functions — revoke from `PUBLIC`; `GRANT EXECUTE ON FUNCTION ledger.request_correction(...), ledger.decide_correction(...), ledger.post_approved_correction(...) TO fl_correction`.
6. `packages/database/src/functions/ledger.ts`: `requestCorrection`, `decideCorrection`, `postApprovedCorrection` wrappers (bigint-safe; `request_hash` as `Buffer`). `errors.ts`: add `LEDGER_CORRECTION_REJECTED`.

**Expected behavior** — Request (operator `alice`) a full reversal of a capture; `decide_correction(id, 'APPROVED', 'alice', hash)` → `SAME_PRINCIPAL`; `bob` approves; `post_approved_correction` returns a `REVERSAL` transaction whose entries mirror the capture; every touched account nets to zero; a second request for the same target → `TARGET_ALREADY_REVERSED`.

**Acceptance criteria**
- [ ] Full reversal: original + reversal net to zero per account; original unchanged; `reversal_of_transaction_id` set; one outbox row.
- [ ] Reversal of a reversal, a second reversal of one target, a reversal across merchants, an unapproved request, a rejected request, a same-principal approval, and a hash mismatch are each rejected with the listed rule.
- [ ] A reversal touching a closed account succeeds; an adjustment touching a closed account fails with `ACCOUNT_CLOSED`.
- [ ] An adjustment that would drive merchant payable negative fails with `NEGATIVE_PROTECTED_BALANCE` and leaves the request `APPROVED`.
- [ ] 100 concurrent `post_approved_correction` calls for one approved request (connections logged in as `fl_correction`) → one journal transaction, one entry set, one balance effect, one outbox row; all callers receive the same ID.
- [ ] 10 concurrent `request_correction` calls for one target → one `PENDING` row; the rest fail (`TARGET_ALREADY_REVERSED` or `23505` on `correction_requests_one_live_reversal`).
- [ ] Content update, delete, and `EXECUTED → APPROVED` on `correction_requests` fail for `fl_migration_owner`.
- [ ] Runtime roles other than `fl_correction` get `42501` on all three functions; `fl_correction` gets `42501` on direct `INSERT`/`UPDATE` of `ledger.correction_requests` and journal tables.

**Testing requirements** — `test/integration/ledger/corrections.test.ts`: every acceptance case; the 100-way concurrency case uses 100 pool clients logged in as `fl_correction` with the password from `infra/docker/.env.example`. Command: `pnpm vitest run --project integration test/integration/ledger/corrections.test.ts`.

**Non-goals** — No operator CLI for corrections (P11). No audit-log rows (audit table arrives in P10-T11). No platform-only corrections (deferred by docs/07).

**Handoff checklist**
- [ ] Removing the `approved_by <> requested_by` check from `post_approved_correction` and the table check was observed to fail the same-principal case, then restored.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P03-T10 — Balance rebuild tooling and ledger crash-point tests

**Task ID:** `P03-T10`
**Feature:** Projection rebuild and atomicity under failure
**Commit:** `feat(ledger): add rebuild_balance_projection and crash-point tests`
**Priority:** High
**Dependencies:** `P03-T09`
**Estimated complexity:** M
**Contract references:** docs/08 §Ledger and balance projection (crash-point matrix), §Runbook: ledger or payment discrepancy (safe action "rebuild a derived balance projection"), §Required failure-injection tests Ledger; docs/02 §Required property tests (Atomicity and idempotency); ADR-0005
**Files:** create: `migrations/0380_ledger_rebuild.sql`, `test/integration/ledger/rebuild.test.ts`, `test/integration/ledger/crash-points.test.ts`; modify: `packages/database/src/functions/ledger.ts`; must not touch: `migrations/0300*`–`0370*`

**Objective** — Give operators the runbook's "rebuild a derived projection from immutable entries" action, and prove the ledger crash-point rows of docs/08 that are reachable before P07 (pre-commit failure, lost commit acknowledgement, duplicate key with same/different hash, projection divergence).

**Implementation instructions**
1. `ledger.rebuild_balance_projection(p_account_id text) RETURNS boolean` — `SECURITY DEFINER`, owner `ledger_function_owner`, `SET search_path = pg_catalog, ledger`; checks `pg_has_role(session_user, 'fl_operator_command', 'MEMBER')` (`INVOKER_NOT_ALLOWED`). Locks the balance row `FOR UPDATE` (the same lock posting takes), computes `d = Σ DEBIT`, `c = Σ CREDIT`, `v = count(DISTINCT transaction_id)` from `ledger.journal_entries`, and if any of `debit_total_minor`, `credit_total_minor`, `normal_balance_minor`, `version` differ, updates them (and `updated_at = clock_timestamp()`) and returns `true`; otherwise `false`. Never touches entries. Grant EXECUTE to `fl_operator_command` only. The audit record of this action is P11 (risk R-14).
2. `packages/database/src/functions/ledger.ts`: `rebuildBalanceProjection(client, accountId): Promise<boolean>`.
3. `test/integration/ledger/crash-points.test.ts` cases (all via the harness or the correction entry point):
   1. Pre-commit failure after posting: post inside a transaction, then `ROLLBACK` → no header, entries, balance change, or outbox row.
   2. Failure inside the routine after the header claim: a posting that fails `NEGATIVE_PROTECTED_BALANCE` (raised after step 8's insert) → nothing visible after rollback, and the same key can then post successfully with valid lines.
   3. Failure at outbox insertion (the last step, after entries and balances): as the container superuser, inside the test transaction, run `REVOKE EXECUTE ON FUNCTION messaging.insert_outbox(jsonb) FROM ledger_function_owner` (DDL is transactional), then post → SQLSTATE `42501` at step 12 → after `ROLLBACK` no header, entries, balance change, or outbox row exist and the grant is restored.
   4. Deferred-commit failure: in the owner harness, post a valid transaction, then insert an extra unbalanced header directly as owner in the same transaction → commit fails and the valid posting is also absent.
   5. Lost commit ack: commit, then retry same key → original ID, no new rows.
   6. Duplicate key, same hash → original ID; duplicate key, different hash → `IDEMPOTENCY_CONFLICT` and the original untouched.
   7. Retry under existing key resolves to the same bucket: capture via `resolve_recipe` at N=32, retry with a freshly resolved line set → same accounts, original ID.
4. `test/integration/ledger/rebuild.test.ts`: corrupt one balance row with a fixture helper local to the test file named `corruptBalanceForTest` (superuser, `SET session_replication_role = replica`, `UPDATE` totals and normal balance consistently) → `rebuild_balance_projection` returns `true` and restores exact equality; a second call returns `false`; `fl_api` gets `42501`.

**Expected behavior** — See cases.

**Acceptance criteria**
- [ ] Crash cases 1–7 pass with zero partial rows.
- [ ] Rebuild restores equality for debit/credit/normal/version and is a no-op on a correct row.
- [ ] Only `fl_operator_command` can execute the rebuild.

**Testing requirements** — Commands: `pnpm vitest run --project integration test/integration/ledger/crash-points.test.ts` and `... test/integration/ledger/rebuild.test.ts`.

**Non-goals** — No `FLOWLEDGER_FAULT_HOOKS` points inside production SQL (P07/P12 own the chaos suite for capture/refund transactions). No account quarantine.

**Handoff checklist**
- [ ] Making the rebuild compute `version` as `count(*)` of entries was observed to fail on an account that has both a debit and a credit entry in one transaction (2 entries, version 1), then restored.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P03-T11 — `flowledger verify` framework, output formats, and ledger classes

**Task ID:** `P03-T11`
**Feature:** Continuous invariant checker
**Commit:** `feat(cli): add flowledger verify with journal, projection, and bucket classes`
**Priority:** Critical
**Dependencies:** `P03-T06`
**Estimated complexity:** L
**Contract references:** docs/09 §Continuous invariant checker, §Stop conditions; docs/10 §M3 (verify bullets); docs/02 §Balance semantics, §Striped platform accounts; docs/08 §Recovery observability (`ledger_projection_mismatches`); CONVENTIONS §4 (`pnpm verify:ledger`), §11
**Files:** create: `packages/database/src/verify/index.ts`, `packages/database/src/verify/classes/ledger.ts`, `packages/database/src/verify/index.test.ts`, `apps/cli/src/commands/verify.ts`, `packages/testkit/src/ledger-corruption.ts`, `test/integration/verify/ledger-classes.test.ts`, `test/integration/verify/cli.test.ts`; modify: the `apps/cli` command dispatcher created in P02 (the file that routes `migrate`/`seed`), `packages/testkit/src/index.ts`, `packages/database/src/index.ts`; must not touch: `migrations/**`

**Objective** — One command that asserts the correctness invariants against committed state, reports rows checked and findings per class, never passes a class silently when its tables do not exist, and exits nonzero on any finding. This task builds the runner, both output formats, the CLI, the class registry with all nine names, and the three ledger classes.

**Implementation instructions**
1. `packages/database/src/verify/index.ts`:
   ```ts
   export const VERIFY_CLASS_ORDER = ['journal_balance','projection_equality','bucket_aggregation','payment_totals',
     'reservation_integrity','posting_cardinality','orphan_detection','settlement_membership','duplicate_financial_effects'] as const;
   export type VerifyClassName = typeof VERIFY_CLASS_ORDER[number];
   export interface SqlVerifyClass { name: VerifyClassName; requiredTables: string[]; rowsCheckedSql: string; findingsSql: string }
   export interface Finding { subject: string; detail: Record<string, unknown> }
   export interface ClassResult { name: VerifyClassName; status: 'OK'|'FINDINGS'|'SKIPPED'; rowsChecked: number; findings: number;
     skipReason: null|'TABLE_ABSENT'|'GROUND_TRUTH_UNAVAILABLE'; absentTables: string[]; samples: Finding[] }
   export interface VerifyReport { schemaVersion: 1; result: 'PASS'|'FAIL'; failureReasons: ('FINDINGS'|'GROUND_TRUTH_REQUIRED')[];
     bucketCount: number|null; classes: ClassResult[]; gauges: { unresolvedAmbiguity: number|null } }
   export interface GroundTruthEffect { providerIdempotencyKey: string; paymentRef: string; operationType: 'AUTHORIZE'|'CAPTURE'|'CANCEL'|'REFUND'; effectCount: bigint }
   export interface GroundTruthSource { effects(): Promise<GroundTruthEffect[]> }
   export interface VerifyOptions { groundTruth?: GroundTruthSource; requireGroundTruth: boolean }
   export async function runVerify(pool: Pool, opts: VerifyOptions): Promise<VerifyReport>;
   export function formatHuman(report: VerifyReport): string;
   export function formatJson(report: VerifyReport): string;   // JSON.stringify(report, null, 2) + '\n'
   ```
   - `runVerify` takes one client, runs `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` (one consistent snapshot so live traffic cannot produce false projection findings), evaluates classes in `VERIFY_CLASS_ORDER`, then `COMMIT`.
   - For each SQL class: absent tables = `requiredTables` where `to_regclass($1) IS NULL`. If any absent → `status 'SKIPPED'`, `rowsChecked 0`, `findings 0`, `skipReason 'TABLE_ABSENT'`. Else `rowsChecked = (rowsCheckedSql)::bigint`, `findings = SELECT count(*) FROM (findingsSql) f`, `samples = SELECT subject, detail FROM (findingsSql) f ORDER BY subject LIMIT 20`; status `FINDINGS` when findings > 0 else `OK`.
   - `runVerify` evaluates only the classes registered in the exported `VERIFY_CLASSES` array (in `VERIFY_CLASS_ORDER` order), and both formats list exactly those. This task registers the three ledger classes; T12–T14 register the other six. No placeholder entries.
   - `bucketCount = SELECT max(bucket_count) FROM ledger.accounts` (null when no striped account).
   - `result = 'FAIL'` iff any class has findings > 0 (`failureReasons` includes `'FINDINGS'`) or `requireGroundTruth` and the duplicate class was skipped (`'GROUND_TRUTH_REQUIRED'`).
   - Money values inside `detail` are decimal strings (`::text` in SQL).
2. Human format (exact; `\n` line endings; name column `padEnd(28)`, `ROWS_CHECKED` `padStart(12)`, `FINDINGS` `padStart(10)`, two spaces, status):
   ```text
   flowledger verify
   bucket_count: 32
   CLASS                       ROWS_CHECKED  FINDINGS  STATUS
   journal_balance                     1204         0  OK
   projection_equality                   70         2  FINDINGS
   orphan_detection                       0         0  0 rows checked (table absent: reconciliation.cases)
   duplicate_financial_effects            0         0  0 rows checked (ground truth unavailable)
   FINDING projection_equality lac_01J... {"rule":"PROJECTION_MISMATCH","rebuiltDebitMinor":"500","projectedDebitMinor":"505"}
   ... and 0 more
   gauge unresolved_ambiguity: n/a
   RESULT: FAIL (2 findings)
   ```
   Rules: `bucket_count: none` when null; one `FINDING <class> <subject> <compact JSON detail>` line per sample, in class order; a `... and <k> more` line only when findings > samples; gauge prints the number or `n/a`; final line `RESULT: PASS (0 findings)`, `RESULT: FAIL (<n> findings)`, or `RESULT: FAIL (ground truth required but unavailable)` (when both apply: `RESULT: FAIL (<n> findings; ground truth required but unavailable)`). Skipped status text: `0 rows checked (table absent: <comma-space-separated tables>)` or `0 rows checked (ground truth unavailable)`.
3. JSON format: the `VerifyReport` object with keys in the order declared above, `JSON.stringify(report, null, 2)`.
4. `apps/cli/src/commands/verify.ts`: `flowledger verify [--json] [--require-ground-truth]`. Reads `DATABASE_URL` through the CLI config module from P02 (`packages/config`). Unknown flag → usage on stderr, exit 2. Connection/config error → message without the URL or password on stderr, exit 2. Prints `formatJson` with `--json`, else `formatHuman`, to stdout. Exit 0 on PASS, 1 on FAIL. Register in the P02 dispatcher. `--require-ground-truth` is parsed and passed as `opts.requireGroundTruth`; it has an effect only once T14 registers the duplicate class.
5. Ledger classes in `packages/database/src/verify/classes/ledger.ts` (`requiredTables` lists every table each query reads):
   - `journal_balance` — required `ledger.journal_transactions`, `ledger.journal_entries`; rowsChecked = `count(*)` of headers; findings:
     ```sql
     SELECT t.id AS subject, jsonb_build_object('rule',
         CASE WHEN count(e.*) < 2 THEN 'ENTRY_COUNT' WHEN count(DISTINCT e.account_id) < 2 THEN 'DISTINCT_ACCOUNTS'
              WHEN bool_or(e.currency <> t.currency OR e.ledger_id <> t.ledger_id) THEN 'CURRENCY_OR_LEDGER_MISMATCH' ELSE 'UNBALANCED' END,
       'debitsMinor', coalesce(sum(e.amount_minor) FILTER (WHERE e.side = 'DEBIT'), 0)::text,
       'creditsMinor', coalesce(sum(e.amount_minor) FILTER (WHERE e.side = 'CREDIT'), 0)::text) AS detail
     FROM ledger.journal_transactions t LEFT JOIN ledger.journal_entries e ON e.transaction_id = t.id
     GROUP BY t.id
     HAVING count(e.*) < 2 OR count(DISTINCT e.account_id) < 2
        OR coalesce(bool_or(e.currency <> t.currency OR e.ledger_id <> t.ledger_id), false)
        OR coalesce(sum(e.amount_minor) FILTER (WHERE e.side = 'DEBIT'), 0) <> coalesce(sum(e.amount_minor) FILTER (WHERE e.side = 'CREDIT'), 0)
     ```
   - `projection_equality` — required `ledger.accounts`, `ledger.account_balances`, `ledger.journal_entries`; rowsChecked = accounts; finding per account where the balance row is missing (`MISSING_BALANCE_ROW`) or any of `debit_total_minor`, `credit_total_minor`, `normal_balance_minor`, `version` differs from the rebuild (`Σ DEBIT`, `Σ CREDIT`, side-dependent difference, `count(DISTINCT transaction_id)`) (`PROJECTION_MISMATCH`, detail with rebuilt and projected values).
   - `bucket_aggregation` — required `ledger.accounts`, `ledger.account_balances`, `ledger.journal_entries`, `ledger.logical_account_balances`; subjects are striped logical accounts `ledger_id || ':' || logical_code || ':' || currency`; rowsChecked = number of striped logical accounts; findings: `BUCKET_SET_INCOMPLETE` (`count(*) <> max(bucket_count)` or `min(bucket_count) <> max(bucket_count)` or `array_agg(bucket_index ORDER BY bucket_index) <> ARRAY(SELECT generate_series(0, max(bucket_count) - 1))`), `BUCKET_SUM_MISMATCH` (Σ bucket balance debit/credit ≠ Σ entries over those accounts), `VIEW_MISMATCH` (view row debit/credit ≠ Σ entries). One finding row per (subject, rule).
6. `packages/testkit/src/ledger-corruption.ts`: `withReplicaMode<T>(client, fn)` (superuser; `SET LOCAL session_replication_role = replica` inside a transaction — disables user triggers and FK checks, CHECK constraints still apply); `insertUnbalancedTransaction(client, {ledgerId, merchantId, accountId})` (header + one entry); `skewBalance(client, accountId, deltaMinor)` (adds to debit total and adjusts normal balance consistently); `addOrphanBucket(client, ledgerId, logicalCode)` (inserts a platform account with `bucket_index = N`, `bucket_count = N + 1` plus its zero balance row). Every helper name says what it corrupts; production code never imports this file.
7. Unit test `packages/database/src/verify/index.test.ts`: `formatHuman`/`formatJson` golden strings for (a) all OK, (b) findings with 25 findings (20 samples + `... and 5 more`), (c) table-absent and ground-truth-unavailable rows, (d) `RESULT` line variants.

**Expected behavior** — On a migrated, empty-traffic N=32 database: `journal_balance 0/0 OK`, `projection_equality` rows checked = 66 + 2 × merchants (64 buckets + 2 rounding + clearing/payable per merchant), 0 findings, `bucket_aggregation 2/0 OK`; exit 0.

**Acceptance criteria**
- [ ] Each corrupted fixture is detected by the named class with the named rule: unbalanced transaction → `journal_balance` (`ENTRY_COUNT`); `skewBalance` on merchant clearing → `projection_equality` (`PROJECTION_MISMATCH`) and `bucket_aggregation` reports 0; `skewBalance` on `platform.processor_receivable.03` → `bucket_aggregation` (`BUCKET_SUM_MISMATCH`, `VIEW_MISMATCH`); `addOrphanBucket` → `bucket_aggregation` (`BUCKET_SET_INCOMPLETE`) with `projection_equality` 0.
- [ ] Each corrupted run exits 1 from the CLI; the clean run exits 0; unknown flag exits 2.
- [ ] A class whose `requiredTables` contains a nonexistent relation (unit-level: a test-only `SqlVerifyClass` passed to an exported `runClasses(client, classes)` helper used by `runVerify`) reports `SKIPPED`/`TABLE_ABSENT`, prints `0 rows checked (table absent: …)`, and does not fail the run.
- [ ] Verify runs in a single REPEATABLE READ READ ONLY transaction (asserted by attempting a write through the same client in a spy test: `runVerify` issues no statement other than SELECTs plus BEGIN/COMMIT, checked via a `pg` client wrapper that records SQL).
- [ ] Output formats match the golden strings byte-for-byte.

**Testing requirements**
- `test/integration/verify/ledger-classes.test.ts`: clean run on N=1 and N=32 databases (`createLedgerDatabase`) after harness traffic; each corruption above on its own fresh database; assert per-class counts and rules in the report.
- `test/integration/verify/cli.test.ts`: build first (`pnpm build`), spawn `node apps/cli/dist/main.js verify --json` (the P02 CLI entry path) with `DATABASE_URL` pointing at the fixture database; assert exit codes 0/1/2 and parse JSON.
- `packages/database/src/verify/index.test.ts` (unit).
- Commands: `pnpm vitest run --project integration test/integration/verify/`, `pnpm vitest run --project unit packages/database/src/verify/index.test.ts`.

**Non-goals** — No metrics export (`ledger_projection_mismatches` gauge wiring is P11). No auto-repair. No payment/recovery/settlement/ground-truth classes (T12–T14).

**Handoff checklist**
- [ ] A case skews only a balance row's `version` (in replica mode); removing the `version` comparison from `projection_equality` was observed to fail it, then restored.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P03-T12 — Verify classes: payment totals, reservation integrity, posting cardinality

**Task ID:** `P03-T12`
**Feature:** Payment-side invariant classes
**Commit:** `feat(db): add payment totals, reservation, and posting cardinality verify classes`
**Priority:** High
**Dependencies:** `P03-T11`
**Estimated complexity:** M
**Contract references:** docs/09 §Continuous invariant checker (rows 4–6); docs/07 §payments.payments (checks, deferred trigger), §payments.payment_operations; docs/03 (monetary invariants, voided rules); docs/02 §Idempotent posting (posting keys)
**Files:** create: `packages/database/src/verify/classes/payments.ts`, `test/integration/verify/payment-classes.test.ts`; modify: `packages/database/src/verify/index.ts` (register classes), `packages/testkit/src/ledger-corruption.ts`; must not touch: `migrations/**`

**Objective** — Assert that payment aggregates agree with their operation rows and that every successful capture/refund has exactly one correctly keyed journal transaction and nothing else has one.

**Implementation instructions**
1. `payment_totals` — required `payments.payments`, `payments.payment_operations`; rowsChecked = payments; per payment, aggregate operations: `sa` = Σ amount of `SUCCEEDED AUTHORIZE`, `sc` = Σ `SUCCEEDED CAPTURE`, `sr` = Σ `SUCCEEDED REFUND`, `has_capture`, `has_cancel` (`SUCCEEDED CANCEL`), `fee_cap` = capture `fee_effect_amount_minor` of the `SUCCEEDED CAPTURE`, `fee_rev` = Σ `fee_effect_amount_minor` of `SUCCEEDED REFUND`. One finding per payment with `detail = {"violations":[...], ...values as strings}` where violations ⊆ `AUTHORIZED_MISMATCH` (`authorized_amount_minor <> sa`), `CAPTURED_MISMATCH` (`<> sc`), `REFUNDED_MISMATCH` (`<> sr`), `VOIDED_MISMATCH` (`voided_amount_minor <> CASE WHEN has_capture THEN authorized - captured WHEN has_cancel OR authorization_outcome = 'EXPIRED' THEN authorized ELSE 0 END`, docs/03 lines 151–153, 293, 312), `OVER_REFUND` (`refunded + reserved > captured`), `FEE_OVER_REVERSAL` (`fee_rev > fee_cap`).
2. `reservation_integrity` — required as above; rowsChecked = payments; finding `RESERVATION_MISMATCH` when `reserved_refund_amount_minor <> Σ amount` or `unresolved_refund_count <> count` over that payment's `REFUND` rows with status in (`REQUESTED`,`PROCESSING`,`UNKNOWN`,`REQUIRES_REVIEW`).
3. `posting_cardinality` — required `payments.payment_operations`, `ledger.journal_transactions`; rowsChecked = count of `CAPTURE`/`REFUND` operations + count of headers with nonnull `payment_operation_id`; findings:
   - `MISSING_POSTING`: `SUCCEEDED` capture/refund with no header where `payment_operation_id = o.id`.
   - `DUPLICATE_POSTING`: more than one header per operation.
   - `POSTING_FOR_UNSUCCESSFUL_OPERATION`: header whose operation is not `SUCCEEDED` or whose operation type is not `CAPTURE`/`REFUND`.
   - `POSTING_KEY_MISMATCH`: header whose `posting_key <> 'payment:' || o.payment_id || ':' || lower(o.type) || ':' || o.id` or whose `operation_type <> o.type`.
   Subject = operation ID.
4. Corruption helpers (append to `ledger-corruption.ts`, all inside `withReplicaMode`): `skewCapturedTotal(client, paymentId, deltaMinor)` (moves `delta` from captured to voided so row checks still hold), `skewReservation(client, paymentId, deltaMinor)` (adds `delta` to `reserved_refund_amount_minor` and sets `unresolved_refund_count` to at least 1), `insertSucceededOperationWithoutPosting(client, {merchantId, paymentId, type})` (inserts a `SUCCEEDED` capture/refund row supplying every NOT NULL/CHECK column of docs/07 §payments.payment_operations, including a syntactically valid `resolution_evidence_id`, `resolution_source = 'API_RESPONSE'`, `provider_operation_id`, `resolved_at`).
5. Register the three classes in `VERIFY_CLASS_ORDER` positions.

**Expected behavior** — A fixture payment authorized 10000, captured 10000 with one succeeded capture and its harness posting → all three classes 0 findings. Skewing captured by 1000 → `payment_totals` finding with `["CAPTURED_MISMATCH","VOIDED_MISMATCH"]`.

**Acceptance criteria**
- [ ] Clean fixture (payments in each of: no operations, authorized only, captured, partially refunded with one unresolved refund, canceled) → 0 findings in all three classes.
- [ ] `skewCapturedTotal` → `payment_totals`; `skewReservation` → `reservation_integrity` (and not `payment_totals` unless the over-refund condition holds); `insertSucceededOperationWithoutPosting` → `posting_cardinality` `MISSING_POSTING`; a harness posting for a `REQUESTED` capture operation → `POSTING_FOR_UNSUCCESSFUL_OPERATION`; a harness posting with key `payment:<pay>:refund:<capture op>` for a capture op → `POSTING_KEY_MISMATCH`.
- [ ] CLI exits 1 for each corrupted fixture.

**Testing requirements** — `test/integration/verify/payment-classes.test.ts`, payments built with the P02 builders (succeeded rows via the corruption/fixture helper in replica mode where builders cannot produce them). Command: `pnpm vitest run --project integration test/integration/verify/payment-classes.test.ts`.

**Non-goals** — No recipe-amount comparison between operation and journal entries (P07 extends `posting_cardinality` once `post_payment_operation` exists). No repair.

**Handoff checklist**
- [ ] Removing `VOIDED_MISMATCH` logic does not hide `CAPTURED_MISMATCH` (assert both present).
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P03-T13 — Verify classes: orphan detection and settlement membership (table-absent aware)

**Task ID:** `P03-T13`
**Feature:** Recovery-ownership and settlement invariant classes
**Commit:** `feat(db): add orphan detection and settlement membership verify classes`
**Priority:** High
**Dependencies:** `P03-T11`
**Estimated complexity:** M
**Contract references:** docs/09 §Continuous invariant checker (rows 7–8); docs/08 §Recovery owners; docs/07 §reconciliation.cases, §settlement.batches, §settlement.batch_members, §messaging.outbox_messages, §messaging.dead_letter_records; docs/02 §Batch invariants
**Files:** create: `packages/database/src/verify/classes/recovery.ts`, `test/integration/verify/recovery-classes.test.ts`; modify: `packages/database/src/verify/index.ts`, `packages/testkit/src/ledger-corruption.ts`; must not touch: `migrations/**`

**Objective** — Implement the two classes whose subject tables arrive in later phases (P08 `reconciliation.cases`, P10 settlement tables), so they report `0 rows checked (table absent: …)` now and turn on automatically when those migrations land, with detection proven today against stub tables.

**Implementation instructions**
1. `orphan_detection` — required `payments.payment_operations`, `messaging.outbox_messages`, `messaging.dead_letter_records`, `reconciliation.cases`; rowsChecked = operations with status in (`REQUESTED`,`PROCESSING`,`UNKNOWN`,`REQUIRES_REVIEW`); finding `ORPHANED_OPERATION` (subject operation ID, detail `{status, type}`) for a nonterminal operation with none of these owners (**[ASSUMPTION]** ownership rules derived from docs/08 §Recovery owners; P08 may tighten them, risk R-15):
   - `REQUESTED` with `not_before IS NOT NULL` (due-work scheduler owns it);
   - `REQUESTED` with an outbox row `message_type = 'payment.operation.execute.v1' AND envelope->'data'->>'operationId' = o.id` (relay/subscriber owns it);
   - `REQUESTED` or `PROCESSING` with an unresolved `messaging.dead_letter_records` row for `operation_id = o.id` (operator owns it);
   - `PROCESSING` with `lease_expires_at IS NOT NULL` (lease owner, then stale sweeper);
   - `UNKNOWN`/`REQUIRES_REVIEW` with a `reconciliation.cases` row for `operation_id = o.id` in status `OPEN`/`SCHEDULED`/`IN_PROGRESS`/`REQUIRES_REVIEW`.
   `-- ponytail: outbox JSON scan is O(outbox); add an operation_id expression index if verify exceeds the CI budget.`
2. `settlement_membership` — required `settlement.batches`, `settlement.batch_members`, `ledger.journal_entries`, `ledger.accounts`; rowsChecked = batches + members; findings (one row per subject/rule):
   - `DUPLICATE_MEMBERSHIP` — `movement_transaction_id` in more than one member row (subject = movement ID).
   - `BATCH_NET_MISMATCH` — `b.net_amount_minor IS DISTINCT FROM` Σ over members' journal entries on the batch merchant's `merchant.clearing` account of (`CREDIT` = +amount, `DEBIT` = −amount) (recomputed from immutable entries, never from `clearing_delta_minor`).
   - `MEMBER_COUNT_MISMATCH` — `b.member_count <>` count of member rows.
   - `BATCH_POSTING_MISMATCH` — Σ `DEBIT` on the merchant's clearing account in `b.journal_transaction_id` `IS DISTINCT FROM b.net_amount_minor`.
3. Test stubs (in the test file only): `CREATE SCHEMA IF NOT EXISTS reconciliation; CREATE TABLE IF NOT EXISTS reconciliation.cases (...)` and `CREATE TABLE IF NOT EXISTS settlement.batches (...)`, `settlement.batch_members (...)` declaring **every** docs/07 column with its docs/07 type, all nullable, no constraints. Fixture inserts always populate every docs/07 NOT NULL column with values satisfying the docs/07 checks (e.g. `posting_key = 'settlement:' || id`, `net_amount_minor > 0`) so the same test runs unchanged against the real P08/P10 tables, inserted inside `withReplicaMode`.
4. Duplicate-membership case: if `settlement.batch_members` has a unique index on `movement_transaction_id` (real P10 table), assert the duplicate insert fails with `23505` (the guarantee is structural); otherwise (stub) assert `DUPLICATE_MEMBERSHIP` is reported. Both branches assert.

**Expected behavior** — On a P03 database: `orphan_detection 0 0 0 rows checked (table absent: reconciliation.cases)`, `settlement_membership 0 0 0 rows checked (table absent: settlement.batches, settlement.batch_members)`; run result PASS.

**Acceptance criteria**
- [ ] Table-absent output exactly as above on a P03-only database, exit 0.
- [ ] With stubs: an `UNKNOWN` operation with no case → `ORPHANED_OPERATION`; adding an `OPEN` case clears it; a `REQUESTED` operation with null `not_before`, no execute outbox row, and no DLQ row → `ORPHANED_OPERATION`; with an execute outbox row (inserted through `messaging.insert_outbox`) → clear.
- [ ] With stubs: a batch whose `net_amount_minor` is 9700 over members whose clearing entries net 9600 → `BATCH_NET_MISMATCH`; wrong `member_count` → `MEMBER_COUNT_MISMATCH`; duplicate membership per step 4.
- [ ] CLI exits 1 for each corrupted fixture.

**Testing requirements** — `test/integration/verify/recovery-classes.test.ts` (each scenario on a fresh `createLedgerDatabase({ bucketCount: 32 })`; movements are harness-posted capture/refund transactions; the settlement transaction is a harness `SETTLEMENT` posting debiting clearing and crediting payable). Command: `pnpm vitest run --project integration test/integration/verify/recovery-classes.test.ts`.

**Non-goals** — No settlement or reconciliation schema (P08/P10). No sweeper.

**Handoff checklist**
- [ ] Changing the clearing net sign was observed to fail `BATCH_NET_MISMATCH`, then restored.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P03-T14 — Verify class: duplicate financial effects against provider ground truth

**Task ID:** `P03-T14`
**Feature:** Cross-system duplicate-effect detector
**Commit:** `feat(db): add duplicate_financial_effects verify class with ground-truth interface`
**Priority:** High
**Dependencies:** `P03-T11`
**Estimated complexity:** M
**Contract references:** docs/09 §Defining `duplicate_financial_effects_total`; docs/08 §Recovery observability; CONVENTIONS §16 (ground truth via `SIMULATOR_DATABASE_URL`, role `fl_simulator_truth`, `--require-ground-truth`)
**Files:** create: `packages/database/src/verify/ground-truth.ts`, `test/integration/verify/duplicate-effects.test.ts`; modify: `packages/database/src/verify/index.ts`, `apps/cli/src/commands/verify.ts`, the P02 CLI config module in `packages/config`, `infra/docker/.env.example`, `docs/CONFIG.md`; must not touch: `migrations/**`, `apps/provider-simulator/**`

**Objective** — Implement the headline correctness metric exactly as docs/09 defines it — a comparison against provider ground truth, not a count that a unique index makes zero — against a documented query interface the P06 simulator must satisfy.

**Implementation instructions**
1. Ground-truth interface (created by P06-T03 in the `flowledger_sim` database, `SELECT` granted only to `fl_simulator_truth`; risk R-16):
   ```sql
   -- view in the simulator database
   truth.provider_financial_effects (
     provider_idempotency_key text NOT NULL,  -- the stable key FlowLedger sent
     payment_ref              text NOT NULL,  -- FlowLedger paymentId the adapter sent as provider metadata (docs/06 ProviderOperationCommand.paymentId)
     operation_type           text NOT NULL,  -- AUTHORIZE | CAPTURE | CANCEL | REFUND, as sent in the command
     effect_count             int  NOT NULL   -- provider-side financial effects applied under that (key, payment, type); >= 1
   )
   ```
   Query: `SELECT provider_idempotency_key, payment_ref, operation_type, effect_count FROM truth.provider_financial_effects`. Keys never applied are absent (P = 0). Per key, `P = Σ effect_count` over that key's rows; per payment and type, `E(payment, type) = Σ effect_count` over rows with that `payment_ref` and `operation_type`.
2. `packages/database/src/verify/ground-truth.ts`: `export function pgGroundTruth(url: string): GroundTruthSource` (own short-lived `pg.Client`, closes after the query). `packages/database` never reads env (CONVENTIONS §16).
3. Register `duplicate_financial_effects` in `runVerify` as a TypeScript class (not a `SqlVerifyClass`):
   - No `opts.groundTruth` → `SKIPPED`, `skipReason 'GROUND_TRUTH_UNAVAILABLE'`, gauge `unresolvedAmbiguity = null`.
   - Else read, in the verify snapshot: `SELECT o.id, o.type, o.status, o.provider_idempotency_key, (SELECT count(*) FROM ledger.journal_transactions t WHERE o.type IN ('CAPTURE','REFUND') AND t.posting_key = 'payment:' || o.payment_id || ':' || lower(o.type) || ':' || o.id) AS l FROM payments.payment_operations o`. rowsChecked = operations. For each: `P` = per-key sum (0 when absent), `L`, `S`. Finding (one per operation, `detail.conditions` = matched list) when any of: `P_GT_1` (P > 1); `L_GT_1` (L > 1); `SUCCEEDED_WITHOUT_POSTING` (P = 1, L = 0, S = `SUCCEEDED`, type `CAPTURE`/`REFUND`); `POSTING_WITHOUT_EFFECT` (P = 0, L = 1); `NO_EFFECT_RECORDED_FOR_APPLIED_EFFECT` (P = 1, S ∈ {`REJECTED`,`FAILED`}); `SUCCESS_WITHOUT_EFFECT` (P = 0, S = `SUCCEEDED`). Excluded (not findings): `UNKNOWN`/`REQUIRES_REVIEW` with P = 1 and L = 0 — counted into `gauges.unresolvedAmbiguity`; P = 0, L = 0, S = `REJECTED`.
   - Substituted-key check (addition to the docs/09 per-key conditions, which stay unchanged): a blind retry under a different provider key is invisible per key, so additionally, per `payment_ref`, compare provider effects by type with what FlowLedger allows: finding `PAYMENT_EFFECTS_EXCEED_ALLOWED` (subject = payment ID, `detail = { operationType, providerEffects, allowed }`) when `E(p,'AUTHORIZE') > 1`, `E(p,'CAPTURE') > 1`, `E(p,'CANCEL') > 1`, or `E(p,'REFUND') >` the number of `REFUND` operations of payment `p` in `payments.payment_operations` (same snapshot). Each such finding counts toward the class's `findings` (one per payment and type); `rowsChecked` stays the operation count.
   - `-- ponytail: loads all operations into memory; stream with a cursor if a benchmark run exceeds memory.`
4. CLI: read optional `SIMULATOR_DATABASE_URL` via the config module; when set, pass `pgGroundTruth(url)`; `--require-ground-truth` with no URL → `result FAIL`, `failureReasons ['GROUND_TRUTH_REQUIRED']`, exit 1. Unreachable simulator URL → exit 2. Add `SIMULATOR_DATABASE_URL=` (empty, synthetic comment) to `infra/docker/.env.example` and document it in `docs/CONFIG.md` (read only by `flowledger verify` and `packages/testkit`).

**Expected behavior** — No URL: `duplicate_financial_effects 0 0 0 rows checked (ground truth unavailable)`, exit 0; with `--require-ground-truth`: `RESULT: FAIL (ground truth required but unavailable)`, exit 1.

**Acceptance criteria**
- [ ] Fixture simulator database (created by the test in the same container: `CREATE DATABASE sim_fixture_<hex>`; `CREATE SCHEMA truth; CREATE TABLE truth.provider_financial_effects (provider_idempotency_key text NOT NULL, payment_ref text NOT NULL, operation_type text NOT NULL, effect_count int NOT NULL CHECK (effect_count >= 1))`) drives each condition: P = 2 → `P_GT_1`; succeeded capture with P = 1 and no posting → `SUCCEEDED_WITHOUT_POSTING`; succeeded capture with posting and P = 0 → `POSTING_WITHOUT_EFFECT` + `SUCCESS_WITHOUT_EFFECT` (one finding, two conditions); `REJECTED` with P = 1 → `NO_EFFECT_RECORDED_FOR_APPLIED_EFFECT`; succeeded authorize with P = 0 → `SUCCESS_WITHOUT_EFFECT`; substituted-key duplicate (payment X has one succeeded `CAPTURE` operation with P = 1 under its key, plus a second truth row for X/`CAPTURE` under a different key) → `PAYMENT_EFFECTS_EXCEED_ALLOWED` for X/`CAPTURE` although every per-key condition is clean; three `REFUND` effects for a payment with two refund operations → `PAYMENT_EFFECTS_EXCEED_ALLOWED` for `REFUND`.
- [ ] `UNKNOWN` capture with P = 1, L = 0 → no finding, gauge = 1; `REJECTED` with P = 0 → no finding, gauge unaffected.
- [ ] A clean fixture (every succeeded capture/refund posted once, P = 1; two refund effects for a payment with two refund operations) → 0 findings.
- [ ] `--require-ground-truth` semantics and exit codes as above.
- [ ] No module outside `apps/cli` and `packages/testkit` references `SIMULATOR_DATABASE_URL` (grep check in the test).

**Testing requirements** — `test/integration/verify/duplicate-effects.test.ts` (operations via P02 builders/replica fixture helpers; postings via harness). Command: `pnpm vitest run --project integration test/integration/verify/duplicate-effects.test.ts`.

**Non-goals** — No simulator (P06). No metric export (P11). No reconciliation-based approximation for a real provider (out of MVP).

**Handoff checklist**
- [ ] Removing the `UNKNOWN` exclusion was observed to fail the gauge case, then restored.
- [ ] Removing the per-payment check was observed to miss the substituted-key fixture, then restored.
- [ ] `pnpm check` and `pnpm test:integration` green.

---

### P03-T15 — CI wiring: `pnpm verify:ledger` in the integration job

**Task ID:** `P03-T15`
**Feature:** Invariant checker in CI
**Commit:** `ci: run pnpm verify:ledger in the integration job`
**Priority:** High
**Dependencies:** `P03-T11`
**Estimated complexity:** S
**Contract references:** docs/10 §M3 ("Wire flowledger verify into CI"), §CI and verification lanes; docs/09 §Continuous invariant checker; CONVENTIONS §4
**Files:** create: none; modify: `.github/workflows/ci.yml`, `package.json` (root); must not touch: application code

**Objective** — Make every database/domain change run the checker against a migrated and seeded database and fail the build on any finding.

**Implementation instructions**
1. Root `package.json`: ensure `"verify:ledger": "pnpm --filter @flowledger/app-cli exec flowledger verify"` (replace a P00 placeholder if present).
2. `.github/workflows/ci.yml`, in the existing integration job, after `pnpm test:integration`, add:
   ```yaml
   - name: Ledger invariant checker
     env:
       DATABASE_URL: ${{ env.MIGRATION_DATABASE_URL }}
     run: |
       pnpm db:up
       pnpm db:migrate
       pnpm db:seed
       pnpm verify:ledger
       pnpm verify:ledger -- --json > verify-report.json
   - name: Upload verify report
     if: always()
     uses: actions/upload-artifact@v4
     with: { name: verify-report, path: verify-report.json }
   ```
   `MIGRATION_DATABASE_URL` is set at job level to the `fl_migration_owner` URL from `infra/docker/.env.example` (synthetic local password). `--require-ground-truth` is **not** passed until P06 provides the simulator; P06 adds it (risk R-17).
3. The populated-database check runs inside `pnpm test:integration` via `test/integration/verify/cli.test.ts` (T11) and the gate test (GATE), which spawn the CLI against databases with ledger traffic.

**Expected behavior** — The integration job shows the verify table; a corrupted database would exit 1 and fail the job.

**Acceptance criteria**
- [ ] The CI integration job contains the step and passes on the P03 head.
- [ ] Locally, `pnpm db:up && pnpm db:migrate && pnpm db:seed && pnpm verify:ledger` exits 0 and prints the human table.
- [ ] Temporarily corrupting the compose database (`skewBalance` via a one-off psql statement in a scratch branch) makes the step fail (observed once; not committed).

**Testing requirements** — Run the workflow on the task branch; record the job URL in the commit body. Local command sequence above.

**Non-goals** — No nightly lane (docs/10 nightly verify runs after the full e2e matrix exists, P12). No benchmark wiring.

**Handoff checklist**
- [ ] Job green; artifact uploaded.
- [ ] `pnpm check` green.

---

### P03-GATE — Ledger-ready milestone verification

**Task ID:** `P03-GATE`
**Feature:** M3 exit gate
**Commit:** `test(ledger): add P03 gate suite and evidence`
**Priority:** Critical
**Dependencies:** `P03-T01` … `P03-T15`
**Estimated complexity:** M
**Contract references:** docs/10 §M3 Test and acceptance criteria; docs/09 §Quality gates (Ledger-ready); docs/07 §Schema acceptance tests (ledger rows); docs/08 §Required failure-injection tests Ledger
**Files:** create: `test/integration/ledger/p03-gate.test.ts`, `docs/evidence/P03.md`; modify: none; must not touch: any non-test source

**Objective** — Prove the milestone end to end on fresh databases at N=1 and N=32: randomized ledger traffic through the harness and the correction entry point, then `flowledger verify` with zero findings in every active class, and the full table of M3 acceptance bullets mapped to passing tests.

**Implementation instructions**
1. `test/integration/ledger/p03-gate.test.ts`, for each `bucketCount` in `[1, 32]` on `createLedgerDatabase`:
   - Build 3 merchants (accounts via `open_merchant_accounts`), 12 payments with authorize/capture/refund operation rows (P02 builders + replica fixture helpers for `SUCCEEDED` rows) so that every `SUCCEEDED` capture/refund gets exactly one harness posting built from `resolve_recipe(capture_recipe|refund_recipe)` with fee reversal from `incremental_fee_reversal`.
   - 8 concurrent workers post the captures/refunds in random order with 20% duplicate retries; then run 3 full reversals and 2 adjustments through `request_correction` → `decide_correction` (second principal) → `post_approved_correction` as `fl_correction`.
   - Assert: `runVerify(pool, { requireGroundTruth: false })` → `result 'PASS'`; `journal_balance`, `projection_equality`, `bucket_aggregation`, `payment_totals`, `reservation_integrity`, `posting_cardinality` are `OK` with `rowsChecked > 0`; `orphan_detection` and `settlement_membership` are `SKIPPED` with `TABLE_ABSENT`; `duplicate_financial_effects` `SKIPPED` with `GROUND_TRUTH_UNAVAILABLE`; `bucketCount` equals N.
   - Spawn the CLI (`verify --json`) against the same database → exit 0 and identical class counts.
   - Apply `skewBalance` to bucket 0 of `platform.fee_revenue` → CLI exit 1 with `bucket_aggregation` and `projection_equality` findings.
   - Re-run the docs/07 striped acceptance row: every striped logical account has exactly N contiguous buckets.
2. `docs/evidence/P03.md`: commit SHA, date, PostgreSQL version, the human `flowledger verify` output for N=1 and N=32 from the gate run, the list of test files with pass counts, and the traceability table from this file with each row marked pass.

**Expected behavior** — Both bucket counts PASS with nonzero rows checked in the six active classes.

**Acceptance criteria**
- [ ] Gate test passes at N=1 and N=32.
- [ ] Every row of the Requirements traceability table below points at a passing test.
- [ ] `pnpm check`, `pnpm test:integration`, and the CI integration job (with `pnpm verify:ledger`) are green.
- [ ] `docs/evidence/P03.md` contains both verify outputs.

**Testing requirements** — Command: `pnpm vitest run --project integration test/integration/ledger/p03-gate.test.ts`, then `pnpm test:integration`.

**Non-goals** — No feature code. No benchmark numbers (P12/P13).

**Handoff checklist**
- [ ] Evidence file committed with real output (no hand-edited numbers).
- [ ] All P03 tasks' handoff checklists ticked.

---

## Parallelization

Dependency graph: `T01 → T02 → {T03, T04}`; `T01 + P01-GATE → T05`; `{T03, T04, T05} → T06 → {T07, T09, T11}`; `T07 → T08`; `T09 → T10`; `T11 → {T12, T13, T14, T15}`; all → `GATE`.

Can run concurrently:
- T03 ‖ T04 ‖ T05 (after T02/T01).
- T07 ‖ T09 ‖ T11 (after T06).
- T08 ‖ T10 ‖ T12 ‖ T13 ‖ T14 ‖ T15.

Shared files that conflict (merge in the listed order, rebase the rest):

| File | Tasks | Rule |
| --- | --- | --- |
| `migrations/03NN_*.sql` | T01–T10 | Merge in migration-number order (0300 … 0380). The runner applies files lexically; merging 0370 before 0360 would apply 0360 out of order on persistent dev databases (risk R-18). |
| `packages/testkit/src/ledger.ts` | T03 (creates), T06 | T06 after T03. |
| `packages/database/src/functions/ledger.ts` | T03 (creates), T09, T10 | Append-only exports. |
| `packages/database/src/errors.ts` | T06, T09 | Append-only code-union members. |
| `packages/database/src/verify/index.ts` | T11 (creates), T12, T13, T14 | Each adds one import + registry entry. |
| `packages/testkit/src/ledger-corruption.ts` | T11 (creates), T12, T13 | Append-only helpers. |
| `apps/cli/src/commands/verify.ts`, `packages/config` CLI module | T11, T14 | T14 after T11. |

## Requirements traceability

| Requirement (source doc §/bullet) | Task ID(s) | Verification (test file :: case) |
| --- | --- | --- |
| docs/10 M3: ledgers, accounts, zero balance creation, headers, entries, synchronous projections | T02, T04, T06 | `accounts.test.ts :: create_account inserts balance row`; `journal-tables.test.ts :: checks`; `post-journal.test.ts :: balance versions` |
| docs/10 M3: striping columns + derivation checks, seeded bucket set, `bucket_for_payment`, logical view; no caller chooses bucket | T01, T02, T03, T07 | `helpers.test.ts :: golden vectors`; `accounts.test.ts :: code derivation`; `seed.test.ts :: N=1/N=32 contiguity`; `recipes.test.ts :: bucket resolution` |
| docs/10 M3: clearing allows negative, payable does not | T03, T06 | `seed.test.ts :: allow_negative flags`; `post-journal.test.ts :: clearing negative ok / payable NEGATIVE_PROTECTED_BALANCE` |
| docs/10 M3: `flowledger verify` with every docs/09 class; absent tables report 0 rows | T11–T14 | `ledger-classes.test.ts`, `payment-classes.test.ts`, `recovery-classes.test.ts :: table absent output`, `duplicate-effects.test.ts` |
| docs/10 M3: verify in CI | T15 | CI integration job step; `cli.test.ts` |
| docs/10 M3: private canonical routine + dual-approved correction entry point; `post_payment_operation` deferred | T06, T09 | `post-journal.test.ts :: execute privilege matrix`; `corrections.test.ts` |
| docs/10 M3: canonical lock ordering + protected negative checks | T06, T08 | `concurrency.test.ts :: case 3, case 6 (0 deadlocks)` |
| docs/10 M3: derive merchant, currency, accounts, hash in DB | T05, T06, T07, T09 | `posting-hash.test.ts :: P01 vectors`; `corrections.test.ts :: derived lines` |
| docs/10 M3: pure capture/refund recipes + golden vectors incl. proportional fee reversal | T07 | `recipes.test.ts :: golden table, fee properties` |
| docs/10 M3: idempotent replay / changed hash conflicts | T06, T08 | `post-journal.test.ts :: replay, IDEMPOTENCY_CONFLICT`; `concurrency.test.ts :: case 2` |
| docs/10 M3: full reversal links + dual-approved correction | T09 | `corrections.test.ts :: net zero, duplicate reversal, same principal` |
| docs/10 M3: balance rebuild/audit tooling | T10, T11 | `rebuild.test.ts`; `ledger-classes.test.ts :: projection_equality` |
| docs/10 M3 test: unbalanced/cross-currency/cross-ledger/cross-merchant/zero-entry/closed/negative-protected fail | T06 | `post-journal.test.ts :: rejection cases` |
| docs/10 M3 test: direct insert/update/delete/truncate fails for every runtime role | T04 | `journal-tables.test.ts :: role matrix` |
| docs/10 M3 test: 100 concurrent identical postings → one transaction; runtime roles cannot execute private routine | T08, T09, T06 | `concurrency.test.ts :: case 1`; `corrections.test.ts :: 100 concurrent`; `post-journal.test.ts :: execute privilege matrix` |
| docs/10 M3 test: random balanced postings rebuild to projection | T08 | `properties.test.ts :: property 1` |
| docs/10 M3 test: random order and retries do not change results | T08 | `properties.test.ts :: property 2` |
| docs/10 M3 test: full reversals net zero and cannot be duplicated | T09 | `corrections.test.ts` |
| docs/10 M3 test: deadlock/serialization retries keep posting key and converge | T08 | `concurrency.test.ts :: case 7` |
| docs/10 M3 test: contiguous bucket set; code agrees; merchant cannot be striped | T02, T03 | `accounts.test.ts :: merchant striped rejected`; `seed.test.ts` |
| docs/10 M3 test: bucket stable across sessions/processes; retry → same bucket, original tx | T01, T08, T10 | `helpers.test.ts :: two sessions`; `properties.test.ts :: property 3`; `crash-points.test.ts :: case 7` |
| docs/10 M3 test: bucket sums = view = rebuild at N=1 and seeded N | T08, GATE | `properties.test.ts :: property 4`; `p03-gate.test.ts` |
| docs/10 M3 test: different buckets concurrent; same bucket serializes without deadlock | T08 | `concurrency.test.ts :: cases 4, 5, 6, 9` |
| docs/10 M3 test: verify on populated DB, per-class counts, fails build; corrupted fixtures detected by correct class | T11–T15, GATE | `ledger-classes.test.ts :: corruptions`; `p03-gate.test.ts` |
| docs/02 posting invariants 1–9 | T05, T06 | `post-journal.test.ts` (each rule); outbox case |
| docs/02 §Idempotent posting behavior table (5 rows) | T06, T08 | `post-journal.test.ts :: replay/conflict`; `concurrency.test.ts :: cases 1, 2` |
| docs/02 §Concurrency: two debits that collectively overdraw cannot both commit | T08 | `concurrency.test.ts :: case 3` |
| docs/02 §Immutability; docs/07 §Mutability rules (journal, balances, accounts, corrections) | T02, T04, T09 | `accounts.test.ts :: triggers`; `journal-tables.test.ts :: JOURNAL_IMMUTABLE`; `corrections.test.ts :: content immutable` |
| docs/02 §Reversals (one reversal per original, swaps sides, reason/actor/separate key) | T09 | `corrections.test.ts` |
| docs/02 MVP: closed-account correction requires second operator | T09 | `corrections.test.ts :: reversal on closed account` |
| docs/02 property tests: fee allocation (total = F, ≤1 unit variance, no over-reversal) | T07 | `recipes.test.ts :: fee properties` |
| docs/07 accounts: one balance row per account (deferred trigger + create_account) | T02 | `accounts.test.ts :: ACCOUNT_WITHOUT_BALANCE` |
| docs/07 journal: one tx per operation; one reversal; composite tenant FKs | T04 | `journal-tables.test.ts` |
| docs/07 protected posting steps 1–9 | T06 | `post-journal.test.ts` |
| docs/07 correction_requests: distinct approver, immutable content, one live reversal request | T09 | `corrections.test.ts` |
| docs/07 tenant isolation item 7 (merchant cannot read other merchant's journal; buckets operator-only) | T02, T04 | `journal-tables.test.ts :: RLS`; `accounts.test.ts :: role matrix` |
| docs/07 schema acceptance: striped completeness; bucket stability; bucket sum = view = rebuild; direct DML fails; posting function rejects invalid postings; concurrent identical → one tx/envelope; rebuilt = projection | T02, T03, T04, T06, T08 | as above |
| docs/07 schema acceptance: roll back together at every injected pre-commit failure point (ledger part) | T10 | `crash-points.test.ts :: cases 1–4` |
| docs/09 §Continuous invariant checker: 9 classes, per-class counts, nonzero fails | T11–T14 | verify tests |
| docs/09 §Defining duplicate_financial_effects_total (6 conditions, 2 exclusions, gauges) | T14 | `duplicate-effects.test.ts` |
| docs/09 §Property tests Ledger (7 bullets) | T08 | `properties.test.ts`, `concurrency.test.ts :: case 3` |
| docs/09 §PostgreSQL integration: role cannot bypass posting; 100 concurrent ledger requests; lock order + retries incl. same bucket; striped completeness; rebuild after randomized traffic | T04, T06, T08 | as above |
| docs/08 §Ledger crash points: before posting / during posting / lost commit / committed then crash / same key same hash / same key different hash / projection divergence | T10, T11 | `crash-points.test.ts :: cases 1–6`; `rebuild.test.ts`; `ledger-classes.test.ts :: projection` |
| docs/08 §Required failure-injection Ledger: lost ack retry; changed-hash conflict; rebuild incl. striped sum; retry same bucket | T10, T08 | `crash-points.test.ts :: cases 5–7`; `properties.test.ts :: property 4` |
| docs/08 §Required failure-injection Ledger: statement-level injection in capture/refund result transactions; three-source duplicate race | P07 | out of scope (needs `post_payment_operation`) |
| docs/08 §Runbook ledger discrepancy: rebuild projection; compensating correction | T10, T09 | `rebuild.test.ts`; `corrections.test.ts :: adjustment` |
| ADR-0005 projection version monotonic, rebuildable | T06, T10, T11 | `post-journal.test.ts :: version`; `rebuild.test.ts` |
| ADR-0007 golden hash vectors identical in TS and SQL | T05 | `posting-hash.test.ts` |
| ADR-0008 refund reversal at confirmation from cumulative refunds | T07 | `recipes.test.ts` |
| ADR-0010 deterministic bucket, N fixed per env, retry same bucket | T01, T03, T08 | `helpers.test.ts`; `seed.test.ts`; `properties.test.ts` |
| CONVENTIONS §8 bucket GUC default 32, N=1/N=32 databases | T03 | `seed.test.ts`; `createLedgerDatabase` |
| CONVENTIONS §16 ground truth unavailable / `--require-ground-truth` | T14 | `duplicate-effects.test.ts` |

## Phase risks / open questions

| ID | Risk / question | Impact | Severity | Recommended resolution | Blocked tasks |
| --- | --- | --- | --- | --- | --- |
| R-01 | P01 export names are now fixed (`computePostingHash`, `incrementalFeeReversal`); only the exact canonical hash object are assumed. The object here (T05) follows docs/07 §ledger.journal_entries; if P01 hashes a different object, TS and SQL disagree. | Replay prechecks reject valid retries | High | P01 and P03 adopt the T05 object (keys `correctionRequestId, currency, entries[accountId, amountMinor, ordinal, side], hashVersion, ledgerId, merchantId, operationType, paymentId, paymentOperationId, recipeVersion, reversalOfTransactionId`) and the V1 digest `df092e45…22efa` as a shared vector. | T05, T07 |
| R-02 | Prefixes `led_`, `lac_`, `lcr_` are defined in docs/07:771, :783, :917 but absent from `schemas/common/entity-ids.v1.schema.json`; CONVENTIONS:145 says stop on absent prefixes. | Contract inconsistency | Medium | Treat docs/07 as authoritative for DB-internal IDs (they never appear on merchant wire or in events); add them to the entity-ids schema in a separate contracts commit. P03 proceeds with SQL checks only. | none |
| R-03 | Bucket entropy span not fully specified (docs/07:822 "ULID entropy"; docs/02 `ulid_entropy_bigint`; ADR-0010 `crockford_ulid_entropy`). | Different implementations pick different buckets | Low | [ASSUMPTION] last 16 ULID chars, big-endian base-32, golden vectors in T01. | none |
| R-04 | Adjustment posting key not in docs/02:181–185. | Name drift | Low | [ASSUMPTION] `ledger:adjustment:{correctionRequestId}`; add to docs/02. | none |
| R-05 | Logical codes for merchant clearing/payable and rounding accounts are unnamed (docs/07 names only `platform.processor_receivable`, `platform.fee_revenue`). | Name drift across P07/P10 | Medium | Use `merchant.clearing`, `merchant.payable`, `platform.rounding_expense`, `platform.rounding_revenue`; record in docs/07. | none |
| R-06 | docs/07:808 `lpad(bucket_index, 2)` pads with spaces by default in PostgreSQL. | Codes like `platform.fee_revenue. 3` | Low | [ASSUMPTION] zero padding `lpad(bucket_index::text, 2, '0')`; fix docs/07 wording. | none |
| R-07 | docs/02:66 fee revenue negative policy "allowed through explicit adjustments" and :69 rounding "expense or revenue pair" don't map to one `allow_negative` boolean. | Policy ambiguity | Low | `allow_negative = true` for fee revenue buckets; seed an expense and a revenue rounding account. | none |
| R-08 | CONVENTIONS §7 says `DomainError.code` equals a docs/05 problem code; ledger internal failures have none. | Error mapping gap | Low | Add internal codes `LEDGER_INVARIANT_VIOLATION`, `LEDGER_CORRECTION_REJECTED` (map to `500 INTERNAL_ERROR` if surfaced); amend CONVENTIONS §7. | none |
| R-09 | Seed hard-coded `environment = 'LOCAL'`; deployed sandbox needs `SANDBOX`. | — | Low | **Closed:** seed reads GUC `flowledger.ledger_environment` (P02 runner, env `LEDGER_ENVIRONMENT`, default `LOCAL`); only `legal_entity_code 'FLOWLEDGER_PLATFORM'` remains an assumption. | — |
| R-10 | docs/02:140 "exactly one merchant" vs a legal capture with fee = gross (docs/10 M1 vector) that has no merchant line. | Valid capture rejected | Medium | Interpret as "at most one merchant"; amend docs/02. | none |
| R-11 | `source` for `ledger.transaction.posted.v1` unspecified (docs/04 shows only `flowledger.payment`). | Event drift | Low | [ASSUMPTION] `flowledger.ledger`. | none |
| R-12 | `post_journal_internal` has no `settlementBatchId` input; docs/04 requires it for `SETTLEMENT` events. | P10 cannot emit a valid settlement ledger event | Medium | P10 adds a new overload or a forward migration that replaces the function with an extra `p_settlement_batch_id text` parameter and updates all callers. | none (P10) |
| R-13 | `messaging.insert_outbox` (P02) may validate its invoker role; `ledger_function_owner` must be allowed, and `fl_migration_owner` must be able to grant EXECUTE on it. | Every posting fails at step 12 | High | P02 allowlists `ledger_function_owner` (and `settlement_function_owner`) and makes `fl_migration_owner` a member of every `*_function_owner` role. | T06 |
| R-14 | Corrections and projection rebuild are "audited" per docs/02/08, but the audit table (`audit.operator_actions`) is created in P10-T11. | Audit gap until P10 | Medium | P10 wires audit rows for these operator paths (P10-T11–T14); P11 consumes the table, never recreates it. | none |
| R-15 | Orphan-detection ownership rules are derived, not specified; outbox envelopes archived after 30 days hide execute commands. | False positives on old REQUESTED operations | Medium | P08 refines rules (e.g. require the due-work scheduler's record) and keeps the T13 fixture test green. | none |
| R-16 | Ground-truth relation keyed only by provider idempotency key would miss a blind retry under a substituted key. | Duplicate effect escapes the detector | High | **Resolved with P06:** `truth.provider_financial_effects(provider_idempotency_key, payment_ref, operation_type, effect_count)` (P06-T03); T14 adds the per-payment `PAYMENT_EFFECTS_EXCEED_ALLOWED` check; P06's gate runs T14's test against the real simulator. | T14 |
| R-17 | CONVENTIONS §16 says CI always passes `--require-ground-truth`, impossible before P06. | CI would fail in P03–P05 | Medium | Omit the flag until P06; P06 adds it to the T15 step. | T15 |
| R-18 | Parallel migration tasks merged out of numeric order apply out of order on persistent databases. | Divergent dev schemas | Low | Merge migrations in number order (Parallelization table). | none |
| R-19 | docs/07 allows account attribute changes before first posting; T02 forbids them always. | None functionally | Low | Keep stricter rule; note in docs/07. | none |
| R-20 | Verify in CI runs as `fl_migration_owner`; `fl_operator_readonly` lacks payments/messaging read and RLS policies. | Operators cannot run verify least-privilege | Low | P11 grants operator read policies and switches the documented role. | none |
| R-21 | CONVENTIONS references `docs/execution-plan/README.md` §5.4/§6.0/§10, which does not exist yet. | Agents cannot follow those references | Low | Coordinator creates the README. | none |
| R-22 | The duplicate detector computes `L` only for CAPTURE/REFUND (authorize/cancel never post); `P > 1` and status conditions apply to all types. | Interpretation of docs/09 | Low | Keep; state in docs/09. | none |
