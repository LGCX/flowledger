-- 0210_identity.sql — merchants and API credentials.
--
-- Order: tables → constraints/indexes → triggers → RLS → grants (CONVENTIONS §8). Grants last so a
-- partially applied file never exposes an unguarded table.
--
-- The credential row is deliberately narrow in what it holds: a keyed digest, never the credential.
-- The locator (`key_prefix`) is the only part that may appear in a log, and it exists so
-- authentication can find the candidate row before any tenant context exists.

-- 1. Tables --------------------------------------------------------------------------------------

CREATE TABLE identity.merchants (
  id               text COLLATE "C" PRIMARY KEY,
  display_name     text NOT NULL,
  status           text NOT NULL,
  default_currency text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at        timestamptz,
  CONSTRAINT merchants_id_format CHECK (public.fl_is_id(id, 'mer')),
  CONSTRAINT merchants_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT merchants_status CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  CONSTRAINT merchants_default_currency CHECK (default_currency = 'USD'),
  CONSTRAINT merchants_closed_at CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);

CREATE TABLE identity.merchant_api_credentials (
  id                text COLLATE "C" PRIMARY KEY,
  merchant_id       text COLLATE "C" NOT NULL,
  key_prefix        text COLLATE "C" NOT NULL,
  credential_digest bytea NOT NULL,
  digest_version    smallint NOT NULL,
  scopes            text[] NOT NULL,
  status            text NOT NULL DEFAULT 'ACTIVE',
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at        timestamptz,
  revoked_at        timestamptz,
  last_used_at      timestamptz,

  CONSTRAINT merchant_api_credentials_id_format CHECK (public.fl_is_id(id, 'mcr')),
  -- The prefix is 12 Crockford base32 characters; the alphabet excludes I, L, O and U.
  CONSTRAINT merchant_api_credentials_key_prefix_format
    CHECK (key_prefix ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
  CONSTRAINT merchant_api_credentials_digest_length
    CHECK (public.fl_is_sha256(credential_digest)),
  CONSTRAINT merchant_api_credentials_digest_version CHECK (digest_version > 0),
  CONSTRAINT merchant_api_credentials_scopes_nonempty CHECK (cardinality(scopes) > 0),
  -- A CHECK rather than docs/07's "trigger rejects unknown scopes": same rule, native mechanism, and
  -- it cannot be bypassed by a path that forgets to fire the trigger.
  CONSTRAINT merchant_api_credentials_scopes_allowlisted
    CHECK (scopes <@ ARRAY['payments:read', 'payments:write']::text[]),
  CONSTRAINT merchant_api_credentials_status CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT merchant_api_credentials_revoked_at
    CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)),

  -- UNIQUE (key_prefix) is the authentication index: it is consulted before tenant context exists.
  CONSTRAINT merchant_api_credentials_key_prefix_key UNIQUE (key_prefix),
  -- UNIQUE (merchant_id, id) exists so later tables can carry a tenant-safe composite foreign key.
  CONSTRAINT merchant_api_credentials_merchant_id_id_key UNIQUE (merchant_id, id),
  CONSTRAINT merchant_api_credentials_merchant_fkey
    FOREIGN KEY (merchant_id) REFERENCES identity.merchants (id)
);

-- 2. Guard functions -----------------------------------------------------------------------------
-- These live in this migration rather than 0200 because 0200 is already applied on developer
-- databases; a guard needed by one table belongs with that table.

-- Merchants: identity and display name are immutable; the row may be suspended or closed, never
-- deleted. `status`, `closed_at` and `updated_at` are the only mutable columns.
CREATE OR REPLACE FUNCTION public.fl_merchant_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.fl_assert_unchanged(
    'identity.merchants',
    jsonb_build_object(
      'id', OLD.id,
      'default_currency', OLD.default_currency,
      'created_at', OLD.created_at,
      'display_name', OLD.display_name
    ),
    jsonb_build_object(
      'id', NEW.id,
      'default_currency', NEW.default_currency,
      'created_at', NEW.created_at,
      'display_name', NEW.display_name
    ),
    ARRAY['id', 'default_currency', 'created_at', 'display_name']
  );
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

