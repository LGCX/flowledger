-- 0220_provider_configuration.sql — tenant-owned provider configuration and route selection.
--
-- Order: tables → constraints/indexes → triggers → function → RLS → grants (CONVENTIONS §8).
--
-- Two ideas carry this file. First, identity and configuration are immutable: an account's provider
-- code, environment and external reference never change, and a configuration version is superseded
-- once and never edited. Second, a route resolves to exactly one (account, current version) or raises
-- PROVIDER_ROUTE_UNAVAILABLE — there is no fallback, because silently routing to a different account
-- would move a merchant's money through infrastructure they did not choose.

-- 1. Tables --------------------------------------------------------------------------------------

CREATE TABLE providers.provider_accounts (
  id                         text COLLATE "C" PRIMARY KEY,
  merchant_id                text COLLATE "C" NOT NULL,
  provider_code              text NOT NULL,
  external_account_reference text,
  environment                text NOT NULL,
  status                     text NOT NULL DEFAULT 'ACTIVE',
  created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT provider_accounts_id_format CHECK (public.fl_is_id(id, 'pacc')),
  CONSTRAINT provider_accounts_provider_code_format
    CHECK (provider_code ~ '^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  CONSTRAINT provider_accounts_environment CHECK (environment IN ('SANDBOX', 'SIMULATOR')),
  CONSTRAINT provider_accounts_status CHECK (status IN ('ACTIVE', 'DISABLED', 'REVOKED')),

  CONSTRAINT provider_accounts_merchant_id_id_key UNIQUE (merchant_id, id),
  -- Target of the composite route foreign key: a route cannot name an account whose provider code or
  -- environment differs, so the database enforces agreement instead of trusting the caller.
  CONSTRAINT provider_accounts_route_target_key
    UNIQUE (merchant_id, id, provider_code, environment),
  CONSTRAINT provider_accounts_external_identity_key
    UNIQUE NULLS NOT DISTINCT (merchant_id, provider_code, external_account_reference, environment),
  CONSTRAINT provider_accounts_merchant_fkey
    FOREIGN KEY (merchant_id) REFERENCES identity.merchants (id)
);

CREATE INDEX provider_accounts_lookup
  ON providers.provider_accounts (merchant_id, provider_code, status);

CREATE TABLE providers.merchant_routes (
  merchant_id         text COLLATE "C" NOT NULL,
  provider_code       text NOT NULL,
  environment         text NOT NULL,
  provider_account_id text COLLATE "C" NOT NULL,
  is_default          boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'ACTIVE',
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT merchant_routes_pkey PRIMARY KEY (merchant_id, provider_code, environment),
  CONSTRAINT merchant_routes_status CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT merchant_routes_account_key UNIQUE (merchant_id, provider_account_id),
  CONSTRAINT merchant_routes_account_fkey
    FOREIGN KEY (merchant_id, provider_account_id, provider_code, environment)
    REFERENCES providers.provider_accounts (merchant_id, id, provider_code, environment)
);

-- One default per merchant and environment: two defaults would make routing order-dependent.
CREATE UNIQUE INDEX merchant_routes_one_default
  ON providers.merchant_routes (merchant_id, environment)
  WHERE status = 'ACTIVE' AND is_default;

CREATE TABLE providers.provider_account_versions (
  provider_account_id text COLLATE "C" NOT NULL,
  version             integer NOT NULL,
  configuration       jsonb NOT NULL,
  capabilities_hash   bytea NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  superseded_at       timestamptz,

  CONSTRAINT provider_account_versions_pkey PRIMARY KEY (provider_account_id, version),
  CONSTRAINT provider_account_versions_version_positive CHECK (version > 0),
  CONSTRAINT provider_account_versions_configuration_object
    CHECK (jsonb_typeof(configuration) = 'object'),
  CONSTRAINT provider_account_versions_capabilities_hash
    CHECK (public.fl_is_sha256(capabilities_hash)),
  CONSTRAINT provider_account_versions_account_fkey
    FOREIGN KEY (provider_account_id) REFERENCES providers.provider_accounts (id)
);

CREATE UNIQUE INDEX provider_account_versions_one_current
  ON providers.provider_account_versions (provider_account_id)
  WHERE superseded_at IS NULL;

CREATE TABLE providers.provider_account_credentials (
  id                  text COLLATE "C" PRIMARY KEY,
  merchant_id         text COLLATE "C" NOT NULL,
  provider_account_id text COLLATE "C" NOT NULL,
  version             integer NOT NULL,
  secret_reference    text NOT NULL,
  status              text NOT NULL DEFAULT 'ACTIVE',
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at          timestamptz,

  CONSTRAINT provider_account_credentials_id_format CHECK (public.fl_is_id(id, 'pac')),
  CONSTRAINT provider_account_credentials_version_positive CHECK (version > 0),
  CONSTRAINT provider_account_credentials_secret_reference_nonempty
    CHECK (char_length(secret_reference) > 0),
  CONSTRAINT provider_account_credentials_status
    CHECK (status IN ('ACTIVE', 'RETIRED', 'REVOKED')),
  CONSTRAINT provider_account_credentials_retired_at
    CHECK ((status = 'ACTIVE') = (retired_at IS NULL)),
  CONSTRAINT provider_account_credentials_account_version_key
    UNIQUE (provider_account_id, version),
  -- Composite so the tenant copy is checked against the account, not just the account id.
  CONSTRAINT provider_account_credentials_account_fkey
    FOREIGN KEY (merchant_id, provider_account_id)
    REFERENCES providers.provider_accounts (merchant_id, id)
);

CREATE UNIQUE INDEX provider_account_credentials_one_active
  ON providers.provider_account_credentials (provider_account_id)
  WHERE status = 'ACTIVE';

CREATE TABLE providers.webhook_endpoints (
  id                         text COLLATE "C" PRIMARY KEY,
  provider_code              text NOT NULL,
  endpoint_key               text COLLATE "C" NOT NULL,
  external_account_reference text,
  status                     text NOT NULL DEFAULT 'ACTIVE',
  created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at                 timestamptz,

  CONSTRAINT webhook_endpoints_id_format CHECK (public.fl_is_id(id, 'pwe')),
  CONSTRAINT webhook_endpoints_endpoint_key_format
    CHECK (endpoint_key ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  CONSTRAINT webhook_endpoints_provider_code_format
    CHECK (provider_code ~ '^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  CONSTRAINT webhook_endpoints_status CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT webhook_endpoints_retired_at CHECK ((status = 'REVOKED') = (retired_at IS NOT NULL)),
  CONSTRAINT webhook_endpoints_endpoint_key UNIQUE (provider_code, endpoint_key)
);

CREATE TABLE providers.webhook_endpoint_secret_versions (
  webhook_endpoint_id       text COLLATE "C" NOT NULL,
  version                   integer NOT NULL,
  signing_secret_reference  text NOT NULL,
  verifier_version          text NOT NULL,
  status                    text NOT NULL DEFAULT 'ACTIVE',
  accepted_from             timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted_until            timestamptz,
  created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT webhook_endpoint_secret_versions_pkey PRIMARY KEY (webhook_endpoint_id, version),
  CONSTRAINT webhook_endpoint_secret_versions_version_positive CHECK (version > 0),
  CONSTRAINT webhook_endpoint_secret_versions_status
    CHECK (status IN ('ACTIVE', 'OVERLAP', 'RETIRED')),
  CONSTRAINT webhook_endpoint_secret_versions_window
    CHECK (accepted_until IS NULL OR accepted_until > accepted_from),
  -- A secret that is not ACTIVE must say when it stopped being accepted.
  CONSTRAINT webhook_endpoint_secret_versions_bounded
    CHECK (status = 'ACTIVE' OR accepted_until IS NOT NULL),
  CONSTRAINT webhook_endpoint_secret_versions_endpoint_fkey
    FOREIGN KEY (webhook_endpoint_id) REFERENCES providers.webhook_endpoints (id)
);

CREATE UNIQUE INDEX webhook_endpoint_secret_versions_one_active
  ON providers.webhook_endpoint_secret_versions (webhook_endpoint_id)
  WHERE status = 'ACTIVE';

CREATE TABLE providers.webhook_endpoint_accounts (
  webhook_endpoint_id text COLLATE "C" NOT NULL,
  provider_account_id text COLLATE "C" NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at          timestamptz,

  CONSTRAINT webhook_endpoint_accounts_pkey PRIMARY KEY (webhook_endpoint_id, provider_account_id),
  CONSTRAINT webhook_endpoint_accounts_endpoint_fkey
    FOREIGN KEY (webhook_endpoint_id) REFERENCES providers.webhook_endpoints (id),
  CONSTRAINT webhook_endpoint_accounts_account_fkey
    FOREIGN KEY (provider_account_id) REFERENCES providers.provider_accounts (id)
);

CREATE INDEX webhook_endpoint_accounts_account
  ON providers.webhook_endpoint_accounts (provider_account_id);

-- 2. Guard functions -----------------------------------------------------------------------------

-- Generic immutability guard: the columns are named as trigger arguments, so each table states its own
-- immutable set in one readable line instead of a bespoke function.
CREATE OR REPLACE FUNCTION public.fl_guard_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  column_name text;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    IF (old_row -> column_name) IS DISTINCT FROM (new_row -> column_name) THEN
      PERFORM public.fl_raise_domain(
        'IMMUTABLE_FIELD',
        jsonb_build_object('table', TG_TABLE_NAME, 'column', column_name)
      );
    END IF;
  END LOOP;

  -- Tables that carry `updated_at` get it stamped here, so no caller can set it.
  IF new_row ? 'updated_at' THEN
    NEW.updated_at := clock_timestamp();
  END IF;

  RETURN NEW;
END
$$;

-- Versions are monotonic per owner row: the next version is max+1, never a caller-chosen number.
CREATE OR REPLACE FUNCTION public.fl_version_monotonic() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  expected integer;
  key_value text;
BEGIN
  -- The owner column is named by the trigger argument and read from the row as JSON, so one function
  -- serves tables whose key column has a different name.
  key_value := to_jsonb(NEW) ->> TG_ARGV[0];

  EXECUTE format(
    'SELECT coalesce(max(version), 0) + 1 FROM %I.%I WHERE %I = $1',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[0]
  )
  INTO expected
  USING key_value;

  IF NEW.version IS DISTINCT FROM expected THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'VERSION_NOT_MONOTONIC', 'expected', expected)
    );
  END IF;
  RETURN NEW;
END
$$;

-- A configuration version is superseded exactly once; nothing else about it may change.
CREATE OR REPLACE FUNCTION public.fl_supersede_once() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.superseded_at IS NOT NULL THEN
    PERFORM public.fl_raise_domain(
      'IMMUTABLE_FIELD',
      jsonb_build_object('table', TG_TABLE_NAME, 'column', 'superseded_at')
    );
  END IF;
  IF NEW.superseded_at IS NULL THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'SUPERSEDE_REQUIRES_TIMESTAMP')
    );
  END IF;
  -- Every other column is compared by the companion fl_guard_immutable trigger.
  RETURN NEW;
