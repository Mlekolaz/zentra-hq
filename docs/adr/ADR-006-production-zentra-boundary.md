# ADR-006: Production Zentra boundary

## Status

Accepted — 2026-09-29

## Context

HQ needs product facts without inheriting production database privileges or implementation details.

## Decision

Production transactions will atomically add semantic events to an integration outbox. A dispatcher signs and sends them to HQ ingestion. HQ receives facts, not a service-role credential.

## Alternatives considered

Direct production reads, shared schemas, and change-data events such as `database.row_updated` were rejected.

## Consequences

Production must own an outbox dispatcher and delivery observability. HQ remains loosely coupled and can reason in business language.
