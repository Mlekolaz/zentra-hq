import { PostgresEventRepository, PostgresQueue } from "@zentra/database";
import {
  DevelopmentIdentityProvider,
  ReceiverOnlyIdentityProvider,
  loadConfig,
} from "@zentra/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createKernel, type Kernel } from "./kernel.js";

const config = loadConfig({
  NODE_ENV: "production",
  RUNTIME_MODE: "postgres",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  WEBHOOK_VERIFIER: "provider",
  ZENTRA_WEBHOOK_SECRET: "local-production-test-secret-at-least-32-characters",
  EMBEDDED_WORKER: "false",
  LOG_LEVEL: "silent",
  WEB_ORIGIN: "http://127.0.0.1:5173",
});
let kernel: Kernel | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => {
  await app?.close();
  await kernel?.close();
  app = undefined;
  kernel = undefined;
});

describe("production receiver bootstrap", () => {
  it.each(["apps/api/src/main.ts", "apps/worker/src/main.ts"])(
    "fails before starting %s when required CA is absent",
    (entrypoint) => {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", entrypoint],
        {
          env: {
            ...process.env,
            NODE_ENV: "production",
            RUNTIME_MODE: "postgres",
            DATABASE_URL:
              "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
            DATABASE_CA_CERT_PATH: "missing-public-ca.crt",
            WEBHOOK_VERIFIER: "provider",
            EMBEDDED_WORKER: "false",
            ZENTRA_WEBHOOK_SECRET:
              "local-test-secret-with-at-least-32-characters",
            WEB_ORIGIN: "http://127.0.0.1:5173",
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Database TLS Root CA is missing, invalid or expired",
      );
      expect(result.stderr).not.toContain("postgresql://postgres:postgres@");
    },
    15_000,
  );
  it.each(["apps/api/src/main.ts", "apps/worker/src/main.ts"])(
    "fails before starting %s when WEB_ORIGIN is absent",
    (entrypoint) => {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", entrypoint],
        {
          env: {
            ...process.env,
            NODE_ENV: "production",
            RUNTIME_MODE: "postgres",
            DATABASE_URL:
              "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
            WEBHOOK_VERIFIER: "provider",
            EMBEDDED_WORKER: "false",
            ZENTRA_WEBHOOK_SECRET:
              "local-test-secret-with-at-least-32-characters",
            WEB_ORIGIN: undefined,
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Explicit WEB_ORIGIN is required in production",
      );
    },
    15_000,
  );
  it("refuses a standalone worker with process-local memory storage", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "apps/worker/src/main.ts"],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          RUNTIME_MODE: "in-memory",
          DATABASE_URL: undefined,
          WEBHOOK_VERIFIER: "development",
          EMBEDDED_WORKER: "true",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "The standalone worker requires RUNTIME_MODE=postgres and DATABASE_URL",
    );
  }, 15_000);
  it.each(["apps/api/src/main.ts", "apps/worker/src/main.ts"])(
    "fails before starting %s when the production secret is absent",
    (entrypoint) => {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", entrypoint],
        {
          env: {
            ...process.env,
            NODE_ENV: "production",
            RUNTIME_MODE: "postgres",
            DATABASE_URL:
              "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
            WEBHOOK_VERIFIER: "provider",
            EMBEDDED_WORKER: "false",
            ZENTRA_WEBHOOK_SECRET: undefined,
            WEB_ORIGIN: "http://127.0.0.1:5173",
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Environment configuration is invalid");
    },
    15_000,
  );
  it("composes Postgres storage/queue without development identity or embedded worker", async () => {
    kernel = createKernel(config);
    expect(kernel.identityProvider).toBeInstanceOf(
      ReceiverOnlyIdentityProvider,
    );
    expect(kernel.identityProvider).not.toBeInstanceOf(
      DevelopmentIdentityProvider,
    );
    expect(kernel.repository).toBeInstanceOf(PostgresEventRepository);
    expect(kernel.queue).toBeInstanceOf(PostgresQueue);
    expect(kernel.workerRuntime).toBeNull();
    expect(
      kernel.connectors.list().map((connector) => connector.provider),
    ).toEqual(["zentra"]);
    app = await buildApp(config, kernel);
    await app.ready();
  });

  it.each(["/v1/context", "/v1/overview", "/v1/events", "/v1/integrations"])(
    "denies operator reads at %s before accessing storage",
    async (url) => {
      kernel = createKernel(config);
      const read = vi.spyOn(kernel.repository, "getOverview");
      const events = vi.spyOn(kernel.repository, "listEvents");
      app = await buildApp(config, kernel);
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer forged-operator", "x-role": "admin" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: "AUTHENTICATION_FAILED" },
      });
      expect(read).not.toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
    },
  );

  it("does not register development ingestion and rejects unsigned provider requests", async () => {
    kernel = createKernel(config);
    app = await buildApp(config, kernel);
    expect(
      (await app.inject({ method: "POST", url: "/v1/events/ingest" }))
        .statusCode,
    ).toBe(404);
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/zentra",
      headers: {
        "content-type": "application/json",
        "x-zentra-webhook-secret": "local-development-only",
      },
      payload: "{not-json",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "AUTHENTICATION_FAILED" },
    });
  });
});
import { spawnSync } from "node:child_process";