END
$$;

-- Credential lifecycle: ACTIVE → RETIRED | REVOKED, RETIRED → REVOKED. Never back.
CREATE OR REPLACE FUNCTION public.fl_credential_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status = NEW.status AND OLD.retired_at IS NOT DISTINCT FROM NEW.retired_at THEN
    RETURN NEW;
  END IF;

  IF NOT (
       (OLD.status = 'ACTIVE' AND NEW.status IN ('RETIRED', 'REVOKED'))
    OR (OLD.status = 'RETIRED' AND NEW.status = 'REVOKED')
  ) THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'CREDENTIAL_STATUS_TRANSITION', 'from', OLD.status, 'to', NEW.status)
    );
  END IF;

  IF NEW.status <> 'ACTIVE' AND NEW.retired_at IS NULL THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'CREDENTIAL_RETIRED_AT_REQUIRED')
    );
  END IF;
  RETURN NEW;
END
$$;

-- Webhook signing secrets: ACTIVE → OVERLAP | RETIRED, and the end of the window is set in the same
-- update that stops accepting the secret.
CREATE OR REPLACE FUNCTION public.fl_secret_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT (
       (OLD.status = 'ACTIVE' AND NEW.status IN ('OVERLAP', 'RETIRED'))
    OR (OLD.status = 'OVERLAP' AND NEW.status = 'RETIRED')
  ) THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'SECRET_STATUS_TRANSITION', 'from', OLD.status, 'to', NEW.status)
    );
  END IF;

  IF NEW.accepted_until IS NULL THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'SECRET_ACCEPTED_UNTIL_REQUIRED')
    );
  END IF;
  RETURN NEW;
