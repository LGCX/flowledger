-- 0280_messaging_tables.sql — durable messaging: registry, outbox, inbox, dead letters, replays.
--
-- Three ideas are enforced here rather than in application code.
--
-- First, a message's identity and content are fixed at insertion. The outbox repeats eleven envelope
-- fields as separate columns so the relay can claim and query by them without parsing JSON — which only
-- helps if the two can never disagree, so a CHECK proves the copies still equal the envelope, and a
-- trigger refuses any update to either side.
--
-- Second, a hot envelope is cleared only after it has been published *and* archived, with a reference
-- recorded. The UUID/type/aggregate/hash tombstone always survives, so publication identity is never
-- lost even when the body stops being hot.
--
-- Third, the registry lives in the database too. `insert_outbox` (P02-T13) must reject an unregistered
-- type *inside* the producing transaction; a table the migration seeds, kept honest by a parity test
-- against `schemas/registry.v1.json`, is what makes that possible without a schema reader in PL/pgSQL.

-- 1. message_types -------------------------------------------------------------------------------

CREATE TABLE messaging.message_types (
  message_type text COLLATE "C" PRIMARY KEY,
  kind text NOT NULL,
  schema_version integer NOT NULL,
  aggregate_type text NOT NULL,
  schema_path text NOT NULL,

  CONSTRAINT message_types_type_format
    CHECK (message_type ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*\.v[1-9][0-9]*$'),
  CONSTRAINT message_types_kind CHECK (kind IN ('COMMAND', 'EVENT')),
  CONSTRAINT message_types_schema_version
    CHECK (schema_version = substring(message_type from '\.v([1-9][0-9]*)$')::integer),
  CONSTRAINT message_types_aggregate_type
    CHECK (aggregate_type IN ('payment', 'payment_operation', 'ledger_transaction',
                              'webhook_delivery', 'settlement_batch')),
  CONSTRAINT message_types_schema_path CHECK (char_length(schema_path) > 0)
);

-- The 26 rows of schemas/registry.v1.json. A type is added by a new migration, never by an INSERT.
INSERT INTO messaging.message_types (message_type, kind, schema_version, aggregate_type, schema_path)
VALUES
  ('payment.operation.execute.v1', 'COMMAND', 1, 'payment', 'commands/payment-operation-execute.v1.schema.json'),
  ('payment.operation.reconcile.v1', 'COMMAND', 1, 'payment', 'commands/payment-operation-reconcile.v1.schema.json'),
  ('merchant.webhook.deliver.v1', 'COMMAND', 1, 'webhook_delivery', 'commands/merchant-webhook-deliver.v1.schema.json'),
  ('payment.created.v1', 'EVENT', 1, 'payment', 'events/payment-created.v1.schema.json'),
  ('payment.authorization.requested.v1', 'EVENT', 1, 'payment', 'events/payment-operation-requested.v1.schema.json'),
  ('payment.capture.requested.v1', 'EVENT', 1, 'payment', 'events/payment-operation-requested.v1.schema.json'),
  ('payment.authorization.cancellation.requested.v1', 'EVENT', 1, 'payment', 'events/payment-operation-requested.v1.schema.json'),
  ('payment.refund.requested.v1', 'EVENT', 1, 'payment', 'events/payment-operation-requested.v1.schema.json'),
  ('payment.authorization.succeeded.v1', 'EVENT', 1, 'payment', 'events/payment-operation-terminal.v1.schema.json'),
  ('payment.authorization.rejected.v1', 'EVENT', 1, 'payment', 'events/payment-operation-terminal.v1.schema.json'),
  ('payment.authorization.failed.v1', 'EVENT', 1, 'payment', 'events/payment-operation-terminal.v1.schema.json'),
  ('payment.authorization.expired.v1', 'EVENT', 1, 'payment', 'events/payment-authorization-expired.v1.schema.json'),
  ('payment.capture.succeeded.v1', 'EVENT', 1, 'payment', 'events/payment-operation-terminal.v1.schema.json'),
  ('payment.capture.rejected.v1', 'EVENT', 1, 'payment', 'events/payment-operation-terminal.v1.schema.json'),
  ('payment.capture.failed.v1', 'EVENT', 1, 'payment', 'events/payment-operation-terminal.v1.schema.json'),
  ('payment.authorization.cancellation.succeeded.v1', 'EVENT', 1, 'payment', 'events/payment-operation-terminal.v1.schema.json'),
  ('payment.authorization.cancellation.rejected.v1', 'EVENT', 1, 'payment', 'events/payment-operation-terminal.v1.schema.json'),
  ('payment.authorization.cancellation.failed.v1', 'EVENT', 1, 'payment', 'events/payment-operation-terminal.v1.schema.json'),
  ('payment.refund.succeeded.v1', 'EVENT', 1, 'payment', 'events/payment-operation-terminal.v1.schema.json'),
  ('payment.refund.rejected.v1', 'EVENT', 1, 'payment', 'events/payment-operation-terminal.v1.schema.json'),
  ('payment.refund.failed.v1', 'EVENT', 1, 'payment', 'events/payment-operation-terminal.v1.schema.json'),
  ('payment.operation.reconciliation.required.v1', 'EVENT', 1, 'payment', 'events/payment-operation-reconciliation-required.v1.schema.json'),
  ('payment.operation.review.required.v1', 'EVENT', 1, 'payment', 'events/payment-operation-review-required.v1.schema.json'),
  ('payment.discrepancy.detected.v1', 'EVENT', 1, 'payment', 'events/payment-discrepancy-detected.v1.schema.json'),
  ('ledger.transaction.posted.v1', 'EVENT', 1, 'ledger_transaction', 'events/ledger-transaction-posted.v1.schema.json'),
  ('settlement.batch.posted.v1', 'EVENT', 1, 'settlement_batch', 'events/settlement-batch-posted.v1.schema.json')
;

CREATE TRIGGER message_types_no_update
  BEFORE UPDATE ON messaging.message_types
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER message_types_no_delete
  BEFORE DELETE ON messaging.message_types
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER message_types_no_truncate
  BEFORE TRUNCATE ON messaging.message_types
  FOR EACH STATEMENT EXECUTE FUNCTION public.fl_reject_mutation();

-- 2. outbox_messages -----------------------------------------------------------------------------

CREATE TABLE messaging.outbox_messages (
  envelope_id uuid PRIMARY KEY,
  kind text NOT NULL,
  message_type text NOT NULL,
  schema_version integer NOT NULL,
  source text NOT NULL,
  merchant_id text COLLATE "C" NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text COLLATE "C" NOT NULL,
  aggregate_version bigint NOT NULL,
  ordering_key text COLLATE "C" NOT NULL,
  correlation_id text COLLATE "C" NOT NULL,
  causation_id text COLLATE "C" NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  envelope jsonb,
  envelope_hash bytea NOT NULL,
  archived_envelope_reference text,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  publication_attempts integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  broker_message_id text,
  last_error_class text,

  CONSTRAINT outbox_messages_message_type_fkey
    FOREIGN KEY (message_type) REFERENCES messaging.message_types (message_type),
  CONSTRAINT outbox_messages_merchant_fkey
    FOREIGN KEY (merchant_id) REFERENCES identity.merchants (id),

  CONSTRAINT outbox_messages_kind CHECK (kind IN ('COMMAND', 'EVENT')),
  CONSTRAINT outbox_messages_schema_version
    CHECK (
      schema_version >= 1
      AND schema_version = substring(message_type from '\.v([1-9][0-9]*)$')::integer
    ),
  CONSTRAINT outbox_messages_aggregate_version CHECK (aggregate_version >= 1),
  CONSTRAINT outbox_messages_publication_attempts CHECK (publication_attempts >= 0),
  CONSTRAINT outbox_messages_envelope_hash CHECK (public.fl_is_sha256(envelope_hash)),
  CONSTRAINT outbox_messages_lease_pair
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT outbox_messages_archive_state
    CHECK (envelope IS NOT NULL OR (archived_envelope_reference IS NOT NULL AND published_at IS NOT NULL)),

  -- The derivation proof: while the hot envelope exists, every repeated column must equal it. Written
  -- as one CHECK so no field can be added to the copy without being proven here.
  CONSTRAINT outbox_messages_envelope_derivation CHECK (envelope IS NULL OR (
    jsonb_typeof(envelope) = 'object'
    AND envelope_id::text = envelope->>'id'
    AND kind = envelope->>'kind'
    AND message_type = envelope->>'type'
    AND schema_version::text = envelope->>'schemaVersion'
    AND source = envelope->>'source'
    AND merchant_id = envelope->>'merchantId'
    AND aggregate_type = envelope->>'aggregateType'
    AND aggregate_id = envelope->>'aggregateId'
    AND aggregate_version::text = envelope->>'aggregateVersion'
    AND ordering_key = envelope->>'orderingKey'
    AND correlation_id = envelope->>'correlationId'
    AND causation_id = envelope->>'causationId'
  ))
);

CREATE INDEX outbox_due
  ON messaging.outbox_messages (available_at, recorded_at, envelope_id)
  WHERE published_at IS NULL;

CREATE INDEX outbox_lease_recovery
  ON messaging.outbox_messages (lease_expires_at)
  WHERE published_at IS NULL AND lease_token IS NOT NULL;

CREATE INDEX outbox_messages_merchant ON messaging.outbox_messages (merchant_id);
CREATE INDEX outbox_messages_message_type ON messaging.outbox_messages (message_type);

CREATE OR REPLACE FUNCTION messaging.guard_outbox_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.fl_assert_unchanged(
    'messaging.outbox_messages',
    to_jsonb(OLD),
    to_jsonb(NEW),
    ARRAY[
      'envelope_id', 'kind', 'message_type', 'schema_version', 'source', 'merchant_id',
      'aggregate_type', 'aggregate_id', 'aggregate_version', 'ordering_key', 'correlation_id',
      'causation_id', 'occurred_at', 'recorded_at', 'envelope_hash'
    ]
  );

  -- The hot envelope survives until the bytes are known to be archived.
  IF OLD.envelope IS NOT NULL AND NEW.envelope IS NULL THEN
    IF NEW.archived_envelope_reference IS NULL OR NEW.published_at IS NULL THEN
      PERFORM public.fl_raise_domain(
        'INVALID_TRANSITION',
        jsonb_build_object('reason', 'ENVELOPE_CLEARED_BEFORE_ARCHIVE')
      );
    END IF;
  ELSIF OLD.envelope IS DISTINCT FROM NEW.envelope THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'ENVELOPE_CLEARED_BEFORE_ARCHIVE')
    );
  END IF;

  IF OLD.archived_envelope_reference IS NOT NULL
     AND OLD.archived_envelope_reference IS DISTINCT FROM NEW.archived_envelope_reference THEN
    PERFORM public.fl_raise_domain(
      'IMMUTABLE_FIELD',
      jsonb_build_object('table', 'messaging.outbox_messages', 'column', 'archived_envelope_reference')
    );
  END IF;

  IF OLD.published_at IS NOT NULL AND OLD.published_at IS DISTINCT FROM NEW.published_at THEN
    PERFORM public.fl_raise_domain(
      'IMMUTABLE_FIELD',
      jsonb_build_object('table', 'messaging.outbox_messages', 'column', 'published_at')
    );
  END IF;

  IF NEW.publication_attempts < OLD.publication_attempts THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'ATTEMPTS_DECREASED')
    );
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER outbox_messages_guard
  BEFORE UPDATE ON messaging.outbox_messages
  FOR EACH ROW EXECUTE FUNCTION messaging.guard_outbox_update();

