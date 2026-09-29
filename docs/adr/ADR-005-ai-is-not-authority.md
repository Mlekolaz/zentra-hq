# ADR-005: AI is not authority

## Status

Accepted — 2026-09-29

## Context

Models can understand context but are probabilistic, prompt-sensitive, and cannot be trusted to grant themselves permissions.

## Decision

AI may classify, draft, suggest, and create an ActionRequest. Authentication, authorization, policy, approval, and execution gates remain deterministic code and human-governed configuration.

## Alternatives considered

Letting a model select its own policy level or call production tools directly was rejected.

## Consequences

AI integration needs traceable evidence and structured outputs. Some flows require explicit approval and additional latency by design.
