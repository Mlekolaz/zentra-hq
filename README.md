# Zentra HQ

## What is Zentra HQ

Zentra HQ is the internal, event-driven attention management system for Moja Zentra. It is designed to turn a noisy stream of provider and product facts into a small, explainable set of things that require human attention. It is not a generic CRM, an analytics dashboard, or a privileged window into the production Zentra database.

## M0 scope

M0 establishes the testable spine of the system:

- React command-center shell with live Overview, Events, and Integrations views;
- Fastify ingestion and read API;
- immutable raw-event storage and canonical-event storage;
- race-safe idempotency by explicit key and provider identity;
- queue port with in-memory and Postgres adapters;
- separate worker entrypoint plus an explicit embedded development worker;
- Mock Connector normalization;
- bounded retry, processing history, dead letters, audit entries, and health reporting;
- deterministic policy/action/approval foundation;
- Zod boundary validation, structured logs, secret redaction, typed configuration, and development auth boundaries;
- SQL migrations and architecture records.

## Future vision

Later milestones will add real sources, entity resolution, configurable pipelines, task/follow-up engines, customer and product intelligence, attention ranking, universal search, and governed AI assistance. Those capabilities are described in [Product Vision](docs/PRODUCT_VISION.md); they are not implemented in M0.

## Architecture

```text
External source
      |
      v
Fastify ingestion API -- verify exact raw body
      |
      v
Immutable raw_events  <---- durable source of truth
      |
      v
Queue (rawEventId + traceId + attempt only)
      |
      v
Worker -> Connector registry -> Canonical validation
      |                         |
      | failure                 v
      +-> retry/dead letter   events
                                |
                                v
                        audit + read API + UI
```

The queue is work transport, never the event store. In Postgres mode, the API and worker are separate processes. In the default, explicitly non-production in-memory mode, the API runs a background worker in the same process so a no-account local demo remains useful; the standalone worker refuses to start without Postgres.

See [Architecture Overview](docs/architecture/OVERVIEW.md) and [Event Flow](docs/architecture/EVENT_FLOW.md).

## Repository layout

```text
apps/
  api/           Fastify API and composition root
  web/           React/Vite command-center shell
  worker/        processing engine and standalone process
packages/
  connectors/    provider-neutral connector and verification contracts
  database/      repositories and queue adapters
  domain/        identifiers, raw-event model, audit and errors
  events/        canonical schema and queue port
  observability/ logging and redaction
  policy/        deterministic policy/action/approval model
  shared/        typed config and auth boundary
supabase/migrations/
docs/            architecture, ADRs, security, event and connector conventions
```

## Requirements

- Node.js 22 or newer (verified on Node 24)
- pnpm 10 or newer (verified on pnpm 11)
- optional: Docker and Supabase CLI for persistent Postgres mode

No cloud account or production credential is required for M0.

## Local development

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5173`. The API listens on `http://localhost:4100`.

Individual processes:

```bash
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

`pnpm dev:worker` requires `RUNTIME_MODE=postgres`, a migrated database, and `DATABASE_URL`. Do not run it alongside the embedded worker; set `EMBEDDED_WORKER=false` first.

## Environment

Copy `.env.example` to `.env`. The defaults are deliberately local-only:

```powershell
Copy-Item .env.example .env
```

```bash
cp .env.example .env
```

Never place real credentials in Vite variables. `VITE_API_BASE_URL` may contain only the public API origin. Production config fails unless Postgres and a non-development verifier are selected; M0 intentionally does not ship a production provider verifier.

### Persistent Postgres mode

With Supabase CLI available:

```bash
supabase start
supabase db reset
```

Then set `RUNTIME_MODE=postgres`, `DATABASE_URL` to the local database connection string, and `EMBEDDED_WORKER=false`; run API, worker, and web as separate processes. The checked-in SQL migration is the schema source of truth.

## Tests and quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Tests use dependency injection and do not need Postgres, Supabase, or an external provider.

## Manual event flow demo

1. Start the default local stack with `pnpm dev`.
2. Send the development event:

```bash
curl -i http://localhost:4100/v1/events/ingest \
  -H "content-type: application/json" \
  -H "x-zentra-webhook-secret: local-development-only" \
  --data '{"source":"mock","sourceAccountId":"demo","externalEventId":"mock-123","idempotencyKey":"demo-mock-123","eventTypeHint":"message","occurredAt":"2026-09-29T08:00:00.000Z","payload":{"kind":"message","messageId":"mock-123","sender":{"name":"Jan Kowalski","email":"jan@example.com"},"text":"Chciałbym dowiedzieć się więcej o Zentrze."}}'
```

On Windows PowerShell, use `curl.exe` with the same arguments. The API returns `202` immediately after durable acceptance and enqueue; normalization remains asynchronous.

3. Open `http://localhost:5173/events`. The canonical `communication.message_received` event appears after the worker poll.
4. Send the same command again. The response has `"duplicate": true`, the same `rawEventId`, and no second canonical event.
5. Inspect `http://localhost:4100/health` for actual storage, queue, and embedded-worker readiness.

In-memory state is intentionally lost when the API restarts and must never be treated as production persistence.

## Adding a connector

1. Implement `Connector` without leaking provider types into domain code.
2. Declare only real capabilities and implement meaningful health/disabled states.
3. Implement provider-specific exact-byte webhook verification separately.
4. Preserve provider IDs and normalize into versioned, validated semantic facts.
5. Register the connector in the composition root and add contract, retry, and idempotency tests.

See [Connector Conventions](docs/connectors/README.md).

## Security model

- browser and webhooks are untrusted;
- provider verification occurs server-side against exact request bytes;
- raw metadata uses an allow-list and never stores authorization/cookie headers;
- development webhook and identity bypasses fail closed in production;
- frontend code has no database service role or provider credentials;
- actions pass through deterministic policy, and risky execution requires approval;
- structured logs recursively redact known secret keys and service-role-like values;
- HQ is a separate database boundary from production Zentra.

See [Trust Boundaries](docs/security/TRUST_BOUNDARIES.md).

## Current limitations

- only Mock Connector exists;
- no full user authentication or authorization provider exists;
- no production webhook verifier exists, so production startup intentionally fails closed;
- in-memory mode is process-local and ephemeral;
- Postgres mode uses a simple M0 polling queue, not PGMQ;
- queue enqueue is not an outbox transaction with raw insertion; a persisted raw event remains recoverable if enqueue fails, and production hardening should add a transactional dispatch marker/reconciler;
- no action executor, AI runtime, real connector, entity resolution, attention engine, CRM, task engine, or search exists.
