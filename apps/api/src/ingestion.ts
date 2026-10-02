import type { WebhookVerifierRegistry } from "@zentra/connectors";
import type { EventIngestionPort, QueueDisposition } from "@zentra/database";
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
export type VerifiedIngestionRequest = Omit<IngestionRequest, "source">;

export type IngestionInput = {
  trustedSource: string;
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
  queueDisposition: QueueDisposition;
};

export type WebhookVerificationRequest = {
  trustedSource: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  rawBody: Buffer;
};

export type VerifiedIngestionInput = {
  trustedSource: string;
  request: VerifiedIngestionRequest;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  traceId: string;
};

export class IngestionService {
  public constructor(
    private readonly ingestion: EventIngestionPort,
    private readonly verifiers: WebhookVerifierRegistry,
  ) {}

  public async verify(input: WebhookVerificationRequest): Promise<void> {
    const normalizedHeaders = Object.fromEntries(
      Object.entries(input.headers).map(([key, value]) => [
        key.toLowerCase(),
        Array.isArray(value) ? value.join(",") : value,
      ]),
    );
    await this.verifiers.verify(input.trustedSource, {
      headers: normalizedHeaders,
      rawBody: input.rawBody,
    });
  }

  public async ingest(input: IngestionInput): Promise<IngestionResult> {
    await this.verify(input);
    return this.ingestVerified(input);
  }

  public async ingestVerified(
    input: VerifiedIngestionInput,
  ): Promise<IngestionResult> {
    const receivedAt = new Date().toISOString();
    const result = await this.ingestion.ingestEventAtomically({
      source: input.trustedSource,
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

    return {
      accepted: true,
      duplicate: !result.created,
      rawEventId: result.rawEvent.id,
      traceId: input.traceId,
      queueDisposition: result.queueDisposition,
    };
  }
}
