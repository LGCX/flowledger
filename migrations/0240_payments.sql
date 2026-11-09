-- 0240_payments.sql — the payment aggregate row.
--
-- Every monetary invariant from docs/03 is a CHECK here, not a convention: the database refuses a row
-- whose totals could not have arisen from the state machine. The binding to provider account, provider
-- configuration version, fee policy and issuing credential is immutable and composite, so a payment
-- cannot be re-pointed at another merchant's infrastructure or priced with a policy that never applied
-- to it.
--
-- `active_exclusive_operation_id` has no foreign key yet: operations arrive in 0250. Until then the
-- column is constrained only by shape (docs/07 step 7).

-- 1. Table ---------------------------------------------------------------------------------------

CREATE TABLE payments.payments (
  id                                 text COLLATE "C" PRIMARY KEY,
  merchant_id                        text COLLATE "C" NOT NULL,
  merchant_reference                 text,
  currency                           text NOT NULL DEFAULT 'USD',
  payment_method_reference_ciphertext bytea NOT NULL,
  payment_method_key_version         text NOT NULL,
  payment_method_reference_hash      bytea NOT NULL,
  provider_account_id                text COLLATE "C" NOT NULL,
  provider_account_version           integer NOT NULL,
  provider_payment_id                text,
  provider_authorization_id          text,
  provider_capture_id                text,
  fee_policy_id                      text COLLATE "C" NOT NULL,
  fee_policy_version                 integer NOT NULL,
  requested_amount_minor             bigint NOT NULL,
  authorized_amount_minor            bigint NOT NULL DEFAULT 0,
  captured_amount_minor              bigint NOT NULL DEFAULT 0,
  refunded_amount_minor              bigint NOT NULL DEFAULT 0,
  voided_amount_minor                bigint NOT NULL DEFAULT 0,
  reserved_refund_amount_minor       bigint NOT NULL DEFAULT 0,
  unresolved_refund_count            integer NOT NULL DEFAULT 0,
  authorization_outcome              text NOT NULL DEFAULT 'NOT_REQUESTED',
  active_exclusive_operation_id      text COLLATE "C",
  version                            bigint NOT NULL DEFAULT 1,
  created_by_credential_id           text COLLATE "C",
  created_at                         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at                         timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- Keys and bindings
  CONSTRAINT payments_id_format CHECK (public.fl_is_id(id, 'pay')),
  CONSTRAINT payments_merchant_id_id_key UNIQUE (merchant_id, id),
  CONSTRAINT payments_binding_key
    UNIQUE (merchant_id, id, provider_account_id, provider_account_version),

  -- Tenant-safe foreign keys: each carries merchant_id so a cross-tenant reference cannot typecheck.
  CONSTRAINT payments_provider_account_fkey
    FOREIGN KEY (merchant_id, provider_account_id)
    REFERENCES providers.provider_accounts (merchant_id, id),
  CONSTRAINT payments_provider_account_version_fkey
    FOREIGN KEY (provider_account_id, provider_account_version)
    REFERENCES providers.provider_account_versions (provider_account_id, version),
  CONSTRAINT payments_fee_policy_fkey
    FOREIGN KEY (merchant_id, fee_policy_id, fee_policy_version)
    REFERENCES payments.fee_policies (merchant_id, id, version),
  CONSTRAINT payments_created_by_credential_fkey
    FOREIGN KEY (merchant_id, created_by_credential_id)
    REFERENCES identity.merchant_api_credentials (merchant_id, id),

  -- Scalar checks
  CONSTRAINT payments_currency CHECK (currency = 'USD'),
  CONSTRAINT payments_merchant_reference_length
    CHECK (merchant_reference IS NULL OR char_length(merchant_reference) BETWEEN 1 AND 200),
  CONSTRAINT payments_payment_method_ciphertext
    CHECK (octet_length(payment_method_reference_ciphertext) > 0),
  CONSTRAINT payments_payment_method_key_version
    CHECK (char_length(payment_method_key_version) > 0),
  CONSTRAINT payments_payment_method_hash
    CHECK (public.fl_is_sha256(payment_method_reference_hash)),
  CONSTRAINT payments_provider_refs_nonempty
    CHECK (
      coalesce(char_length(provider_payment_id), 1) > 0
      AND coalesce(char_length(provider_authorization_id), 1) > 0
      AND coalesce(char_length(provider_capture_id), 1) > 0
    ),

  -- Monetary invariants (docs/03 §Monetary invariants)
  CONSTRAINT payments_requested_amount
    CHECK (requested_amount_minor BETWEEN 1 AND 1000000000000),
  CONSTRAINT payments_totals_nonnegative
    CHECK (
      authorized_amount_minor >= 0
      AND captured_amount_minor >= 0
      AND refunded_amount_minor >= 0
      AND voided_amount_minor >= 0
      AND reserved_refund_amount_minor >= 0
      AND unresolved_refund_count >= 0
    ),
  CONSTRAINT payments_authorized_le_requested
    CHECK (authorized_amount_minor <= requested_amount_minor),
  CONSTRAINT payments_captured_le_authorized
    CHECK (captured_amount_minor <= authorized_amount_minor),
  CONSTRAINT payments_refunded_le_captured CHECK (refunded_amount_minor <= captured_amount_minor),
  CONSTRAINT payments_voided_le_uncaptured
    CHECK (voided_amount_minor <= authorized_amount_minor - captured_amount_minor),
  CONSTRAINT payments_refund_reservation_bound
    CHECK (refunded_amount_minor + reserved_refund_amount_minor <= captured_amount_minor),
  CONSTRAINT payments_reservation_count
    CHECK ((reserved_refund_amount_minor = 0) = (unresolved_refund_count = 0)),
  -- docs/03 exclusion rules 2–3: an exclusive operation and a refund are never both unresolved.
  CONSTRAINT payments_exclusive_excludes_refunds
    CHECK (active_exclusive_operation_id IS NULL OR unresolved_refund_count = 0),
  CONSTRAINT payments_active_operation_format
    CHECK (
      active_exclusive_operation_id IS NULL
      OR public.fl_is_id(active_exclusive_operation_id, 'op')
    ),

  -- State-dependent invariants (docs/03 §State-dependent invariants)
  CONSTRAINT payments_authorization_outcome
    CHECK (authorization_outcome IN ('NOT_REQUESTED', 'AUTHORIZED', 'DECLINED', 'CANCELED', 'EXPIRED')),
  CONSTRAINT payments_unauthorized_zero
    CHECK (
      authorization_outcome NOT IN ('NOT_REQUESTED', 'DECLINED')
      OR (
        authorized_amount_minor = 0
        AND captured_amount_minor = 0
        AND refunded_amount_minor = 0
        AND voided_amount_minor = 0
      )
    ),
  CONSTRAINT payments_released_authorization
    CHECK (
      authorization_outcome NOT IN ('CANCELED', 'EXPIRED')
      OR (
        captured_amount_minor = 0
        AND refunded_amount_minor = 0
        AND voided_amount_minor = authorized_amount_minor
      )
    ),
  -- A capture releases the remainder in the same statement, so a fully resolved payment always
  -- balances captured + voided against the authorization.
  CONSTRAINT payments_capture_releases_remainder
    CHECK (
      captured_amount_minor = 0
      OR captured_amount_minor + voided_amount_minor = authorized_amount_minor
    ),
  CONSTRAINT payments_version_positive CHECK (version >= 1)
);

