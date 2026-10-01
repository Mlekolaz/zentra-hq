import type { Logger } from "pino";
import { safeErrorSummary } from "@zentra/observability";
import type { EventProcessor } from "./event-processor.js";

export type WorkerHealth = {
  running: boolean;
  ready: boolean;
  lastPollAt: string | null;
  lastErrorCode: string | null;
};

export interface RawEventReconciler {
  reconcileUndispatchedRawEvents(options: {
    olderThanMs: number;
    limit: number;
  }): Promise<number>;
}

export class WorkerRuntime {
  #running = false;
  #lastPollAt: string | null = null;
  #lastErrorCode: string | null = null;
  #nextReconciliationAt = 0;

  public constructor(
    private readonly processor: EventProcessor,
    private readonly logger: Logger,
    private readonly pollMs: number,
    private readonly reconciler?: RawEventReconciler,
  ) {}

  public health(): WorkerHealth {
    return {
      running: this.#running,
      ready: this.#running && this.#lastErrorCode === null,
      lastPollAt: this.#lastPollAt,
      lastErrorCode: this.#lastErrorCode,
    };
  }

  public async start(signal: AbortSignal): Promise<void> {
    this.#running = true;
    this.logger.info({ pollMs: this.pollMs }, "worker started");
    await this.#reconcile(true);
    while (!signal.aborted) {
      this.#lastPollAt = new Date().toISOString();
      try {
        await this.#reconcile(false);
        const processed = await this.processor.processNext();
        this.#lastErrorCode = null;
        if (!processed) await this.#wait(signal);
      } catch (error: unknown) {
        this.#lastErrorCode = "WORKER_LOOP_ERROR";
        this.logger.error(
          { error: safeErrorSummary(error) },
          "worker loop failed",
        );
        await this.#wait(signal);
      }
    }
    this.#running = false;
    this.logger.info("worker stopped");
  }

  async #reconcile(force: boolean): Promise<void> {
    if (
      this.reconciler === undefined ||
      (!force && Date.now() < this.#nextReconciliationAt)
    )
      return;
    this.#nextReconciliationAt = Date.now() + 60_000;
    try {
      const recovered = await this.reconciler.reconcileUndispatchedRawEvents({
        olderThanMs: 2 * 60_000,
        limit: 100,
      });
      if (recovered > 0)
        this.logger.warn(
          { recovered },
          "reconciler restored undispatched raw events",
        );
    } catch (error: unknown) {
      this.logger.error(
        { error: safeErrorSummary(error) },
        "raw event reconciliation failed",
      );
    }
  }

  async #wait(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, this.pollMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
    });
  }
}
