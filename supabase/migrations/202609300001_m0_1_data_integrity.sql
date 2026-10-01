-- M0.1: close atomic-ingestion, deduplication, and queue-leasing gaps.

DROP INDEX raw_events_provider_identity_unique;
CREATE UNIQUE INDEX raw_events_provider_identity_unique
  ON raw_events (source, COALESCE(source_account_id, ''), external_event_id)
  WHERE external_event_id IS NOT NULL;

DROP TRIGGER raw_events_immutable ON raw_events;
CREATE TRIGGER raw_events_immutable
  BEFORE UPDATE OR DELETE ON raw_events
  FOR EACH ROW EXECUTE FUNCTION prevent_raw_event_mutation();

ALTER TABLE events ADD COLUMN deduplication_key text;
UPDATE events SET deduplication_key = 'legacy:' || id::text;
ALTER TABLE events ALTER COLUMN deduplication_key SET NOT NULL;
ALTER TABLE events
  ADD CONSTRAINT events_raw_event_deduplication_key_unique
  UNIQUE (raw_event_id, deduplication_key);

ALTER TABLE event_queue
  ADD COLUMN raw_event_id uuid,
  ADD COLUMN delivery_count integer NOT NULL DEFAULT 0,
  ADD COLUMN lease_token uuid;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM event_queue
    WHERE payload->>'rawEventId' IS NULL
       OR payload->>'rawEventId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'event_queue contains a payload without a valid rawEventId';
  END IF;
END;
$$;

UPDATE event_queue SET raw_event_id = (payload->>'rawEventId')::uuid;

-- Queue state is transport-only. Retain the oldest item if an M0 deployment
-- produced more than one active row for the same durable raw event.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY raw_event_id ORDER BY created_at ASC, id ASC
  ) AS rank
  FROM event_queue
)
DELETE FROM event_queue q
USING ranked r
WHERE q.id = r.id AND r.rank > 1;

-- An M0 lock has no fencing token and therefore cannot safely retain ownership.
UPDATE event_queue SET locked_at = NULL WHERE locked_at IS NOT NULL;

ALTER TABLE event_queue
  ALTER COLUMN raw_event_id SET NOT NULL,
  ADD CONSTRAINT event_queue_raw_event_fk
    FOREIGN KEY (raw_event_id) REFERENCES raw_events(id),
  ADD CONSTRAINT event_queue_delivery_count_nonnegative
    CHECK (delivery_count >= 0),
  ADD CONSTRAINT event_queue_lease_consistent
    CHECK (
      (locked_at IS NULL AND lease_token IS NULL)
      OR (locked_at IS NOT NULL AND lease_token IS NOT NULL)
    ),
  ADD CONSTRAINT event_queue_one_active_item_per_raw_event
    UNIQUE (raw_event_id);

DROP INDEX event_queue_receive_idx;
CREATE INDEX event_queue_receive_idx
  ON event_queue (available_at ASC, locked_at ASC);

CREATE INDEX events_raw_event_idx ON events (raw_event_id);
CREATE INDEX events_received_at_idx ON events (received_at DESC);
CREATE INDEX dead_letters_raw_event_idx ON dead_letters (raw_event_id);

COMMENT ON COLUMN events.deduplication_key IS
  'Connector-defined stable identity of one canonical fact within a raw event.';
COMMENT ON COLUMN event_queue.delivery_count IS
  'Database-owned count incremented atomically whenever a lease is issued.';
COMMENT ON COLUMN event_queue.lease_token IS
  'Fencing token required for ACK and retry mutations.';
