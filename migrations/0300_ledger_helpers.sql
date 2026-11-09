-- 0300_ledger_helpers.sql — the three primitives every later ledger object depends on.
--
-- An ID generator that works inside SQL (the TypeScript `newId` is not reachable from a migration or a
-- protected function), an RFC 8785 serializer for the restricted shapes the ledger hashes, and the
-- striping derivation that decides which platform bucket a payment's postings use.
--
-- `jcs` and `bucket_for_payment` are IMMUTABLE, and that is a correctness requirement rather than an
-- optimisation: a posting hash must reproduce forever, and a payment's postings must not move bucket
-- because a function was later declared STABLE and started returning something else.
--
-- The serializer is deliberately narrow. It accepts only what the ledger hashes — ASCII keys, integers
-- within the JavaScript safe range — and raises on everything else, because a value it silently
-- re-encoded differently from the TypeScript canonicaliser would produce a hash that does not match.

-- 1. ID generator ---------------------------------------------------------------------------------

CREATE FUNCTION ledger.generate_id(p_prefix text) RETURNS text
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, public
AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  bits bit(130);
  result text := '';
  i integer;
BEGIN
  IF p_prefix IS NULL OR p_prefix !~ '^[a-z][a-z0-9]{1,15}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LEDGER_INVARIANT_VIOLATION',
      DETAIL = '{"rule":"INVALID_ID_PREFIX"}';
  END IF;

  -- 2 + 48 + 80 = 130 bits = 26 Crockford characters. The leading B'00' is what keeps the first
  -- character in 0..7, which is the range CONVENTIONS §6 allows.
  bits := B'00' || ms::bit(48) || ('x' || encode(public.gen_random_bytes(10), 'hex'))::bit(80);

  FOR i IN 0..25 LOOP
    result := result || substr(alphabet, substring(bits FROM i * 5 + 1 FOR 5)::integer + 1, 1);
  END LOOP;

  RETURN p_prefix || '_' || result;
END $$;

-- 2. JCS serializer -------------------------------------------------------------------------------

CREATE FUNCTION ledger.jcs(p_value jsonb) RETURNS text
  LANGUAGE plpgsql IMMUTABLE STRICT
  SET search_path = pg_catalog
AS $$
DECLARE
  v_type text := jsonb_typeof(p_value);
  v_key text;
  v_text text;
  v_joined text;