CREATE TRIGGER outbox_messages_no_delete
  BEFORE DELETE ON messaging.outbox_messages
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER outbox_messages_no_truncate
  BEFORE TRUNCATE ON messaging.outbox_messages
  FOR EACH STATEMENT EXECUTE FUNCTION public.fl_reject_mutation();

-- 3. inbox_messages ------------------------------------------------------------------------------

CREATE TABLE messaging.inbox_messages (
  consumer_name text COLLATE "C" NOT NULL,
  envelope_id uuid NOT NULL,
  message_type text NOT NULL,
  merchant_id text COLLATE "C" NOT NULL,
  envelope_hash bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  result_reference text,

  CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, envelope_id),
  CONSTRAINT inbox_messages_merchant_fkey
    FOREIGN KEY (merchant_id) REFERENCES identity.merchants (id),

  CONSTRAINT inbox_messages_consumer_name
    CHECK (consumer_name ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT inbox_messages_message_type_format
    CHECK (message_type ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*\.v[1-9][0-9]*$'),
  CONSTRAINT inbox_messages_envelope_hash CHECK (public.fl_is_sha256(envelope_hash)),
  CONSTRAINT inbox_messages_processed_after_received CHECK (processed_at >= received_at)
);

CREATE INDEX inbox_messages_merchant ON messaging.inbox_messages (merchant_id);

CREATE TRIGGER inbox_messages_no_update
  BEFORE UPDATE ON messaging.inbox_messages
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER inbox_messages_no_delete
  BEFORE DELETE ON messaging.inbox_messages
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER inbox_messages_no_truncate
  BEFORE TRUNCATE ON messaging.inbox_messages
  FOR EACH STATEMENT EXECUTE FUNCTION public.fl_reject_mutation();

-- 4. dead_letter_records -------------------------------------------------------------------------

CREATE TABLE messaging.dead_letter_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  consumer_name text COLLATE "C" NOT NULL,
  subscription_name text NOT NULL,
  envelope_id uuid NOT NULL,
  envelope jsonb,
  envelope_hash bytea NOT NULL,
  merchant_id text COLLATE "C",
  payment_id text COLLATE "C",
  operation_id text COLLATE "C",
  correlation_id text COLLATE "C" NOT NULL,
  traceparent text,
  failure_class text NOT NULL,
  attempt_count integer NOT NULL,
  error_detail jsonb NOT NULL,
  first_failed_at timestamptz NOT NULL,
  last_failed_at timestamptz NOT NULL,
  resolved_at timestamptz,
  archived_envelope_reference text,

  CONSTRAINT dead_letter_records_consumer_envelope_key UNIQUE (consumer_name, envelope_id),
  CONSTRAINT dead_letter_records_merchant_fkey
    FOREIGN KEY (merchant_id) REFERENCES identity.merchants (id),
  CONSTRAINT dead_letter_records_payment_fkey
    FOREIGN KEY (merchant_id, payment_id) REFERENCES payments.payments (merchant_id, id),
  CONSTRAINT dead_letter_records_operation_fkey
    FOREIGN KEY (merchant_id, operation_id)
    REFERENCES payments.payment_operations (merchant_id, id),

  -- A subject identity without a tenant would not be tenant-safe.
  CONSTRAINT dead_letter_records_subject_requires_merchant
    CHECK ((payment_id IS NULL AND operation_id IS NULL) OR merchant_id IS NOT NULL),
  -- [ASSUMPTION] These four names stand for docs/07's "Schema, invariant, unsupported version, or
  -- retry exhausted" (risk R16).
  CONSTRAINT dead_letter_records_failure_class
    CHECK (failure_class IN ('SCHEMA_INVALID', 'INVARIANT_VIOLATION', 'UNSUPPORTED_VERSION', 'RETRY_EXHAUSTED')),
  CONSTRAINT dead_letter_records_attempt_count CHECK (attempt_count > 0),
  CONSTRAINT dead_letter_records_envelope_hash CHECK (public.fl_is_sha256(envelope_hash)),
  CONSTRAINT dead_letter_records_envelope_object
    CHECK (envelope IS NULL OR jsonb_typeof(envelope) = 'object'),
  CONSTRAINT dead_letter_records_error_detail_object
    CHECK (jsonb_typeof(error_detail) = 'object'),
  CONSTRAINT dead_letter_records_archive_state
    CHECK (envelope IS NOT NULL OR archived_envelope_reference IS NOT NULL),
  CONSTRAINT dead_letter_records_failure_window
    CHECK (last_failed_at >= first_failed_at),
  CONSTRAINT dead_letter_records_traceparent
    CHECK (traceparent IS NULL OR traceparent ~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$')
);

CREATE INDEX dead_letter_records_merchant
  ON messaging.dead_letter_records (merchant_id) WHERE merchant_id IS NOT NULL;
CREATE INDEX dead_letter_records_payment
  ON messaging.dead_letter_records (merchant_id, payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX dead_letter_records_operation
  ON messaging.dead_letter_records (merchant_id, operation_id) WHERE operation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION messaging.guard_dead_letter_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.fl_assert_unchanged(
    'messaging.dead_letter_records',
    to_jsonb(OLD),
    to_jsonb(NEW),
    ARRAY[
      'id', 'consumer_name', 'subscription_name', 'envelope_id', 'envelope_hash', 'merchant_id',
      'payment_id', 'operation_id', 'correlation_id', 'traceparent', 'failure_class',
      'first_failed_at'
    ]
  );

  IF NEW.attempt_count < OLD.attempt_count THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'ATTEMPTS_DECREASED')
    );
  END IF;

  IF NEW.last_failed_at < OLD.last_failed_at THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'FAILURE_WINDOW_MOVED_BACKWARDS')
    );
  END IF;

  IF OLD.resolved_at IS NOT NULL AND OLD.resolved_at IS DISTINCT FROM NEW.resolved_at THEN
    PERFORM public.fl_raise_domain(
      'IMMUTABLE_FIELD',
      jsonb_build_object('table', 'messaging.dead_letter_records', 'column', 'resolved_at')
    );
  END IF;

  IF OLD.archived_envelope_reference IS NOT NULL
     AND OLD.archived_envelope_reference IS DISTINCT FROM NEW.archived_envelope_reference THEN
    PERFORM public.fl_raise_domain(
      'IMMUTABLE_FIELD',
      jsonb_build_object('table', 'messaging.dead_letter_records', 'column', 'archived_envelope_reference')
    );
  END IF;

  IF OLD.envelope IS NOT NULL AND NEW.envelope IS NULL THEN
    IF NEW.archived_envelope_reference IS NULL THEN
      PERFORM public.fl_raise_domain(
        'INVALID_TRANSITION',
        jsonb_build_object('reason', 'ENVELOPE_CLEARED_BEFORE_ARCHIVE')
      );
    END IF;
  ELSIF OLD.envelope IS DISTINCT FROM NEW.envelope THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'ENVELOPE_CLEARED_BEFORE_ARCHIVE')
    );
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER dead_letter_records_guard
  BEFORE UPDATE ON messaging.dead_letter_records
  FOR EACH ROW EXECUTE FUNCTION messaging.guard_dead_letter_update();

