-- 0200_foundation.sql — schemas, roles, and the helpers every later migration reuses.
--
-- Order in this file is the contract (CONVENTIONS §8): schemas and roles, then helper functions, then
-- grants last. Grants come last so a partially applied migration never exposes an unprivileged object.
--
-- Roles are cluster-wide while databases are not, so every role statement is idempotent. A test
-- database created from a template in the same cluster must be able to apply this file again.

-- 1. Roles ---------------------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'payments_function_owner', 'ledger_function_owner', 'settlement_function_owner',
    'messaging_function_owner', 'reconciliation_function_owner', 'webhooks_function_owner',
    'audit_function_owner'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
    -- SET TRUE lets fl_migration_owner assume the role when assigning function ownership;
    -- INHERIT FALSE keeps the privileges from leaking into ordinary migration statements.
    EXECUTE format('GRANT %I TO fl_migration_owner WITH INHERIT FALSE, SET TRUE', r);
  END LOOP;

  FOREACH r IN ARRAY ARRAY[
    'fl_api', 'fl_relay', 'fl_payment_worker', 'fl_webhook_receiver', 'fl_webhook_worker',
    'fl_reconciler', 'fl_settlement_worker', 'fl_webhook_projector', 'fl_webhook_dispatcher',
    'fl_operator_readonly', 'fl_operator_command', 'fl_correction'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r);
    END IF;
  END LOOP;
END
$$;

-- 2. Schemas -------------------------------------------------------------------------------------
DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'identity', 'providers', 'payments', 'api', 'ledger',
    'settlement', 'messaging', 'webhooks', 'reconciliation', 'audit'
  ] LOOP
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION fl_migration_owner', s);
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', s);
  END LOOP;
END
$$;

-- 3. No function is executable by default --------------------------------------------------------
-- This must precede every CREATE FUNCTION in this file and in every later migration; a function
-- created before it would silently be executable by PUBLIC.
ALTER DEFAULT PRIVILEGES FOR ROLE fl_migration_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 4. pgcrypto (docs/07 §Migration order step 1)
-- 0200 itself uses only built-ins. P03 needs digest()/hmac() for posting and credential hashes; the
-- credential pepper itself never enters PostgreSQL and stays in TypeScript.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

-- 5. Helper functions ----------------------------------------------------------------------------

-- Entity id shape: <prefix>_<Crockford base32 ULID>. The leading [0-7] bound encodes the 48-bit
-- timestamp high nibble, so an id from the wrong decade is rejected by shape alone.
CREATE OR REPLACE FUNCTION public.fl_is_id(p_value text, p_prefix text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN p_value ~ ('^' || p_prefix || '_[0-7][0-9A-HJKMNP-TV-Z]{25}$');

CREATE OR REPLACE FUNCTION public.fl_is_sha256(p_value bytea) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN octet_length(p_value) = 32;

-- Null when unset or empty: `current_setting(..., true)` yields NULL or '' depending on how it was
-- last reset, and both mean "no tenant context".
CREATE OR REPLACE FUNCTION public.fl_current_merchant_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN nullif(current_setting('app.merchant_id', true), '');

-- The one way SQL code raises a merchant-facing or internal domain error (CONVENTIONS §7).
CREATE OR REPLACE FUNCTION public.fl_raise_domain(p_code text, p_detail jsonb DEFAULT '{}')
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = p_code,
    DETAIL = p_detail::text;
END
$$;

-- Raises IMMUTABLE_FIELD for the first listed column whose value changed.
CREATE OR REPLACE FUNCTION public.fl_assert_unchanged(
  p_table text,
  p_old jsonb,
  p_new jsonb,
  p_columns text[]
) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  c text;
BEGIN
  FOREACH c IN ARRAY p_columns LOOP
    IF (p_old -> c) IS DISTINCT FROM (p_new -> c) THEN
      PERFORM public.fl_raise_domain(
        'IMMUTABLE_FIELD',
        jsonb_build_object('table', p_table, 'column', c)
      );
    END IF;
  END LOOP;
END
$$;

-- Append-only tables: usable as BEFORE UPDATE/DELETE FOR EACH ROW and BEFORE TRUNCATE FOR EACH
-- STATEMENT, because a missing statement-level trigger is the usual way a truncate sneaks through.
CREATE OR REPLACE FUNCTION public.fl_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.fl_raise_domain(
    'IMMUTABLE_ROW',
    jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP)
  );
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.fl_touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

-- Migration-only: reassigning a function to its owner schema role requires CREATE on the schema
-- momentarily. Wrapped so the grant cannot be forgotten and cannot outlive the statement.
CREATE OR REPLACE FUNCTION public.fl_assign_function_owner(p_function regprocedure, p_owner name)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  schema_name text;
BEGIN
  SELECT n.nspname INTO schema_name
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.oid = p_function;

  IF schema_name IS NULL THEN
    RAISE EXCEPTION 'fl_assign_function_owner: function % not found', p_function;
  END IF;

  EXECUTE format('GRANT CREATE ON SCHEMA %I TO %I', schema_name, p_owner);
  BEGIN
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', p_function, p_owner);
  EXCEPTION WHEN OTHERS THEN
    -- Never leave the schema grant behind, even if the ownership change fails.
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', schema_name, p_owner);
    RAISE;
  END;
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', schema_name, p_owner);
END
$$;

-- 6. Grants (last) -------------------------------------------------------------------------------

-- Pure predicates are used inside CHECK constraints and RLS expressions, which are evaluated as the
-- querying role; they must be callable by anyone who can reach the table.
GRANT EXECUTE ON FUNCTION public.fl_is_id(text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fl_is_sha256(bytea) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fl_current_merchant_id() TO PUBLIC;

-- Error raising and immutability assertions are only ever called from protected functions, plus from
-- triggers. Triggers fire as the mutating role, so the runtime roles need the raise path too.
GRANT EXECUTE ON FUNCTION public.fl_raise_domain(text, jsonb) TO
  payments_function_owner, ledger_function_owner, settlement_function_owner,
  messaging_function_owner, reconciliation_function_owner, webhooks_function_owner,
  audit_function_owner,
  fl_api, fl_relay, fl_payment_worker, fl_webhook_receiver, fl_webhook_worker,
  fl_reconciler, fl_settlement_worker, fl_webhook_projector, fl_webhook_dispatcher,
  fl_operator_command, fl_correction;

GRANT EXECUTE ON FUNCTION public.fl_assert_unchanged(text, jsonb, jsonb, text[]) TO
  payments_function_owner, ledger_function_owner, settlement_function_owner,
  messaging_function_owner, reconciliation_function_owner, webhooks_function_owner,
  audit_function_owner;

-- Trigger functions themselves fire without an EXECUTE check by the firing role, but granting to the
-- runtime roles documents that they are intentionally reachable.
GRANT EXECUTE ON FUNCTION public.fl_reject_mutation() TO
  fl_api, fl_relay, fl_payment_worker, fl_webhook_receiver, fl_webhook_worker,
  fl_reconciler, fl_settlement_worker, fl_webhook_projector, fl_webhook_dispatcher,
  fl_operator_command, fl_correction;

GRANT EXECUTE ON FUNCTION public.fl_touch_updated_at() TO
  fl_api, fl_payment_worker, fl_operator_command, fl_correction;

-- fl_assign_function_owner: deliberately no grant. Owner only.
