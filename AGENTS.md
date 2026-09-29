# Zentra HQ engineering contract

## Product

Zentra HQ is an event-driven attention management system. Its primary product is a focused view of work requiring human attention, not a generic CRM or analytics dashboard.

## Architecture invariants

- Persist the immutable source event before processing it.
- Never mutate a raw provider payload; keep processing state separately.
- Assume duplicate, retried, and out-of-order delivery. Every processor must be retry-safe.
- The event store is durable truth; a queue is only work transport.
- Domain code depends on connector capabilities and ports, never provider implementations.
- AI may propose work but is never an authority for permissions or policy.
- Never expose secrets or privileged database credentials to the frontend.
- HQ has a database separate from production Zentra and never receives its service-role key.
- Audit external actions and make automated decisions traceable to inputs and evidence.

## Coding standards

- TypeScript strict; no `any`, silent catches, swallowed promises, or unchecked JSON at boundaries.
- Validate system boundaries with Zod and use explicit, stable error types.
- Test domain behavior with dependency injection and in-memory adapters.
- Prefer small cohesive modules; avoid premature abstractions and god services.

## Change discipline

Before a fundamental change, read the ADRs and verify every invariant above. Add a superseding ADR when changing an architectural decision; do not silently rewrite accepted history.

## Security

Never log access or refresh tokens, cookies, authorization headers, session secrets, service-role keys, client secrets, API keys, or passwords. Do not trust roles or actors supplied by a browser or webhook body.
