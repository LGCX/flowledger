-- 0310_ledger_accounts.sql — ledgers, accounts, the balance projection, and the logical view.
--
-- Two ideas shape this file.
--
-- An account's identity is *derived*, not stored twice: `code` must equal `logical_code` plus the padded
-- bucket suffix, so the striping can never disagree with the name. `normal_side` likewise follows from
-- `account_class`, so a REVENUE account cannot be declared debit-normal.
--
-- An account exists only with its balance row. The balance is a projection maintained by the posting
-- routine that arrives in T04; a row without one would be an account nobody can post to and a balance
-- that cannot be read, so the pairing is enforced by a deferred constraint trigger at commit rather than
-- left to callers.

-- 1. Tables --------------------------------------------------------------------------------------

CREATE TABLE ledger.ledgers (
  id text COLLATE "C" PRIMARY KEY,
  legal_entity_code text NOT NULL,
  environment text NOT NULL,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT ledgers_id_format CHECK (id ~ '^led_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT ledgers_legal_entity_code CHECK (legal_entity_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT ledgers_environment CHECK (environment IN ('LOCAL', 'TEST', 'SANDBOX')),
  CONSTRAINT ledgers_currency CHECK (currency = 'USD'),
  CONSTRAINT ledgers_legal_entity_environment_currency_key
    UNIQUE (legal_entity_code, environment, currency),
  -- Carried so a child row's FK can prove the currency matches its ledger's.
  CONSTRAINT ledgers_id_currency_key UNIQUE (id, currency)
);

CREATE TABLE ledger.accounts (
  id text COLLATE "C" PRIMARY KEY,
  ledger_id text COLLATE "C" NOT NULL,
  owner_type text NOT NULL,
  owner_id text COLLATE "C",
  logical_code text NOT NULL,
  bucket_index smallint,
  bucket_count smallint,
  code text NOT NULL,
  account_class text NOT NULL,
  normal_side text NOT NULL,
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  allow_negative boolean NOT NULL DEFAULT false,
  merchant_postable boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,

  CONSTRAINT accounts_id_format CHECK (id ~ '^lac_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT accounts_ledger_currency_fkey
    FOREIGN KEY (ledger_id, currency) REFERENCES ledger.ledgers (id, currency),
  CONSTRAINT accounts_owner_fkey FOREIGN KEY (owner_id) REFERENCES identity.merchants (id),

  -- Identity carried for the journal FKs that arrive in T04.
  CONSTRAINT accounts_ledger_id_currency_key UNIQUE (ledger_id, id, currency),
  CONSTRAINT accounts_ledger_id_normal_side_key UNIQUE (ledger_id, id, normal_side),

  CONSTRAINT accounts_owner_type CHECK (owner_type IN ('PLATFORM', 'MERCHANT')),
  CONSTRAINT accounts_owner_id_iff_merchant
    CHECK ((owner_type = 'MERCHANT') = (owner_id IS NOT NULL)),

  CONSTRAINT accounts_code_name_key
    UNIQUE NULLS NOT DISTINCT (ledger_id, owner_type, owner_id, code, currency),
  CONSTRAINT accounts_logical_identity_key
    UNIQUE NULLS NOT DISTINCT (ledger_id, owner_type, owner_id, logical_code, bucket_index, currency),

  CONSTRAINT accounts_logical_code_format
    CHECK (logical_code ~ '^(platform|merchant)\.[a-z][a-z0-9_]{0,62}$'),
  -- [ASSUMPTION] The logical-code prefix names the owner, so the two cannot drift apart (risk R-05).
  CONSTRAINT accounts_logical_code_owner
    CHECK (split_part(logical_code, '.', 1) = lower(owner_type)),

  -- Striping: both columns or neither, and only a platform account may be striped.
  CONSTRAINT accounts_bucket_pair CHECK ((bucket_index IS NULL) = (bucket_count IS NULL)),
  CONSTRAINT accounts_bucket_range
    CHECK (
      bucket_count IS NULL
      OR (bucket_count BETWEEN 1 AND 100 AND bucket_index >= 0 AND bucket_index < bucket_count)
    ),
  CONSTRAINT accounts_bucket_platform_only
    CHECK (owner_type = 'PLATFORM' OR bucket_index IS NULL),

  -- The derivation proof: the stored code is exactly the logical code plus its bucket suffix.
  CONSTRAINT accounts_code_derived
    CHECK (
      code = CASE
               WHEN bucket_index IS NULL THEN logical_code
               ELSE logical_code || '.' || lpad(bucket_index::text, 2, '0')
             END
    ),

  CONSTRAINT accounts_class
    CHECK (account_class IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  -- A class determines its normal side; an EXPENSE account cannot be declared credit-normal.
  CONSTRAINT accounts_normal_side
    CHECK (
      normal_side = CASE WHEN account_class IN ('ASSET', 'EXPENSE') THEN 'DEBIT' ELSE 'CREDIT' END
    ),

  CONSTRAINT accounts_currency CHECK (currency = 'USD'),
  CONSTRAINT accounts_status CHECK (status IN ('OPEN', 'CLOSED')),
  CONSTRAINT accounts_closed_at CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)),
  CONSTRAINT accounts_merchant_postable
    CHECK (owner_type = 'PLATFORM' OR NOT merchant_postable)
);

CREATE UNIQUE INDEX accounts_owner_code_key
  ON ledger.accounts (owner_id, code)
  WHERE owner_type = 'MERCHANT';

CREATE INDEX accounts_platform_lookup
  ON ledger.accounts (ledger_id, logical_code, bucket_index)
  WHERE owner_type = 'PLATFORM';

CREATE INDEX accounts_owner ON ledger.accounts (owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE ledger.account_balances (
  account_id text COLLATE "C" PRIMARY KEY,
  ledger_id text COLLATE "C" NOT NULL,
  normal_side text NOT NULL,
  debit_total_minor bigint NOT NULL DEFAULT 0,
  credit_total_minor bigint NOT NULL DEFAULT 0,
  normal_balance_minor bigint NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT account_balances_account_fkey
    FOREIGN KEY (ledger_id, account_id, normal_side)
    REFERENCES ledger.accounts (ledger_id, id, normal_side),
  CONSTRAINT account_balances_totals_nonnegative
    CHECK (debit_total_minor >= 0 AND credit_total_minor >= 0),
  CONSTRAINT account_balances_version CHECK (version >= 0),
  -- The projection is not free-standing: the normal balance must agree with the two totals.
  CONSTRAINT account_balances_normal_balance
    CHECK (
      normal_balance_minor = CASE normal_side
                               WHEN 'DEBIT' THEN debit_total_minor - credit_total_minor
                               ELSE credit_total_minor - debit_total_minor
                             END
    )
);

-- 2. Triggers ------------------------------------------------------------------------------------
--
-- Trigger functions run as the mutating role, so they fire for the table owner too: an operator with
-- direct DML still cannot rewrite an account or delete a balance.

CREATE FUNCTION ledger.trg_accounts_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  -- Only the closing transition may change anything. docs/07 permits edits before the first posting;
  -- forbidding them always is stricter and simpler, and nothing needs them.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
     OR NEW.owner_type IS DISTINCT FROM OLD.owner_type
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.logical_code IS DISTINCT FROM OLD.logical_code
     OR NEW.bucket_index IS DISTINCT FROM OLD.bucket_index
     OR NEW.bucket_count IS DISTINCT FROM OLD.bucket_count
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.account_class IS DISTINCT FROM OLD.account_class
     OR NEW.normal_side IS DISTINCT FROM OLD.normal_side
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.allow_negative IS DISTINCT FROM OLD.allow_negative
     OR NEW.merchant_postable IS DISTINCT FROM OLD.merchant_postable
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    PERFORM public.fl_raise_domain('LEDGER_INVARIANT_VIOLATION', jsonb_build_object('rule', 'ACCOUNT_IMMUTABLE'));
  END IF;

  IF OLD.status = NEW.status AND OLD.closed_at IS DISTINCT FROM NEW.closed_at THEN
    PERFORM public.fl_raise_domain('LEDGER_INVARIANT_VIOLATION', jsonb_build_object('rule', 'ACCOUNT_IMMUTABLE'));
  END IF;

  -- Closing is one way: an account cannot be reopened, because postings may already reference it.
  IF OLD.status = 'CLOSED' AND NEW.status = 'OPEN' THEN
    PERFORM public.fl_raise_domain('LEDGER_INVARIANT_VIOLATION', jsonb_build_object('rule', 'ACCOUNT_CLOSE_ONE_WAY'));
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER accounts_guard
  BEFORE UPDATE ON ledger.accounts
  FOR EACH ROW EXECUTE FUNCTION ledger.trg_accounts_guard();

CREATE FUNCTION ledger.trg_accounts_no_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.fl_raise_domain('LEDGER_INVARIANT_VIOLATION', jsonb_build_object('rule', 'ACCOUNT_IMMUTABLE'));
  RETURN NULL;
END $$;

CREATE TRIGGER accounts_no_delete
  BEFORE DELETE ON ledger.accounts
  FOR EACH ROW EXECUTE FUNCTION ledger.trg_accounts_no_delete();

CREATE TRIGGER accounts_no_truncate
  BEFORE TRUNCATE ON ledger.accounts
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.trg_accounts_no_delete();

CREATE FUNCTION ledger.trg_accounts_require_balance() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  -- Deferred to commit: `create_account` inserts the account and its balance in either order, and an
  -- immediate check would reject the first statement of a correct pair.
  IF NOT EXISTS (SELECT 1 FROM ledger.account_balances b WHERE b.account_id = NEW.id) THEN
    PERFORM public.fl_raise_domain('LEDGER_INVARIANT_VIOLATION', jsonb_build_object('rule', 'ACCOUNT_WITHOUT_BALANCE'));
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER accounts_require_balance
  AFTER INSERT ON ledger.accounts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.trg_accounts_require_balance();

CREATE FUNCTION ledger.trg_account_balances_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
     OR NEW.normal_side IS DISTINCT FROM OLD.normal_side THEN
    PERFORM public.fl_raise_domain('LEDGER_INVARIANT_VIOLATION', jsonb_build_object('rule', 'BALANCE_IDENTITY_IMMUTABLE'));
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    PERFORM public.fl_raise_domain('LEDGER_INVARIANT_VIOLATION', jsonb_build_object('rule', 'BALANCE_VERSION_NOT_INCREMENTED'));
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER account_balances_guard
  BEFORE UPDATE ON ledger.account_balances
  FOR EACH ROW EXECUTE FUNCTION ledger.trg_account_balances_guard();

-- A balance row is never removed. This needs its own function: a statement-level TRUNCATE trigger has no
-- NEW/OLD, so the update guard above would fall through its comparisons and let the truncate succeed.
CREATE FUNCTION ledger.trg_account_balances_no_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.fl_raise_domain('LEDGER_INVARIANT_VIOLATION', jsonb_build_object('rule', 'BALANCE_IMMUTABLE'));
  RETURN NULL;
END $$;

CREATE TRIGGER account_balances_no_delete
  BEFORE DELETE ON ledger.account_balances
  FOR EACH ROW EXECUTE FUNCTION ledger.trg_account_balances_no_mutation();

CREATE TRIGGER account_balances_no_truncate
  BEFORE TRUNCATE ON ledger.account_balances
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.trg_account_balances_no_mutation();

-- 3. Account creation ------------------------------------------------------------------------------

CREATE FUNCTION ledger.create_account(
  p_ledger_id text,
  p_owner_type text,
  p_owner_id text,
  p_logical_code text,
  p_bucket_index smallint,
  p_bucket_count smallint,
  p_account_class text,
  p_allow_negative boolean,
  p_merchant_postable boolean
) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER VOLATILE
  SET search_path = pg_catalog, ledger
AS $$
DECLARE
  v_currency text;
  v_account_id text := ledger.generate_id('lac');
  v_normal_side text;
  v_code text;
BEGIN
  -- The ledger decides the currency: an account cannot disagree with the ledger it belongs to.
  SELECT l.currency INTO v_currency FROM ledger.ledgers l WHERE l.id = p_ledger_id;
  IF v_currency IS NULL THEN
    PERFORM public.fl_raise_domain('LEDGER_INVARIANT_VIOLATION', jsonb_build_object('rule', 'LEDGER_NOT_FOUND'));
  END IF;

  v_normal_side := CASE WHEN p_account_class IN ('ASSET', 'EXPENSE') THEN 'DEBIT' ELSE 'CREDIT' END;
  v_code := CASE
              WHEN p_bucket_index IS NULL THEN p_logical_code
              ELSE p_logical_code || '.' || lpad(p_bucket_index::text, 2, '0')
            END;

  INSERT INTO ledger.accounts (
    id, ledger_id, owner_type, owner_id, logical_code, bucket_index, bucket_count, code,
    account_class, normal_side, currency, status, allow_negative, merchant_postable
  ) VALUES (
    v_account_id, p_ledger_id, p_owner_type, p_owner_id, p_logical_code, p_bucket_index, p_bucket_count,
    v_code, p_account_class, v_normal_side, v_currency, 'OPEN', p_allow_negative, p_merchant_postable
  );

  INSERT INTO ledger.account_balances (account_id, ledger_id, normal_side)
  VALUES (v_account_id, p_ledger_id, v_normal_side);

  RETURN v_account_id;
END $$;

-- 4. View ----------------------------------------------------------------------------------------

-- One row per logical account, summing its stripes. `numeric` cannot overflow a bigint sum; consumers
-- convert with BigInt. security_barrier because the owners of the underlying rows are not the reader's
-- tenant.
CREATE VIEW ledger.logical_account_balances WITH (security_barrier = true) AS
SELECT a.ledger_id,
       a.owner_type,
       a.owner_id,
       a.logical_code,
       a.currency,
       a.normal_side,
       count(*)::integer AS bucket_rows,
       sum(b.debit_total_minor)::numeric AS debit_total_minor,
       sum(b.credit_total_minor)::numeric AS credit_total_minor,
       sum(b.normal_balance_minor)::numeric AS normal_balance_minor
  FROM ledger.accounts a
  JOIN ledger.account_balances b ON b.account_id = a.id
 GROUP BY a.ledger_id, a.owner_type, a.owner_id, a.logical_code, a.currency, a.normal_side;

-- 5. Grants (last) -------------------------------------------------------------------------------

REVOKE ALL ON ledger.ledgers, ledger.accounts, ledger.account_balances, ledger.logical_account_balances
  FROM PUBLIC;

GRANT SELECT ON ledger.ledgers, ledger.accounts TO ledger_function_owner;
GRANT INSERT, UPDATE ON ledger.accounts TO ledger_function_owner;
GRANT SELECT, INSERT, UPDATE ON ledger.account_balances TO ledger_function_owner;

-- The operator sees balances but cannot write them, and never sees a medical-information column that
-- does not exist here; merchant-facing roles get nothing, because striped platform buckets are not
-- merchant-readable (docs/07 §Tenant isolation item 7).
GRANT SELECT ON ledger.ledgers, ledger.accounts, ledger.account_balances, ledger.logical_account_balances
  TO fl_operator_readonly;

REVOKE ALL ON FUNCTION ledger.create_account(
  text, text, text, text, smallint, smallint, text, boolean, boolean
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ledger.create_account(
  text, text, text, text, smallint, smallint, text, boolean, boolean
) TO fl_migration_owner, ledger_function_owner;

SELECT public.fl_assign_function_owner(
  'ledger.create_account(text, text, text, text, smallint, smallint, text, boolean, boolean)'::regprocedure,
  'ledger_function_owner'
);

-- The transfer removes the previous owner's implicit EXECUTE, so the migration owner — which the P03
-- seeds run as — is granted again by the new owner, which is the only role that can grant.
SET LOCAL ROLE ledger_function_owner;

GRANT EXECUTE ON FUNCTION ledger.create_account(
  text, text, text, text, smallint, smallint, text, boolean, boolean
) TO fl_migration_owner;

RESET ROLE;
