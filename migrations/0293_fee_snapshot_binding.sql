-- 0293_fee_snapshot_binding.sql — a fee snapshot cannot disagree with the policy it names.
--
-- 0250 snapshots the fee inputs on CAPTURE and REFUND rows (docs/07 §payment_operations) but bound
-- only `(merchant_id, fee_policy_id, fee_policy_version)` to a policy. Three things were left to the
-- P04 acceptance function, which does not exist yet:
--
--   1. the snapshotted basis points, fixed amount and modes equal the policy row they name;
--   2. that policy is the payment's own immutable binding (docs/07: `fee_policy_id` on the payment is
--      the "Immutable policy binding"), not merely some policy of the same merchant;
--   3. a capture's fee is exactly HALF_UP(amount × bp / 10000) + fixed (docs/02 §Capture-fee
--      calculation) — 0250 only bounded it to `0..amount`.
--
-- docs/07 still requires the function to verify all of this; these constraints make a defect in that
-- function unable to commit. A refund's snapshot equals its capture's by transitivity: both are bound to
-- the payment's policy. Migrations are frozen once committed, so the fix is this new file.

-- 1. Targets for the composite keys --------------------------------------------------------------
ALTER TABLE payments.fee_policies
  ADD CONSTRAINT fee_policies_snapshot_key
  UNIQUE (merchant_id, id, version, basis_points, fixed_amount_minor, capture_rounding_mode,
          refund_fee_mode);

ALTER TABLE payments.payments
  ADD CONSTRAINT payments_fee_binding_key
  UNIQUE (merchant_id, id, fee_policy_id, fee_policy_version);

-- 2. The snapshot is the policy row --------------------------------------------------------------
-- MATCH SIMPLE: AUTHORIZE and CANCEL rows carry no snapshot (all null), so the key is not checked.
ALTER TABLE payments.payment_operations
  ADD CONSTRAINT payment_operations_fee_snapshot_fkey
  FOREIGN KEY (merchant_id, fee_policy_id, fee_policy_version, fee_basis_points,
               fee_fixed_amount_minor, fee_capture_rounding_mode, fee_refund_mode)
  REFERENCES payments.fee_policies (merchant_id, id, version, basis_points, fixed_amount_minor,
                                    capture_rounding_mode, refund_fee_mode);

-- 3. The policy is the payment's binding ---------------------------------------------------------
ALTER TABLE payments.payment_operations
  ADD CONSTRAINT payment_operations_payment_fee_binding_fkey
  FOREIGN KEY (merchant_id, payment_id, fee_policy_id, fee_policy_version)
  REFERENCES payments.payments (merchant_id, id, fee_policy_id, fee_policy_version);

-- 4. Exact fee arithmetic ------------------------------------------------------------------------
-- The largest intermediate is 10^12 × 10^4 = 10^16, inside bigint; bigint division truncates, which is
-- floor for these non-negative operands, and `+ 5000` makes it HALF_UP on the 1/10000 scale.
ALTER TABLE payments.payment_operations
  ADD CONSTRAINT payment_operations_capture_fee_formula
  CHECK (
    type <> 'CAPTURE'
    OR fee_effect_amount_minor
       = (amount_minor * fee_basis_points + 5000) / 10000 + fee_fixed_amount_minor
  );

-- A refund reverses floor(F·R1/G) − floor(F·R0/G) of the fee. With F <= G that is never more than the
-- refund amount R1 − R0, so a larger value can only be a computation defect.
ALTER TABLE payments.payment_operations
  ADD CONSTRAINT payment_operations_refund_fee_bound
  CHECK (
    type <> 'REFUND'
    OR fee_effect_amount_minor IS NULL
    OR fee_effect_amount_minor <= amount_minor
  );
