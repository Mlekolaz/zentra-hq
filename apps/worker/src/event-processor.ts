import type { ConnectorRegistry } from "@zentra/connectors";
import type { EventRepository } from "@zentra/database";
import { PermanentProcessingError, toAppError } from "@zentra/domain";
import type { RawEventQueuePort } from "@zentra/events";
import { parseCanonicalEvent } from "@zentra/events";
import { safeErrorSummary } from "@zentra/observability";
import type { Logger } from "pino";
import type { RetryPolicy } from "./retry-policy.js";

export type EventProcessorOptions = {
  processorName: string;
  processorVersion: string;
  maxAttempts: number;
};

export class EventProcessor {
  public constructor(
    private readonly repository: EventRepository,
    private readonly queue: RawEventQueuePort,
    private readonly connectors: ConnectorRegistry,
    private readonly retryPolicy: RetryPolicy,
    private readonly logger: Logger,
    private readonly options: EventProcessorOptions,
  ) {}

  public async processNext(): Promise<boolean> {
    const delivery = await this.queue.receive();
    if (delivery === null) return false;
    const { message } = delivery;
    const lease = {
      queueItemId: delivery.queueItemId,
      leaseToken: delivery.leaseToken,
    };
    const log = this.logger.child({
      traceId: message.traceId,
      rawEventId: message.rawEventId,
      attempt: delivery.deliveryCount,
    });
    let runId: string | null = null;
    try {
      const rawEvent = await this.repository.findRawEvent(message.rawEventId);
      if (rawEvent === null) {
        throw new PermanentProcessingError(
          "RAW_EVENT_NOT_FOUND",
          "Raw event does not exist",
        );
      }
      const run = await this.repository.startProcessingRun({
        rawEventId: rawEvent.id,
        processorName: this.options.processorName,
        processorVersion: this.options.processorVersion,
        attempt: delivery.deliveryCount,
        traceId: message.traceId,
      });
      runId = run.id;
      const connector = this.connectors.get(rawEvent.source);
      if (connector === undefined) {
        throw new PermanentProcessingError(
          "CONNECTOR_NOT_FOUND",
          "No connector can normalize this source",
        );
      }
      const events = await connector.normalize(rawEvent);
      if (events.length === 0) {
        throw new PermanentProcessingError(
          "NORMALIZATION_EMPTY",
          "Connector produced no canonical events",
        );
      }
      const savedIds: string[] = [];
      for (const candidate of events) {
        const event = parseCanonicalEvent(candidate);
        await this.repository.saveCanonicalEvent(event);
        savedIds.push(event.id);
      }
      await this.repository.addAuditEntry({
        actorType: "system",
        actorId: this.options.processorName,
        action: "processing.succeeded",
        targetType: "raw_event",
        targetId: rawEvent.id,
        metadata: {
          canonicalEventIds: savedIds,
          attempt: delivery.deliveryCount,
        },
        traceId: message.traceId,
      });
      await this.repository.markProcessingSucceeded(
        run.id,
        new Date().toISOString(),
      );
      const ackResult = await this.queue.ack(lease);
      if (ackResult === "stale")
        log.warn("processing completed after its queue lease expired");
      log.info(
        { canonicalEventIds: savedIds, source: rawEvent.source },
        "event processing succeeded",
      );
      return true;
    } catch (error: unknown) {
      const appError = toAppError(error);
      const summary = safeErrorSummary(appError);
      const canRetry =
        appError.retryable && delivery.deliveryCount < this.options.maxAttempts;
      if (runId !== null) {
        await this.repository.markProcessingFailed(runId, {
          status: canRetry ? "retryable_failed" : "permanently_failed",
          errorCode: summary.code,
          sanitizedErrorMessage: summary.message,
          completedAt: new Date().toISOString(),
        });
      }
      if (canRetry) {
        const nextAttempt = delivery.deliveryCount + 1;
        const delayMs = this.retryPolicy.delayMs(nextAttempt);
        const retryResult = await this.queue.retry(lease, message, delayMs);
        log.warn(
          {
            errorCode: summary.code,
            nextAttempt,
            delayMs,
            queueMutation: retryResult,
          },
          "event processing scheduled for retry",
        );
      } else {
        if (summary.code === "RAW_EVENT_NOT_FOUND") {
          await this.repository.addAuditEntry({
            actorType: "system",
            actorId: this.options.processorName,
            action: "processing.orphaned_queue_message",
            targetType: "raw_event",
            targetId: message.rawEventId,
            metadata: { errorCode: summary.code },
            traceId: message.traceId,
          });
          const ackResult = await this.queue.ack(lease);
          log.error(
            { errorCode: summary.code, queueMutation: ackResult },
            "orphaned queue message discarded",
          );
          return true;
        }
        await this.repository.addDeadLetter({
          rawEventId: message.rawEventId,
          processorName: this.options.processorName,
          reason: summary.code,
          attemptCount: delivery.deliveryCount,
          traceId: message.traceId,
        });
        await this.repository.addAuditEntry({
          actorType: "system",
          actorId: this.options.processorName,
          action: "processing.permanently_failed",
          targetType: "raw_event",
          targetId: message.rawEventId,
          metadata: {
            errorCode: summary.code,
            attempt: delivery.deliveryCount,
          },
          traceId: message.traceId,
        });
        const ackResult = await this.queue.ack(lease);
        log.error(
          { errorCode: summary.code, queueMutation: ackResult },
          "event processing permanently failed",
        );
      }
      return true;
    }
  }
}