END
$$;

-- Endpoint allowlist removal is one-way.
CREATE OR REPLACE FUNCTION public.fl_retire_once() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'RETIRE_ONCE')
    );
  END IF;
  RETURN NEW;
END
$$;

-- Webhook endpoints are revoked once, and only with retired_at.
CREATE OR REPLACE FUNCTION public.fl_endpoint_revocation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status = 'REVOKED' AND (NEW.status <> 'REVOKED' OR NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'ENDPOINT_REVOCATION_ONE_WAY')
    );
  END IF;
  RETURN NEW;
END
$$;

-- 3. Triggers ------------------------------------------------------------------------------------

CREATE TRIGGER provider_accounts_guard
  BEFORE UPDATE ON providers.provider_accounts
  FOR EACH ROW EXECUTE FUNCTION public.fl_guard_immutable(
    'id', 'merchant_id', 'provider_code', 'environment', 'external_account_reference', 'created_at'
  );

CREATE TRIGGER merchant_routes_guard
  BEFORE UPDATE ON providers.merchant_routes
  FOR EACH ROW EXECUTE FUNCTION public.fl_guard_immutable(
    'merchant_id', 'provider_code', 'environment', 'created_at'
  );

CREATE TRIGGER provider_account_versions_insert
  BEFORE INSERT ON providers.provider_account_versions
  FOR EACH ROW EXECUTE FUNCTION public.fl_version_monotonic('provider_account_id');

