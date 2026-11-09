-- 0250_payment_operations.sql — operation rows, exclusion indexes, and the active-exclusive link.
--
-- Two rules shape this file.
--
-- First, an operation inherits its payment's provider binding through a composite foreign key, so an
-- operation cannot be executed against a provider account or configuration version the payment was not
-- bound to.
--
-- Second, refusals aside, exactly one *exclusive* operation (AUTHORIZE, CAPTURE, CANCEL) may be
-- unresolved at a time, enforced by a partial unique index. Refunds are deliberately excluded from that
-- index: several may be unresolved concurrently, bounded instead by the payment's refund reservation.
-- That asymmetry is the whole concurrency model, and it is expressed here rather than in application
-- code.

-- 1. Table ---------------------------------------------------------------------------------------

CREATE TABLE payments.payment_operations (
  id                       text COLLATE "C" PRIMARY KEY,
  merchant_id              text COLLATE "C" NOT NULL,
  payment_id               text COLLATE "C" NOT NULL,
  type                     text NOT NULL,
  amount_minor             bigint NOT NULL,
  currency                 text NOT NULL DEFAULT 'USD',
  status                   text NOT NULL DEFAULT 'REQUESTED',
  provider_account_id      text COLLATE "C" NOT NULL,
  provider_account_version integer NOT NULL,
  provider_idempotency_key text COLLATE "C" NOT NULL,
  provider_operation_id    text,
  capture_operation_id     text COLLATE "C",
  fee_policy_id            text COLLATE "C",
  fee_policy_version       integer,
  fee_basis_points         integer,
  fee_fixed_amount_minor   bigint,
  fee_capture_rounding_mode text,
  fee_refund_mode          text,
  fee_effect_type          text NOT NULL DEFAULT 'NONE',
  fee_effect_amount_minor  bigint,
  result_code              text,
  resolution_source        text,
  resolution_evidence_id   text COLLATE "C",
  processing_started_at    timestamptz,
  lease_token              uuid,
  lease_expires_at         timestamptz,
  not_before               timestamptz,
  version                  bigint NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at              timestamptz,

  -- Keys
  CONSTRAINT payment_operations_id_format CHECK (public.fl_is_id(id, 'op')),
  CONSTRAINT payment_operations_merchant_id_id_key UNIQUE (merchant_id, id),
  CONSTRAINT payment_operations_payment_scope_key UNIQUE (merchant_id, payment_id, id),
  CONSTRAINT payment_operations_attempt_binding_key
    UNIQUE (merchant_id, id, provider_account_id, provider_idempotency_key),
  -- A provider idempotency key identifies one operation for one account, forever.
  CONSTRAINT payment_operations_provider_key
    UNIQUE (provider_account_id, provider_idempotency_key),

  -- Foreign keys
  CONSTRAINT payment_operations_payment_binding_fkey
    FOREIGN KEY (merchant_id, payment_id, provider_account_id, provider_account_version)
    REFERENCES payments.payments (merchant_id, id, provider_account_id, provider_account_version),
  CONSTRAINT payment_operations_fee_policy_fkey
    FOREIGN KEY (merchant_id, fee_policy_id, fee_policy_version)
    REFERENCES payments.fee_policies (merchant_id, id, version),
  -- A refund names the capture it reverses, and that capture must belong to the same payment.
  CONSTRAINT payment_operations_capture_fkey
    FOREIGN KEY (merchant_id, payment_id, capture_operation_id)
    REFERENCES payments.payment_operations (merchant_id, payment_id, id),

  -- Scalar checks
  CONSTRAINT payment_operations_type
    CHECK (type IN ('AUTHORIZE', 'CAPTURE', 'CANCEL', 'REFUND')),
  CONSTRAINT payment_operations_amount CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  CONSTRAINT payment_operations_currency CHECK (currency = 'USD'),
  CONSTRAINT payment_operations_status
    CHECK (status IN ('REQUESTED', 'PROCESSING', 'SUCCEEDED', 'REJECTED', 'FAILED', 'UNKNOWN', 'REQUIRES_REVIEW')),
  CONSTRAINT payment_operations_provider_key_nonempty
    CHECK (char_length(provider_idempotency_key) BETWEEN 1 AND 255),
  CONSTRAINT payment_operations_version_positive CHECK (version >= 1),

  -- Terminal states carry a resolution; non-terminal ones do not.
  CONSTRAINT payment_operations_resolved_at
    CHECK ((status IN ('SUCCEEDED', 'REJECTED', 'FAILED')) = (resolved_at IS NOT NULL)),
  CONSTRAINT payment_operations_resolution
    CHECK (
      (status IN ('SUCCEEDED', 'REJECTED', 'FAILED')) = (resolution_evidence_id IS NOT NULL)
      AND (resolution_evidence_id IS NULL) = (resolution_source IS NULL)
    ),
  CONSTRAINT payment_operations_resolution_source
    CHECK (resolution_source IS NULL OR resolution_source IN ('API_RESPONSE', 'PROVIDER_WEBHOOK', 'RECONCILIATION')),
  CONSTRAINT payment_operations_resolution_evidence_format
    CHECK (resolution_evidence_id IS NULL OR public.fl_is_id(resolution_evidence_id, 'pev')),

  -- A success names what the provider did; a rejection or failure says why.
  CONSTRAINT payment_operations_success_reference
    CHECK (status <> 'SUCCEEDED' OR (provider_operation_id IS NOT NULL AND result_code IS NULL)),
  CONSTRAINT payment_operations_result_code
    CHECK (
      (status IN ('REJECTED', 'FAILED')) = (result_code IS NOT NULL)
      AND (result_code IS NULL OR result_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
    ),

  -- Refunds point at their capture; other types do not.
  CONSTRAINT payment_operations_refund_capture_link
    CHECK ((type = 'REFUND') = (capture_operation_id IS NOT NULL)),

  -- CAPTURE and REFUND snapshot the policy they were priced with; AUTHORIZE and CANCEL never do.
  CONSTRAINT payment_operations_fee_snapshot
    CHECK (
      CASE
        WHEN type IN ('CAPTURE', 'REFUND') THEN
          fee_policy_id IS NOT NULL
          AND fee_policy_version IS NOT NULL
          AND fee_basis_points IS NOT NULL
          AND fee_fixed_amount_minor IS NOT NULL
          AND fee_capture_rounding_mode IS NOT NULL
          AND fee_refund_mode IS NOT NULL
        ELSE
          fee_policy_id IS NULL
          AND fee_policy_version IS NULL
          AND fee_basis_points IS NULL
          AND fee_fixed_amount_minor IS NULL
          AND fee_capture_rounding_mode IS NULL
          AND fee_refund_mode IS NULL
      END
    ),
  CONSTRAINT payment_operations_fee_snapshot_values
    CHECK (
      (fee_basis_points IS NULL OR fee_basis_points BETWEEN 0 AND 10000)
      AND (fee_fixed_amount_minor IS NULL OR fee_fixed_amount_minor BETWEEN 0 AND 1000000000000)
      AND (fee_capture_rounding_mode IS NULL OR fee_capture_rounding_mode = 'HALF_UP')
      AND (fee_refund_mode IS NULL OR fee_refund_mode = 'PROPORTIONAL')
    ),

  -- A capture charges a fee at acceptance; a refund computes one only when it succeeds. This is what
  -- makes "no fee effect before confirmation" a database fact rather than a handler convention.
  CONSTRAINT payment_operations_fee_effect
    CHECK (
      CASE type
        WHEN 'CAPTURE' THEN
          fee_effect_type = 'CHARGE'
          AND fee_effect_amount_minor IS NOT NULL
          AND fee_effect_amount_minor BETWEEN 0 AND amount_minor
        WHEN 'REFUND' THEN
          fee_effect_type = 'REFUND'
          AND (
            (status = 'SUCCEEDED' AND fee_effect_amount_minor IS NOT NULL AND fee_effect_amount_minor >= 0)
            OR (status <> 'SUCCEEDED' AND fee_effect_amount_minor IS NULL)
          )
        ELSE
          fee_effect_type = 'NONE' AND fee_effect_amount_minor IS NULL
      END
    ),

  -- A deadline only exists for work that has not started.
  CONSTRAINT payment_operations_not_before
    CHECK (not_before IS NULL OR status = 'REQUESTED')
);

-- 2. Exclusion and uniqueness indexes (docs/03 §Operation exclusion model) ---------------------------

-- AUTHORIZE, CAPTURE and CANCEL contend for the single exclusive slot. REFUND is absent on purpose:
-- concurrent refunds are bounded by the payment's reservation, not by this index.
CREATE UNIQUE INDEX payment_operations_one_active_exclusive
  ON payments.payment_operations (payment_id)
  WHERE status IN ('REQUESTED', 'PROCESSING', 'UNKNOWN', 'REQUIRES_REVIEW')
    AND type IN ('AUTHORIZE', 'CAPTURE', 'CANCEL');

CREATE UNIQUE INDEX payment_operations_one_successful_authorization
  ON payments.payment_operations (payment_id)
  WHERE type = 'AUTHORIZE' AND status = 'SUCCEEDED';

CREATE UNIQUE INDEX payment_operations_one_successful_capture
  ON payments.payment_operations (payment_id)
  WHERE type = 'CAPTURE' AND status = 'SUCCEEDED';

CREATE UNIQUE INDEX payment_operations_one_successful_cancel
  ON payments.payment_operations (payment_id)
  WHERE type = 'CANCEL' AND status = 'SUCCEEDED';

-- 3. Operational indexes --------------------------------------------------------------------------

CREATE INDEX payment_operations_history
  ON payments.payment_operations (merchant_id, payment_id, created_at, id);

CREATE INDEX payment_operations_due
  ON payments.payment_operations (not_before, created_at, id)
  WHERE status = 'REQUESTED' AND not_before IS NOT NULL;

CREATE INDEX payment_operations_leases
  ON payments.payment_operations (status, lease_expires_at)
  WHERE status IN ('PROCESSING', 'UNKNOWN', 'REQUIRES_REVIEW');

CREATE INDEX payment_operations_provider_operation
  ON payments.payment_operations (provider_account_id, provider_operation_id)
  WHERE provider_operation_id IS NOT NULL;

CREATE INDEX payment_operations_capture
  ON payments.payment_operations (capture_operation_id)
  WHERE capture_operation_id IS NOT NULL;

CREATE INDEX payment_operations_fee_policy
  ON payments.payment_operations (fee_policy_id)
  WHERE fee_policy_id IS NOT NULL;

-- 4. Active-exclusive link ------------------------------------------------------------------------

-- Deferrable because a single statement may resolve one operation and set the next in either order;
-- the constraint is checked at commit rather than mid-statement. It carries merchant and payment, so
-- the pointer cannot name another payment's operation.
ALTER TABLE payments.payments
  ADD CONSTRAINT payments_active_exclusive_operation_fkey
  FOREIGN KEY (merchant_id, id, active_exclusive_operation_id)
  REFERENCES payments.payment_operations (merchant_id, payment_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX payments_active_exclusive_operation
  ON payments.payments (active_exclusive_operation_id)
  WHERE active_exclusive_operation_id IS NOT NULL;

-- 5. Guard ----------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION payments.guard_operation_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  immutable_columns text[] := ARRAY[
    'id', 'merchant_id', 'payment_id', 'type', 'amount_minor', 'currency',
    'provider_account_id', 'provider_account_version', 'provider_idempotency_key',
    'capture_operation_id', 'fee_policy_id', 'fee_policy_version', 'fee_basis_points',
    'fee_fixed_amount_minor', 'fee_capture_rounding_mode', 'fee_refund_mode',
    'fee_effect_type', 'created_at'
  ];
BEGIN
  -- A terminal operation is settled. Later evidence is appended elsewhere; nothing about the row moves,
  -- which is what makes a resolved outcome stable enough to attest.
  IF OLD.status IN ('SUCCEEDED', 'REJECTED', 'FAILED') THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'TERMINAL_OPERATION', 'status', OLD.status)
    );
  END IF;

  -- A capture's fee is fixed at acceptance; a refund's is fixed when it succeeds.
  -- ARRAY[...] rather than a bare literal: `text[] || 'x'` resolves the right side as an array
  -- literal and fails with "malformed array literal".
  IF OLD.type <> 'REFUND' THEN
    immutable_columns := immutable_columns || ARRAY['fee_effect_amount_minor'];
  ELSIF OLD.fee_effect_amount_minor IS NOT NULL THEN
    immutable_columns := immutable_columns || ARRAY['fee_effect_amount_minor'];
  END IF;

  PERFORM public.fl_assert_unchanged(
    'payments.payment_operations',
    to_jsonb(OLD),
    to_jsonb(NEW),
    immutable_columns
  );

  -- Append-once: the provider reference that confirms an operation may be filled in, never rewritten.
  IF OLD.provider_operation_id IS NOT NULL
     AND OLD.provider_operation_id IS DISTINCT FROM NEW.provider_operation_id THEN
    PERFORM public.fl_raise_domain(
      'IMMUTABLE_FIELD',
      jsonb_build_object('table', 'payments.payment_operations', 'column', 'provider_operation_id')
    );
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    PERFORM public.fl_raise_domain(
      'INVALID_TRANSITION',
      jsonb_build_object('reason', 'VERSION_NOT_INCREMENTED', 'expected', OLD.version + 1)
    );
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER payment_operations_guard
  BEFORE UPDATE ON payments.payment_operations
  FOR EACH ROW EXECUTE FUNCTION payments.guard_operation_update();

CREATE TRIGGER payment_operations_no_delete
  BEFORE DELETE ON payments.payment_operations
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER payment_operations_no_truncate
  BEFORE TRUNCATE ON payments.payment_operations
  FOR EACH STATEMENT EXECUTE FUNCTION public.fl_reject_mutation();

-- 6. RLS ------------------------------------------------------------------------------------------

ALTER TABLE payments.payment_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_operations_tenant_read ON payments.payment_operations
  FOR SELECT TO fl_api
  USING (merchant_id = public.fl_current_merchant_id());

CREATE POLICY payment_operations_function_owner_all ON payments.payment_operations
  FOR ALL TO payments_function_owner
  USING (true) WITH CHECK (true);

CREATE POLICY payment_operations_messaging_owner_read ON payments.payment_operations
  FOR SELECT TO messaging_function_owner
  USING (true);

-- 7. Grants (last) --------------------------------------------------------------------------------

GRANT SELECT ON payments.payment_operations TO fl_api, messaging_function_owner;
GRANT SELECT, INSERT, UPDATE ON payments.payment_operations TO payments_function_owner;

-- No DELETE or TRUNCATE to anyone, and no DML to any runtime role.
