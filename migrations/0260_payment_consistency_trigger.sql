-- 0260_payment_consistency_trigger.sql — the aggregate fields must agree with the operation rows.
--
-- The payment row carries maintained totals (`captured_amount_minor`, `reserved_refund_amount_minor`,
-- the pointer, the outcome). Those are denormalized for locking and query speed, which means they can
-- drift. This deferred constraint trigger is what makes them trustworthy: at commit, every touched
-- payment's fields must equal what its operation rows say, or the transaction fails.
--
-- Deferred on purpose. A single logical transition may resolve one operation and update the payment in
-- either order, and an immediate check would reject the intermediate state of a correct sequence. The
-- check therefore runs at COMMIT, where only a genuinely inconsistent outcome can survive.
--
-- It raises `23514` with the constraint name `payment_aggregate_consistency` and the offending field in
-- the message, so a caller sees which invariant broke rather than a generic failure.

CREATE OR REPLACE FUNCTION payments.assert_payment_consistency() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_payment_id text;
  v_payment payments.payments%ROWTYPE;
  v_pointer text;
  v_reserved bigint;
  v_refund_count integer;
  v_captured bigint;
  v_refunded bigint;
  v_has_authorize boolean;
  v_has_cancel boolean;
BEGIN
  -- Read generically: `payments` has no `payment_id` column and `payment_operations` has both, so a
  -- CASE over NEW fields fails to resolve the missing one at runtime (42703).
  v_payment_id := coalesce(to_jsonb(NEW) ->> 'payment_id', to_jsonb(NEW) ->> 'id');

  SELECT * INTO v_payment FROM payments.payments WHERE id = v_payment_id;
  -- The payment may legitimately be gone only if the whole transaction rolled back, in which case
  -- nothing is checked. A missing row here means the operation outlived its payment, which the
  -- foreign key already forbids.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT o.id INTO v_pointer
    FROM payments.payment_operations o
   WHERE o.payment_id = v_payment_id
     AND o.type IN ('AUTHORIZE', 'CAPTURE', 'CANCEL')
     AND o.status IN ('REQUESTED', 'PROCESSING', 'UNKNOWN', 'REQUIRES_REVIEW');

  SELECT coalesce(sum(o.amount_minor), 0), count(*)
    INTO v_reserved, v_refund_count
    FROM payments.payment_operations o
   WHERE o.payment_id = v_payment_id
     AND o.type = 'REFUND'
     AND o.status IN ('REQUESTED', 'PROCESSING', 'UNKNOWN', 'REQUIRES_REVIEW');

  SELECT coalesce(max(o.amount_minor), 0) INTO v_captured
    FROM payments.payment_operations o
   WHERE o.payment_id = v_payment_id
     AND o.type = 'CAPTURE'
     AND o.status = 'SUCCEEDED';

  SELECT coalesce(sum(o.amount_minor), 0) INTO v_refunded
    FROM payments.payment_operations o
   WHERE o.payment_id = v_payment_id
     AND o.type = 'REFUND'
     AND o.status = 'SUCCEEDED';

  SELECT EXISTS (
    SELECT 1 FROM payments.payment_operations o
     WHERE o.payment_id = v_payment_id AND o.type = 'AUTHORIZE' AND o.status = 'SUCCEEDED'
  ) INTO v_has_authorize;

  SELECT EXISTS (
    SELECT 1 FROM payments.payment_operations o
     WHERE o.payment_id = v_payment_id AND o.type = 'CANCEL' AND o.status = 'SUCCEEDED'
  ) INTO v_has_cancel;

  IF v_payment.active_exclusive_operation_id IS DISTINCT FROM v_pointer THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_aggregate_consistency',
      MESSAGE = 'payment_aggregate_consistency: active_exclusive_operation_id',
      DETAIL = jsonb_build_object('paymentId', v_payment_id)::text;
  END IF;

  IF v_payment.reserved_refund_amount_minor IS DISTINCT FROM v_reserved THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_aggregate_consistency',
      MESSAGE = 'payment_aggregate_consistency: reserved_refund_amount_minor',
      DETAIL = jsonb_build_object('paymentId', v_payment_id)::text;
  END IF;

  IF v_payment.unresolved_refund_count IS DISTINCT FROM v_refund_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_aggregate_consistency',
      MESSAGE = 'payment_aggregate_consistency: unresolved_refund_count',
      DETAIL = jsonb_build_object('paymentId', v_payment_id)::text;
  END IF;

  IF v_payment.captured_amount_minor IS DISTINCT FROM v_captured THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_aggregate_consistency',
      MESSAGE = 'payment_aggregate_consistency: captured_amount_minor',
      DETAIL = jsonb_build_object('paymentId', v_payment_id)::text;
  END IF;

  IF v_payment.refunded_amount_minor IS DISTINCT FROM v_refunded THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_aggregate_consistency',
      MESSAGE = 'payment_aggregate_consistency: refunded_amount_minor',
      DETAIL = jsonb_build_object('paymentId', v_payment_id)::text;
  END IF;

  -- Authorization and cancellation are mutually exclusive outcomes, each tied to the presence of its
  -- successful operation. DECLINED and NOT_REQUESTED both mean "no successful authorization".
  IF v_has_authorize THEN
    IF v_payment.authorization_outcome NOT IN ('AUTHORIZED', 'CANCELED', 'EXPIRED')
       OR v_payment.authorized_amount_minor = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'payment_aggregate_consistency',
        MESSAGE = 'payment_aggregate_consistency: authorization_outcome',
        DETAIL = jsonb_build_object('paymentId', v_payment_id)::text;
    END IF;
  ELSE
    IF v_payment.authorization_outcome IN ('AUTHORIZED', 'CANCELED', 'EXPIRED')
       OR v_payment.authorized_amount_minor <> 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'payment_aggregate_consistency',
        MESSAGE = 'payment_aggregate_consistency: authorization_outcome',
        DETAIL = jsonb_build_object('paymentId', v_payment_id)::text;
    END IF;
  END IF;

  IF v_has_cancel <> (v_payment.authorization_outcome = 'CANCELED') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_aggregate_consistency',
      MESSAGE = 'payment_aggregate_consistency: canceled',
      DETAIL = jsonb_build_object('paymentId', v_payment_id)::text;
  END IF;

  RETURN NULL;
END
$$;

-- Installed on both tables: drift can be introduced from either side, and the check has to fire
-- whichever row moved.
CREATE CONSTRAINT TRIGGER payments_aggregate_consistency
  AFTER INSERT OR UPDATE ON payments.payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payments.assert_payment_consistency();

CREATE CONSTRAINT TRIGGER payment_operations_aggregate_consistency
  AFTER INSERT OR UPDATE ON payments.payment_operations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payments.assert_payment_consistency();

-- No grant changes: the function runs as the DML-issuing role, which already holds SELECT on both
-- tables. Disabling a constraint trigger requires table ownership, which only the migration owner has.