CREATE TRIGGER provider_account_versions_guard
  BEFORE UPDATE ON providers.provider_account_versions
  FOR EACH ROW EXECUTE FUNCTION public.fl_guard_immutable(
    'provider_account_id', 'version', 'configuration', 'capabilities_hash', 'created_at'
  );

CREATE TRIGGER provider_account_versions_supersede
  BEFORE UPDATE ON providers.provider_account_versions
  FOR EACH ROW EXECUTE FUNCTION public.fl_supersede_once();

CREATE TRIGGER provider_account_credentials_insert
  BEFORE INSERT ON providers.provider_account_credentials
  FOR EACH ROW EXECUTE FUNCTION public.fl_version_monotonic('provider_account_id');

CREATE TRIGGER provider_account_credentials_guard
  BEFORE UPDATE ON providers.provider_account_credentials
  FOR EACH ROW EXECUTE FUNCTION public.fl_guard_immutable(
    'id', 'merchant_id', 'provider_account_id', 'version', 'secret_reference', 'created_at'
  );

CREATE TRIGGER provider_account_credentials_lifecycle
  BEFORE UPDATE ON providers.provider_account_credentials
  FOR EACH ROW EXECUTE FUNCTION public.fl_credential_lifecycle();

CREATE TRIGGER webhook_endpoints_guard
  BEFORE UPDATE ON providers.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.fl_guard_immutable(
    'id', 'provider_code', 'endpoint_key', 'external_account_reference', 'created_at'
  );

