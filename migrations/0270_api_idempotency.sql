-- 0270_api_idempotency.sql — the idempotency boundary and its atomic claim.
--
-- `(merchant_id, command_type, idempotency_key)` is the uniqueness boundary: one row per attempt a
-- merchant makes, with the stored result replayed for 90 days afterwards.
--
-- The interesting part is the claim. A waiter must never be aborted by a unique violation it did not
-- cause, and it must never be told the request failed. `INSERT ... ON CONFLICT DO NOTHING` makes the
-- conflicting insert *block* instead of raising, so exactly one caller becomes the owner and the rest
-- read the owner's committed result. A plain INSERT would raise 23505 on every loser and abort their
-- transaction, which the caller would have to interpret — and would sometimes report as a failure.
--
-- Replay bodies are tombstoned after the window: the record survives so the key can never be reused
-- for a different request, but the stored body does not live forever (decision C-07, read-time expiry).

-- 1. Table ---------------------------------------------------------------------------------------

CREATE TABLE api.idempotency_records (
  merchant_id       text COLLATE "C" NOT NULL,
  command_type      text NOT NULL,
  idempotency_key   text COLLATE "C" NOT NULL,
  request_hash      bytea NOT NULL,
  resource_type     text NOT NULL,
  resource_id       text COLLATE "C" NOT NULL,
  http_status       smallint NOT NULL,
  response_body     jsonb,
  response_headers  jsonb,
  response_hash     bytea NOT NULL,
  correlation_id    text COLLATE "C" NOT NULL,
  credential_id     text COLLATE "C" NOT NULL,
  committed_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  replay_expires_at timestamptz NOT NULL,
  tombstoned_at     timestamptz,

  CONSTRAINT idempotency_records_pkey PRIMARY KEY (merchant_id, command_type, idempotency_key),
  CONSTRAINT idempotency_records_merchant_fkey
    FOREIGN KEY (merchant_id) REFERENCES identity.merchants (id),
  CONSTRAINT idempotency_records_credential_fkey
    FOREIGN KEY (merchant_id, credential_id)
    REFERENCES identity.merchant_api_credentials (merchant_id, id),

  CONSTRAINT idempotency_records_command_type
    CHECK (command_type IN ('CREATE_PAYMENT', 'AUTHORIZE', 'CAPTURE', 'CANCEL', 'REFUND')),
  CONSTRAINT idempotency_records_key_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  CONSTRAINT idempotency_records_request_hash CHECK (public.fl_is_sha256(request_hash)),
  CONSTRAINT idempotency_records_response_hash CHECK (public.fl_is_sha256(response_hash)),
  CONSTRAINT idempotency_records_correlation_id
    CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{16,128}$'),

  -- Only CREATE_PAYMENT produces a payment; every other command produces an operation.
  CONSTRAINT idempotency_records_resource_type
    CHECK (
      (resource_type = 'PAYMENT') = (command_type = 'CREATE_PAYMENT')
      AND resource_type IN ('PAYMENT', 'PAYMENT_OPERATION')
    ),
  CONSTRAINT idempotency_records_resource_id_format
    CHECK (
      CASE resource_type
        WHEN 'PAYMENT' THEN public.fl_is_id(resource_id, 'pay')
        ELSE public.fl_is_id(resource_id, 'op')
      END
    ),

  -- 201 for a created payment, 202 for an accepted operation.
  CONSTRAINT idempotency_records_http_status
    CHECK (http_status IN (201, 202) AND (http_status = 201) = (command_type = 'CREATE_PAYMENT')),

  -- Either a replayable body, or a tombstone with none. Never a half-tombstone.
  CONSTRAINT idempotency_records_replay_shape
    CHECK (
      (
        tombstoned_at IS NULL
        AND response_body IS NOT NULL
        AND response_headers IS NOT NULL
        AND jsonb_typeof(response_body) = 'object'
        AND jsonb_typeof(response_headers) = 'object'
      )
      OR (
        tombstoned_at IS NOT NULL
        AND response_body IS NULL
        AND response_headers IS NULL
      )
    ),
  CONSTRAINT idempotency_records_replay_window
    CHECK (replay_expires_at = committed_at + interval '90 days')
);

CREATE INDEX idempotency_records_audit
  ON api.idempotency_records (merchant_id, committed_at DESC);

CREATE INDEX idempotency_records_tombstone_due
  ON api.idempotency_records (replay_expires_at)
  WHERE tombstoned_at IS NULL;

