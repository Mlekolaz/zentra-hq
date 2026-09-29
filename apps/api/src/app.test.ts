import { loadConfig } from "@zentra/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createKernel, type Kernel } from "./kernel.js";

const config = loadConfig({
  NODE_ENV: "test",
  WEBHOOK_DEV_SECRET: "test-secret-value",
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
});
