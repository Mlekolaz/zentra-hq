import { resolve } from "node:path";
import { ConnectorRegistry, MockConnector } from "@zentra/connectors";
import { PostgresEventRepository, PostgresQueue } from "@zentra/database";
import type { RawEventQueueMessage } from "@zentra/events";
import { createLogger, safeErrorSummary } from "@zentra/observability";
import { loadConfig } from "@zentra/shared";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { z } from "zod";
import { EventProcessor } from "./event-processor.js";
import { ExponentialBackoffPolicy } from "./retry-policy.js";
import { WorkerRuntime } from "./runtime.js";

loadDotenv({
  path: resolve(import.meta.dirname, "../../../.env"),
  quiet: true,
});

const queueMessageSchema = z.object({
  rawEventId: z.uuid(),
  traceId: z.uuid(),
  attempt: z.number().int().positive(),
});

const config = loadConfig(process.env);
if (config.RUNTIME_MODE !== "postgres" || config.DATABASE_URL === undefined) {
  throw new Error(
    "The standalone worker requires RUNTIME_MODE=postgres and DATABASE_URL",
  );
}
const logger = createLogger(config.LOG_LEVEL).child({
  service: "zentra-worker",
});
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });
const repository = new PostgresEventRepository(pool);
const queue = new PostgresQueue<RawEventQueueMessage>(pool, (input) =>
  queueMessageSchema.parse(input),
);
const processor = new EventProcessor(
  repository,
  queue,
  new ConnectorRegistry([new MockConnector()]),
  new ExponentialBackoffPolicy(),
  logger,
  {
    processorName: "canonical-normalizer",
    processorVersion: "1.0.0",
    maxAttempts: config.WORKER_MAX_ATTEMPTS,
  },
);
const runtime = new WorkerRuntime(processor, logger, config.WORKER_POLL_MS);
const abortController = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => abortController.abort());
}
const heartbeat = setInterval(
  () => logger.info({ health: runtime.health() }, "worker heartbeat"),
  30_000,
);

try {
  await runtime.start(abortController.signal);
} catch (error: unknown) {
  logger.fatal({ error: safeErrorSummary(error) }, "worker failed");
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  await pool.end();
}