-- 2. Indexes -------------------------------------------------------------------------------------

CREATE UNIQUE INDEX payments_merchant_reference_key
  ON payments.payments (merchant_id, merchant_reference)
  WHERE merchant_reference IS NOT NULL;

CREATE INDEX payments_merchant_history
  ON payments.payments (merchant_id, created_at DESC, id);

CREATE INDEX payments_operator_outcome
  ON payments.payments (merchant_id, authorization_outcome, updated_at DESC);

CREATE INDEX payments_active_exclusive
  ON payments.payments (active_exclusive_operation_id)
  WHERE active_exclusive_operation_id IS NOT NULL;

CREATE INDEX payments_unresolved_refunds
  ON payments.payments (merchant_id, updated_at DESC, id)
  WHERE unresolved_refund_count > 0;

-- FK-supporting indexes: without these, deleting or updating a parent scans the whole payment table.
CREATE INDEX payments_provider_version
  ON payments.payments (provider_account_id, provider_account_version);

CREATE INDEX payments_fee_policy ON payments.payments (fee_policy_id);

CREATE INDEX payments_created_by_credential
  ON payments.payments (created_by_credential_id)
  WHERE created_by_credential_id IS NOT NULL;

-- 3. Guard ---------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION payments.guard_payment_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  column_name text;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  -- The binding and the request are fixed at creation. A payment that could be re-pointed at another
  -- provider account, or re-priced, would make every total below it unattributable.
  PERFORM public.fl_assert_unchanged(
    'payments.payments',
    jsonb_build_object(
      'id', OLD.id,
      'merchant_id', OLD.merchant_id,
      'merchant_reference', OLD.merchant_reference,
      'currency', OLD.currency,
      'payment_method_reference_ciphertext', encode(OLD.payment_method_reference_ciphertext, 'hex'),
      'payment_method_key_version', OLD.payment_method_key_version,
      'payment_method_reference_hash', encode(OLD.payment_method_reference_hash, 'hex'),
      'provider_account_id', OLD.provider_account_id,
      'provider_account_version', OLD.provider_account_version,
      'fee_policy_id', OLD.fee_policy_id,
      'fee_policy_version', OLD.fee_policy_version,
      'requested_amount_minor', OLD.requested_amount_minor,
      'created_by_credential_id', OLD.created_by_credential_id,
      'created_at', OLD.created_at
    ),
    jsonb_build_object(
      'id', NEW.id,
      'merchant_id', NEW.merchant_id,
      'merchant_reference', NEW.merchant_reference,
      'currency', NEW.currency,
      'payment_method_reference_ciphertext', encode(NEW.payment_method_reference_ciphertext, 'hex'),
      'payment_method_key_version', NEW.payment_method_key_version,
      'payment_method_reference_hash', encode(NEW.payment_method_reference_hash, 'hex'),
      'provider_account_id', NEW.provider_account_id,
      'provider_account_version', NEW.provider_account_version,
      'fee_policy_id', NEW.fee_policy_id,
      'fee_policy_version', NEW.fee_policy_version,
      'requested_amount_minor', NEW.requested_amount_minor,
      'created_by_credential_id', NEW.created_by_credential_id,
      'created_at', NEW.created_at
    ),
    ARRAY[
      'id', 'merchant_id', 'merchant_reference', 'currency', 'payment_method_reference_ciphertext',
      'payment_method_key_version', 'payment_method_reference_hash', 'provider_account_id',
      'provider_account_version', 'fee_policy_id', 'fee_policy_version', 'requested_amount_minor',
      'created_by_credential_id', 'created_at'
    ]
  );

  -- Provider references are append-once: a confirmed reference is what makes an operation resolvable,
  -- so it may be filled in and never rewritten.
  FOREACH column_name IN ARRAY ARRAY['provider_payment_id', 'provider_authorization_id', 'provider_capture_id'] LOOP
    IF (old_row ->> column_name) IS NOT NULL
       AND (old_row ->> column_name) IS DISTINCT FROM (new_row ->> column_name) THEN
      PERFORM public.fl_raise_domain(
        'IMMUTABLE_FIELD',
        jsonb_build_object('table', 'payments.payments', 'column', column_name)
      );
    END IF;
  END LOOP;

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

