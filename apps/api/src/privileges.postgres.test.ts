import { randomBytes, randomUUID } from "node:crypto";
import {
  ConnectorRegistry,
  createZentraWebhookSignature,
  ZentraConnector,
} from "@zentra/connectors";
import {
  PostgresEventRepository,
  PostgresQueue,
  type NewRawEvent,
} from "@zentra/database";
import { loadConfig } from "@zentra/shared";
import { EventProcessor, ExponentialBackoffPolicy } from "@zentra/worker";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createKernel } from "./kernel.js";
import { localDatabaseFixture } from "./ops/local-postgres-fixture.js";
import {
  createSmokeRequest,
  runMigrationCommand,
} from "./ops/operator-tools.js";

let fixture: Awaited<ReturnType<typeof localDatabaseFixture>>;
let app: Awaited<ReturnType<typeof buildApp>>;
const secret = randomBytes(32).toString("hex");
const raw = (): NewRawEvent => ({
  source: "zentra",
  sourceAccountId: null,
  eventTypeHint: "ops.receiver_smoke",
  externalEventId: randomUUID(),
  idempotencyKey: null,
  payload: {},
  sanitizedHeaders: {},
  occurredAt: null,
  receivedAt: new Date().toISOString(),
  traceId: randomUUID(),
});
const workerQueue = (maxDeliveries = 4) =>
  new PostgresQueue(fixture.worker, {
    leaseTimeoutMs: 1,
    maxDeliveries,
    processorName: "canonical-normalizer",
  });
const processor = () =>
  new EventProcessor(
    new PostgresEventRepository(fixture.worker),
    workerQueue(),
    new ConnectorRegistry([new ZentraConnector(true)]),
    new ExponentialBackoffPolicy(0, 0),
    pino({ level: "silent" }),
    {
      processorName: "canonical-normalizer",
      processorVersion: "1.0.0",
      maxAttempts: 4,
    },
  );
const send = async (body: string) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: "POST",
    url: "/v1/webhooks/zentra",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-zentra-timestamp": timestamp,
      "x-zentra-signature": createZentraWebhookSignature({
        secret,
        timestamp,
        rawBody: Buffer.from(body),
      }),
    },
  });
};
beforeAll(async () => {
  fixture = await localDatabaseFixture();
  const config = loadConfig({
    NODE_ENV: "production",
    RUNTIME_MODE: "postgres",
    DATABASE_URL: fixture.apiUrl,
    DATABASE_CA_CERT_PATH: fixture.tls.caPath,
    WEBHOOK_VERIFIER: "provider",
    ZENTRA_WEBHOOK_SECRET: secret,
    EMBEDDED_WORKER: "false",
    WEB_ORIGIN: "https://hq.example.com",
    LOG_LEVEL: "silent",
  });
  const kernel = createKernel(config);
  app = await buildApp(config, kernel);
  app.addHook("onClose", async () => kernel.close());
});
beforeEach(async () => {
  await fixture.owner.query(
    "TRUNCATE raw_events, audit_entries, action_requests CASCADE",
  );
});
afterAll(async () => {
  try {
    await app?.close();
  } finally {
    await fixture?.cleanup();
  }
});

it("ingests atomically as hq_api, detects provider duplicate and processes/ACKs as hq_worker", async () => {
  expect(
    (await fixture.api.query<{ current_user: string }>("SELECT current_user"))
      .rows[0]?.current_user,
  ).toBe("hq_api");
  expect(
    (
      await fixture.worker.query<{ current_user: string }>(
        "SELECT current_user",
      )
    ).rows[0]?.current_user,
  ).toBe("hq_worker");
  const companyId = randomUUID();
  const userId = randomUUID();
  const body = JSON.stringify({
    eventId: randomUUID(),
    type: "product.company_created",
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    entity: { type: "company", id: companyId },
    actor: { type: "user", id: userId },
    data: { companyId, createdByUserId: userId },
  });
  expect((await send(body)).statusCode).toBe(202);
  expect((await send(body)).json<unknown>()).toMatchObject({ duplicate: true });
  expect(
    (
      await fixture.owner.query<{ complete: boolean }>(`SELECT
    (SELECT count(*) FROM raw_events) = 1 AND (SELECT count(*) FROM event_queue) = 1
    AND (SELECT count(*) FROM audit_entries) = 2 AS complete`)
    ).rows[0]?.complete,
  ).toBe(true);
  expect(await processor().processNext()).toBe(true);
  expect(await workerQueue().depth()).toBe(0);
  expect((await fixture.owner.query("SELECT * FROM events")).rowCount).toBe(1);
  expect(
    (
      await fixture.owner.query(
        "SELECT 1 FROM audit_entries WHERE action = 'processing.succeeded'",
      )
    ).rowCount,
  ).toBe(1);
  expect((await send(body)).json<unknown>()).toMatchObject({ duplicate: true });
  expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  expect((await app.inject({ url: "/v1/events" })).statusCode).toBe(401);
});

