import type { RawEvent } from "@zentra/domain";
import { describe, expect, it } from "vitest";
import { ZentraConnector } from "./zentra-connector.js";

const sourceEvent = {
  eventId: "10000000-0000-4000-8000-000000000010",
  type: "product.company_created",
  schemaVersion: 1,
  occurredAt: "2026-10-01T12:00:00.000Z",
  entity: { type: "company", id: "10000000-0000-4000-8000-000000000020" },
  actor: { type: "user", id: "10000000-0000-4000-8000-000000000030" },
  data: {
    companyId: "10000000-0000-4000-8000-000000000020",
    createdByUserId: "10000000-0000-4000-8000-000000000030",
  },
} as const;

const rawEvent: RawEvent = {
  id: "10000000-0000-4000-8000-000000000001",
  source: "zentra",
  sourceAccountId: null,
  eventTypeHint: sourceEvent.type,
  externalEventId: sourceEvent.eventId,
  idempotencyKey: null,
  payload: sourceEvent,
  sanitizedHeaders: { "content-type": "application/json" },
  occurredAt: sourceEvent.occurredAt,
  receivedAt: "2026-10-01T12:00:01.000Z",
  traceId: "10000000-0000-4000-8000-000000000002",
  createdAt: "2026-10-01T12:00:01.000Z",
};

describe("ZentraConnector", () => {
  it("normalizes company creation into a stable minimal canonical event", async () => {
    const connector = new ZentraConnector(true);
    const first = await connector.normalize(rawEvent);
    const replay = await connector.normalize(structuredClone(rawEvent));
    expect(first).toEqual(replay);
    expect(first[0]).toMatchObject({
      type: "product.company_created",
      source: "zentra",
      externalEventId: sourceEvent.eventId,
      deduplicationKey: `source-event:${sourceEvent.eventId}`,
      subject: { type: "company", id: sourceEvent.entity.id },
      actor: { type: "user", id: sourceEvent.actor.id },
      payload: sourceEvent.data,
    });
  });

  it("rejects unsupported semantic types as a permanent processing failure", async () => {
    const connector = new ZentraConnector(true);
    await expect(
      connector.normalize({
        ...rawEvent,
        eventTypeHint: "product.unknown_thing",
        payload: { ...sourceEvent, type: "product.unknown_thing" },
      }),
    ).rejects.toMatchObject({
      code: "ZENTRA_EVENT_TYPE_UNSUPPORTED",
      retryable: false,
    });
  });
});
