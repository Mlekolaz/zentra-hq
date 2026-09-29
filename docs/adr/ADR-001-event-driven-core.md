# ADR-001: Event-driven core

## Status

Accepted — 2026-09-29

## Context

HQ must combine heterogeneous facts and later derive many projections without duplicating ingestion logic per screen.

## Decision

Persist immutable source events, normalize them into versioned canonical events, then let later consumers build state and attention views.

## Alternatives considered

Direct provider-to-dashboard integrations and a single mutable CRM model were rejected because they couple sources to views and erase history.

## Consequences

Delivery is asynchronous and consumers must tolerate duplicate and out-of-order facts. Replay, audit, and new projections become possible.