-- Credentials: issued ACTIVE, then revocable exactly once. The digest, its version, the locator, the
-- scopes and the expiry are all immutable, because changing any of them would silently re-point an
-- already-issued credential at different authority.
CREATE OR REPLACE FUNCTION public.fl_credential_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' OR NEW.revoked_at IS NOT NULL THEN
      PERFORM public.fl_raise_domain(
        'INVALID_TRANSITION',
        jsonb_build_object('reason', 'CREDENTIAL_NOT_ISSUED_ACTIVE')
      );
    END IF;
    RETURN NEW;
  END IF;

  PERFORM public.fl_assert_unchanged(
    'identity.merchant_api_credentials',
    jsonb_build_object(
      'id', OLD.id,
      'merchant_id', OLD.merchant_id,
      'key_prefix', OLD.key_prefix,
      'credential_digest', encode(OLD.credential_digest, 'hex'),
      'digest_version', OLD.digest_version,
      'scopes', to_jsonb(OLD.scopes),
      'created_at', OLD.created_at,
      'expires_at', OLD.expires_at
    ),
    jsonb_build_object(
      'id', NEW.id,
      'merchant_id', NEW.merchant_id,
      'key_prefix', NEW.key_prefix,
      'credential_digest', encode(NEW.credential_digest, 'hex'),
      'digest_version', NEW.digest_version,
      'scopes', to_jsonb(NEW.scopes),
      'created_at', NEW.created_at,
      'expires_at', NEW.expires_at
    ),
    ARRAY[
      'id', 'merchant_id', 'key_prefix', 'credential_digest', 'digest_version', 'scopes',
      'created_at', 'expires_at'
    ]
  );

  IF OLD.status = 'REVOKED'
     AND (NEW.status <> 'REVOKED' OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'CREDENTIAL_REVOCATION_ONE_WAY')
    );
  END IF;

  RETURN NEW;
END
$$;

-- 3. Triggers ------------------------------------------------------------------------------------

-- A merchant is suspended or closed, never deleted, while financial records reference it.
CREATE TRIGGER merchants_guard
  BEFORE UPDATE ON identity.merchants
  FOR EACH ROW EXECUTE FUNCTION public.fl_merchant_guard();

CREATE TRIGGER merchants_no_delete
  BEFORE DELETE ON identity.merchants
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER merchants_no_truncate
  BEFORE TRUNCATE ON identity.merchants
  FOR EACH STATEMENT EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER merchant_api_credentials_guard
  BEFORE INSERT OR UPDATE ON identity.merchant_api_credentials
  FOR EACH ROW EXECUTE FUNCTION public.fl_credential_guard();

CREATE TRIGGER merchant_api_credentials_no_delete
  BEFORE DELETE ON identity.merchant_api_credentials
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER merchant_api_credentials_no_truncate
  BEFORE TRUNCATE ON identity.merchant_api_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION public.fl_reject_mutation();

-- 4. RLS -----------------------------------------------------------------------------------------

ALTER TABLE identity.merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.merchant_api_credentials ENABLE ROW LEVEL SECURITY;

-- A merchant sees only itself. There is no "list all merchants" path for a merchant-facing role.
CREATE POLICY merchants_tenant_read ON identity.merchants
  FOR SELECT TO fl_api
  USING (id = public.fl_current_merchant_id());

CREATE POLICY merchants_function_owner_all ON identity.merchants
  FOR ALL TO payments_function_owner, messaging_function_owner
  USING (true) WITH CHECK (true);

-- Lookup happens before tenant context exists, so the prefix is supplied as a transaction-local
-- setting. It reveals at most one row: the prefix is unique and the caller must already know it.
CREATE POLICY merchant_api_credentials_lookup ON identity.merchant_api_credentials
  FOR SELECT TO fl_api
  USING (
    merchant_id = public.fl_current_merchant_id()
    OR key_prefix = nullif(current_setting('app.credential_key_prefix', true), '')
  );

CREATE POLICY merchant_api_credentials_function_owner_read ON identity.merchant_api_credentials
  FOR SELECT TO payments_function_owner
  USING (true);

CREATE POLICY merchant_api_credentials_operator_all ON identity.merchant_api_credentials
  FOR ALL TO fl_operator_command
  USING (true) WITH CHECK (true);

-- 5. Grants (last) -------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA identity TO
  fl_api, fl_operator_command, payments_function_owner, messaging_function_owner;

-- Trigger functions run as the mutating role, so the roles that may update these tables need EXECUTE
-- on the guard, on the raise helper, and on the assertion the guard calls. 0200 granted
-- fl_assert_unchanged only to the function-owner roles; the operator updates credentials directly, so
-- it needs its own grant here.
GRANT EXECUTE ON FUNCTION public.fl_merchant_guard() TO
  fl_operator_command, payments_function_owner, messaging_function_owner;
GRANT EXECUTE ON FUNCTION public.fl_credential_guard() TO
  fl_operator_command, payments_function_owner, messaging_function_owner;
GRANT EXECUTE ON FUNCTION public.fl_assert_unchanged(text, jsonb, jsonb, text[]) TO
  fl_operator_command, messaging_function_owner;

GRANT SELECT ON identity.merchants TO fl_api, payments_function_owner, messaging_function_owner;

GRANT SELECT ON identity.merchant_api_credentials TO fl_api, payments_function_owner;

-- Issuing and revoking are the operator's job. Column-level grants mean the operator cannot rewrite a
-- digest even if a future code path tries: there is no UPDATE privilege on that column at all.
GRANT SELECT ON identity.merchant_api_credentials TO fl_operator_command;
GRANT INSERT (id, merchant_id, key_prefix, credential_digest, digest_version, scopes, expires_at)
  ON identity.merchant_api_credentials TO fl_operator_command;
GRANT UPDATE (status, revoked_at) ON identity.merchant_api_credentials TO fl_operator_command;

-- No DELETE or TRUNCATE to anyone: credential history is append-and-revoke.
