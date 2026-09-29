import type { Logger } from "pino";
import { safeErrorSummary } from "@zentra/observability";
import type { EventProcessor } from "./event-processor.js";

export type WorkerHealth = {
  running: boolean;
  ready: boolean;
  lastPollAt: string | null;
  lastErrorCode: string | null;
};

export class WorkerRuntime {
  #running = false;
  #lastPollAt: string | null = null;
  #lastErrorCode: string | null = null;

  public constructor(
    private readonly processor: EventProcessor,
    private readonly logger: Logger,
    private readonly pollMs: number,
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
    while (!signal.aborted) {
      this.#lastPollAt = new Date().toISOString();
      try {
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
