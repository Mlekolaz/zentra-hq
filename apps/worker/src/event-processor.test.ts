import { ConnectorRegistry, MockConnector } from "@zentra/connectors";
import type {
  Connector,
  ConnectorCapability,
  ConnectorHealth,
} from "@zentra/connectors";
import { InMemoryEventRepository } from "@zentra/database";
import { newTraceId, RetryableProcessingError } from "@zentra/domain";
import type { RawEvent } from "@zentra/domain";
import { InMemoryRawEventQueue } from "@zentra/events";
import type { CanonicalEvent } from "@zentra/events";
import { createLogger } from "@zentra/observability";
import { describe, expect, it } from "vitest";
import { EventProcessor } from "./event-processor.js";
import type { RetryPolicy } from "./retry-policy.js";

const noDelay: RetryPolicy = { delayMs: () => 0 };

class FlakyMockConnector implements Connector {
  public readonly provider = "mock";
  public calls = 0;
  readonly #delegate = new MockConnector();

  public constructor(private readonly failuresBeforeSuccess: number) {}

  public capabilities(): ReadonlySet<ConnectorCapability> {
    return new Set(["WEBHOOKS"]);
  }

  public async health(): Promise<ConnectorHealth> {
    return { status: "CONNECTED", checkedAt: new Date().toISOString() };
  }

  public async normalize(rawEvent: RawEvent): Promise<CanonicalEvent[]> {
    this.calls += 1;
    if (this.calls <= this.failuresBeforeSuccess) {
      throw new RetryableProcessingError(
        "TEMPORARY_TEST_FAILURE",
        "Temporary connector failure",
      );
    }
    return this.#delegate.normalize(rawEvent);
  }
}

const setup = async (
  connector: Connector = new MockConnector(),
  maxAttempts = 3,
) => {
  const repository = new InMemoryEventRepository();
  const queue = new InMemoryRawEventQueue();
  const traceId = newTraceId();
  const inserted = await repository.insertRawEvent({
    source: "mock",
    sourceAccountId: "account-1",
    externalEventId: "mock-event-1",
    idempotencyKey: "mock-key-1",
    eventTypeHint: "message",
    payload: {
      kind: "message",
      messageId: "mock-123",
      sender: { name: "Jan Kowalski", email: "jan@example.com" },
      text: "Chciałbym dowiedzieć się więcej o Zentrze.",
    },
    sanitizedHeaders: {},
    occurredAt: "2026-09-29T08:00:00.000Z",
    receivedAt: "2026-09-29T08:00:01.000Z",
    traceId,
  });
  await queue.enqueue({
    rawEventId: inserted.rawEvent.id,
    traceId,
  });
  const processor = new EventProcessor(
    repository,
    queue,
    new ConnectorRegistry([connector]),
    noDelay,
    createLogger("silent"),
    { processorName: "test-normalizer", processorVersion: "1", maxAttempts },
  );
  return { repository, queue, processor, rawEvent: inserted.rawEvent, traceId };
};

describe("EventProcessor", () => {
  it("processes a queued raw event", async () => {
    const { processor, queue } = await setup();
    expect(await processor.processNext()).toBe(true);
    expect(await queue.depth()).toBe(0);
  });

  it("normalizes the mock provider payload", async () => {
    const { processor, repository } = await setup();
    await processor.processNext();
    expect(repository.snapshot().canonicalEvents[0]).toMatchObject({
      type: "communication.message_received",
      payload: { messageId: "mock-123" },
    });
  });

  it("persists a canonical event", async () => {
    const { processor, repository } = await setup();
    await processor.processNext();
    expect(repository.snapshot().canonicalEvents).toHaveLength(1);
  });

  it("marks the processing run as succeeded", async () => {
    const { processor, repository } = await setup();
    await processor.processNext();
    expect(repository.snapshot().processingRuns).toMatchObject([
      { attempt: 1, status: "succeeded" },
    ]);
  });

  it("records a retryable failure and keeps work queued", async () => {
    const connector = new FlakyMockConnector(1);
    const { processor, repository, queue } = await setup(connector);
    await processor.processNext();
    expect(repository.snapshot().processingRuns).toMatchObject([
      { attempt: 1, status: "retryable_failed" },
    ]);
    expect(await queue.depth()).toBe(1);
  });

  it("increments the attempt when retrying", async () => {
    const connector = new FlakyMockConnector(1);
    const { processor, repository } = await setup(connector);
    await processor.processNext();
    await processor.processNext();
    expect(
      repository.snapshot().processingRuns.map((run) => run.attempt),
    ).toEqual([1, 2]);
  });

  it("creates a dead letter for a permanent normalization failure", async () => {
    const { repository } = await setup();
    const raw = repository.snapshot().rawEvents[0];
    if (raw === undefined) throw new Error("test fixture missing");
    raw.payload.kind = "unsupported";
    const invalidRepository = new InMemoryEventRepository();
    const inserted = await invalidRepository.insertRawEvent({
      ...raw,
      payload: raw.payload,
    });
    const invalidQueue = new InMemoryRawEventQueue();
    await invalidQueue.enqueue({
      rawEventId: inserted.rawEvent.id,
      traceId: raw.traceId,
    });
    const invalidProcessor = new EventProcessor(
      invalidRepository,
      invalidQueue,
      new ConnectorRegistry([new MockConnector()]),
      noDelay,
      createLogger("silent"),
      {
        processorName: "test-normalizer",
        processorVersion: "1",
        maxAttempts: 3,
      },
    );
    await invalidProcessor.processNext();
    expect(invalidRepository.snapshot().deadLetters).toMatchObject([
      { reason: "MOCK_PAYLOAD_INVALID", attemptCount: 1 },
    ]);
  });

  it("turns an exhausted retry into a permanent failure", async () => {
    const connector = new FlakyMockConnector(10);
    const { processor, repository, queue } = await setup(connector, 2);
    await processor.processNext();
    await processor.processNext();
    expect(repository.snapshot().processingRuns.at(-1)?.status).toBe(
      "permanently_failed",
    );
    expect(repository.snapshot().deadLetters).toHaveLength(1);
    expect(await queue.depth()).toBe(0);
  });

  it("does not duplicate a canonical event when processing the same raw event twice", async () => {
    const { processor, repository, queue, rawEvent, traceId } = await setup();
    await processor.processNext();
    await queue.enqueue({ rawEventId: rawEvent.id, traceId });
    await processor.processNext();
    expect(repository.snapshot().canonicalEvents).toHaveLength(1);
    expect(repository.snapshot().processingRuns).toHaveLength(2);
  });
});
