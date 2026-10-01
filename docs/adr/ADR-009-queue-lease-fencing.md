# ADR-009: Database-owned delivery count and lease fencing

## Status

Accepted — 2026-09-30

## Context

A retry counter stored in a message payload does not advance after a hard worker crash. A static queue ID also lets a worker whose lease expired delete or release work already leased by another worker.

## Decision

Postgres atomically increments `event_queue.delivery_count` whenever it grants a lease and creates a fresh UUID `lease_token`. Processing attempts use that count. ACK and retry match both queue ID and token and report `stale` when ownership changed. Expired leases can be acquired again. Work at the configured maximum delivery count is moved transactionally to `dead_letters`, audited, and removed from the queue.

This supersedes the queue-message attempt counter described in ADR-007; queue messages now carry only raw-event and trace identity.

## Alternatives considered

Payload-owned counters, ACK by queue ID alone, and unbounded redelivery were rejected. Lease heartbeats are deferred because expiration plus fencing is sufficient for M0.1.

## Consequences

Hard crashes consume the retry budget, poison work is bounded, and late workers cannot mutate a newer lease. Canonical persistence must remain idempotent because overlapping processing can still occur when a long task outlives its lease.
