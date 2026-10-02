# Zentra Connector

## Purpose

The M1A.1 channel proves the security and data contract between a Zentra producer and HQ without connecting the production Zentra repository. A local simulator sends one semantic source event to `POST /v1/webhooks/zentra`; HQ verifies, stores, queues, and normalizes it through the same architecture intended for M1A.2.

## Transport envelope

```json
{
  "eventId": "10000000-0000-4000-8000-000000000010",
  "type": "product.company_created",
  "schemaVersion": 1,
  "occurredAt": "2026-10-01T12:00:00.000Z",
  "entity": {
    "type": "company",
    "id": "10000000-0000-4000-8000-000000000020"
  },
  "actor": {
    "type": "user",
    "id": "10000000-0000-4000-8000-000000000030"
  },
  "data": {
    "companyId": "10000000-0000-4000-8000-000000000020",
    "createdByUserId": "10000000-0000-4000-8000-000000000030"
  }
}
```

`actor` is optional. The v1 company event requires the entity company ID to equal `data.companyId`; when an actor is present, its user ID must equal `data.createdByUserId`. No company name, tax number, address, email, KSeF token, accounting, invoice, or financial data crosses this boundary.

## HMAC scheme

- Secret: server-only `ZENTRA_WEBHOOK_SECRET`, at least 32 characters.
- Timestamp header: `x-zentra-timestamp`, Unix time in whole seconds.
- Signature header: `x-zentra-signature: sha256=<64 lowercase hex characters>`.
- Signing input: UTF-8 bytes of `<timestamp>.` followed byte-for-byte by the HTTP request body.
- Algorithm: HMAC-SHA256.
- Replay window: five minutes in either direction by default.

HQ checks header shape and replay window, computes the expected signature, checks equal buffer length, and uses `timingSafeEqual`. JSON parsing happens only after successful verification. Reformatting semantically equivalent JSON changes the signature.

## Delivery and retry semantics

`eventId` is the stable source-event identity and maps to `externalEventId`; the request timestamp may change on every delivery. The first accepted delivery creates one raw event and queue item. Later correctly signed deliveries with the same `eventId` resolve through provider idempotency and do not create duplicate raw or canonical facts.

Authenticated events with unsupported semantic types remain immutable raw facts. The worker raises `ZENTRA_EVENT_TYPE_UNSUPPORTED`, records a permanent processing failure, and creates a dead letter. M1A.1 does not synthesize canonical events for unknown types.

## Supported event types

- `product.company_created`, schema version 1.

The connector declares only the `WEBHOOKS` capability.

## Local demo

Follow the PowerShell commands in the root README. `pnpm demo:zentra-event` uses a stable default event ID, signs the exact serialized body, and prints the HTTP response. Pass `--event-id <uuid>` to choose another stable retry identity. The simulator never contains or prints the secret.
