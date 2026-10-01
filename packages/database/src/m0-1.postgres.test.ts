import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CanonicalEvent } from "@zentra/events";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresQueue } from "./postgres-queue.js";
import { PostgresEventRepository } from "./postgres-repository.js";
import type { NewRawEvent } from "./repository.js";

const schema = "zentra_m0_1_integration";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error(
    "TEST_DATABASE_URL is required for PostgreSQL integration tests",
  );

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 20,
  options: `-c search_path=${schema},public`,
});
const repository = new PostgresEventRepository(pool);

const migrationPaths = [
  "supabase/migrations/202609290001_m0_foundation.sql",
  "supabase/migrations/202609300001_m0_1_data_integrity.sql",
];

const rawInput = (overrides: Partial<NewRawEvent> = {}): NewRawEvent => ({
  source: "stripe",
  sourceAccountId: null,
  eventTypeHint: "test.event",
  externalEventId: `evt-${randomUUID()}`,
  idempotencyKey: null,
  payload: { value: "test" },
  sanitizedHeaders: {},
  occurredAt: "2026-09-30T08:00:00.000Z",
  receivedAt: "2026-09-30T08:00:01.000Z",
  traceId: randomUUID(),
  ...overrides,
});

const rowCount = async (table: string): Promise<number> => {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table}`,
  );
  return result.rows[0]?.count ?? 0;
};

const queueFor = (options?: {
  leaseTimeoutMs?: number;
  maxDeliveries?: number;
}) =>
  new PostgresQueue(pool, {
    leaseTimeoutMs: options?.leaseTimeoutMs ?? 300_000,
    maxDeliveries: options?.maxDeliveries ?? 4,
    processorName: "integration-normalizer",
  });

const seedQueuedRaw = async (): Promise<{
  rawEventId: string;
  traceId: string;
}> => {
  const result = await repository.ingestEventAtomically(rawInput());
  return {
    rawEventId: result.rawEvent.id,
    traceId: result.rawEvent.traceId,
  };
};

beforeAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  for (const migrationPath of migrationPaths) {
    const sql = await readFile(resolve(process.cwd(), migrationPath), "utf8");
    await pool.query(sql);
  }
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE raw_events, audit_entries, action_requests RESTART IDENTITY CASCADE",
  );
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

describe("M0.1 PostgreSQL invariants", () => {
  it("rolls back raw and queue rows when the ingestion audit write fails", async () => {
    await pool.query(`
      CREATE FUNCTION reject_test_ingestion_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'ingestion.accepted' THEN
          RAISE EXCEPTION 'simulated audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_test_ingestion_audit
        BEFORE INSERT ON audit_entries
        FOR EACH ROW EXECUTE FUNCTION reject_test_ingestion_audit();
    `);
    try {
      await expect(
        repository.ingestEventAtomically(rawInput()),
      ).rejects.toThrow("simulated audit failure");
      expect(await rowCount("raw_events")).toBe(0);
      expect(await rowCount("event_queue")).toBe(0);
    } finally {
      await pool.query(`
        DROP TRIGGER reject_test_ingestion_audit ON audit_entries;
        DROP FUNCTION reject_test_ingestion_audit();
      `);
    }
  });

  it("deduplicates provider identity with a NULL source account", async () => {
    const identity = `evt-${randomUUID()}`;
    const first = await repository.ingestEventAtomically(
      rawInput({ externalEventId: identity }),
    );
    const duplicate = await repository.ingestEventAtomically(
      rawInput({ externalEventId: identity, idempotencyKey: randomUUID() }),
    );
    expect(duplicate.rawEvent.id).toBe(first.rawEvent.id);
    expect(duplicate.duplicateReason).toBe("provider_identity");
    expect(await rowCount("raw_events")).toBe(1);
  });

  it("keeps exactly one raw and queue row under concurrent duplicate ingestion", async () => {
    const identity = `evt-${randomUUID()}`;
    await Promise.all(
      Array.from({ length: 12 }, async () =>
        repository.ingestEventAtomically(
          rawInput({ externalEventId: identity }),
        ),
      ),
    );
    expect(await rowCount("raw_events")).toBe(1);
    expect(await rowCount("event_queue")).toBe(1);
  });

  it("blocks UPDATE of raw events", async () => {
    const { rawEventId } = await seedQueuedRaw();
    await expect(
      pool.query(
        "UPDATE raw_events SET event_type_hint = 'changed' WHERE id = $1",
        [rawEventId],
      ),
    ).rejects.toThrow("raw_events are immutable");
  });

  it("blocks DELETE of raw events", async () => {
    const { rawEventId } = await seedQueuedRaw();
    await expect(
      pool.query("DELETE FROM raw_events WHERE id = $1", [rawEventId]),
    ).rejects.toThrow("raw_events are immutable");
  });

  it("increments delivery_count atomically when leasing", async () => {
    await seedQueuedRaw();
    const delivery = await queueFor().receive();
    expect(delivery?.deliveryCount).toBe(1);
    const result = await pool.query<{ delivery_count: number }>(
      "SELECT delivery_count FROM event_queue",
    );
    expect(result.rows[0]?.delivery_count).toBe(1);
  });

  it("redelivers with a fresh token after lease expiration", async () => {
    await seedQueuedRaw();
    const queue = queueFor({ leaseTimeoutMs: 1 });
    const workerA = await queue.receive();
    await pool.query("SELECT pg_sleep(0.01)");
    const workerB = await queue.receive();
    expect(workerB?.deliveryCount).toBe(2);
    expect(workerB?.leaseToken).not.toBe(workerA?.leaseToken);
  });

  it("rejects a stale ACK after another worker acquires the lease", async () => {
    await seedQueuedRaw();
    const queue = queueFor({ leaseTimeoutMs: 1 });
    const workerA = await queue.receive();
    if (workerA === null) throw new Error("worker A did not receive a lease");
    await pool.query("SELECT pg_sleep(0.01)");
    await queue.receive();
    expect(
      await queue.ack({
        queueItemId: workerA.queueItemId,
        leaseToken: workerA.leaseToken,
      }),
    ).toBe("stale");
    expect(await rowCount("event_queue")).toBe(1);
  });

  it("rejects a stale retry after another worker acquires the lease", async () => {
    const seeded = await seedQueuedRaw();
    const queue = queueFor({ leaseTimeoutMs: 1 });
    const workerA = await queue.receive();
    if (workerA === null) throw new Error("worker A did not receive a lease");
    await pool.query("SELECT pg_sleep(0.01)");
    const workerB = await queue.receive();
    expect(
      await queue.retry(
        {
          queueItemId: workerA.queueItemId,
          leaseToken: workerA.leaseToken,
        },
        seeded,
        0,
      ),
    ).toBe("stale");
    const result = await pool.query<{ lease_token: string }>(
      "SELECT lease_token FROM event_queue",
    );
    expect(result.rows[0]?.lease_token).toBe(workerB?.leaseToken);
  });

  it("dead-letters poison work after bounded hard-crash redelivery", async () => {
    await seedQueuedRaw();
    const queue = queueFor({ leaseTimeoutMs: 1, maxDeliveries: 2 });
    expect((await queue.receive())?.deliveryCount).toBe(1);
    await pool.query("SELECT pg_sleep(0.01)");
    expect((await queue.receive())?.deliveryCount).toBe(2);
    await pool.query("SELECT pg_sleep(0.01)");
    expect(await queue.receive()).toBeNull();
    expect(await rowCount("event_queue")).toBe(0);
    const result = await pool.query<{ reason: string; attempt_count: number }>(
      "SELECT reason, attempt_count FROM dead_letters",
    );
    expect(result.rows).toEqual([
      { reason: "QUEUE_MAX_DELIVERIES_EXCEEDED", attempt_count: 2 },
    ]);
  });

  it("deduplicates each canonical item during partial persistence replay", async () => {
    const ingested = await repository.ingestEventAtomically(rawInput());
    const base: Omit<CanonicalEvent, "id" | "deduplicationKey" | "payload"> = {
      rawEventId: ingested.rawEvent.id,
      type: "test.item_received",
      schemaVersion: 1,
      source: ingested.rawEvent.source,
      sourceAccountId: null,
      externalEventId: ingested.rawEvent.externalEventId,
      occurredAt: ingested.rawEvent.occurredAt ?? ingested.rawEvent.receivedAt,
      receivedAt: ingested.rawEvent.receivedAt,
      actor: null,
      subject: null,
      entityRefs: [],
      correlationId: null,
      causationId: null,
      metadata: { traceId: ingested.rawEvent.traceId },
    };
    for (const item of ["item:a", "item:b"]) {
      await repository.saveCanonicalEvent({
        ...base,
        id: randomUUID(),
        deduplicationKey: item,
        payload: { item },
      });
    }
    for (const item of ["item:a", "item:b"]) {
      await repository.saveCanonicalEvent({
        ...base,
        id: randomUUID(),
        deduplicationKey: item,
        payload: { item, replayed: true },
      });
    }
    expect(await rowCount("events")).toBe(2);
    const result = await pool.query<{ deduplication_key: string }>(
      "SELECT deduplication_key FROM events ORDER BY deduplication_key",
    );
    expect(result.rows.map((row) => row.deduplication_key)).toEqual([
      "item:a",
      "item:b",
    ]);
  });
});
