-- 0291_idempotency_replay_window.sql — make the 90-day replay window an exact duration.
--
-- 0270 wrote the window as `committed_at + interval '90 days'`, in both the CHECK and the claim. For
-- `timestamptz`, `+ interval 'N days'` is calendar arithmetic in the session `TimeZone`: across a DST
-- change it is 89 days 23 hours or 90 days 1 hour. That made two things depend on the client's
-- `TimeZone` setting:
--
--   * the replay window itself (docs/07: "Exactly 90 days after commit"), and
--   * the CHECK, which is therefore not immutable — a row written by a session in a DST-observing zone
--     can fail the same CHECK when it is restored or re-validated under UTC.
--
-- Hours are not affected by `TimeZone`, so `interval '2160 hours'` (90 × 24) is the same duration in
-- every session. Migrations are frozen once committed, so the fix is this new file.

-- 1. Constraint ----------------------------------------------------------------------------------
-- Same name, so every caller that asserts on `idempotency_records_replay_window` keeps working.
-- NOT VALID: existing rows are immutable (the guard refuses any edit), and a row written under a
-- DST-observing session may legitimately differ from 2160 hours by one hour. Every new row is checked.
-- Rows written under a UTC session — the server default, and what every FlowLedger role uses — are
-- identical under both definitions.
ALTER TABLE api.idempotency_records DROP CONSTRAINT idempotency_records_replay_window;
ALTER TABLE api.idempotency_records
  ADD CONSTRAINT idempotency_records_replay_window
  CHECK (replay_expires_at = committed_at + interval '2160 hours') NOT VALID;

-- 2. Claim ---------------------------------------------------------------------------------------
-- The body is 0270's, with the window written in hours. CREATE OR REPLACE keeps the owner and the
-- EXECUTE ACL; only the owner may replace a function, so the statement runs as the function's current
-- owner (`payments_function_owner` after 0270), which needs CREATE on the schema for that moment only.
-- The owner is looked up rather than assumed: a database restored with `pg_dump --no-owner` (the
-- committed P02 fixture) has every object owned by the restoring role instead.
DO $$
DECLARE
  v_owner name;
BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO v_owner
    FROM pg_proc p
   WHERE p.oid = 'api.claim_idempotency_key(text,text,text,bytea,text,text,smallint,jsonb,jsonb,bytea,text,text,integer)'::regprocedure;
  IF v_owner <> current_user THEN
    EXECUTE format('GRANT CREATE ON SCHEMA api TO %I', v_owner);
    EXECUTE format('SET LOCAL ROLE %I', v_owner);
  END IF;
END
$$;

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
      p_credential_id, v_now, v_now + interval '2160 hours'
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

RESET ROLE;

-- Never leave the momentary CREATE behind. The schema owner keeps its own privileges.
DO $$
DECLARE
  v_owner name;
BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO v_owner
    FROM pg_proc p
   WHERE p.oid = 'api.claim_idempotency_key(text,text,text,bytea,text,text,smallint,jsonb,jsonb,bytea,text,text,integer)'::regprocedure;
  IF v_owner <> current_user THEN
    EXECUTE format('REVOKE CREATE ON SCHEMA api FROM %I', v_owner);
  END IF;
END
$$;
