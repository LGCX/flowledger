-- 0290_insert_outbox.sql — the only way a row enters the outbox.
--
-- The producer validates the envelope against the checked-in JSON Schema first (docs/07: "the producer
-- runs the checked-in strict JSON Schema validator, then calls"), so this function is not a schema
-- validator. It is the *authority* layer: the checks that cannot be done from the envelope alone —
-- whether the type is registered, whether the aggregate it names actually exists and belongs to the
-- stated merchant, whether the identity fields agree with the payload.
--
-- SECURITY DEFINER with a pinned search_path because the callers are function owners that must not need
-- INSERT on the table. Every rejection aborts the enclosing transaction, which is the point: a producer
-- that cannot record its event must not commit the state change that produced it.

CREATE OR REPLACE FUNCTION messaging.insert_outbox(p_envelope jsonb) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_allowed text[] := ARRAY[
    'id', 'kind', 'type', 'schemaVersion', 'source', 'occurredAt', 'recordedAt', 'merchantId',
    'aggregateType', 'aggregateId', 'aggregateVersion', 'orderingKey', 'correlationId',
    'causationId', 'traceparent', 'data'
  ];
  v_required text[] := ARRAY[
    'id', 'kind', 'type', 'schemaVersion', 'source', 'occurredAt', 'recordedAt', 'merchantId',
    'aggregateType', 'aggregateId', 'aggregateVersion', 'orderingKey', 'correlationId',
    'causationId', 'data'
  ];
  v_key text;
  v_env jsonb;
  v_registered messaging.message_types%ROWTYPE;
  v_payment_id text;
  v_operation_id text;
BEGIN
  -- 1. It has to be an object before anything can be read from it.
  IF jsonb_typeof(p_envelope) IS DISTINCT FROM 'object' THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'NOT_OBJECT', 'field', null));
  END IF;

  -- 2. No key outside the contract. A silently ignored field is a field a producer believes works.
  FOR v_key IN SELECT jsonb_object_keys(p_envelope) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'UNKNOWN_FIELD', 'field', v_key));
    END IF;
  END LOOP;

  -- 3. Every field except `traceparent` is required and non-null.
  FOREACH v_key IN ARRAY v_required LOOP
    IF p_envelope->v_key IS NULL OR jsonb_typeof(p_envelope->v_key) = 'null' THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'MISSING_FIELD', 'field', v_key));
    END IF;
  END LOOP;

  -- 4. Field formats, checked here because a `mer_UNKNOWN` or a bare timestamp would otherwise reach
  --    the relational columns and fail later with an error that names the wrong thing.
  IF (p_envelope->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'id'));
  END IF;

  IF (p_envelope->>'occurredAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$' THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'occurredAt'));
  END IF;

  IF (p_envelope->>'recordedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$' THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'recordedAt'));
  END IF;

  IF (p_envelope->>'source') !~ '^flowledger\.[a-z][a-z0-9.]*$' OR char_length(p_envelope->>'source') > 100 THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'source'));
  END IF;

  IF NOT public.fl_is_id(p_envelope->>'merchantId', 'mer') THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'merchantId'));
  END IF;

  IF (p_envelope->>'aggregateId') !~ '^[a-z][a-z0-9]{1,15}_[0-7][0-9A-HJKMNP-TV-Z]{25}$' THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'aggregateId'));
  END IF;

  -- JSON integers, not numeric strings: a `"1"` would compare equal to the registered version but is a
  -- different JSON type, and the column would then be fed a string.
  IF jsonb_typeof(p_envelope->'schemaVersion') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_envelope->'aggregateVersion') IS DISTINCT FROM 'number' THEN
    PERFORM public.fl_raise_domain(
      'INVALID_ENVELOPE',
      jsonb_build_object(
        'reason', 'INVALID_FIELD_FORMAT',
        'field', CASE WHEN jsonb_typeof(p_envelope->'schemaVersion') IS DISTINCT FROM 'number'
                      THEN 'schemaVersion' ELSE 'aggregateVersion' END
      )
    );
  END IF;

  IF (p_envelope->>'schemaVersion')::numeric < 1
     OR (p_envelope->>'schemaVersion')::numeric <> trunc((p_envelope->>'schemaVersion')::numeric) THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'schemaVersion'));
  END IF;

  IF (p_envelope->>'aggregateVersion')::numeric < 1
     OR (p_envelope->>'aggregateVersion')::numeric <> trunc((p_envelope->>'aggregateVersion')::numeric) THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'aggregateVersion'));
  END IF;

  IF char_length(p_envelope->>'orderingKey') NOT BETWEEN 1 AND 128 THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'orderingKey'));
  END IF;

  IF (p_envelope->>'correlationId') !~ '^[A-Za-z0-9._:-]{16,128}$' THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'correlationId'));
  END IF;

  IF char_length(p_envelope->>'causationId') NOT BETWEEN 1 AND 128 THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'causationId'));
  END IF;

  IF p_envelope ? 'traceparent' AND jsonb_typeof(p_envelope->'traceparent') <> 'null'
     AND (p_envelope->>'traceparent') !~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$' THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'traceparent'));
  END IF;

  IF jsonb_typeof(p_envelope->'data') IS DISTINCT FROM 'object' THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'INVALID_FIELD_FORMAT', 'field', 'data'));
  END IF;

  -- 5-8. Registry agreement. This is why the registry lives in the database: a producer cannot publish
  --      a type the contract does not define, even if it skips the TypeScript validator.
  SELECT * INTO v_registered
    FROM messaging.message_types t
   WHERE t.message_type = p_envelope->>'type';

  IF NOT FOUND THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'UNREGISTERED_TYPE', 'field', 'type'));
  END IF;

  IF p_envelope->>'kind' IS DISTINCT FROM v_registered.kind THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'KIND_MISMATCH', 'field', 'kind'));
  END IF;

  IF (p_envelope->>'schemaVersion')::integer IS DISTINCT FROM v_registered.schema_version THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'SCHEMA_VERSION_MISMATCH', 'field', 'schemaVersion'));
  END IF;

  IF p_envelope->>'aggregateType' IS DISTINCT FROM v_registered.aggregate_type THEN
    PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'AGGREGATE_TYPE_MISMATCH', 'field', 'aggregateType'));
  END IF;

  -- 9-14. Identity agreement between the envelope's identity fields and its payload.
  IF v_registered.aggregate_type = 'payment' THEN
    IF NOT public.fl_is_id(p_envelope->>'aggregateId', 'pay') THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'AGGREGATE_ID_MISMATCH', 'field', 'aggregateId'));
    END IF;
    IF p_envelope->>'aggregateId' IS DISTINCT FROM p_envelope->'data'->>'paymentId' THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'AGGREGATE_ID_MISMATCH', 'field', 'aggregateId'));
    END IF;
    IF p_envelope->>'orderingKey' IS DISTINCT FROM p_envelope->'data'->>'paymentId' THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'ORDERING_KEY_MISMATCH', 'field', 'orderingKey'));
    END IF;

    -- An execution command authorizes against the payment version the caller observed; a mismatch means
    -- the command was built for a stale view.
    IF p_envelope->>'type' = 'payment.operation.execute.v1' THEN
      IF (p_envelope->>'aggregateVersion')::bigint IS DISTINCT FROM (p_envelope->'data'->>'expectedPaymentVersion')::bigint THEN
        PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'AGGREGATE_VERSION_MISMATCH', 'field', 'aggregateVersion'));
      END IF;
    END IF;

    -- The aggregate must exist and belong to the stated merchant: an envelope cannot smuggle another
    -- tenant's payment into this merchant's outbox.
    IF NOT EXISTS (
      SELECT 1 FROM payments.payments p
       WHERE p.id = p_envelope->>'aggregateId' AND p.merchant_id = p_envelope->>'merchantId'
    ) THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'SUBJECT_NOT_FOUND', 'field', 'aggregateId'));
    END IF;

    v_operation_id := p_envelope->'data'->>'operationId';
    IF v_operation_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM payments.payment_operations o
         WHERE o.id = v_operation_id
           AND o.payment_id = p_envelope->>'aggregateId'
           AND o.merchant_id = p_envelope->>'merchantId'
      ) THEN
        PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'SUBJECT_NOT_FOUND', 'field', 'operationId'));
      END IF;
    END IF;

  ELSIF v_registered.aggregate_type = 'ledger_transaction' THEN
    IF p_envelope->>'aggregateId' IS DISTINCT FROM p_envelope->'data'->>'ledgerTransactionId' THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'AGGREGATE_ID_MISMATCH', 'field', 'aggregateId'));
    END IF;

  ELSIF v_registered.aggregate_type = 'webhook_delivery' THEN
    -- [ASSUMPTION] The ordering key for a webhook delivery is its endpoint ID (docs/09 D-06).
    IF p_envelope->>'aggregateId' IS DISTINCT FROM p_envelope->'data'->>'deliveryId' THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'AGGREGATE_ID_MISMATCH', 'field', 'aggregateId'));
    END IF;
    IF p_envelope->>'orderingKey' IS DISTINCT FROM p_envelope->'data'->>'endpointId' THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'ORDERING_KEY_MISMATCH', 'field', 'orderingKey'));
    END IF;

  ELSIF v_registered.aggregate_type = 'settlement_batch' THEN
    IF p_envelope->>'aggregateId' IS DISTINCT FROM p_envelope->'data'->>'settlementBatchId' THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'AGGREGATE_ID_MISMATCH', 'field', 'aggregateId'));
    END IF;
    IF p_envelope->>'orderingKey' IS DISTINCT FROM p_envelope->>'merchantId' THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'ORDERING_KEY_MISMATCH', 'field', 'orderingKey'));
    END IF;
    IF (p_envelope->>'aggregateVersion')::bigint <> 1 THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'AGGREGATE_VERSION_MISMATCH', 'field', 'aggregateVersion'));
    END IF;
    -- Explicit types: with an unknown literal on the left, `||` resolves to `jsonb || anynonarray` and
    -- PostgreSQL tries to parse 'settlement:' as JSON.
    IF p_envelope->'data'->>'postingKey' IS DISTINCT FROM
       ('settlement:'::text || (p_envelope->>'aggregateId')::text) THEN
      PERFORM public.fl_raise_domain('INVALID_ENVELOPE', jsonb_build_object('reason', 'POSTING_KEY_MISMATCH', 'field', 'data.postingKey'));
    END IF;
  END IF;

  -- 15. Insert, deriving every relational column from the envelope so the copies cannot disagree with it
  --     even momentarily. The ID is lower-cased because the schema accepts either case and the column is
  --     `uuid`: two spellings of one ID must not become two identities.
  v_env := jsonb_set(p_envelope, '{id}', to_jsonb(lower(p_envelope->>'id')));

  INSERT INTO messaging.outbox_messages (
    envelope_id, kind, message_type, schema_version, source, merchant_id, aggregate_type,
    aggregate_id, aggregate_version, ordering_key, correlation_id, causation_id, occurred_at,
    envelope, envelope_hash
  ) VALUES (
    (v_env->>'id')::uuid,
    v_env->>'kind',
    v_env->>'type',
    (v_env->>'schemaVersion')::integer,
    v_env->>'source',
    v_env->>'merchantId',
    v_env->>'aggregateType',
    v_env->>'aggregateId',
    (v_env->>'aggregateVersion')::bigint,
    v_env->>'orderingKey',
    v_env->>'correlationId',
    v_env->>'causationId',
    (v_env->>'occurredAt')::timestamptz,
    v_env,
    -- [ASSUMPTION] SHA-256 over PostgreSQL's canonical jsonb text form (risk R6).
    sha256(convert_to(v_env::text, 'UTF8'))
  );

  RETURN (v_env->>'id')::uuid;
