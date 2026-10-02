# Zentra HQ

## What is Zentra HQ

Zentra HQ is the internal, event-driven attention management system for Moja Zentra. It is designed to turn a noisy stream of provider and product facts into a small, explainable set of things that require human attention. It is not a generic CRM, an analytics dashboard, or a privileged window into the production Zentra database.

## Implemented foundation

M0 and M0.1 establish the testable spine of the system:

- React command-center shell with live Overview, Events, and Integrations views;
- Fastify ingestion and read API;
- append-only raw-event storage and deduplicated canonical-event storage;
- race-safe idempotency by explicit key and provider identity;
- atomic Postgres ingestion, duplicate recovery, and a reconciliation safety net;
- fenced, bounded queue delivery with in-memory and Postgres adapters;
- separate worker entrypoint plus an explicit embedded development worker;
- Mock Connector normalization;
- bounded retry, processing history, dead letters, audit entries, and health reporting;
- deterministic policy/action/approval foundation;
- Zod boundary validation, structured logs, secret redaction, typed configuration, and development auth boundaries;
- SQL migrations and architecture records.

M1A.1 adds:

- trusted Zentra semantic event channel with timestamped HMAC-SHA256 verification;
- `product.company_created` normalization through the real Zentra Connector.

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
Queue (rawEventId + traceId; DB-owned delivery count and lease)
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

The queue is work transport, never the event store. In Postgres mode, raw insertion, queue dispatch, and the ingestion audit commit in one transaction. In the default, explicitly non-production in-memory mode, the API runs a background worker in the same process so a no-account local demo remains useful; the standalone worker refuses to start without Postgres.

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

No cloud account or production credential is required for the local M1A.1 contract demo.

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

Never place real credentials in Vite variables. `VITE_API_BASE_URL` may contain only the public API origin. `ZENTRA_WEBHOOK_SECRET` is server-side only and must contain at least 32 characters. Selecting provider webhook verification without that secret fails during configuration loading.

### Persistent Postgres mode

With Supabase CLI available:

```bash
supabase start
supabase db reset
```

Then set `RUNTIME_MODE=postgres`, `DATABASE_URL` to the local database connection string, and `EMBEDDED_WORKER=false`; run API, worker, and web as separate processes. The checked-in SQL migration is the schema source of truth.

## Tests and quality gates

Receiver-only production runtime, its fail-closed identity boundary, required infrastructure, and local production simulation are documented in [HQ production runtime](docs/security/HQ_PRODUCTION_RUNTIME.md). Production provisioning/deployment is not performed by this repository task.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

Unit tests use dependency injection and do not need Postgres, Supabase, or an external provider. PostgreSQL invariants have a separate real-database suite:

```bash
TEST_DATABASE_URL=postgresql://... pnpm test:integration:postgres
```

The integration command intentionally fails with a clear message when `TEST_DATABASE_URL` is absent; it never reports a skipped database suite as passed. Use an isolated test database because the suite creates and drops its own `zentra_m0_1_integration` schema.

## Trusted Zentra event demo

Terminal 1 generates a local secret, copies it to the clipboard, and starts HQ:

```powershell
$bytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$env:ZENTRA_WEBHOOK_SECRET = [Convert]::ToHexString($bytes).ToLowerInvariant()
$env:ZENTRA_WEBHOOK_SECRET | Set-Clipboard
pnpm dev
```

Terminal 2 reads the same secret and sends the stable demo event:

```powershell
$env:ZENTRA_WEBHOOK_SECRET = Get-Clipboard
$env:HQ_URL = "http://127.0.0.1:4100"
pnpm demo:zentra-event
pnpm demo:zentra-event
```

The first response contains `"duplicate":false`; the second contains `"duplicate":true`. Open `http://localhost:5173/events` to see the single canonical `product.company_created` event. To choose an explicit stable source ID:

```powershell
pnpm demo:zentra-event -- --event-id 20000000-0000-4000-8000-000000000001
```

In-memory state is intentionally lost when the API restarts and must never be treated as production persistence.

## Adding a connector

1. Implement `Connector` without leaking provider types into domain code.
2. Declare only real capabilities and implement meaningful health/disabled states.
3. Implement provider-specific exact-byte webhook verification and register it by a trusted route source.
4. Preserve provider IDs and normalize into versioned, validated semantic facts with a stable `deduplicationKey` and the shared canonical-ID helper.
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

- Zentra Connector currently supports only `product.company_created` schema version 1;
- production Zentra is not connected; M1A.1 uses only the local signed producer simulator;
- no full user authentication or authorization provider exists;
- in-memory mode is process-local and ephemeral;
- Postgres mode uses a simple M0 polling queue, not PGMQ;
- no action executor, AI runtime, real connector, entity resolution, attention engine, CRM, task engine, or search exists.
