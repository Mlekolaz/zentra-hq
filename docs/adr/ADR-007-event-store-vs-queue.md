# ADR-007: Event store versus queue

## Status

Accepted — 2026-09-29

## Context

Queues optimize work delivery but can expire, redeliver, lock, or be replaced. Source facts require durable retention and replay.

## Decision

`raw_events` is the authoritative source record. Queue messages carry only `rawEventId`, trace ID, and attempt. Workers always reload payloads from the event store.

## Alternatives considered

Storing the only payload copy in a queue and copying full provider payloads into messages were rejected.

## Consequences

Queue loss does not erase facts and adapters remain replaceable. Production hardening must reconcile raw rows that persist when enqueue fails; M0 documents this reliability gap explicitly.
