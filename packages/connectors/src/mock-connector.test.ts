import type { RawEvent } from "@zentra/domain";
import { describe, expect, it } from "vitest";
import { MockConnector } from "./mock-connector.js";

const rawEvent: RawEvent = {
  id: "10000000-0000-4000-8000-000000000001",
  source: "mock",
  sourceAccountId: null,
  eventTypeHint: "message",
  externalEventId: "provider-event-1",
  idempotencyKey: null,
  payload: {
    kind: "message",
    messageId: "message-1",
    sender: { name: "Ada", email: "ada@example.com" },
    text: "Hello",
  },
  sanitizedHeaders: {},
  occurredAt: "2026-09-29T08:00:00.000Z",
  receivedAt: "2026-09-29T08:00:01.000Z",
  traceId: "10000000-0000-4000-8000-000000000002",
  createdAt: "2026-09-29T08:00:01.000Z",
};

describe("MockConnector", () => {
  it("emits a stable canonical identity and deduplication key", async () => {
    const connector = new MockConnector();
    const first = await connector.normalize(rawEvent);
    const second = await connector.normalize(structuredClone(rawEvent));
    expect(first[0]).toMatchObject({
      id: second[0]?.id,
      deduplicationKey: "message:message-1",
    });
  });
});
