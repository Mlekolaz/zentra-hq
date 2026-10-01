import { newId, ValidationError } from "@zentra/domain";
import type {
  AuditEntry,
  DeadLetter,
  ProcessingRun,
  RawEvent,
} from "@zentra/domain";
import type { CanonicalEvent } from "@zentra/events";
import type {
  EventListItem,
  EventRepository,
  NewProcessingRun,
  NewRawEvent,
  OverviewSnapshot,
  ProcessingFailure,
  RawEventInsertResult,
} from "./repository.js";

class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  public async run<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryEventRepository implements EventRepository {
  readonly #mutex = new AsyncMutex();
  readonly #rawEvents = new Map<string, RawEvent>();
  readonly #canonicalEvents = new Map<string, CanonicalEvent>();
  readonly #processingRuns = new Map<string, ProcessingRun>();
  readonly #deadLetters = new Map<string, DeadLetter>();
  readonly #auditEntries = new Map<string, AuditEntry>();

  public async insertRawEvent(
    input: NewRawEvent,
  ): Promise<RawEventInsertResult> {
    return this.#mutex.run(() => {
      const events = [...this.#rawEvents.values()];
      const explicitMatch =
        input.idempotencyKey === null
          ? undefined
          : events.find(
              (event) =>
                event.source === input.source &&
                event.sourceAccountId === input.sourceAccountId &&
                event.idempotencyKey === input.idempotencyKey,
            );
      const providerMatch =
        input.externalEventId === null
          ? undefined
          : events.find(
              (event) =>
                event.source === input.source &&
                event.sourceAccountId === input.sourceAccountId &&
                event.externalEventId === input.externalEventId,
            );
      if (
        explicitMatch !== undefined &&
        providerMatch !== undefined &&
        explicitMatch.id !== providerMatch.id
      ) {
        throw new ValidationError(
          "Idempotency identifiers refer to different raw events",
        );
      }
      const duplicate = explicitMatch ?? providerMatch;
      if (duplicate !== undefined) {
        const duplicateReason =
          explicitMatch !== undefined ? "idempotency_key" : "provider_identity";
        return { rawEvent: copy(duplicate), created: false, duplicateReason };
      }
      const rawEvent: RawEvent = {
        ...copy(input),
        id: newId(),
        createdAt: new Date().toISOString(),
      };
      this.#rawEvents.set(rawEvent.id, rawEvent);
      return { rawEvent: copy(rawEvent), created: true, duplicateReason: null };
    });
  }

  public async findRawEvent(id: string): Promise<RawEvent | null> {
    const event = this.#rawEvents.get(id);
    return event === undefined ? null : copy(event);
  }

  public async saveCanonicalEvent(
    event: CanonicalEvent,
  ): Promise<{ created: boolean }> {
    return this.#mutex.run(() => {
      const duplicate = [...this.#canonicalEvents.values()].some(
        (existing) =>
          existing.id === event.id ||
          (existing.rawEventId === event.rawEventId &&
            existing.deduplicationKey === event.deduplicationKey),
      );
      if (duplicate) return { created: false };
      this.#canonicalEvents.set(event.id, copy(event));
      return { created: true };
    });
  }

  public async startProcessingRun(
    input: NewProcessingRun,
  ): Promise<ProcessingRun> {
    const run: ProcessingRun = {
      id: newId(),
      ...input,
      status: "processing",
      startedAt: new Date().toISOString(),
      completedAt: null,
      errorCode: null,
      sanitizedErrorMessage: null,
    };
    this.#processingRuns.set(run.id, copy(run));
    return copy(run);
  }

  public async markProcessingSucceeded(
    runId: string,
    completedAt: string,
  ): Promise<void> {
    const run = this.#processingRuns.get(runId);
    if (run === undefined) return;
    this.#processingRuns.set(runId, {
      ...run,
      status: "succeeded",
      completedAt,
    });
  }

  public async markProcessingFailed(
    runId: string,
    failure: ProcessingFailure,
  ): Promise<void> {
    const run = this.#processingRuns.get(runId);
    if (run === undefined) return;
    this.#processingRuns.set(runId, { ...run, ...failure });
  }

  public async addDeadLetter(
    input: Omit<DeadLetter, "id" | "createdAt">,
  ): Promise<DeadLetter> {
    const deadLetter = {
      ...copy(input),
      id: newId(),
      createdAt: new Date().toISOString(),
    };
    this.#deadLetters.set(deadLetter.id, deadLetter);
    return copy(deadLetter);
  }

  public async addAuditEntry(
    input: Omit<AuditEntry, "id" | "createdAt">,
  ): Promise<AuditEntry> {
    const entry = {
      ...copy(input),
      id: newId(),
      createdAt: new Date().toISOString(),
    };
    this.#auditEntries.set(entry.id, entry);
    return copy(entry);
  }

  public async listEvents(limit: number): Promise<EventListItem[]> {
    return [...this.#canonicalEvents.values()]
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, limit)
      .map((event) => ({
        id: event.id,
        rawEventId: event.rawEventId,
        type: event.type,
        source: event.source,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
        processingStatus: this.#latestStatus(event.rawEventId),
        traceId: event.metadata.traceId,
      }));
  }

  public async getOverview(): Promise<OverviewSnapshot> {
    const today = new Date().toISOString().slice(0, 10);
    const events = await this.listEvents(10);
    const failedProcessing = [...this.#processingRuns.values()].filter(
      (run) =>
        run.status === "retryable_failed" ||
        run.status === "permanently_failed",
    ).length;
    return {
      totalEvents: this.#canonicalEvents.size,
      eventsToday: [...this.#canonicalEvents.values()].filter((event) =>
        event.receivedAt.startsWith(today),
      ).length,
      failedProcessing,
      pendingApprovals: 0,
      recentEvents: events,
    };
  }

  public async healthCheck(): Promise<boolean> {
    return true;
  }

  public snapshot(): {
    rawEvents: RawEvent[];
    canonicalEvents: CanonicalEvent[];
    processingRuns: ProcessingRun[];
    deadLetters: DeadLetter[];
    auditEntries: AuditEntry[];
  } {
    return copy({
      rawEvents: [...this.#rawEvents.values()],
      canonicalEvents: [...this.#canonicalEvents.values()],
      processingRuns: [...this.#processingRuns.values()],
      deadLetters: [...this.#deadLetters.values()],
      auditEntries: [...this.#auditEntries.values()],
    });
  }

  #latestStatus(rawEventId: string): ProcessingRun["status"] {
    return (
      [...this.#processingRuns.values()]
        .filter((run) => run.rawEventId === rawEventId)
        .sort((left, right) => right.attempt - left.attempt)[0]?.status ??
      "queued"
    );
  }
}
