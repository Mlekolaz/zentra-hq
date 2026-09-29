import { z } from "zod";
import type { RawEventId, TraceId } from "./ids.js";

export const jsonObjectSchema = z.record(z.string(), z.unknown());

export const rawEventSchema = z.object({
  id: z.uuid(),
  source: z.string().min(1).max(100),
  sourceAccountId: z.string().min(1).max(255).nullable(),
  eventTypeHint: z.string().min(1).max(200).nullable(),
  externalEventId: z.string().min(1).max(500).nullable(),
  idempotencyKey: z.string().min(1).max(500).nullable(),
  payload: jsonObjectSchema,
  sanitizedHeaders: z.record(z.string(), z.string()),
  occurredAt: z.iso.datetime({ offset: true }).nullable(),
  receivedAt: z.iso.datetime({ offset: true }),
  traceId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type RawEvent = Omit<
  z.infer<typeof rawEventSchema>,
  "id" | "traceId"
> & {
  id: RawEventId;
  traceId: TraceId;
};

export const processingStatusSchema = z.enum([
  "queued",
  "processing",
  "succeeded",
  "retryable_failed",
  "permanently_failed",
]);
export type ProcessingStatus = z.infer<typeof processingStatusSchema>;

export type ProcessingRun = {
  id: string;
  rawEventId: RawEventId;
  processorName: string;
  processorVersion: string;
  attempt: number;
  status: ProcessingStatus;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  sanitizedErrorMessage: string | null;
  traceId: TraceId;
};

export type DeadLetter = {
  id: string;
  rawEventId: RawEventId;
  processorName: string;
  reason: string;
  attemptCount: number;
  traceId: TraceId;
  createdAt: string;
};
