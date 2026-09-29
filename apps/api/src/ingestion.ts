import type { WebhookVerifier } from "@zentra/connectors";
import type { EventRepository } from "@zentra/database";
import type { QueuePort, RawEventQueueMessage } from "@zentra/events";
import { sanitizeHeaders } from "@zentra/observability";
import { z } from "zod";

export const ingestionRequestSchema = z
  .object({
    source: z.string().min(1).max(100),
    sourceAccountId: z.string().min(1).max(255).nullable().optional(),
    externalEventId: z.string().min(1).max(500).nullable().optional(),
    eventTypeHint: z.string().min(1).max(200).nullable().optional(),
    occurredAt: z.iso.datetime({ offset: true }).nullable().optional(),
    idempotencyKey: z.string().min(1).max(500).nullable().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type IngestionRequest = z.infer<typeof ingestionRequestSchema>;

export type IngestionInput = {
  request: IngestionRequest;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  rawBody: Buffer;
  traceId: string;
};

export type IngestionResult = {
  accepted: true;
  duplicate: boolean;
  rawEventId: string;
  traceId: string;
};

export class IngestionService {
  public constructor(
    private readonly repository: EventRepository,
    private readonly queue: QueuePort<RawEventQueueMessage>,
    private readonly verifier: WebhookVerifier,
  ) {}

  public async ingest(input: IngestionInput): Promise<IngestionResult> {
    const normalizedHeaders = Object.fromEntries(
      Object.entries(input.headers).map(([key, value]) => [
        key.toLowerCase(),
        Array.isArray(value) ? value.join(",") : value,
      ]),
    );
    await this.verifier.verify({
      source: input.request.source,
      headers: normalizedHeaders,
      rawBody: input.rawBody,
    });
    const receivedAt = new Date().toISOString();
    const result = await this.repository.insertRawEvent({
      source: input.request.source,
      sourceAccountId: input.request.sourceAccountId ?? null,
      eventTypeHint: input.request.eventTypeHint ?? null,
      externalEventId: input.request.externalEventId ?? null,
      idempotencyKey: input.request.idempotencyKey ?? null,
      payload: structuredClone(input.request.payload),
      sanitizedHeaders: sanitizeHeaders(input.headers),
      occurredAt: input.request.occurredAt ?? null,
      receivedAt,
      traceId: input.traceId,
    });

    if (result.created) {
      await this.queue.enqueue({
        rawEventId: result.rawEvent.id,
        traceId: input.traceId,
        attempt: 1,
      });
      await this.repository.addAuditEntry({
        actorType: "connector",
        actorId: input.request.source,
        action: "ingestion.accepted",
        targetType: "raw_event",
        targetId: result.rawEvent.id,
        metadata: { source: input.request.source },
        traceId: input.traceId,
      });
    } else {
      await this.repository.addAuditEntry({
        actorType: "connector",
        actorId: input.request.source,
        action: "ingestion.duplicate_detected",
        targetType: "raw_event",
        targetId: result.rawEvent.id,
        metadata: { reason: result.duplicateReason },
        traceId: input.traceId,
      });
    }

    return {
      accepted: true,
      duplicate: !result.created,
      rawEventId: result.rawEvent.id,
      traceId: input.traceId,
    };
  }
}