BEGIN
  IF v_type = 'object' THEN
    -- C-collation order equals JCS's UTF-16 code-unit order only for ASCII. A non-ASCII key would sort
    -- differently from the TypeScript serializer, so it is refused rather than hashed differently.
    FOR v_key IN SELECT jsonb_object_keys(p_value) LOOP
      IF v_key !~ '^[ -~]*$' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LEDGER_INVARIANT_VIOLATION',
          DETAIL = '{"rule":"JCS_NON_ASCII_KEY"}';
      END IF;
    END LOOP;

    SELECT string_agg(
             to_json(k)::text || ':' || ledger.jcs(p_value -> k),
             ',' ORDER BY k COLLATE "C"
           )
      INTO v_joined
      FROM jsonb_object_keys(p_value) AS k;

    RETURN '{' || coalesce(v_joined, '') || '}';
  END IF;

  IF v_type = 'array' THEN
    SELECT string_agg(ledger.jcs(e.value), ',' ORDER BY e.ordinality)
      INTO v_joined
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS e(value, ordinality);

    RETURN '[' || coalesce(v_joined, '') || ']';
  END IF;

  IF v_type = 'string' THEN
    -- PostgreSQL's JSON escaping matches JCS for quote, backslash, the short forms and \u00XX controls.
    RETURN to_json(p_value #>> '{}')::text;
  END IF;

  IF v_type = 'number' THEN
    v_text := p_value #>> '{}';
    -- Integers only, and the pattern also rejects `1.0`: jsonb preserves that scale and prints `1.0`
    -- where the TypeScript canonicaliser prints `1`, so emitting it would make the two hashes diverge.
    IF v_text !~ '^-?(0|[1-9][0-9]{0,15})$' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LEDGER_INVARIANT_VIOLATION',
        DETAIL = '{"rule":"JCS_UNSUPPORTED_NUMBER"}';
    END IF;
    IF abs(v_text::numeric) > 9007199254740991 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LEDGER_INVARIANT_VIOLATION',
        DETAIL = '{"rule":"JCS_UNSUPPORTED_NUMBER"}';
    END IF;
    RETURN v_text;
  END IF;

  IF v_type = 'boolean' THEN
    RETURN p_value::text;
  END IF;

  -- `jsonb_typeof` cannot return anything else, and STRICT means NULL never reaches here.
  RETURN 'null';
END $$;

-- 3. Bucket derivation ----------------------------------------------------------------------------

CREATE FUNCTION ledger.bucket_for_payment(p_payment_id text, p_bucket_count integer)
  RETURNS smallint
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
DECLARE
  v_value numeric := 0;
  v_character text;
BEGIN
  IF p_payment_id !~ '^pay_[0-7][0-9A-HJKMNP-TV-Z]{25}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LEDGER_INVARIANT_VIOLATION',
      DETAIL = '{"rule":"INVALID_PAYMENT_ID"}';
  END IF;

  IF p_bucket_count < 1 OR p_bucket_count > 100 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LEDGER_INVARIANT_VIOLATION',
      DETAIL = '{"rule":"INVALID_BUCKET_COUNT"}';
  END IF;

  -- The 16 characters after the 10-character ULID timestamp, i.e. ULID characters 11-26, read as a
  -- big-endian base-32 integer. Reading only the last character would be correct for powers of two and
  -- wrong for every other bucket count.
  FOREACH v_character IN ARRAY regexp_split_to_array(substr(p_payment_id, 15, 16), '') LOOP
    v_value := v_value * 32 + (strpos('0123456789ABCDEFGHJKMNPQRSTVWXYZ', v_character) - 1);
  END LOOP;

  RETURN mod(v_value, p_bucket_count)::smallint;
END $$;

-- 4. Grants and ownership (last) ------------------------------------------------------------------
--
-- USAGE first: no earlier migration grants any role USAGE on `ledger`, so without it every EXECUTE
-- below would be inert and the caller would see "permission denied for schema ledger".
-- Grants before the ownership change because only the owner can grant, and
-- `fl_assign_function_owner` grants the new owner momentary CREATE on the schema and revokes it again —
-- which a bare `ALTER FUNCTION ... OWNER TO` does not, and that is why it fails here.

GRANT USAGE ON SCHEMA ledger TO
  fl_operator_readonly, payments_function_owner, settlement_function_owner, ledger_function_owner,
  fl_migration_owner;

REVOKE ALL ON FUNCTION ledger.bucket_for_payment(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger.generate_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger.jcs(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ledger.bucket_for_payment(text, integer) TO
  fl_operator_readonly, payments_function_owner, settlement_function_owner, fl_migration_owner;

GRANT EXECUTE ON FUNCTION ledger.generate_id(text), ledger.jcs(jsonb) TO fl_migration_owner;

SELECT public.fl_assign_function_owner('ledger.bucket_for_payment(text, integer)'::regprocedure, 'ledger_function_owner');
SELECT public.fl_assign_function_owner('ledger.generate_id(text)'::regprocedure, 'ledger_function_owner');
SELECT public.fl_assign_function_owner('ledger.jcs(jsonb)'::regprocedure, 'ledger_function_owner');

-- The transfer removes the previous owner's implicit EXECUTE, so the migration owner — which the P03
-- seeds run as — must be granted again *by the new owner*. Only the owner can grant, hence the
-- assumption of the role here; `fl_migration_owner` holds it with SET TRUE from 0200.
SET LOCAL ROLE ledger_function_owner;

GRANT EXECUTE ON FUNCTION ledger.bucket_for_payment(text, integer) TO fl_migration_owner;
GRANT EXECUTE ON FUNCTION ledger.generate_id(text) TO fl_migration_owner;
GRANT EXECUTE ON FUNCTION ledger.jcs(jsonb) TO fl_migration_owner;

RESET ROLE;
