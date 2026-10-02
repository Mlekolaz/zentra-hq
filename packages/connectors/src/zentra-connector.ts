import { PermanentProcessingError } from "@zentra/domain";
import type { RawEvent } from "@zentra/domain";
import { createCanonicalEventId, parseCanonicalEvent } from "@zentra/events";
import type { CanonicalEvent } from "@zentra/events";
import type {
  Connector,
  ConnectorCapability,
  ConnectorHealth,
} from "./connector.js";
import {
  zentraCompanyCreatedEventSchema,
  zentraEventEnvelopeSchema,
} from "./zentra-event.js";

export class ZentraConnector implements Connector {
  public readonly provider = "zentra";

  public constructor(private readonly configured: boolean) {}

  public capabilities(): ReadonlySet<ConnectorCapability> {
    return new Set(["WEBHOOKS"]);
  }

  public async health(): Promise<ConnectorHealth> {
    return {
      status: this.configured ? "CONNECTED" : "DISABLED",
      checkedAt: new Date().toISOString(),
      message: this.configured ? "Configured" : "Not configured",
    };
  }

  public async normalize(rawEvent: RawEvent): Promise<CanonicalEvent[]> {
    const envelope = zentraEventEnvelopeSchema.safeParse(rawEvent.payload);
    if (!envelope.success) {
      throw new PermanentProcessingError(
        "ZENTRA_PAYLOAD_INVALID",
        "Zentra event payload is invalid",
      );
    }
    if (envelope.data.type !== "product.company_created") {
      throw new PermanentProcessingError(
        "ZENTRA_EVENT_TYPE_UNSUPPORTED",
        "Zentra event type is not supported",
        { details: { eventType: envelope.data.type } },
      );
    }
    const event = zentraCompanyCreatedEventSchema.safeParse(rawEvent.payload);
    if (!event.success) {
      throw new PermanentProcessingError(
        "ZENTRA_PAYLOAD_INVALID",
        "Zentra event payload is invalid",
      );
    }

    const deduplicationKey = `source-event:${event.data.eventId}`;
    return [
      parseCanonicalEvent({
        id: createCanonicalEventId(rawEvent.id, deduplicationKey, 1),
        rawEventId: rawEvent.id,
        deduplicationKey,
        type: event.data.type,
        schemaVersion: 1,
        source: "zentra",
        sourceAccountId: null,
        externalEventId: event.data.eventId,
        occurredAt: event.data.occurredAt,
        receivedAt: rawEvent.receivedAt,
        actor:
          event.data.actor === undefined
            ? null
            : { type: "user", id: event.data.actor.id },
        subject: { type: "company", id: event.data.entity.id },
        entityRefs: [
          { type: "company", id: event.data.data.companyId },
          { type: "user", id: event.data.data.createdByUserId },
        ],
        correlationId: null,
        causationId: rawEvent.id,
        payload: {
          companyId: event.data.data.companyId,
          createdByUserId: event.data.data.createdByUserId,
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
