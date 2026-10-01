import type { RawEventId } from "@zentra/domain";
import type { InMemoryRawEventQueue } from "@zentra/events";
import type {
  AtomicIngestionResult,
  EventIngestionPort,
  NewRawEvent,
  ReconcileOptions,
} from "./repository.js";
import type { InMemoryEventRepository } from "./in-memory-repository.js";

class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  public async run<T>(operation: () => Promise<T>): Promise<T> {
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

export class InMemoryEventIngestion implements EventIngestionPort {
  readonly #mutex = new AsyncMutex();

  public constructor(
    private readonly repository: InMemoryEventRepository,
    private readonly queue: InMemoryRawEventQueue,
  ) {}

  public async ingestEventAtomically(
    input: NewRawEvent,
  ): Promise<AtomicIngestionResult> {
    return this.#mutex.run(async () => {
      const inserted = await this.repository.insertRawEvent(input);
      let queueDisposition: AtomicIngestionResult["queueDisposition"];
      if (inserted.created) {
        await this.#enqueue(inserted.rawEvent.id, inserted.rawEvent.traceId);
        queueDisposition = "enqueued";
      } else {
        const snapshot = this.repository.snapshot();
        const hasCanonical = snapshot.canonicalEvents.some(
          (event) => event.rawEventId === inserted.rawEvent.id,
        );
        const hasSuccess = snapshot.processingRuns.some(
          (run) =>
            run.rawEventId === inserted.rawEvent.id &&
            run.status === "succeeded",
        );
        const hasDeadLetter = snapshot.deadLetters.some(
          (deadLetter) => deadLetter.rawEventId === inserted.rawEvent.id,
        );
        if (hasCanonical || hasSuccess) {
          queueDisposition = "already_processed";
        } else if (hasDeadLetter) {
          queueDisposition = "permanently_failed";
        } else if (await this.queue.hasActive(inserted.rawEvent.id)) {
          queueDisposition = "already_queued";
        } else {
          await this.#enqueue(inserted.rawEvent.id, inserted.rawEvent.traceId);
          queueDisposition = "recovered";
        }
      }
      await this.repository.addAuditEntry({
        actorType: "connector",
        actorId: input.source,
        action: inserted.created
          ? "ingestion.accepted"
          : "ingestion.duplicate_detected",
        targetType: "raw_event",
        targetId: inserted.rawEvent.id,
        metadata: {
          source: input.source,
          duplicateReason: inserted.duplicateReason,
          queueDisposition,
        },
        traceId: input.traceId,
      });
      return { ...inserted, queueDisposition };
    });
  }

  public async reconcileUndispatchedRawEvents(
    options: ReconcileOptions,
  ): Promise<number> {
    return this.#mutex.run(async () => {
      const snapshot = this.repository.snapshot();
      const cutoff = Date.now() - Math.max(0, options.olderThanMs);
      let recovered = 0;
      for (const rawEvent of snapshot.rawEvents
        .filter((event) => new Date(event.createdAt).getTime() < cutoff)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
        if (recovered >= options.limit) break;
        const completed = snapshot.canonicalEvents.some(
          (event) => event.rawEventId === rawEvent.id,
        );
        const succeeded = snapshot.processingRuns.some(
          (run) => run.rawEventId === rawEvent.id && run.status === "succeeded",
        );
        const permanentlyFailed = snapshot.deadLetters.some(
          (deadLetter) => deadLetter.rawEventId === rawEvent.id,
        );
        if (
          completed ||
          succeeded ||
          permanentlyFailed ||
          (await this.queue.hasActive(rawEvent.id))
        ) {
          continue;
        }
        await this.#enqueue(rawEvent.id, rawEvent.traceId);
        await this.repository.addAuditEntry({
          actorType: "system",
          actorId: "raw-event-reconciler",
          action: "ingestion.queue_recovered",
          targetType: "raw_event",
          targetId: rawEvent.id,
          metadata: {},
          traceId: rawEvent.traceId,
        });
        recovered += 1;
      }
      return recovered;
    });
  }

  async #enqueue(rawEventId: RawEventId, traceId: string): Promise<void> {
    await this.queue.enqueue({ rawEventId, traceId });
  }
}
