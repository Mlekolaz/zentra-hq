# HQ pre-provisioning / operator runbook

Scope: receiver only. This repository does not provision infrastructure or deploy.
No production action below is authorized by a successful local test.

## Image and services

Build from the workspace root: `docker build -t zentra-hq-preflight:local .`.
Node 24, pinned pnpm 11.25.0, frozen production dependencies, workspace TS sources.
No compilation is required. `tsx` is a runtime dependency, not a development tool.
The optional BuildKit `npm_ca` secret is a trusted corporate CA for installation
only; it is not an application secret and never persists in an image layer.

Same image, two services, one replica each initially:

| Service | Exec-form command                           | Network                                 |
| ------- | ------------------------------------------- | --------------------------------------- |
| API     | `node --import tsx apps/api/src/main.ts`    | HTTP `$PORT`, `HOST=0.0.0.0`, `/health` |
| Worker  | `node --import tsx apps/worker/src/main.ts` | No public port/domain/HTTP healthcheck  |

Use the Dockerfile at repository root; do not configure a second provider build
step or `pnpm build`. Do not wrap Node in a shell or pnpm at runtime. Node is PID 1,
UID 1000. Allow at least 30 seconds for SIGTERM before forced termination. Use an
infrastructure restart policy (always/on failure) and alert on restart loops.
Never configure a migration command as either service's startup/pre-deploy hook.

Both services require `NODE_ENV=production`, `RUNTIME_MODE=postgres`,
`WEBHOOK_VERIFIER=provider`, `EMBEDDED_WORKER=false`, explicit `WEB_ORIGIN`, and
`ZENTRA_WEBHOOK_SECRET` (at least 32 characters), because config validation is
shared. API `DATABASE_URL` authenticates as `hq_api`; worker as `hq_worker`.
API also uses `HOST` and provider-assigned `PORT`; worker ignores them.
Worker defaults: poll 100 ms, max attempts 4, lease 5 min, reconciliation each
minute for raw events older than 2 minutes, heartbeat each 30 seconds.

## Production database connectivity: direct IPv6 + verified TLS

Approved HQ project: `fxmssbnkmelaokttznqw`, PostgreSQL 17.11. Both persistent
services use **direct** `db.fxmssbnkmelaokttznqw.supabase.co:5432`, database
`postgres`. API authenticates as `hq_api`, worker as `hq_worker` (plain role
names, no pooler project suffix). Keep the existing verified runtime roles and
passwords; do not recreate roles or reset passwords as a connectivity workaround.
HQ remains separate from Zentra, with Data API OFF and scheduled backups enabled.
No Zentra service-role credential is required or accepted.

