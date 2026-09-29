import {
  ConnectorRegistry,
  DevelopmentWebhookVerifier,
  MockConnector,
  type WebhookVerifier,
} from "@zentra/connectors";
import {
  InMemoryEventRepository,
  PostgresEventRepository,
  PostgresQueue,
  type EventRepository,
} from "@zentra/database";
import { ConfigurationError } from "@zentra/domain";
import { InMemoryQueue } from "@zentra/events";
import type { QueuePort, RawEventQueueMessage } from "@zentra/events";
import { createLogger } from "@zentra/observability";
import type { AppConfig } from "@zentra/shared";
import { DevelopmentIdentityProvider } from "@zentra/shared";
import {
  EventProcessor,
  ExponentialBackoffPolicy,
  WorkerRuntime,
} from "@zentra/worker";
import pg from "pg";
import { z } from "zod";

const queueMessageSchema = z.object({
  rawEventId: z.uuid(),
  traceId: z.uuid(),
  attempt: z.number().int().positive(),
});

export type Kernel = {
  repository: EventRepository;
  queue: QueuePort<RawEventQueueMessage>;
  connectors: ConnectorRegistry;
  verifier: WebhookVerifier;
  identityProvider: DevelopmentIdentityProvider;
  workerRuntime: WorkerRuntime | null;
  logger: ReturnType<typeof createLogger>;
  close(): Promise<void>;
};

export const createKernel = (config: AppConfig): Kernel => {
  const logger = createLogger(config.LOG_LEVEL).child({
    service: "zentra-api",
    runtimeMode: config.RUNTIME_MODE,
  });
  const connectors = new ConnectorRegistry([new MockConnector()]);
  if (config.WEBHOOK_VERIFIER !== "development") {
    throw new ConfigurationError(
      "No production webhook verifier is configured in M0",
    );
  }
  const verifier = new DevelopmentWebhookVerifier(
    config.WEBHOOK_DEV_SECRET,
    config.NODE_ENV,
  );
  const identityProvider = new DevelopmentIdentityProvider(config.NODE_ENV);
  let repository: EventRepository;
  let queue: QueuePort<RawEventQueueMessage>;
  let closeStorage = async (): Promise<void> => undefined;

  if (config.RUNTIME_MODE === "postgres") {
    if (config.DATABASE_URL === undefined)
      throw new ConfigurationError("DATABASE_URL is required");
    const pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
    });
    repository = new PostgresEventRepository(pool);
    queue = new PostgresQueue(pool, (input) => queueMessageSchema.parse(input));
    closeStorage = async () => pool.end();
  } else {
    repository = new InMemoryEventRepository();
    queue = new InMemoryQueue();
  }

  const workerRuntime = config.EMBEDDED_WORKER
    ? new WorkerRuntime(
        new EventProcessor(
          repository,
          queue,
          connectors,
          new ExponentialBackoffPolicy(),
          logger,
          {
            processorName: "canonical-normalizer",
            processorVersion: "1.0.0",
            maxAttempts: config.WORKER_MAX_ATTEMPTS,
          },
        ),
        logger,
        config.WORKER_POLL_MS,
      )
    : null;

  return {
    repository,
    queue,
    connectors,
    verifier,
    identityProvider,
    workerRuntime,
    logger,
    close: closeStorage,
  };
};
