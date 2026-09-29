import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import { AppError, AuthenticationError, ValidationError } from "@zentra/domain";
import { safeErrorSummary } from "@zentra/observability";
import type { AppConfig } from "@zentra/shared";
import Fastify, { LogController } from "fastify";
import { z } from "zod";
import type { Kernel } from "./kernel.js";
import { ingestionRequestSchema, IngestionService } from "./ingestion.js";

const clientStatusFrom = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null || !("statusCode" in error))
    return null;
  const statusCode: unknown = error.statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500
    ? statusCode
    : null;
};

export const buildApp = async (config: AppConfig, kernel: Kernel) => {
  const app = Fastify({
    loggerInstance: kernel.logger,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    methods: ["GET", "POST"],
  });

  // Provider signatures require the exact request bytes, so the parser preserves them before JSON validation.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      request.rawBody = buffer;
      try {
        done(null, JSON.parse(buffer.toString("utf8")) as unknown);
      } catch (error: unknown) {
        done(
          new ValidationError("Request body contains malformed JSON", {
            cause: error,
          }),
        );
      }
    },
  );

  app.addHook("onRequest", async (request, reply) => {
    request.rawBody = Buffer.alloc(0);
    reply.header("x-trace-id", request.id);
  });

  const ingestion = new IngestionService(
    kernel.repository,
    kernel.queue,
    kernel.verifier,
  );

  app.get("/health", async () => {
    const [storageReady, queueDepth] = await Promise.all([
      kernel.repository.healthCheck(),
      kernel.queue.depth(),
    ]);
    const worker = kernel.workerRuntime?.health() ?? null;
    return {
      status:
        storageReady && (worker === null || worker.ready) ? "ok" : "degraded",
      liveness: true,
      readiness: storageReady,
      storage: config.RUNTIME_MODE,
      queueDepth,
      worker,
    };
  });

  app.get("/v1/context", async () => ({
    identity: await kernel.identityProvider.resolve(),
  }));
  app.get("/v1/overview", async () => kernel.repository.getOverview());
  app.get("/v1/events", async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .safeParse(request.query);
    if (!query.success) throw new ValidationError("Events query is malformed");
    return { events: await kernel.repository.listEvents(query.data.limit) };
  });
  app.get("/v1/integrations", async () => ({
    integrations: await Promise.all(
      kernel.connectors.list().map(async (connector) => ({
        provider: connector.provider,
        capabilities: [...connector.capabilities()],
        health: await connector.health(),
        developmentOnly: connector.provider === "mock",
      })),
    ),
  }));

  app.post("/v1/events/ingest", async (request, reply) => {
    const parsed = ingestionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Ingestion request is malformed", {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
          })),
        },
      });
    }
    const result = await ingestion.ingest({
      request: parsed.data,
      headers: request.headers,
      rawBody: request.rawBody,
      traceId: request.id,
    });
    return reply.code(202).send(result);
  });

  app.setErrorHandler((error, request, reply) => {
    const frameworkStatus = clientStatusFrom(error);
    const summary =
      error instanceof AppError
        ? safeErrorSummary(error)
        : frameworkStatus !== null
          ? {
              code: "REQUEST_REJECTED",
              message: "Request could not be accepted",
              retryable: false,
            }
          : safeErrorSummary(error);
    const statusCode =
      error instanceof AuthenticationError
        ? 401
        : error instanceof ValidationError
          ? 400
          : (frameworkStatus ?? 500);
    if (statusCode >= 500)
      request.log.error({ errorCode: summary.code }, "request failed");
    else request.log.warn({ errorCode: summary.code }, "request rejected");
    reply.code(statusCode).send({
      error: { code: summary.code, message: summary.message },
      traceId: request.id,
    });
  });

  return app;
};