`DATABASE_URL` remains the only endpoint/credential source, with URL-encoded
passwords prepared privately in the approved secret manager. Never put a complete
production URL in argv, repository files, screenshots or logs. Do not append
`sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `ssl`, `uselibpqcompat` or other TLS
parameters. Only `options` and `application_name` query parameters are accepted
in production. Shared Supavisor `.pooler.supabase.com` URLs are refused; neither
session 5432 nor transaction 6543 is a fallback after EAUTHQUERY/network/TLS errors.

API and worker share one Pool configuration (max 10 and 5 respectively), which
parses the URL into explicit fields and **never passes connectionString in
production**. TLS has one authority: the programmatic object with the bundled
Supabase public Root CA, `rejectUnauthorized: true`, minimum TLS 1.2, DNS SNI and
certificate hostname verification bound to DATABASE_URL. This avoids the
[node-postgres URL SSL override](https://node-postgres.com/features/ssl).
Missing/unreadable/invalid/expired CA, invalid URL, competing URL configuration
or `NODE_TLS_REJECT_UNAUTHORIZED=0` abort bootstrap before listening/processing.
There is no plaintext, system-root or insecure-verification fallback, including
for loopback production simulations. An untrusted chain or mismatched hostname
fails the handshake; the client does not downgrade or retry a pooler endpoint.

The image sets `DATABASE_CA_CERT_PATH=/app/packages/database/certs/supabase-root-2021.crt`.
Outside Docker the factory resolves that bundled file relative to its module.
This is a public file, not a secret. An optional explicit path supports a reviewed
CA rotation/mount; the selected root must exist and be valid. See
`packages/database/certs/README.md` for public provenance, fingerprint and expiry.
`PGSSLMODE`/`PGHOST` must not be used to configure runtime: explicit URL fields
and TLS policy are authoritative. They do not override the programmatic settings.

**Railway Outbound IPv6 REQUIRED, separately for API and worker.** In each
service's Settings > Networking stage Enable Outbound IPv6 before its first
approved deployment. It is disabled by default; applying the staged change
redeploys the service and therefore requires an operator deployment gate. See
[Railway outbound networking](https://docs.railway.com/networking/outbound-networking#outbound-ipv6).
Do not use the private-network IPv6 setting as a substitute. Keep the direct DNS
hostname (do not pin an IPv6 literal or force IPv4), so SNI/hostname verification
and future address changes remain correct. No code-level network probe contacts
production during pre-flight; actual Railway routing/handshake remains an
explicitly approved later verification. Do not broaden database grants to fix TLS.

## Operator-only migrations

Requires a local checkout with full operator tooling and `psql` installed. The
production image intentionally excludes scripts and migrations.

1. Operator approves a **separate HQ database/project**, region, backups and cost.
   Never use Zentra's database or its service-role key. Disable the HQ Supabase
   Data API if using Supabase; it is not part of the receiver architecture.
2. Prepare a protected PostgreSQL service file outside the repository, containing
   only the approved HQ host/port/database/migrator user/TLS settings (no password).
   Set `PGSERVICEFILE` to its absolute path. Prepare a protected passfile outside
   the repository and set `PGPASSFILE` to its absolute path. Unix mode 0600; on
   Windows restrict the files' ACL to the operator. Do not set `PGPASSWORD` for
   the production runner. The runner rejects paths within the checkout and clears
   ambient libpq overrides; host/database/user/TLS must be in the approved service
   file. Require authenticated TLS (`sslmode=verify-full` with the provider CA).
   Do not paste credentials into terminal arguments or logs. Operator must also
   verify file ACLs and resolved paths (no symlinks back into the checkout).
3. `pnpm ops:migrate --check` checks SHA-256 and exact order, without connecting.
   Hashes normalize CRLF to LF only. Review a checksum change as a source change;
   never regenerate the manifest to bypass a failed verification.
4. **After a separate operator gate**, run
   `pnpm ops:migrate --apply --confirm-hq-migrations --service=hq_migrator`.
   This invokes `psql -X --single-transaction --set=ON_ERROR_STOP=1 --file=-`,
   with the verified SQL on stdin: foundation first, data-integrity second.
   A failure aborts the transaction; client output is suppressed to protect
   credentials. This is a fresh-database bootstrap, not an idempotent migration
   history engine. Refuse to rerun against an already-migrated database.
5. Verify both schema and immutable UPDATE/DELETE trigger using the operator
   connection. **Separate operator gate:** with the same protected service
   environment, run `psql -X --single-transaction --set=ON_ERROR_STOP=1
