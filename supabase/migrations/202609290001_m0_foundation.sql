CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE raw_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
  source_account_id text,
  event_type_hint text,
  external_event_id text,
  idempotency_key text,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  sanitized_headers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sanitized_headers) = 'object'),
  occurred_at timestamptz,
  received_at timestamptz NOT NULL,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX raw_events_idempotency_key_unique
  ON raw_events (source, COALESCE(source_account_id, ''), idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX raw_events_provider_identity_unique
  ON raw_events (source, source_account_id, external_event_id)
  WHERE source_account_id IS NOT NULL AND external_event_id IS NOT NULL;

CREATE FUNCTION prevent_raw_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'raw_events are immutable';
END;
$$;

CREATE TRIGGER raw_events_immutable
  BEFORE UPDATE ON raw_events
  FOR EACH ROW EXECUTE FUNCTION prevent_raw_event_mutation();

CREATE TABLE events (
  id uuid PRIMARY KEY,
  raw_event_id uuid NOT NULL REFERENCES raw_events(id),
  type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  source text NOT NULL,
  source_account_id text,
  external_event_id text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  actor jsonb,
  subject jsonb,
  entity_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(entity_refs) = 'array'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  correlation_id text,
  causation_id text,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_type_occurred_at_idx ON events (type, occurred_at DESC);
CREATE INDEX events_trace_id_idx ON events (trace_id);

CREATE TYPE processing_status AS ENUM (
  'queued', 'processing', 'succeeded', 'retryable_failed', 'permanently_failed'
);

CREATE TABLE processing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_event_id uuid NOT NULL REFERENCES raw_events(id),
  processor_name text NOT NULL,
  processor_version text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  status processing_status NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_code text,
  sanitized_error_message text,
  trace_id uuid NOT NULL,
  CHECK (
    (status IN ('queued', 'processing') AND completed_at IS NULL)
    OR (status IN ('succeeded', 'retryable_failed', 'permanently_failed') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX processing_runs_raw_event_idx ON processing_runs (raw_event_id, attempt DESC);

CREATE TABLE dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_event_id uuid NOT NULL REFERENCES raw_events(id),
  processor_name text NOT NULL,
  reason text NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE audit_actor_type AS ENUM ('human', 'system', 'ai', 'connector');

CREATE TABLE audit_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type audit_actor_type NOT NULL,
  actor_id text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_entries_target_idx ON audit_entries (target_type, target_id, created_at DESC);
CREATE INDEX audit_entries_trace_id_idx ON audit_entries (trace_id);

CREATE TYPE action_request_status AS ENUM ('pending', 'drafted', 'suggested', 'ready', 'awaiting_approval', 'approved', 'denied', 'cancelled');

CREATE TABLE action_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type text NOT NULL,
  requested_by jsonb NOT NULL CHECK (jsonb_typeof(requested_by) = 'object'),
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  required_policy_level text NOT NULL CHECK (required_policy_level IN ('READ','DRAFT','SUGGEST','EXECUTE_WITH_APPROVAL','AUTO_EXECUTE','FORBIDDEN')),
  status action_request_status NOT NULL DEFAULT 'pending',
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_request_id uuid NOT NULL REFERENCES action_requests(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  status approval_status NOT NULL DEFAULT 'pending',
  decided_by text,
  decided_at timestamptz,
  decision_reason text,
  CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
    OR status <> 'pending'
  )
);

CREATE UNIQUE INDEX approval_requests_one_pending_per_action
  ON approval_requests (action_request_id) WHERE status = 'pending';

-- M0 transport adapter. The event store remains authoritative; queue rows only carry IDs.
CREATE TABLE event_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX event_queue_receive_idx ON event_queue (available_at);

COMMENT ON TABLE raw_events IS 'Immutable provider facts. Processing state lives in processing_runs.';
COMMENT ON TABLE event_queue IS 'Transport only; raw_events is the durable source of truth.';
