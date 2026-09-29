import type { WebhookVerifier } from "@zentra/connectors";
import { InMemoryEventRepository } from "@zentra/database";
import { newTraceId } from "@zentra/domain";
import { InMemoryQueue } from "@zentra/events";
import type { RawEventQueueMessage } from "@zentra/events";
import { describe, expect, it } from "vitest";
import { IngestionService, type IngestionInput } from "./ingestion.js";

const verifier: WebhookVerifier = {
  verify: async () => ({ verified: true, verifier: "test" }),
};

const fixture = (
  overrides: Partial<IngestionInput["request"]> = {},
): IngestionInput => ({
  request: {
    source: "mock",
    sourceAccountId: "account-1",
    externalEventId: "event-1",
    idempotencyKey: "key-1",
    eventTypeHint: "message",
    occurredAt: "2026-09-29T08:00:00.000Z",
    payload: {
      kind: "message",
      messageId: "mock-123",
      sender: { name: "Jan Kowalski", email: "jan@example.com" },
      text: "Chciałbym dowiedzieć się więcej o Zentrze.",
    },
    ...overrides,
  },
  headers: {
    authorization: "Bearer must-not-persist",
    "content-type": "application/json",
  },
  rawBody: Buffer.from("{}"),
  traceId: newTraceId(),
});

const setup = () => {
  const repository = new InMemoryEventRepository();
  const queue = new InMemoryQueue<RawEventQueueMessage>();
  return {
    repository,
    queue,
    service: new IngestionService(repository, queue, verifier),
  };
};

describe("IngestionService", () => {
  it("creates an immutable raw event on first ingestion", async () => {
    const { repository, service } = setup();
    const input = fixture();
    const result = await service.ingest(input);
    input.request.payload.text = "mutated outside repository";
    expect(result.duplicate).toBe(false);
    expect(repository.snapshot().rawEvents[0]?.payload.text).toBe(
      "Chciałbym dowiedzieć się więcej o Zentrze.",
    );
  });

  it("deduplicates an explicit idempotency key", async () => {
    const { repository, service } = setup();
    const first = await service.ingest(fixture());
    const duplicate = await service.ingest(
      fixture({ externalEventId: "different-event" }),
    );
    expect(duplicate).toMatchObject({
      duplicate: true,
      rawEventId: first.rawEventId,
    });
    expect(repository.snapshot().rawEvents).toHaveLength(1);
  });

  it("deduplicates provider identity", async () => {
    const { repository, service } = setup();
    const first = await service.ingest(fixture({ idempotencyKey: null }));
    const duplicate = await service.ingest(
      fixture({ idempotencyKey: "new-key" }),
    );
    expect(duplicate).toMatchObject({
      duplicate: true,
      rawEventId: first.rawEventId,
    });
    expect(repository.snapshot().rawEvents).toHaveLength(1);
  });

  it("is race-safe for concurrent duplicate ingestion", async () => {
    const { repository, service } = setup();
    const results = await Promise.all(
      Array.from({ length: 12 }, async () => service.ingest(fixture())),
    );
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(repository.snapshot().rawEvents).toHaveLength(1);
  });

  it("enqueues each newly accepted event", async () => {
    const { queue, service } = setup();
    const result = await service.ingest(fixture());
    expect((await queue.receive())?.message).toMatchObject({
      rawEventId: result.rawEventId,
      attempt: 1,
    });
  });

  it("does not enqueue a duplicate event twice", async () => {
    const { queue, service } = setup();
    await service.ingest(fixture());
    await service.ingest(fixture());
    expect(await queue.depth()).toBe(1);
  });

  it("stores only allow-listed request headers", async () => {
    const { repository, service } = setup();
    await service.ingest(fixture());
    expect(repository.snapshot().rawEvents[0]?.sanitizedHeaders).toEqual({
      "content-type": "application/json",
    });
  });

  it("rejects conflicting idempotency identities instead of choosing one", async () => {
    const { service } = setup();
    await service.ingest(
      fixture({ idempotencyKey: "key-a", externalEventId: "event-a" }),
    );
    await service.ingest(
      fixture({ idempotencyKey: "key-b", externalEventId: "event-b" }),
    );
    await expect(
      service.ingest(
        fixture({ idempotencyKey: "key-a", externalEventId: "event-b" }),
      ),
    ).rejects.toThrow("Idempotency identifiers refer to different raw events");
  });
});