CREATE INDEX idempotency_records_credential
  ON api.idempotency_records (credential_id);

-- 2. Deferred resource integrity ----------------------------------------------------------------

-- Deferred because the claim is the first statement of a command: it inserts the record, then the
-- payment or operation it names, in one transaction. An immediate check would reject the claim.
CREATE OR REPLACE FUNCTION api.assert_idempotency_resource() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.resource_type = 'PAYMENT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM payments.payments p
       WHERE p.id = NEW.resource_id AND p.merchant_id = NEW.merchant_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'idempotency_records_resource_integrity',
        MESSAGE = 'idempotency_records_resource_integrity: payment',
        DETAIL = jsonb_build_object('resourceId', NEW.resource_id)::text;
    END IF;
  ELSE
    -- The operation must belong to the merchant *and* match the command that produced it: a REFUND
    -- record pointing at a CAPTURE would replay the wrong result under the wrong command.
    IF NOT EXISTS (
      SELECT 1 FROM payments.payment_operations o
       WHERE o.id = NEW.resource_id
         AND o.merchant_id = NEW.merchant_id
         AND o.type = NEW.command_type
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'idempotency_records_resource_integrity',
        MESSAGE = 'idempotency_records_resource_integrity: operation',
        DETAIL = jsonb_build_object('resourceId', NEW.resource_id)::text;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER idempotency_records_resource_integrity
  AFTER INSERT ON api.idempotency_records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION api.assert_idempotency_resource();

-- 3. Guard --------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION api.guard_idempotency_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Everything except the replay body and the tombstone stamp is fixed at claim time. A record whose
  -- request hash could change would make CONFLICT undetectable.
  PERFORM public.fl_assert_unchanged(
    'api.idempotency_records',
    to_jsonb(OLD) - 'response_body' - 'response_headers' - 'tombstoned_at',
    to_jsonb(NEW) - 'response_body' - 'response_headers' - 'tombstoned_at',
    ARRAY[
      'merchant_id', 'command_type', 'idempotency_key', 'request_hash', 'resource_type',
      'resource_id', 'http_status', 'response_hash', 'correlation_id', 'credential_id',
      'committed_at', 'replay_expires_at'
    ]
  );

  -- The only permitted transition: one-way tombstoning, once the replay window has passed.
  IF OLD.tombstoned_at IS NULL AND NEW.tombstoned_at IS NOT NULL THEN
    IF NEW.response_body IS NOT NULL OR NEW.response_headers IS NOT NULL THEN
      PERFORM public.fl_raise_domain(
        'INVALID_TRANSITION',
        jsonb_build_object('reason', 'TOMBSTONE_ONLY')
      );
    END IF;
    IF clock_timestamp() < OLD.replay_expires_at THEN
      PERFORM public.fl_raise_domain(
        'INVALID_TRANSITION',
        jsonb_build_object('reason', 'TOMBSTONE_ONLY')
      );
    END IF;
  ELSIF OLD.tombstoned_at IS DISTINCT FROM NEW.tombstoned_at THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'TOMBSTONE_ONLY')
    );
  ELSIF OLD.response_body IS DISTINCT FROM NEW.response_body
     OR OLD.response_headers IS DISTINCT FROM NEW.response_headers THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'TOMBSTONE_ONLY')
    );
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER idempotency_records_guard
  BEFORE UPDATE ON api.idempotency_records
  FOR EACH ROW EXECUTE FUNCTION api.guard_idempotency_update();

CREATE TRIGGER idempotency_records_no_delete
  BEFORE DELETE ON api.idempotency_records
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER idempotency_records_no_truncate
  BEFORE TRUNCATE ON api.idempotency_records
  FOR EACH STATEMENT EXECUTE FUNCTION public.fl_reject_mutation();

-- 4. Claim --------------------------------------------------------------------------------------

-- [ASSUMPTION] No `api` function-owner role exists (CONVENTIONS §7); `payments_function_owner` owns
-- this because only payment functions call it.
CREATE OR REPLACE FUNCTION api.claim_idempotency_key(
  p_merchant_id text,
  p_command_type text,
  p_idempotency_key text,
  p_request_hash bytea,
  p_resource_type text,
  p_resource_id text,
  p_http_status smallint,
  p_response_body jsonb,
  p_response_headers jsonb,
  p_response_hash bytea,
  p_correlation_id text,
  p_credential_id text,
  p_lock_timeout_ms integer DEFAULT 2000
) RETURNS TABLE (
  outcome text,
  resource_type text,
  resource_id text,
  http_status smallint,
  response_body jsonb,
  response_headers jsonb,
  correlation_id text
)
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_previous_timeout text;
  v_inserted integer;
  v_now timestamptz := clock_timestamp();
  v_row api.idempotency_records%ROWTYPE;