it("rolls back raw/queue when an audit failure interrupts hq_api ingestion", async () => {
  await fixture.owner
    .query(`CREATE FUNCTION reject_preflight_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'local test audit failure'; END $$;
    CREATE TRIGGER reject_preflight_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION reject_preflight_audit()`);
  try {
    await expect(
      new PostgresEventRepository(fixture.api).ingestEventAtomically(raw()),
    ).rejects.toThrow();
    for (const table of ["raw_events", "event_queue", "audit_entries"])
      expect(
        (await fixture.owner.query(`SELECT 1 FROM ${table}`)).rowCount,
      ).toBe(0);
  } finally {
    await fixture.owner.query(
      "DROP TRIGGER reject_preflight_audit ON audit_entries; DROP FUNCTION reject_preflight_audit()",
    );
  }
});

it("reconciles with column UPDATE privilege but the immutable trigger still rejects actual mutation", async () => {
  const inserted = await new PostgresEventRepository(
    fixture.api,
  ).insertRawEvent(raw());
  const repository = new PostgresEventRepository(fixture.worker);
  expect(
    await repository.reconcileUndispatchedRawEvents({
      olderThanMs: 0,
      limit: 100,
    }),
  ).toBe(1);
  expect(
    (
      await fixture.owner.query(
        "SELECT 1 FROM audit_entries WHERE action = 'ingestion.queue_recovered'",
      )
    ).rowCount,
  ).toBe(1);
  await expect(
    fixture.worker.query("UPDATE raw_events SET id = id WHERE id = $1", [
      inserted.rawEvent.id,
    ]),
  ).rejects.toThrow("immutable");
  expect(
    await repository.reconcileUndispatchedRawEvents({
      olderThanMs: 0,
      limit: 100,
    }),
  ).toBe(0);
});

