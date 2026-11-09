-- 0230_fee_policies.sql — immutable, versioned fee policies.
--
-- A fee change creates a new row; payments and operations keep referencing the version they were
-- priced with, so a historical charge can always be recomputed from the policy it used.
--
-- The interesting constraint is `fee_policies_fee_within_minimum`. It is what makes "an accepted
-- capture can always be priced" a structural guarantee rather than a runtime hope: a policy must
-- declare a minimum high enough to cover the fee it charges at that minimum. Without it, a policy of
-- 5000 bp, 30 fixed, minimum 30 admits a capture of 40 whose fee is 50 — more than the capture.

-- 1. Table ---------------------------------------------------------------------------------------

CREATE TABLE payments.fee_policies (
  id                           text COLLATE "C" PRIMARY KEY,
  merchant_id                  text COLLATE "C" NOT NULL,
  version                      integer NOT NULL,
  currency                     text NOT NULL DEFAULT 'USD',
  basis_points                 integer NOT NULL,
  fixed_amount_minor           bigint NOT NULL,
  minimum_capture_amount_minor bigint NOT NULL,
  capture_rounding_mode        text NOT NULL DEFAULT 'HALF_UP',
  refund_fee_mode              text NOT NULL DEFAULT 'PROPORTIONAL',
  effective_from               timestamptz NOT NULL DEFAULT clock_timestamp(),
  superseded_at                timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT fee_policies_id_format CHECK (public.fl_is_id(id, 'fee')),
  CONSTRAINT fee_policies_version_positive CHECK (version > 0),
  CONSTRAINT fee_policies_currency CHECK (currency = 'USD'),
  CONSTRAINT fee_policies_basis_points CHECK (basis_points BETWEEN 0 AND 10000),
  CONSTRAINT fee_policies_fixed_amount CHECK (fixed_amount_minor BETWEEN 0 AND 1000000000000),
  CONSTRAINT fee_policies_minimum_capture
    CHECK (minimum_capture_amount_minor >= GREATEST(fixed_amount_minor, 1)),
  CONSTRAINT fee_policies_minimum_capture_max
    CHECK (minimum_capture_amount_minor <= 1000000000000),
  -- The structural guarantee (D-07). Integer division on non-negative bigint is the intended floor;
  -- the largest intermediate is 1e16, inside bigint range.
  CONSTRAINT fee_policies_fee_within_minimum
    CHECK (
      (minimum_capture_amount_minor * basis_points + 5000) / 10000 + fixed_amount_minor
        <= minimum_capture_amount_minor
    ),
  CONSTRAINT fee_policies_capture_rounding_mode CHECK (capture_rounding_mode = 'HALF_UP'),
  CONSTRAINT fee_policies_refund_fee_mode CHECK (refund_fee_mode = 'PROPORTIONAL'),

  CONSTRAINT fee_policies_merchant_version_key UNIQUE (merchant_id, version),
  -- Target of later composite foreign keys: a payment references its policy by (merchant, id, version)
  -- so it cannot be priced with another merchant's policy or an unpinned version.
  CONSTRAINT fee_policies_merchant_id_version_key UNIQUE (merchant_id, id, version),
  CONSTRAINT fee_policies_merchant_fkey
    FOREIGN KEY (merchant_id) REFERENCES identity.merchants (id)
);

CREATE UNIQUE INDEX fee_policies_one_current
  ON payments.fee_policies (merchant_id, currency)
  WHERE superseded_at IS NULL;

-- 2. Triggers ------------------------------------------------------------------------------------

CREATE TRIGGER fee_policies_insert
  BEFORE INSERT ON payments.fee_policies
  FOR EACH ROW EXECUTE FUNCTION public.fl_version_monotonic('merchant_id');

CREATE TRIGGER fee_policies_guard
  BEFORE UPDATE ON payments.fee_policies
  FOR EACH ROW EXECUTE FUNCTION public.fl_guard_immutable(
    'id', 'merchant_id', 'version', 'currency', 'basis_points', 'fixed_amount_minor',
    'minimum_capture_amount_minor', 'capture_rounding_mode', 'refund_fee_mode',
    'effective_from', 'created_at'
  );

CREATE TRIGGER fee_policies_supersede
  BEFORE UPDATE ON payments.fee_policies
  FOR EACH ROW EXECUTE FUNCTION public.fl_supersede_once();

CREATE TRIGGER fee_policies_no_delete
  BEFORE DELETE ON payments.fee_policies
  FOR EACH ROW EXECUTE FUNCTION public.fl_reject_mutation();

CREATE TRIGGER fee_policies_no_truncate
  BEFORE TRUNCATE ON payments.fee_policies
  FOR EACH STATEMENT EXECUTE FUNCTION public.fl_reject_mutation();

-- 3. RLS -----------------------------------------------------------------------------------------

ALTER TABLE payments.fee_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY fee_policies_function_owner_read ON payments.fee_policies
  FOR SELECT TO payments_function_owner
  USING (true);

-- 4. Grants (last) -------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA payments TO payments_function_owner;
GRANT SELECT ON payments.fee_policies TO payments_function_owner;

-- Appending a version is the owner's or the fixture's job: supersede the current row and insert the
-- next one in a single transaction. No runtime role needs a function for this through M13.