CREATE TRIGGER dead_letter_records_no_delete
  BEFORE DELETE ON messaging.dead_letter_records
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER dead_letter_records_no_truncate
  BEFORE TRUNCATE ON messaging.dead_letter_records
  FOR EACH STATEMENT EXECUTE FUNCTION public.fl_reject_mutation();

-- 5. dead_letter_replays -------------------------------------------------------------------------

CREATE TABLE messaging.dead_letter_replays (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dead_letter_id bigint NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL,
  replayed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  broker_message_id text,
  outcome text NOT NULL,
  error_class text,

  CONSTRAINT dead_letter_replays_dead_letter_fkey
    FOREIGN KEY (dead_letter_id) REFERENCES messaging.dead_letter_records (id),
  CONSTRAINT dead_letter_replays_outcome
    CHECK (outcome IN ('PUBLISHED', 'SKIPPED_TERMINAL', 'FAILED')),
  CONSTRAINT dead_letter_replays_actor CHECK (char_length(actor_id) > 0),
  CONSTRAINT dead_letter_replays_reason CHECK (char_length(reason) > 0),
  CONSTRAINT dead_letter_replays_error_class
    CHECK ((outcome = 'FAILED') = (error_class IS NOT NULL))
);

CREATE INDEX dead_letter_replays_dead_letter
  ON messaging.dead_letter_replays (dead_letter_id);

