# ADR-004: Connector abstraction

## Status

Accepted — 2026-09-29

## Context

Providers differ in signatures, identifiers, health, limits, and read/write capabilities; providers may also be replaced.

## Decision

Provider implementations conform to capability-aware connector and verifier ports. Domain consumers use canonical events and never provider SDK types.

## Alternatives considered

Provider branches throughout domain services and a universal connector claiming every capability were rejected.

## Consequences

Adapters require explicit translation and contract tests. Official and alternative implementations can coexist without rewriting downstream logic.
