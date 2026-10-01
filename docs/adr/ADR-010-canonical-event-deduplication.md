# ADR-010: Canonical item deduplication key

## Status

Accepted — 2026-09-30

## Context

A deterministic event UUID by convention alone is too easy for a new connector to bypass. Uniqueness by raw event and type is too restrictive because one raw batch may validly produce several facts of the same type.

## Decision

Every canonical event requires a stable `deduplicationKey` identifying one normalized item within its raw event. PostgreSQL enforces unique `(raw_event_id, deduplication_key)`. Connectors derive deterministic IDs through the shared `createCanonicalEventId(rawEventId, deduplicationKey, schemaVersion)` helper.

## Alternatives considered

Full-payload hashing and unique `(raw_event_id, type)` were rejected because payload representation can change and a batch can contain multiple same-type items. Connector-local ID algorithms were rejected because they cannot enforce a shared contract.

## Consequences

Partial persistence and replay converge on one row per normalized item even if the supplied event ID changes. Connector contract tests must demonstrate stable keys and IDs for the same raw input.
