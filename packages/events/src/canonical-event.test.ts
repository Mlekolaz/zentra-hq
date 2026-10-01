import { describe, expect, it } from "vitest";
import {
  canonicalEventSchema,
  createCanonicalEventId,
  parseCanonicalEvent,
  validateCanonicalEvent,
} from "./canonical-event.js";

const validEvent = () => ({
  id: "10000000-0000-4000-8000-000000000001",
  rawEventId: "10000000-0000-4000-8000-000000000002",
  deduplicationKey: "message:message-1",
  type: "communication.message_received",
  schemaVersion: 1,
  source: "mock",
  sourceAccountId: "account-1",
  externalEventId: "message-1",
  occurredAt: "2026-09-29T08:00:00.000Z",
  receivedAt: "2026-09-29T08:00:01.000Z",
  actor: null,
  subject: null,
  entityRefs: [],
  correlationId: null,
  causationId: null,
  payload: { text: "hello" },
  metadata: { traceId: "10000000-0000-4000-8000-000000000003" },
});

describe("CanonicalEvent", () => {
  it("accepts a valid canonical event", () => {
    expect(parseCanonicalEvent(validEvent())).toMatchObject({
      type: "communication.message_received",
      schemaVersion: 1,
    });
  });

  it("rejects a malformed canonical event", () => {
    expect(validateCanonicalEvent({ ...validEvent(), metadata: {} })).toBe(
      false,
    );
  });

  it("rejects an invalid event type", () => {
    expect(
      canonicalEventSchema.safeParse({ ...validEvent(), type: "send-message" })
        .success,
    ).toBe(false);
  });

  it("rejects unsupported schema versions predictably", () => {
    expect(() =>
      parseCanonicalEvent({ ...validEvent(), schemaVersion: 2 }),
    ).toThrow("Canonical event schema version is unsupported");
  });

  it("derives a stable canonical ID from raw identity and deduplication key", () => {
    const first = createCanonicalEventId(
      validEvent().rawEventId,
      validEvent().deduplicationKey,
      1,
    );
    expect(first).toBe(
      createCanonicalEventId(
        validEvent().rawEventId,
        validEvent().deduplicationKey,
        1,
      ),
    );
    expect(first).not.toBe(
      createCanonicalEventId(validEvent().rawEventId, "message:other", 1),
    );
  });
});