END
$$;

-- A defect in 0280 surfaced here: RLS was enabled on `messaging.message_types` with no policy, so a
-- SECURITY DEFINER function owned by `messaging_function_owner` sees an empty registry and rejects every
-- envelope as UNREGISTERED_TYPE. Migrations are frozen once committed, so the policy is added here.
CREATE POLICY message_types_messaging_owner_read ON messaging.message_types
  FOR SELECT TO messaging_function_owner
  USING (true);

REVOKE ALL ON FUNCTION messaging.insert_outbox(jsonb) FROM PUBLIC;

-- [ASSUMPTION] The EXECUTE ACL is the invoker boundary (risk R15): only function-owner roles publish,
-- and no runtime role can execute this in M2.
GRANT EXECUTE ON FUNCTION messaging.insert_outbox(jsonb) TO
  payments_function_owner,
  ledger_function_owner,
  settlement_function_owner,
  reconciliation_function_owner,
  webhooks_function_owner;

GRANT USAGE ON SCHEMA messaging TO
  payments_function_owner,
  ledger_function_owner,
  settlement_function_owner,
  reconciliation_function_owner,
  webhooks_function_owner;

SELECT public.fl_assign_function_owner('messaging.insert_outbox(jsonb)'::regprocedure, 'messaging_function_owner');
