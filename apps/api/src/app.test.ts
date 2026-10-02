import { createZentraWebhookSignature } from "@zentra/connectors";
import { InMemoryEventRepository } from "@zentra/database";
import { loadConfig } from "@zentra/shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "./app.js";
import { createKernel, type Kernel } from "./kernel.js";

const zentraSecret = "zentra-test-secret-that-is-at-least-32-chars";
const config = loadConfig({
  NODE_ENV: "test",
  WEBHOOK_DEV_SECRET: "test-secret-value",
  ZENTRA_WEBHOOK_SECRET: zentraSecret,
  EMBEDDED_WORKER: "true",
});
type BuiltApp = Awaited<ReturnType<typeof buildApp>>;
let app: BuiltApp | null = null;
let kernel: Kernel | null = null;

afterEach(async () => {
  if (app !== null) await app.close();
  if (kernel !== null) await kernel.close();
  app = null;
  kernel = null;
});

const setup = async () => {
  kernel = createKernel(config);
  const server = await buildApp(config, kernel);
  app = server;
  await server.ready();
  return server;
};

const companyCreatedEvent = {
  eventId: "10000000-0000-4000-8000-000000000010",
  type: "product.company_created",
  schemaVersion: 1,
  occurredAt: "2026-10-01T12:00:00.000Z",
  entity: { type: "company", id: "10000000-0000-4000-8000-000000000020" },
  actor: { type: "user", id: "10000000-0000-4000-8000-000000000030" },
  data: {
    companyId: "10000000-0000-4000-8000-000000000020",
    createdByUserId: "10000000-0000-4000-8000-000000000030",
  },
} as const;

const signedZentraHeaders = (rawBody: Buffer) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "content-type": "application/json",
    "x-zentra-timestamp": timestamp,
    "x-zentra-signature": createZentraWebhookSignature({
      secret: zentraSecret,
      timestamp,
      rawBody,
    }),
  };
};

const waitUntil = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the embedded worker");
};

