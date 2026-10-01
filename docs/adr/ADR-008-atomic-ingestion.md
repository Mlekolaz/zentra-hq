# ADR-008: Atomic ingestion and recovery

## Status

Accepted — 2026-09-30

## Context

Writing a durable raw event and dispatching queue work in separate operations can strand an event if the API stops between those writes. A retried webhook may then be recognized as a duplicate without restoring processing.

## Decision

In PostgreSQL mode, raw insertion or duplicate resolution, queue dispatch or recovery, and the ingestion audit entry run on one pool client inside one transaction. A duplicate is requeued only when it has no canonical event, successful processing run, permanent dead letter, or active queue row. `event_queue.raw_event_id` has a unique constraint. An idempotent reconciler applies the same completion checks to older undispatched raw rows at worker startup and periodically.

This closes the production-hardening gap recorded in ADR-007 while preserving its event-store-versus-queue boundary.

## Alternatives considered

A distributed transaction, external broker, and an asynchronous outbox subsystem were rejected as unnecessary for the current single-Postgres boundary. Treating every duplicate as complete was rejected because it preserves stranded events.

## Consequences

Successful acceptance means the durable fact, dispatch record, and audit evidence committed together. Queue transport remains replaceable and non-authoritative. The reconciler provides defense in depth for legacy state and operator intervention without creating duplicate active work.
