-- 0294_authorization_attempt_limit.sql — the authorization retry policy as a database fact.
--
-- docs/03 §MVP policy decisions: "A payment permits at most three authorization operations in total. A
-- new attempt is allowed only after the preceding attempt is terminal as REJECTED or is FAILED". The
-- domain enforces it (`AT_MOST_THREE_AUTHORIZATIONS`), and docs/07 assigns it to
-- `payments.accept_operation`, but no constraint mirrored it: a defect in that function could commit a
-- fourth authorization, or a new authorization after one had already succeeded.
--
-- The 0250 indexes already give "at most one unresolved exclusive operation" and "at most one succeeded
-- AUTHORIZE". This adds the two remaining rules:
--
--   1. at most three AUTHORIZE operations per payment;
--   2. once an AUTHORIZE has succeeded, every other AUTHORIZE on that payment is REJECTED or FAILED.
--
-- Together with the exclusive index, (2) is "the preceding attempt is terminal and unsuccessful": no
-- attempt can be accepted alongside or after a success. It raises 23514 with its own constraint name,
-- following 0260's convention, so a caller sees which invariant broke.

CREATE OR REPLACE FUNCTION payments.assert_authorization_attempts() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_attempts integer;
  v_succeeded integer;
  v_open_after_success integer;
BEGIN
  IF NEW.type <> 'AUTHORIZE' THEN
    RETURN NULL;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE o.status = 'SUCCEEDED'),
         count(*) FILTER (WHERE o.status NOT IN ('SUCCEEDED', 'REJECTED', 'FAILED'))
    INTO v_attempts, v_succeeded, v_open_after_success
    FROM payments.payment_operations o
   WHERE o.payment_id = NEW.payment_id
     AND o.type = 'AUTHORIZE';

  IF v_attempts > 3 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_authorization_attempts',
      MESSAGE = 'payment_authorization_attempts: more than three',
      DETAIL = jsonb_build_object('paymentId', NEW.payment_id)::text;
  END IF;

  IF v_succeeded > 0 AND v_open_after_success > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'payment_authorization_attempts',
      MESSAGE = 'payment_authorization_attempts: attempt alongside a success',
      DETAIL = jsonb_build_object('paymentId', NEW.payment_id)::text;
  END IF;

  RETURN NULL;
END
$$;

-- Immediate by default: unlike the aggregate totals, these rules hold after every statement of a
-- correct sequence, so there is no intermediate state to tolerate.
CREATE CONSTRAINT TRIGGER payment_operations_authorization_attempts
  AFTER INSERT OR UPDATE ON payments.payment_operations
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION payments.assert_authorization_attempts();

-- No grant changes: like 0260, the function runs as the DML-issuing role, which already holds SELECT
-- on the table, and only the table owner can disable the trigger.
