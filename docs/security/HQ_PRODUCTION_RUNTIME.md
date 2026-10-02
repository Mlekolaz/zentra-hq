# HQ receiver production runtime (M1A.3B)

This is a provisioning contract, not a deployment instruction or proof of deployed infrastructure. No production database, secret, DNS, or service has been created by this milestone.

## Inventory and runtime boundary

- API: `apps/api/src/main.ts` validates configuration and composes `kernel.ts` before listening. Production uses PostgresEventRepository, PostgresQueue, the real Zentra HMAC verifier, and ReceiverOnlyIdentityProvider. There is no memory fallback or embedded worker.
- Identity: no production user/session provider exists. `/v1/context`, `/v1/overview`, `/v1/events`, and `/v1/integrations` fail closed with 401 in production. This is receiver-only readiness, not readiness for operator UI authentication. Browser roles and webhook actors are not identities.
- Receiver: `POST /v1/webhooks/zentra` verifies exact raw bytes and timestamp before parsing. Successful acknowledgement follows atomic raw-event, queue, and audit persistence. Retries are deduplicated. Development ingestion is not registered in production.
- Worker: `apps/worker/src/main.ts` is a separate process, requires Postgres, reloads immutable raw events, normalizes through ZentraConnector, and persists canonical facts, processing history, and audit. It does not listen on HTTP. Production excludes MockConnector.
- Config: `packages/shared/src/config.ts` requires provider verification, a secret of at least 32 characters, a PostgreSQL URL, Postgres mode, and EMBEDDED_WORKER=false in production. PORT is an integer from 1 through 65535. HOST is a hostname/IP, defaults to `0.0.0.0` in production and `127.0.0.1` in development/test. Explicit HOST overrides either default. Production entrypoints use process environment only, never the development `.env` file.

## Required operator-supplied infrastructure

A separately provisioned HQ PostgreSQL database, existing HQ migrations applied by an operator, least-privilege server-side access, backups/restore verification, and the required network/TLS protections. Never use production Zentra's database or service-role credential.

Two supervised Node processes sharing HQ DATABASE_URL: API and standalone worker. At present workspace packages export TypeScript; start commands use the `tsx` loader, not plain `node dist/main.js`. The runtime artifact must contain the workspace source, manifests, lockfile, workspace configuration, and production dependencies (`NODE_ENV=production pnpm install --prod --frozen-lockfile`). The root `tsx` loader is a runtime dependency; developer tools are not required to start either process. Node >=22 is required. Building alone does not create a self-contained container image.

The API needs TLS routing to its runtime-assigned PORT, suitable request body limits, readiness checks, and protection/rate limiting for health and ingestion. `/health` reports API storage readiness and `worker: null`; it does not assert standalone worker readiness. Monitor the worker's heartbeat, processing lag, retries, and dead letters independently.

Provision these values through the operator-managed secret/config mechanism, not through checked-in files:

```text
NODE_ENV=production
RUNTIME_MODE=postgres
DATABASE_URL=<separate HQ PostgreSQL connection URL>
WEBHOOK_VERIFIER=provider
EMBEDDED_WORKER=false
ZENTRA_WEBHOOK_SECRET=<random shared producer secret, minimum 32 characters>
PORT=<API runtime-assigned port>
WEB_ORIGIN=<approved production web origin>
# HOST defaults to 0.0.0.0; override only deliberately.
```

Production secret generation, storage, rotation, and producer alignment remain operator responsibilities. WEB_ORIGIN is a CORS allow-list, not authentication; production requires an explicit valid URL and fails fast without it. Only development/test retains the localhost default. No user auth secrets are needed for receiver-only mode.

After provisioning is separately authorized, process commands from repository root are `pnpm start:api` and `pnpm start:worker`. Do not start `pnpm dev` or an embedded worker for production. No deployment is performed by these documented steps.

## Local production simulation

With an already running local PostgreSQL at `127.0.0.1:54322`:

```powershell
$env:TEST_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
pnpm test:integration:postgres
```

The production smoke test refuses nonlocal connections, creates a unique test schema, applies unchanged migrations there, generates an ephemeral test-only secret, and launches real API/worker entrypoints in separate processes. It checks storage health, operator denial, development route absence, provider authentication, persistence/queue without a worker, standalone processing, and duplicate delivery. Child processes and only the generated smoke schema are removed afterward. The existing M0.1 suite also owns its dedicated test schema. No production request or persistent secret is involved.

### Production-only packaging verification

Verified on 2026-10-03 with Node 24 and pnpm 11.25.0: a fresh temporary copy contained source/manifests/lockfile, but no existing `node_modules`, `.env`, or build output. `NODE_ENV=production pnpm install --prod --frozen-lockfile --prefer-offline` installed 76 runtime packages (developer dependencies skipped), with frozen resolution and supply-chain/TLS checks enabled. The version of tsx remains 4.23.15 in the lockfile; no dependency upgrade was needed.

The smoke test also supports `HQ_PRODUCTION_WORKSPACE=<isolated installed copy>` and `HQ_TEST_PNPM_EXECUTABLE=<absolute pnpm executable>` when invoked from the developer workspace. In that mode only the verifier runs with test tooling; the API and worker run via the actual `pnpm start:api` / `pnpm start:worker` commands in the production-only copy. A separate plain Node process checks that tsx resolves from that copy and TypeScript, Vitest, ESLint, and `@types/node` cannot resolve. The local signed-event flow, separate worker processing, audit, queue acknowledgement, and duplicate check passed. No additional devDependency is required by the runtime source imports.

The Windows test machine uses Norton TLS inspection. Verification used its already trusted Windows root certificate through a temporary NODE_EXTRA_CA_CERTS file; TLS and supply-chain verification were not disabled. This is a local test-environment accommodation, not a production configuration requirement.

## Next operator step

Review and explicitly approve a provisioning plan for the separate HQ database, two process services, runtime packaging, TLS ingress, secret ownership/rotation, and monitoring. Stop before executing that plan. Enabling the operator UI requires a separate identity/authorization milestone.
