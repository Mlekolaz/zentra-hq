# ADR-002: Separate HQ database

## Status

Accepted — 2026-09-29

## Context

HQ aggregates sensitive operational data but should not become an unrestricted path into production Zentra.

## Decision

HQ owns a separate Postgres/Supabase database. Production Zentra will send signed semantic events through an outbox boundary.

## Alternatives considered

Sharing the production database or service-role key was rejected because it increases blast radius, couples schemas, and bypasses purpose-limited event contracts.

## Consequences

Integration is eventually consistent and needs reliable dispatch. Security, retention, migrations, and access policy can evolve independently.