CREATE TRIGGER payments_guard
  BEFORE UPDATE ON payments.payments
  FOR EACH ROW EXECUTE FUNCTION payments.guard_payment_update();

CREATE TRIGGER payments_no_delete
  BEFORE DELETE ON payments.payments
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER payments_no_truncate
  BEFORE TRUNCATE ON payments.payments
  FOR EACH STATEMENT EXECUTE FUNCTION public.fl_reject_mutation();

-- 4. RLS -----------------------------------------------------------------------------------------

ALTER TABLE payments.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY payments_tenant_read ON payments.payments
  FOR SELECT TO fl_api
  USING (merchant_id = public.fl_current_merchant_id());

CREATE POLICY payments_function_owner_all ON payments.payments
  FOR ALL TO payments_function_owner
  USING (true) WITH CHECK (true);

CREATE POLICY payments_messaging_owner_read ON payments.payments
  FOR SELECT TO messaging_function_owner
  USING (true);

-- 5. Grants (last) -------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA payments TO fl_api, messaging_function_owner;

-- Column-level: the ciphertext is the one field a merchant-facing role must never read, so the grant
-- says so rather than relying on a select list in every query.
GRANT SELECT (
  id, merchant_id, merchant_reference, currency, payment_method_key_version,
  payment_method_reference_hash, provider_account_id, provider_account_version, provider_payment_id,
  provider_authorization_id, provider_capture_id, fee_policy_id, fee_policy_version,
  requested_amount_minor, authorized_amount_minor, captured_amount_minor, refunded_amount_minor,
  voided_amount_minor, reserved_refund_amount_minor, unresolved_refund_count, authorization_outcome,
  active_exclusive_operation_id, version, created_by_credential_id, created_at, updated_at
) ON payments.payments TO fl_api;

GRANT SELECT, INSERT, UPDATE ON payments.payments TO payments_function_owner;
GRANT SELECT ON payments.payments TO messaging_function_owner;

-- No DELETE or TRUNCATE to anyone. No DML to any runtime role: every mutation is a protected function.