CREATE TRIGGER dead_letter_replays_no_update
  BEFORE UPDATE ON messaging.dead_letter_replays
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER dead_letter_replays_no_delete
  BEFORE DELETE ON messaging.dead_letter_replays
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER dead_letter_replays_no_truncate
  BEFORE TRUNCATE ON messaging.dead_letter_replays
  FOR EACH STATEMENT EXECUTE FUNCTION public.fl_reject_mutation();

-- 6. RLS -----------------------------------------------------------------------------------------

ALTER TABLE messaging.message_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.outbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.inbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.dead_letter_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.dead_letter_replays ENABLE ROW LEVEL SECURITY;

-- Only the messaging owner has policies in this phase. Relay, consumer, and operator policies arrive
-- with the functions that use them (P05, P10), so no runtime role can reach these tables by accident.
CREATE POLICY outbox_messages_messaging_owner_all ON messaging.outbox_messages
  FOR ALL TO messaging_function_owner USING (true) WITH CHECK (true);

-- 7. Grants (last) -------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA messaging TO messaging_function_owner;
GRANT SELECT ON messaging.message_types TO messaging_function_owner;
GRANT SELECT, INSERT ON messaging.outbox_messages TO messaging_function_owner;

-- No runtime grant on any messaging table: insertion and lease paths arrive with their protected
-- functions in P05.
