# Trust boundaries

## Browser to HQ Web/API

The browser is untrusted. Request bodies cannot assign actor, role, or admin status. M0 resolves a server-created development identity, guarded against production use. A future identity provider can replace this port without changing route/domain contracts. The browser never receives database service-role or provider credentials.

## HQ API to HQ database

This is trusted server-side access with validated inputs. Uniqueness constraints, not a select-before-insert convention, are the final idempotency guard. Future workspace/member columns and RLS may add defense in depth; frontend clients still do not perform privileged writes.

## HQ worker to HQ database

The worker is server-side and receives only event identifiers from the queue. It retrieves the source fact from storage, validates normalized output, records processing history, and uses bounded retry. Logs omit provider payloads.

## HQ to external providers

Credentials remain server-side. Connector capabilities, health, disable state, provider rate limits, policy, approval, and audit surround every future outbound operation. M0 has no outbound executor.

## Production Zentra to HQ

Production Zentra will write semantic facts to a transactional outbox and dispatch signed webhooks. HQ has a separate database and does not receive the production Supabase service-role key or broad production-table access merely because it is an internal tool.

## External webhooks to HQ

Every provider requires verification before acceptance. M0 preserves exact raw bytes and offers a secret-based development verifier that throws during production construction. Provider-specific HMAC/signature/challenge implementations are intentionally deferred.

## Secrets and logs

Raw event headers use a small allow-list. Authorization, cookies, tokens, API keys, passwords, client secrets, service-role values, and session material are neither persisted nor included in normal structured logs. Unexpected errors return stable safe messages and a trace ID, never a stack trace.