it("retries with fencing and dead-letters bounded hard-crash redelivery as hq_worker", async () => {
  await new PostgresEventRepository(fixture.api).ingestEventAtomically(raw());
  const queue = workerQueue(2);
  const first = await queue.receive();
  if (first === null) throw new Error("Expected lease");
  const repository = new PostgresEventRepository(fixture.worker);
  const run = await repository.startProcessingRun({
    rawEventId: first.message.rawEventId,
    processorName: "canonical-normalizer",
    processorVersion: "1.0.0",
    attempt: 1,
    traceId: first.message.traceId,
  });
  await repository.markProcessingFailed(run.id, {
    status: "retryable_failed",
    completedAt: new Date().toISOString(),
    errorCode: "LOCAL_TRANSIENT",
    sanitizedErrorMessage: "Local retry probe",
  });
  expect(await queue.retry(first, first.message, 0)).toBe("applied");
  const second = await queue.receive();
  expect(second?.deliveryCount).toBe(2);
  expect(await queue.ack(first)).toBe("stale");
  await fixture.owner.query(
    "UPDATE event_queue SET locked_at = now() - interval '1 second'",
  );
  expect(await queue.receive()).toBeNull();
  expect(await queue.depth()).toBe(0);
  expect(
    (
      await fixture.owner.query(
        "SELECT 1 FROM dead_letters WHERE reason = 'QUEUE_MAX_DELIVERIES_EXCEEDED'",
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await fixture.owner.query(
        "SELECT 1 FROM audit_entries WHERE action = 'processing.poison_queue_item'",
      )
    ).rowCount,
  ).toBe(1);
});

it("handles synthetic ops smoke as controlled unsupported dead-letter with no canonical event and duplicate replay", async () => {
  // Never calls the sender or any production hostname. Only injects the generated body locally.
  const request = createSmokeRequest(
    ["--confirm-production-smoke", "--hostname=hq.example.com"],
    { ZENTRA_WEBHOOK_SECRET: secret },
  );
  expect((await send(request.init.body)).statusCode).toBe(202);
  expect(await processor().processNext()).toBe(true);
  expect(
    (
      await fixture.owner.query(
        "SELECT 1 FROM dead_letters WHERE reason = 'ZENTRA_EVENT_TYPE_UNSUPPORTED'",
      )
    ).rowCount,
  ).toBe(1);
  expect((await fixture.owner.query("SELECT 1 FROM events")).rowCount).toBe(0);
  expect((await send(request.init.body)).json<unknown>()).toMatchObject({
    duplicate: true,
  });
  expect(await workerQueue().depth()).toBe(0);
});

it("denies DDL, ownership/trigger bypass, role switching and unnecessary cross-access", async () => {
  const statements = [
    "CREATE TABLE public.forbidden (id int)",
    "CREATE TEMP TABLE forbidden (id int)",
    "CREATE SCHEMA forbidden",
    "CREATE FUNCTION public.forbidden() RETURNS int LANGUAGE sql AS 'SELECT 1'",
    "DROP TABLE raw_events CASCADE",
    "ALTER TABLE raw_events ADD COLUMN forbidden int",
    "ALTER TABLE raw_events DISABLE TRIGGER raw_events_immutable",
    "ALTER TABLE raw_events DISABLE TRIGGER ALL",
    "SET session_replication_role = replica",
    "TRUNCATE raw_events CASCADE",
    "DELETE FROM raw_events",
    "SELECT * FROM approval_requests",
    "SELECT * FROM action_requests",
    "CREATE ROLE forbidden",
    "CREATE DATABASE forbidden",
    "ALTER ROLE hq_api SUPERUSER",
    "DROP FUNCTION prevent_raw_event_mutation() CASCADE",
  ];
  for (const pool of [fixture.api, fixture.worker]) {
    for (const sql of statements)
      await expect(pool.query(sql), sql).rejects.toMatchObject({
        code: "42501",
      });
  }
  for (const sql of [
    "DELETE FROM event_queue",
    "UPDATE event_queue SET delivery_count = 0",
    "INSERT INTO events DEFAULT VALUES",
    "INSERT INTO dead_letters DEFAULT VALUES",
    "INSERT INTO processing_runs DEFAULT VALUES",
    "SELECT * FROM audit_entries",
    "SET ROLE hq_worker",
  ])
    await expect(fixture.api.query(sql), sql).rejects.toMatchObject({
      code: "42501",
    });
  for (const sql of [
    "INSERT INTO raw_events (source) VALUES ('forbidden')",
    "UPDATE raw_events SET payload = '{}'",
    "SELECT metadata FROM audit_entries",
    "SELECT payload FROM events",
    "SET ROLE hq_api",
  ])
    await expect(fixture.worker.query(sql), sql).rejects.toMatchObject({
      code: "42501",
    });
  const roles = await fixture.owner.query<{ safe: boolean }>(`SELECT
    NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
    AND NOT rolinherit AS safe FROM pg_roles WHERE rolname IN ('hq_api','hq_worker')`);
  expect(roles.rows).toEqual([{ safe: true }, { safe: true }]);
  expect(
    (
      await fixture.owner.query(`SELECT 1 FROM pg_class WHERE relowner IN
    (SELECT oid FROM pg_roles WHERE rolname IN ('hq_api','hq_worker'))`)
    ).rowCount,
  ).toBe(0);
});

it("uses real psql single-transaction/ON_ERROR_STOP and rolls back an interrupted migration", async () => {
  // All writes remain inside the isolated, generated local test database.
  const env = {
    ...process.env,
    PGHOST: "127.0.0.1",
    PGPORT: "5432",
    PGDATABASE: fixture.database,
    PGUSER: "postgres",
    PGPASSWORD: decodeURIComponent(
      new URL(process.env.TEST_DATABASE_URL ?? "").password,
    ),
  };
  const args = [
    "exec",
    "-i",
    "--env",
    "PGHOST",
    "--env",
    "PGPORT",
    "--env",
    "PGDATABASE",
    "--env",
    "PGUSER",
    "--env",
    "PGPASSWORD",
    "supabase_db_zentra-hq",
    "psql",
    "-X",
    "--single-transaction",
    "--set=ON_ERROR_STOP=1",
    "--file=-",
  ];
  await expect(
    runMigrationCommand(
      "docker",
      args,
      env,
      "CREATE TABLE migration_rollback_probe (id int); SELECT 1/0; CREATE TABLE must_not_run (id int);",
    ),
  ).rejects.toThrow("TRANSACTION_FAILED");
  expect(
    (
      await fixture.owner.query<{ absent: boolean }>(
        "SELECT to_regclass('migration_rollback_probe') IS NULL AND to_regclass('must_not_run') IS NULL AS absent",
      )
    ).rows[0]?.absent,
  ).toBe(true);
});

it("removes managed-provider Data API grants from the dedicated HQ schema/tables", async () => {
  const result = await fixture.owner.query(`SELECT rolname FROM pg_roles
    WHERE rolname IN ('anon','authenticated','service_role')
    AND (has_schema_privilege(rolname, 'public', 'USAGE')
      OR has_table_privilege(rolname, 'raw_events', 'SELECT')
      OR has_table_privilege(rolname, 'audit_entries', 'INSERT'))`);
  expect(result.rowCount).toBe(0);
});
