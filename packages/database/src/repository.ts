import type {
  AuditEntry,
  DeadLetter,
  ProcessingRun,
  RawEvent,
  RawEventId,
  TraceId,
} from "@zentra/domain";
import type { CanonicalEvent } from "@zentra/events";

export type NewRawEvent = Omit<RawEvent, "id" | "createdAt">;

export type RawEventInsertResult = {
  rawEvent: RawEvent;
  created: boolean;
  duplicateReason: "idempotency_key" | "provider_identity" | null;
};

export type NewProcessingRun = {
  rawEventId: RawEventId;
  processorName: string;
  processorVersion: string;
  attempt: number;
  traceId: TraceId;
};

export type ProcessingFailure = {
  status: "retryable_failed" | "permanently_failed";
  errorCode: string;
  sanitizedErrorMessage: string;
  completedAt: string;
};

export type EventListItem = {
  id: string;
  rawEventId: RawEventId;
  type: string;
  source: string;
  occurredAt: string;
  receivedAt: string;
  processingStatus: ProcessingRun["status"];
  traceId: TraceId;
};

export type OverviewSnapshot = {
  totalEvents: number;
  eventsToday: number;
  failedProcessing: number;
  pendingApprovals: number;
  recentEvents: EventListItem[];
};

export interface EventRepository {
  insertRawEvent(input: NewRawEvent): Promise<RawEventInsertResult>;
  findRawEvent(id: RawEventId): Promise<RawEvent | null>;
  saveCanonicalEvent(event: CanonicalEvent): Promise<{ created: boolean }>;
  startProcessingRun(input: NewProcessingRun): Promise<ProcessingRun>;
  markProcessingSucceeded(runId: string, completedAt: string): Promise<void>;
  markProcessingFailed(
    runId: string,
    failure: ProcessingFailure,
  ): Promise<void>;
  addDeadLetter(
    input: Omit<DeadLetter, "id" | "createdAt">,
  ): Promise<DeadLetter>;
  addAuditEntry(
    input: Omit<AuditEntry, "id" | "createdAt">,
  ): Promise<AuditEntry>;
  listEvents(limit: number): Promise<EventListItem[]>;
  getOverview(): Promise<OverviewSnapshot>;
  healthCheck(): Promise<boolean>;
}
