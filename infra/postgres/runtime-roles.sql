-- Operator only, AFTER both migrations, in a dedicated HQ database.
-- Transaction is supplied by the operator (psql -X -v ON_ERROR_STOP=1 -1).
-- Intentionally fail on pre-existing cluster roles: do not hijack identities.
CREATE ROLE hq_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE hq_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
-- No password in this file. Operator subsequently uses psql \password separately.

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hq_api, hq_worker', current_database());
END;
$$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hq_api, hq_worker;
REVOKE ALL ON TABLE raw_events, events, processing_runs, dead_letters,
  audit_entries, event_queue, action_requests, approval_requests FROM PUBLIC;
-- Managed Supabase installations may pre-grant Data API roles explicitly.
-- Remove access only in THIS dedicated HQ schema/database, never in Zentra.
DO $$
DECLARE provider_role text;
BEGIN
  FOREACH provider_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = provider_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', provider_role);
      EXECUTE format('REVOKE ALL ON TABLE raw_events, events, processing_runs,
        dead_letters, audit_entries, event_queue, action_requests, approval_requests
        FROM %I', provider_role);
    END IF;
  END LOOP;
END;
$$;
ALTER ROLE hq_api SET search_path = public, pg_catalog;
ALTER ROLE hq_worker SET search_path = public, pg_catalog;

-- API: atomic ingestion, duplicate state lookup, health queue count.
GRANT SELECT ON raw_events, event_queue TO hq_api;
GRANT SELECT (raw_event_id) ON events, dead_letters TO hq_api;
GRANT SELECT (raw_event_id, status) ON processing_runs TO hq_api;
GRANT INSERT (source, source_account_id, event_type_hint, external_event_id,
  idempotency_key, payload, sanitized_headers, occurred_at, received_at, trace_id)
  ON raw_events TO hq_api;
GRANT INSERT (raw_event_id, payload, available_at) ON event_queue TO hq_api;
GRANT INSERT (actor_type, actor_id, action, target_type, target_id, metadata, trace_id)
  ON audit_entries TO hq_api;

-- Worker: normalize, reconcile, lease/retry/ACK, audit and dead-letter.
GRANT SELECT ON raw_events, processing_runs, event_queue TO hq_worker;
GRANT SELECT (id, raw_event_id) ON events TO hq_worker;
GRANT SELECT (id, raw_event_id, created_at) ON dead_letters TO hq_worker;
GRANT SELECT (id, created_at) ON audit_entries TO hq_worker;
-- FOR UPDATE OF raw_events requires UPDATE on at least one column.
-- The UPDATE/DELETE immutable trigger still rejects every actual mutation.
GRANT UPDATE (id) ON raw_events TO hq_worker;
GRANT INSERT (id, raw_event_id, deduplication_key, type, schema_version, source,
  source_account_id, external_event_id, occurred_at, received_at, actor, subject,
  entity_refs, payload, metadata, correlation_id, causation_id, trace_id)
  ON events TO hq_worker;
GRANT INSERT (raw_event_id, processor_name, processor_version, attempt, status, trace_id)
  ON processing_runs TO hq_worker;
GRANT UPDATE (status, completed_at, error_code, sanitized_error_message)
  ON processing_runs TO hq_worker;
GRANT INSERT (raw_event_id, processor_name, reason, attempt_count, trace_id)
  ON dead_letters TO hq_worker;
GRANT INSERT (actor_type, actor_id, action, target_type, target_id, metadata, trace_id)
  ON audit_entries TO hq_worker;
GRANT INSERT (raw_event_id, payload, available_at) ON event_queue TO hq_worker;
GRANT UPDATE (payload, locked_at, lease_token, available_at, delivery_count)
  ON event_queue TO hq_worker;
GRANT DELETE ON event_queue TO hq_worker;

-- No ownership, sequences (UUID defaults), REFERENCES, TRUNCATE, TRIGGER,
-- action/approval access, DDL, schema CREATE, database CREATE/TEMP, or role membership.