BEGIN
  IF p_merchant_id IS DISTINCT FROM public.fl_current_merchant_id() THEN
    PERFORM public.fl_raise_domain(
      'TENANT_CONTEXT_MISMATCH',
      jsonb_build_object('expected', p_merchant_id)
    );
  END IF;

  v_previous_timeout := current_setting('lock_timeout');
  PERFORM set_config('lock_timeout', p_lock_timeout_ms::text || 'ms', true);

  BEGIN
    INSERT INTO api.idempotency_records (
      merchant_id, command_type, idempotency_key, request_hash, resource_type, resource_id,
      http_status, response_body, response_headers, response_hash, correlation_id, credential_id,
      committed_at, replay_expires_at
    ) VALUES (
      p_merchant_id, p_command_type, p_idempotency_key, p_request_hash, p_resource_type, p_resource_id,
      p_http_status, p_response_body, p_response_headers, p_response_hash, p_correlation_id,
      p_credential_id, v_now, v_now + interval '90 days'
    )
    ON CONFLICT (merchant_id, command_type, idempotency_key) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  EXCEPTION WHEN lock_not_available THEN
    PERFORM set_config('lock_timeout', coalesce(v_previous_timeout, '0'), true);
    PERFORM public.fl_raise_domain(
      'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      jsonb_build_object('retryAfterSeconds', 1)
    );
  END;

  PERFORM set_config('lock_timeout', coalesce(v_previous_timeout, '0'), true);

  IF v_inserted = 1 THEN
    RETURN QUERY SELECT 'OWNER'::text, p_resource_type, p_resource_id, p_http_status,
                        p_response_body, p_response_headers, p_correlation_id;
    RETURN;
  END IF;

  SELECT * INTO v_row
    FROM api.idempotency_records r
   WHERE r.merchant_id = p_merchant_id
     AND r.command_type = p_command_type
     AND r.idempotency_key = p_idempotency_key;

  -- Read-time expiry: the record survives to keep the key unusable, but its result is not replayed.
  IF v_row.tombstoned_at IS NOT NULL OR clock_timestamp() >= v_row.replay_expires_at THEN
    RETURN QUERY SELECT 'EXPIRED'::text, v_row.resource_type, v_row.resource_id, v_row.http_status,
                        NULL::jsonb, NULL::jsonb, v_row.correlation_id;
    RETURN;
  END IF;

  IF v_row.request_hash = p_request_hash THEN
    RETURN QUERY SELECT 'REPLAY'::text, v_row.resource_type, v_row.resource_id, v_row.http_status,
                        v_row.response_body, v_row.response_headers, v_row.correlation_id;
    RETURN;
  END IF;

  -- CONFLICT reveals nothing about the original request: not the resource, not the status.
  RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::smallint,
                      NULL::jsonb, NULL::jsonb, NULL::text;
END
$$;

REVOKE ALL ON FUNCTION api.claim_idempotency_key(
  text, text, text, bytea, text, text, smallint, jsonb, jsonb, bytea, text, text, integer
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION api.claim_idempotency_key(
  text, text, text, bytea, text, text, smallint, jsonb, jsonb, bytea, text, text, integer
) TO payments_function_owner;

SELECT public.fl_assign_function_owner(
  'api.claim_idempotency_key(text,text,text,bytea,text,text,smallint,jsonb,jsonb,bytea,text,text,integer)'::regprocedure,
  'payments_function_owner'
);

-- 5. RLS ----------------------------------------------------------------------------------------

ALTER TABLE api.idempotency_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY idempotency_records_function_owner_all ON api.idempotency_records
  FOR ALL TO payments_function_owner
  USING (true) WITH CHECK (true);

-- 6. Grants (last) ------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA api TO payments_function_owner;

-- Column-level UPDATE: the replay body and the tombstone stamp are the only mutable columns, so the
-- grant says exactly that.
GRANT SELECT, INSERT ON api.idempotency_records TO payments_function_owner;
GRANT UPDATE (response_body, response_headers, tombstoned_at)
  ON api.idempotency_records TO payments_function_owner;

-- No runtime grants: `create_payment` and `accept_operation` reach this through the claim function.
