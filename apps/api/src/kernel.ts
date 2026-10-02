import {
  ConnectorRegistry,
  DevelopmentWebhookVerifier,
  MockConnector,
  WebhookVerifierRegistry,
  ZentraConnector,
  ZentraWebhookVerifier,
  type Connector,
  type WebhookVerifierRegistration,
} from "@zentra/connectors";
import {
  InMemoryEventIngestion,
  InMemoryEventRepository,
  PostgresEventRepository,
  PostgresQueue,
  type EventIngestionPort,
  type EventRepository,
} from "@zentra/database";
import { ConfigurationError } from "@zentra/domain";
import { InMemoryRawEventQueue } from "@zentra/events";
import type { RawEventQueuePort } from "@zentra/events";
import { createLogger } from "@zentra/observability";
import type { AppConfig } from "@zentra/shared";
import { DevelopmentIdentityProvider } from "@zentra/shared";
import {
  EventProcessor,
  ExponentialBackoffPolicy,
  WorkerRuntime,
} from "@zentra/worker";
import pg from "pg";

export type Kernel = {
  repository: EventRepository;
  ingestion: EventIngestionPort;
  queue: RawEventQueuePort;
  connectors: ConnectorRegistry;
  verifiers: WebhookVerifierRegistry;
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
  const connectorList: Connector[] = [
    new ZentraConnector(config.ZENTRA_WEBHOOK_SECRET !== undefined),
  ];
  if (config.NODE_ENV !== "production") connectorList.push(new MockConnector());
  const connectors = new ConnectorRegistry(connectorList);

  const verifierRegistrations: WebhookVerifierRegistration[] = [];
  if (config.WEBHOOK_VERIFIER === "development") {
    verifierRegistrations.push({
      source: "mock",
      verifier: new DevelopmentWebhookVerifier(
        config.WEBHOOK_DEV_SECRET,
        config.NODE_ENV,
      ),
    });
  }
  if (config.ZENTRA_WEBHOOK_SECRET !== undefined) {
    verifierRegistrations.push({
      source: "zentra",
      verifier: new ZentraWebhookVerifier(config.ZENTRA_WEBHOOK_SECRET),
    });
  }
  const verifiers = new WebhookVerifierRegistry(verifierRegistrations);
  const identityProvider = new DevelopmentIdentityProvider(config.NODE_ENV);
  let repository: EventRepository;
  let ingestion: EventIngestionPort;
  let queue: RawEventQueuePort;
  let closeStorage = async (): Promise<void> => undefined;

  if (config.RUNTIME_MODE === "postgres") {
    if (config.DATABASE_URL === undefined)
      throw new ConfigurationError("DATABASE_URL is required");
    const pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
    });
    const postgresRepository = new PostgresEventRepository(pool);
    repository = postgresRepository;
    ingestion = postgresRepository;
    queue = new PostgresQueue(pool, {
      leaseTimeoutMs: 5 * 60_000,
      maxDeliveries: config.WORKER_MAX_ATTEMPTS,
      processorName: "canonical-normalizer",
    });
    closeStorage = async () => pool.end();
  } else {
    const inMemoryRepository = new InMemoryEventRepository();
    repository = inMemoryRepository;
    const inMemoryQueue = new InMemoryRawEventQueue();
    queue = inMemoryQueue;
    ingestion = new InMemoryEventIngestion(inMemoryRepository, inMemoryQueue);
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
        ingestion,
      )
    : null;

  return {
    repository,
    ingestion,
    queue,
    connectors,
    verifiers,
    identityProvider,
    workerRuntime,
    logger,
    close: closeStorage,
  };
};