--file=infra/postgres/runtime-roles.sql` (`PGSERVICE=hq_migrator`). The SQL
   intentionally refuses existing role names; do not silently reuse identities.
6. **Separate operator gate:** interactive `psql -X`, then `\password hq_api`
   and `\password hq_worker`. Generate independent strong passwords in the
   approved password manager. Set separate runtime URLs in provider secret
   stores later; no credentials belong in this checkout or the container image.

The local test adapter permits only the existing local Supabase container and a
generated `hq_preflight_<UUID>` database. It does not accept production targets.
Privileges tests use isolated databases and refuse pre-existing runtime roles.
They remove only their generated databases/roles after closing all connections.

## Derived grant matrix

Column details are authoritative in `postgres/runtime-roles.sql`. No grants on
action/approval tables, no ownership or DDL, no schema/database CREATE or TEMP,
no SUPERUSER/CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS or memberships.

| Table                               | hq_api                                              | hq_worker                                                            | Runtime query requirement                                           |
| ----------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| raw_events                          | SELECT; INSERT ingest columns                       | SELECT; UPDATE(id) only                                              | API RETURNING/dedup; worker normalize and FOR UPDATE reconciliation |
| events                              | SELECT(raw_event_id)                                | SELECT(id, raw_event_id); INSERT canonical columns                   | Duplicate/reconciler terminal lookup; canonical RETURNING id        |
| processing_runs                     | SELECT(raw_event_id, status)                        | SELECT; INSERT start columns; UPDATE status/completion/error columns | Terminal lookup; RETURNING * and processing transitions             |
| event_queue                         | SELECT; INSERT(raw_event_id, payload, available_at) | SELECT; INSERT same; UPDATE lease/retry columns; DELETE              | API health/dedup/dispatch; worker receive/reconcile/retry/ACK       |
| audit_entries                       | INSERT audit columns; no SELECT                     | INSERT audit columns; SELECT(id, created_at)                         | Atomic ingest; worker audit RETURNING                               |
| dead_letters                        | SELECT(raw_event_id)                                | INSERT dead-letter columns; SELECT(id, raw_event_id, created_at)     | Terminal lookup; poison handling and RETURNING                      |
| action_requests / approval_requests | None                                                | None                                                                 | Production operator endpoints fail closed before repository access  |

`UPDATE(id)` on raw_events permits a row lock, not successful mutation: the
owner-controlled immutable trigger rejects it. Runtime roles cannot disable
that trigger or set `session_replication_role=replica`. UUID defaults need no
sequence grants. Migrator ownership remains outside runtime.
Revoking PUBLIC schema/database access affects the dedicated HQ database only.
The script also removes any existing explicit anon/authenticated/service-role
grants on the HQ schema/tables. Provider-specific default grants must still be
audited for the migration owner before future migrations; disable Data API.
Do not broaden runtime grants to make an operator UI work in this milestone.

## Local verification

With local Supabase PostgreSQL on `127.0.0.1:54322` and `TEST_DATABASE_URL` set
locally (never production), run `pnpm test:integration:postgres`.
Development/test defaults still connect to the local plaintext database.
Production simulations use an ephemeral local PostgreSQL SSLRequest/TLS test
endpoint forwarding only to `127.0.0.1:54322`. It generates a one-day local test
CA/key outside the checkout (OpenSSL; Windows Git includes the binary), trusts
only that CA, and removes the generated files and sockets after tests. This
test-only adapter is excluded from the image; it is not a production TLS proxy.
Tests reject untrusted CA, incorrect hostname and a plaintext server. The local
Postgres configuration is not changed. The container test mounts only the public
test CA read-only, never the test private key; the image's actual Supabase root
is independently checked. These tests cannot prove the live provider's current
certificate chain or Railway routing without a separately approved connection.
After the local image build, set `HQ_TEST_IMAGE=zentra-hq-preflight:local` and run
`pnpm test:container`. The container test applies verified migrations through
the real psql runner, then role SQL; starts separate non-root containers with
distinct runtime credentials and synthetic local-only events; checks failure
without WEB_ORIGIN, clean production-only files, real processing/audit, heartbeat,
duplicate detection, and exit code 0 after SIGTERM. No production smoke is sent.

## Later, explicitly approved production smoke

Do not execute during local pre-flight. Operator obtains `ZENTRA_WEBHOOK_SECRET`
from the approved secret manager into the process environment without echoing it
(e.g. PowerShell masked `Read-Host -AsSecureString` and transient process env).
Clear it afterwards. Never put a literal secret in a command, shell history,
`.env`, service file, git, report, or screen capture. The same shared HMAC key
must subsequently be configured only in Zentra's backend sender secret store,
never browser/frontend code. Worker currently also requires it via shared config.

After a separate production-write gate:
`pnpm ops:smoke --hostname=api.hq.mojazentra.pl --confirm-production-smoke`.
No default host, no default send, HTTPS only, redirects refused, 15-second timeout,
exactly one request, no retry. It prints only status and a generated eventId.
Payload is a synthetic `ops.receiver_smoke` envelope: no business identifiers or
PII. Its fixed synthetic occurredAt makes an explicitly requested replay identical.
For a later separately-approved duplicate check, reuse `--event-id=<returned UUID>`.
Even after a timeout, inspect the raw event before deciding on any replay.

Expected: HTTP 202; one immutable raw event; processing marked permanently failed
with `ZENTRA_EVENT_TYPE_UNSUPPORTED`; one controlled dead letter and failure audit;
zero canonical events. An explicit same-ID replay returns duplicate=true, with no
new raw/canonical event or queue work. Do not add support for this event type.

## Monitoring and incident runbook

No new monitoring stack. Use provider process monitoring/log alerts and manual
read-only SQL with a protected operator connection (not a public API endpoint).
Do not log payloads, authorization headers, HMAC signatures, secrets or DB URLs.

| Signal                   | Check / initial alert                                                                                     | Operator response                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| API readiness            | GET /health: HTTP 200, readiness=true, storage=postgres; 2 failed probes                                  | Check DB connectivity and API restart loop; worker=null is expected                                       |
| Worker process/heartbeat | Service running; every 30s `worker heartbeat` with advancing lastPollAt, running/ready=true; missing >90s | Check lastErrorCode, process exits and queue/lag; heartbeat alone does not prove reconciliation succeeded |
| queueDepth               | /health queueDepth plus SQL below; rising for >5 min                                                      | Check worker heartbeat, retries and DB; never delete raw facts                                            |
| oldest pending lag       | SQL below; >5 min initially                                                                               | Check leases (5 min), reconciliation failures and normalization errors                                    |
| Retries                  | retryable_failed counts + retry log codes; sustained increase                                             | Diagnose provider/DB failures; do not blind requeue                                                       |
| Dead letters             | New dead letters excluding the approved ops smoke: alert                                                  | Inspect reason/trace metadata only; approved replay/reprocessing procedure required                       |
| HMAC failures            | API safe errorCode AUTHENTICATION_FAILED / HTTP 401, sudden increase                                      | Check sender/receiver key parity and UTC clock skew (5 min window); never print signatures                |
| DB connectivity          | /health readiness; worker loop/reconciliation safe error codes                                            | Verify per-service URL, TLS, DB availability and role grants; do not substitute migrator credentials      |

`AUTHENTICATION_FAILED` is not an HMAC-exclusive metric: operator routes also
reject unauthenticated requests. If the infrastructure exposes HTTP route/status
metrics, filter 401 counts to `/v1/webhooks/zentra`; otherwise treat this log code
as an aggregate authentication alert, not an exact HMAC failure counter. No
payload/header logging should be enabled to obtain a more specific metric.

```sql
SELECT count(*) AS queue_depth,
       COALESCE(max(now() - r.received_at), interval '0 seconds') AS oldest_event_lag,
       count(*) FILTER (WHERE q.delivery_count > 1) AS redelivered_items
