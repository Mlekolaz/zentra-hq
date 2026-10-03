import { resolve } from "node:path";
import {
  ConnectorRegistry,
  MockConnector,
  ZentraConnector,
  type Connector,
} from "@zentra/connectors";
import {
  PostgresEventRepository,
  PostgresQueue,
  postgresPoolConfig,
} from "@zentra/database";
import { createLogger, safeErrorSummary } from "@zentra/observability";
import { loadConfig } from "@zentra/shared";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { EventProcessor } from "./event-processor.js";
import { ExponentialBackoffPolicy } from "./retry-policy.js";
import { WorkerRuntime } from "./runtime.js";

if (process.env.NODE_ENV !== "production") {
  loadDotenv({
    path: resolve(import.meta.dirname, "../../../.env"),
    quiet: true,
  });
}

const config = loadConfig(process.env);
if (config.RUNTIME_MODE !== "postgres" || config.DATABASE_URL === undefined) {
  throw new Error(
    "The standalone worker requires RUNTIME_MODE=postgres and DATABASE_URL",
  );
}
const logger = createLogger(config.LOG_LEVEL).child({
  service: "zentra-worker",
});
const pool = new pg.Pool(postgresPoolConfig(config, 5));
const repository = new PostgresEventRepository(pool);
const queue = new PostgresQueue(pool, {
  leaseTimeoutMs: 5 * 60_000,
  maxDeliveries: config.WORKER_MAX_ATTEMPTS,
  processorName: "canonical-normalizer",
});
const connectorList: Connector[] = [
  new ZentraConnector(config.ZENTRA_WEBHOOK_SECRET !== undefined),
];
if (config.NODE_ENV !== "production") connectorList.push(new MockConnector());
const processor = new EventProcessor(
  repository,
  queue,
  new ConnectorRegistry(connectorList),
  new ExponentialBackoffPolicy(),
  logger,
  {
    processorName: "canonical-normalizer",
    processorVersion: "1.0.0",
    maxAttempts: config.WORKER_MAX_ATTEMPTS,
  },
);
const runtime = new WorkerRuntime(
  processor,
  logger,
  config.WORKER_POLL_MS,
  repository,
);
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