CREATE TRIGGER webhook_endpoints_revocation
  BEFORE UPDATE ON providers.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.fl_endpoint_revocation();

CREATE TRIGGER webhook_endpoint_secret_versions_insert
  BEFORE INSERT ON providers.webhook_endpoint_secret_versions
  FOR EACH ROW EXECUTE FUNCTION public.fl_version_monotonic('webhook_endpoint_id');

CREATE TRIGGER webhook_endpoint_secret_versions_guard
  BEFORE UPDATE ON providers.webhook_endpoint_secret_versions
  FOR EACH ROW EXECUTE FUNCTION public.fl_guard_immutable(
    'webhook_endpoint_id', 'version', 'signing_secret_reference', 'verifier_version', 'created_at'
  );

CREATE TRIGGER webhook_endpoint_secret_versions_lifecycle
  BEFORE UPDATE ON providers.webhook_endpoint_secret_versions
  FOR EACH ROW EXECUTE FUNCTION public.fl_secret_lifecycle();

CREATE TRIGGER webhook_endpoint_accounts_guard
  BEFORE UPDATE ON providers.webhook_endpoint_accounts
  FOR EACH ROW EXECUTE FUNCTION public.fl_guard_immutable(
    'webhook_endpoint_id', 'provider_account_id', 'created_at'
  );

CREATE TRIGGER webhook_endpoint_accounts_retire
  BEFORE UPDATE ON providers.webhook_endpoint_accounts
  FOR EACH ROW EXECUTE FUNCTION public.fl_retire_once();

-- No row in this schema is ever deleted or truncated: configuration history is the audit trail.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'provider_accounts', 'merchant_routes', 'provider_account_versions',
    'provider_account_credentials', 'webhook_endpoints',
    'webhook_endpoint_secret_versions', 'webhook_endpoint_accounts'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_no_delete BEFORE DELETE ON providers.%I FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation()',
      t, t
    );
    EXECUTE format(
      'CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON providers.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fl_reject_mutation()',
      t, t
    );
  END LOOP;
END
$$;

-- 4. Route selection -----------------------------------------------------------------------------

-- VOLATILE, not STABLE: the FOR SHARE lock is what stops a concurrent supersede from changing the
-- current version mid-create, and PostgreSQL refuses a locking read in a non-volatile function.
CREATE OR REPLACE FUNCTION providers.select_route(
  p_merchant_id text,
  p_environment text,
  p_provider_code text
) RETURNS TABLE (
  provider_account_id text,
  provider_code text,
  provider_account_version integer
)
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  selected_account_id text;
  selected_provider_code text;
  selected_route_status text;
  account_status text;
  current_version integer;
BEGIN
  SELECT r.provider_account_id, r.provider_code, r.status
    INTO selected_account_id, selected_provider_code, selected_route_status
    FROM providers.merchant_routes r
   WHERE r.merchant_id = p_merchant_id
     AND r.environment = p_environment
     AND (
          (p_provider_code IS NOT NULL AND r.provider_code = p_provider_code)
       OR (p_provider_code IS NULL AND r.is_default AND r.status = 'ACTIVE')
     )
   LIMIT 1;

  IF selected_account_id IS NULL THEN
    PERFORM public.fl_raise_domain(
      'PROVIDER_ROUTE_UNAVAILABLE',
      jsonb_build_object('providerCode', p_provider_code, 'reason', 'NO_ROUTE')
    );
  END IF;

  IF selected_route_status <> 'ACTIVE' THEN
    PERFORM public.fl_raise_domain(
      'PROVIDER_ROUTE_UNAVAILABLE',
      jsonb_build_object('providerCode', p_provider_code, 'reason', 'ROUTE_DISABLED')
    );
  END IF;

  SELECT a.status INTO account_status
    FROM providers.provider_accounts a
   WHERE a.id = selected_account_id;

  IF account_status IS DISTINCT FROM 'ACTIVE' THEN
    PERFORM public.fl_raise_domain(
      'PROVIDER_ROUTE_UNAVAILABLE',
      jsonb_build_object('providerCode', p_provider_code, 'reason', 'ACCOUNT_NOT_ACTIVE')
    );
  END IF;

  SELECT v.version INTO current_version
    FROM providers.provider_account_versions v
   WHERE v.provider_account_id = selected_account_id
     AND v.superseded_at IS NULL
   FOR SHARE;

  IF current_version IS NULL THEN
    PERFORM public.fl_raise_domain(
      'PROVIDER_ROUTE_UNAVAILABLE',
      jsonb_build_object('providerCode', p_provider_code, 'reason', 'NO_CURRENT_VERSION')
    );
  END IF;

  RETURN QUERY SELECT selected_account_id, selected_provider_code, current_version;
