# Trust boundaries

## Browser to HQ Web/API

The browser is untrusted. Request bodies cannot assign actor, role, or admin status. M0 resolves a server-created development identity, guarded against production use. A future identity provider can replace this port without changing route/domain contracts. The browser never receives database service-role or provider credentials.

M1A.3B production is receiver-only: the identity port rejects all operator authentication, and every operator read endpoint resolves identity before accessing data. Signed webhook actors do not grant user access. See [ADR-011](../adr/ADR-011-receiver-only-production-identity.md) and [HQ production runtime](HQ_PRODUCTION_RUNTIME.md).

## HQ API to HQ database

This is trusted server-side access with validated inputs. Uniqueness constraints, not a select-before-insert convention, are the final idempotency guard. Future workspace/member columns and RLS may add defense in depth; frontend clients still do not perform privileged writes.

## HQ worker to HQ database

The worker is server-side and receives only event identifiers from the queue. It retrieves the source fact from storage, validates normalized output, records processing history, and uses bounded retry. Logs omit provider payloads.

## HQ to external providers

Credentials remain server-side. Connector capabilities, health, disable state, provider rate limits, policy, approval, and audit surround every future outbound operation. M0 has no outbound executor.

## Production Zentra to HQ

M1A.1 defines and locally proves the signed semantic webhook contract. Production Zentra will write those facts to a transactional outbox and dispatch them in M1A.2. HQ has a separate database and does not receive the production Supabase service-role key or broad production-table access merely because it is an internal tool.

## External webhooks to HQ

Every provider requires verification before acceptance. The Zentra route selects its provider from routing context, checks a five-minute timestamp window, and verifies HMAC-SHA256 over the timestamp and exact raw bytes before JSON parsing. The development verifier remains unavailable in production.

## Secrets and logs

Raw event headers use a small allow-list. Authorization, cookies, signatures, tokens, API keys, passwords, webhook/client secrets, service-role values, and session material are neither persisted nor included in normal structured logs. Unexpected errors return stable safe messages and a trace ID, never a stack trace.
