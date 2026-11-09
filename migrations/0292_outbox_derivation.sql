-- 0292_outbox_derivation.sql — close the two gaps in the outbox's "copies cannot diverge" proof.
--
-- 0280 states that every repeated envelope column is proven equal to the envelope by one CHECK. Two
-- facts were proven only inside `messaging.insert_outbox`, so a direct INSERT by
-- `messaging_function_owner` (which holds INSERT on the table) could still store a disagreeing row:
--
--   1. `occurred_at` is a repeated envelope field (`occurredAt`) but was missing from the CHECK.
--   2. `kind` and `aggregate_type` must equal the registry row for `message_type`; only the function
--      compared them.
--
-- Both are now structural. Migrations are frozen once committed, so the fix is this new file.

-- 1. Registry agreement --------------------------------------------------------------------------
-- The registry key plus the two facts the outbox repeats, as a target for a composite foreign key.
ALTER TABLE messaging.message_types
  ADD CONSTRAINT message_types_registry_key UNIQUE (message_type, kind, aggregate_type);

ALTER TABLE messaging.outbox_messages
  ADD CONSTRAINT outbox_messages_registry_fkey
  FOREIGN KEY (message_type, kind, aggregate_type)
  REFERENCES messaging.message_types (message_type, kind, aggregate_type);

-- 2. Derivation proof ----------------------------------------------------------------------------
-- Same name and the same single-CHECK shape as 0280, with `occurred_at` added. The timestamp must carry
-- an explicit offset (as `insert_outbox` already requires), so the text-to-timestamptz cast is the same
-- instant in every session TimeZone.
ALTER TABLE messaging.outbox_messages DROP CONSTRAINT outbox_messages_envelope_derivation;
ALTER TABLE messaging.outbox_messages
  ADD CONSTRAINT outbox_messages_envelope_derivation CHECK (envelope IS NULL OR (
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
    AND envelope->>'occurredAt' ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
    AND occurred_at = (envelope->>'occurredAt')::timestamptz
  ));
