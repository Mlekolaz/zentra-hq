import { PermanentProcessingError } from "@zentra/domain";
import type { RawEvent } from "@zentra/domain";
import { createCanonicalEventId, parseCanonicalEvent } from "@zentra/events";
import type { CanonicalEvent } from "@zentra/events";
import { z } from "zod";
import type {
  Connector,
  ConnectorCapability,
  ConnectorHealth,
} from "./connector.js";

const mockPayloadSchema = z.object({
  kind: z.literal("message"),
  messageId: z.string().min(1),
  sender: z.object({
    name: z.string().min(1),
    email: z.email(),
  }),
  text: z.string().min(1),
});

export class MockConnector implements Connector {
  public readonly provider = "mock";
  readonly #enabled: boolean;

  public constructor(enabled = true) {
    this.#enabled = enabled;
  }

  public capabilities(): ReadonlySet<ConnectorCapability> {
    return new Set(["WEBHOOKS", "READ_MESSAGES"]);
  }

  public async health(): Promise<ConnectorHealth> {
    return {
      status: this.#enabled ? "CONNECTED" : "DISABLED",
      checkedAt: new Date().toISOString(),
      message: "Development-only connector",
    };
  }

  public async normalize(rawEvent: RawEvent): Promise<CanonicalEvent[]> {
    if (!this.#enabled) {
      throw new PermanentProcessingError(
        "CONNECTOR_DISABLED",
        "Connector is disabled",
      );
    }
    const payload = mockPayloadSchema.safeParse(rawEvent.payload);
    if (!payload.success) {
      throw new PermanentProcessingError(
        "MOCK_PAYLOAD_INVALID",
        "Mock event payload is invalid",
        {
          details: { issueCount: payload.error.issues.length },
        },
      );
    }
    const occurredAt = rawEvent.occurredAt ?? rawEvent.receivedAt;
    const deduplicationKey = `message:${payload.data.messageId}`;
    return [
      parseCanonicalEvent({
        id: createCanonicalEventId(rawEvent.id, deduplicationKey, 1),
        rawEventId: rawEvent.id,
        deduplicationKey,
        type: "communication.message_received",
        schemaVersion: 1,
        source: rawEvent.source,
        sourceAccountId: rawEvent.sourceAccountId,
        externalEventId: rawEvent.externalEventId ?? payload.data.messageId,
        occurredAt,
        receivedAt: rawEvent.receivedAt,
        actor: {
          type: "email_identity",
          id: payload.data.sender.email.toLowerCase(),
          displayName: payload.data.sender.name,
        },
        subject: null,
        entityRefs: [
          {
            type: "email_identity",
            id: payload.data.sender.email.toLowerCase(),
          },
        ],
        correlationId: null,
        causationId: rawEvent.id,
        payload: {
          messageId: payload.data.messageId,
          text: payload.data.text,
          sender: payload.data.sender,
        },
        metadata: {
          traceId: rawEvent.traceId,
          sensitivity: "internal",
          connectorVersion: "1.0.0",
        },
      }),
    ];
  }
}