describe("HQ API", () => {
  it("returns 400 for a malformed ingestion request", async () => {
    const server = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/v1/events/ingest",
      headers: {
        "content-type": "application/json",
        "x-zentra-webhook-secret": "test-secret-value",
      },
      payload: { source: "mock" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("returns a safe 400 response for malformed JSON", async () => {
    const server = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/v1/events/ingest",
      headers: {
        "content-type": "application/json",
        "x-zentra-webhook-secret": "test-secret-value",
      },
      payload: "{not-json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
    expect(response.body).not.toContain("SyntaxError");
  });

  it("rejects invalid development webhook authentication", async () => {
    const server = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/v1/events/ingest",
      headers: {
        "content-type": "application/json",
        "x-zentra-webhook-secret": "wrong-secret-value",
      },
      payload: {
        source: "mock",
        payload: {
          kind: "message",
          messageId: "1",
          sender: { name: "Jan", email: "jan@example.com" },
          text: "Hi",
        },
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "AUTHENTICATION_FAILED" },
    });
  });

  it("reports liveness and actual storage readiness", async () => {
    const server = await setup();
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      liveness: true,
      readiness: true,
      storage: "in-memory",
    });
  });

  it("reports the configured Zentra webhook capability without secrets", async () => {
    const server = await setup();
    const response = await server.inject({
      method: "GET",
      url: "/v1/integrations",
    });
    expect(response.statusCode).toBe(200);
    const responseBody: unknown = response.json();
    const parsed = z
      .object({
        integrations: z.array(
          z.object({
            provider: z.string(),
            capabilities: z.array(z.string()),
            health: z.object({
              status: z.string(),
              checkedAt: z.string(),
              message: z.string().optional(),
            }),
            developmentOnly: z.boolean(),
          }),
        ),
      })
      .parse(responseBody);
    expect(
      parsed.integrations.find((entry) => entry.provider === "zentra"),
    ).toMatchObject({
      provider: "zentra",
      capabilities: ["WEBHOOKS"],
      health: { status: "CONNECTED", message: "Configured" },
      developmentOnly: false,
    });
    expect(response.body).not.toContain(zentraSecret);
  });

  it("verifies Zentra before parsing malformed JSON", async () => {
    const server = await setup();
    const rawBody = Buffer.from("{not-json", "utf8");
    const response = await server.inject({
      method: "POST",
      url: "/v1/webhooks/zentra",
      headers: {
        "content-type": "application/json",
        "x-zentra-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-zentra-signature": `sha256=${"0".repeat(64)}`,
      },
      payload: rawBody,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "AUTHENTICATION_FAILED" },
    });
  });

  it("returns 400 when valid Zentra authentication covers malformed JSON", async () => {
    const server = await setup();
    const rawBody = Buffer.from("{not-json", "utf8");
    const response = await server.inject({
      method: "POST",
      url: "/v1/webhooks/zentra",
      headers: signedZentraHeaders(rawBody),
      payload: rawBody,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("returns 400 for a signed but invalid Zentra semantic event", async () => {
    const server = await setup();
    const rawBody = Buffer.from(
      JSON.stringify({
        ...companyCreatedEvent,
        data: {
          ...companyCreatedEvent.data,
          companyId: "10000000-0000-4000-8000-000000000099",
        },
      }),
      "utf8",
    );
    const response = await server.inject({
      method: "POST",
      url: "/v1/webhooks/zentra",
      headers: signedZentraHeaders(rawBody),
      payload: rawBody,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("processes a signed Zentra event end to end and deduplicates its retry", async () => {
    const server = await setup();
    const currentKernel = kernel;
    const repository = currentKernel?.repository;
    if (
      currentKernel === null ||
      currentKernel.workerRuntime === null ||
      !(repository instanceof InMemoryEventRepository)
    ) {
      throw new Error("in-memory test kernel is unavailable");
    }
    const rawBody = Buffer.from(JSON.stringify(companyCreatedEvent), "utf8");
    const first = await server.inject({
      method: "POST",
      url: "/v1/webhooks/zentra",
      headers: signedZentraHeaders(rawBody),
      payload: rawBody,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ accepted: true, duplicate: false });

    const abortController = new AbortController();
    const worker = currentKernel.workerRuntime.start(abortController.signal);
    try {
      await waitUntil(() => repository.snapshot().canonicalEvents.length === 1);
      const retry = await server.inject({
        method: "POST",
        url: "/v1/webhooks/zentra",
        headers: signedZentraHeaders(rawBody),
        payload: rawBody,
      });
      expect(retry.statusCode).toBe(202);
      expect(retry.json()).toMatchObject({
        accepted: true,
        duplicate: true,
      });

      const snapshot = repository.snapshot();
      expect(snapshot.rawEvents).toHaveLength(1);
      expect(snapshot.rawEvents[0]).toMatchObject({
        source: "zentra",
        externalEventId: companyCreatedEvent.eventId,
        payload: companyCreatedEvent,
        sanitizedHeaders: { "content-type": "application/json" },
      });
      expect(snapshot.canonicalEvents).toHaveLength(1);
      expect(snapshot.canonicalEvents[0]).toMatchObject({
        source: "zentra",
        type: "product.company_created",
        externalEventId: companyCreatedEvent.eventId,
        deduplicationKey: `source-event:${companyCreatedEvent.eventId}`,
        subject: { type: "company", id: companyCreatedEvent.entity.id },
        actor: { type: "user", id: companyCreatedEvent.actor.id },
      });
      const eventsResponse = await server.inject({
        method: "GET",
        url: "/v1/events",
      });
      const eventsBody: unknown = eventsResponse.json();
      const eventTypes = z
        .object({ events: z.array(z.object({ type: z.string() })) })
        .parse(eventsBody)
        .events.map((event) => event.type);
      expect(eventTypes).toContain("product.company_created");
    } finally {
      abortController.abort();
      await worker;
    }
  });

  it("preserves an unsupported signed Zentra fact and dead-letters it", async () => {
    const server = await setup();
    const currentKernel = kernel;
    const repository = currentKernel?.repository;
    if (
      currentKernel === null ||
      currentKernel.workerRuntime === null ||
      !(repository instanceof InMemoryEventRepository)
    ) {
      throw new Error("in-memory test kernel is unavailable");
    }
    const rawBody = Buffer.from(
      JSON.stringify({
        ...companyCreatedEvent,
        type: "product.unknown_thing",
        data: {},
      }),
      "utf8",
    );
    const response = await server.inject({
      method: "POST",
      url: "/v1/webhooks/zentra",
      headers: signedZentraHeaders(rawBody),
      payload: rawBody,
    });
    expect(response.statusCode).toBe(202);

    const abortController = new AbortController();
    const worker = currentKernel.workerRuntime.start(abortController.signal);
    try {
      await waitUntil(() => repository.snapshot().deadLetters.length === 1);
      const snapshot = repository.snapshot();
      expect(snapshot.rawEvents).toHaveLength(1);
      expect(snapshot.canonicalEvents).toHaveLength(0);
      expect(snapshot.deadLetters).toMatchObject([
        { reason: "ZENTRA_EVENT_TYPE_UNSUPPORTED" },
      ]);
    } finally {
      abortController.abort();
      await worker;
    }
  });
});
