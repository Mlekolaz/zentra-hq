# ADR-003: Action and approval model

## Status

Accepted — 2026-09-29

## Context

Future automation may propose communications, mutations, financial operations, or other work with materially different risk.

## Decision

Represent proposals as ActionRequests. A deterministic policy assigns READ, DRAFT, SUGGEST, EXECUTE_WITH_APPROVAL, AUTO_EXECUTE, or FORBIDDEN. Approval is a separate audited record; M0 executes nothing externally.

## Alternatives considered

Implicit permissions in connector code and model-selected permissions were rejected as non-auditable and unsafe.

## Consequences

Actions require additional records and state transitions, but permission decisions remain explainable, testable, and independent of provider/AI behavior.