END
$$;

REVOKE ALL ON FUNCTION providers.select_route(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION providers.select_route(text, text, text) TO payments_function_owner;

SELECT public.fl_assign_function_owner(
  'providers.select_route(text,text,text)'::regprocedure,
  'payments_function_owner'
);

-- 5. RLS -----------------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'provider_accounts', 'merchant_routes', 'provider_account_versions',
    'provider_account_credentials', 'webhook_endpoints',
    'webhook_endpoint_secret_versions', 'webhook_endpoint_accounts'
  ] LOOP
    EXECUTE format('ALTER TABLE providers.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON providers.%I FOR SELECT TO payments_function_owner USING (true)',
      t || '_function_owner_read', t
    );
  END LOOP;
END
$$;

-- A locking read (`FOR SHARE`) applies the UPDATE policy, and with none it returns no rows at all —
-- which would make select_route report NO_CURRENT_VERSION for a perfectly current account. This policy
-- lets the function owner lock a version row while `WITH CHECK (false)` makes an actual modification
-- impossible; the immutability trigger would refuse one anyway.
CREATE POLICY provider_account_versions_function_owner_lock ON providers.provider_account_versions
  FOR UPDATE TO payments_function_owner
  USING (true) WITH CHECK (false);

-- 6. Grants (last) -------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA providers TO payments_function_owner;

GRANT SELECT ON
  providers.provider_accounts,
  providers.merchant_routes,
  providers.provider_account_versions,
  providers.provider_account_credentials,
  providers.webhook_endpoints,
  providers.webhook_endpoint_secret_versions,
  providers.webhook_endpoint_accounts
TO payments_function_owner;

-- The row lock in select_route needs UPDATE privilege on the version table: PostgreSQL requires
-- UPDATE for FOR SHARE, not SELECT alone. No UPDATE policy exists for this role, so the grant permits
-- locking a row and still cannot modify one — asserted by a test rather than assumed.
GRANT UPDATE ON providers.provider_account_versions TO payments_function_owner;

-- Guard functions fire as the mutating role; the function owner needs the raise and assertion path.
GRANT EXECUTE ON FUNCTION public.fl_guard_immutable() TO payments_function_owner;
GRANT EXECUTE ON FUNCTION public.fl_version_monotonic() TO payments_function_owner;
GRANT EXECUTE ON FUNCTION public.fl_supersede_once() TO payments_function_owner;
GRANT EXECUTE ON FUNCTION public.fl_credential_lifecycle() TO payments_function_owner;
GRANT EXECUTE ON FUNCTION public.fl_secret_lifecycle() TO payments_function_owner;
GRANT EXECUTE ON FUNCTION public.fl_retire_once() TO payments_function_owner;
GRANT EXECUTE ON FUNCTION public.fl_endpoint_revocation() TO payments_function_owner;
GRANT EXECUTE ON FUNCTION public.fl_assert_unchanged(text, jsonb, jsonb, text[])
  TO payments_function_owner;

-- No runtime role gets anything here. P04 adds what the API needs; P06 and P09 add worker and
-- receiver grants.
