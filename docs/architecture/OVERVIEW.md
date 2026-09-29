# Architecture overview

## Scope

M0 proves one complete path from an untrusted source to an immutable canonical fact. It deliberately stops before entity resolution, tasks, pipelines, attention, or AI.

## Modules and direction

- `domain` owns provider-independent primitives, raw facts, audit types, and stable errors.
- `events` owns canonical-event validation and the queue port.
- `connectors` translates provider facts and declares capabilities; it cannot grant permissions.
- `database` implements event repositories and transport adapters behind ports.
- `worker` orchestrates normalization, retries, dead letters, and processing audit.
- `policy` deterministically classifies action risk and creates approval requests.
- `api` validates untrusted input, verifies webhooks, persists raw events, and enqueues IDs.
- `web` consumes read APIs only and has no privileged database access.

Dependencies point inward toward contracts. Provider implementations do not enter domain or policy code.

## Runtime modes

`in-memory` is a labeled development/test composition. API and the background development worker share process memory, making the manual demo deterministic without cloud infrastructure. It is forbidden in production configuration.

`postgres` uses the SQL schema as durable storage and a Postgres polling queue. API and worker can run as independent processes. Queue rows are disposable transport state; raw events are recoverable facts.

## Data invariants

- Raw rows are inserted once; a database trigger rejects updates.
- Provider identity and explicit keys have independent unique indexes.
- Canonical events are validated and protected by connector-generated deterministic IDs plus the primary-key constraint. A single raw batch may legitimately produce several facts of the same type.
- Every worker execution creates a processing history row; mutable status never touches raw facts.
- Failures contain stable codes and safe messages, not provider payloads.
- Every important operation carries a UUID trace ID.

## Future boundaries

Dynamic pipelines, identities, and attention signals will be data-driven consumers of canonical events. One person may eventually have email, LinkedIn, Instagram, WhatsApp, and Zentra identities. Deterministic identifiers come first, strong heuristics second, and AI may only suggest uncertain merges. No uncertain record is auto-merged.

The future Attention Engine will retain multiple explainable signals—urgency, business value, risk, SLA risk, customer impact, response required, relationship value, novelty, and confidence—instead of hiding them behind one unexplained score.