FROM event_queue q JOIN raw_events r ON r.id = q.raw_event_id;
SELECT count(*) AS undispatched,
       COALESCE(max(now() - r.received_at), interval '0 seconds') AS oldest_undispatched_lag
FROM raw_events r
WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.raw_event_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM processing_runs p WHERE p.raw_event_id = r.id AND p.status = 'succeeded')
  AND NOT EXISTS (SELECT 1 FROM dead_letters d WHERE d.raw_event_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM event_queue q WHERE q.raw_event_id = r.id);
SELECT status, count(*) FROM processing_runs
WHERE started_at > now() - interval '15 minutes' GROUP BY status;
SELECT reason, count(*) FROM dead_letters
WHERE created_at > now() - interval '15 minutes' GROUP BY reason;
```

Restart/rollback: operator gate first. Keep immutable raw events, audit and queue;
do not down-migrate or truncate. Stop API intake if a bad release is accepting
invalid work; drain or stop the worker gracefully as appropriate. Pin the previous
verified image digest and unchanged compatible schema/config, restart worker,
then API, verify heartbeat, /health, queue/lag. A crashed worker's queue lease is
recoverable after 5 min with fencing and bounded deliveries. Rollback involving
schema or replay requires a separate reviewed procedure and a verified backup.

## Provisioning boundary

The dedicated HQ project and least-privilege runtime roles have already been
provisioned and verified by the operator. Earlier fresh-database bootstrap steps
are historical procedures, not instructions to rerun migrations/roles/passwords.
Next: review the local direct/TLS image and configuration changes. After separate
explicit approval, stage Outbound IPv6 on both Railway services before their
first deployment. Do not apply staged changes, configure secrets, deploy, change
DNS or send a production request during this local readiness stage.
