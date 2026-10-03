import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createZentraWebhookSignature } from "@zentra/connectors";
import pg from "pg";
import { expect, it } from "vitest";
import { z } from "zod";
import { localPostgresTls } from "./ops/local-postgres-tls.js";

const pause = async () => new Promise<void>((done) => setTimeout(done, 100));
const waitFor = async (condition: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await condition()) return;
    await pause();
  }
  throw new Error("Local production simulation timed out");
};

const unusedPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing test port");
  await new Promise<void>((done, reject) =>
    server.close((error) => (error === undefined ? done() : reject(error))),
  );
  return address.port;
};

const startProcess = (entrypoint: string, environment: NodeJS.ProcessEnv) => {
  const productionWorkspace = process.env.HQ_PRODUCTION_WORKSPACE;
  const pnpmExecutable = process.env.HQ_TEST_PNPM_EXECUTABLE;
  if (productionWorkspace !== undefined && pnpmExecutable === undefined) {
    throw new Error(
      "HQ_TEST_PNPM_EXECUTABLE is required for production-install verification",
    );
  }
  const child = spawn(
    productionWorkspace === undefined
      ? process.execPath
      : (pnpmExecutable ?? process.execPath),
    productionWorkspace === undefined
      ? ["--import", "tsx", entrypoint]
      : [entrypoint === "apps/api/src/main.ts" ? "start:api" : "start:worker"],
    {
      cwd: productionWorkspace ?? process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  let startupError: Error | undefined;
  child.on("error", (error) => {
    startupError = error;
  });
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  child.stdout.on("data", (chunk: Buffer) => {
    logs = (logs + chunk.toString("utf8")).slice(-100_000);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    logs = (logs + chunk.toString("utf8")).slice(-100_000);
  });
  return {
    child,
    logs: () => logs,
    assertRunning: () => {
      if (
        startupError !== undefined ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        throw new Error("Local runtime exited unexpectedly", {
          cause: startupError,
        });
      }
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        if (
          process.platform === "win32" &&
          productionWorkspace !== undefined &&
          child.pid !== undefined
        ) {
          // pnpm owns a shell + Node child. Terminate only this test-owned PID tree.
          const stopped = spawn("taskkill", [
            "/PID",
            String(child.pid),
            "/T",
            "/F",
          ]);
          await new Promise<void>((done, reject) => {
            stopped.once("error", reject);
            stopped.once("close", (code) =>
              code === 0
                ? done()
                : reject(
                    new Error("Could not stop packaging test process tree"),
                  ),
            );
          });
        } else child.kill("SIGTERM");
      }
      await exited;
    },
  };
};

it("runs the real production API and standalone worker against local Postgres", async () => {
  const productionWorkspace = process.env.HQ_PRODUCTION_WORKSPACE;
  if (productionWorkspace !== undefined) {
    // Run outside Vitest's patched resolver to prove real Node isolation.
    const isolation = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { createRequire } from "node:module";
      const runtimeRequire = createRequire(process.cwd() + "/package.json");
      for (const tool of ["typescript", "vitest", "eslint", "@types/node"]) {
        try {
          runtimeRequire.resolve(tool + "/package.json");
          throw new Error("Developer dependency available: " + tool);
        } catch (error) {
          if (error.code !== "MODULE_NOT_FOUND") throw error;
        }
      }
      console.log(runtimeRequire.resolve("tsx"));
    `,
      ],
      {
        cwd: productionWorkspace,
        env: { ...process.env, NODE_PATH: undefined },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(isolation.error).toBeUndefined();
    expect(isolation.status, isolation.stderr).toBe(0);
    expect(isolation.stdout).toContain(productionWorkspace);
  }
  const input = process.env.TEST_DATABASE_URL;
  if (input === undefined) throw new Error("TEST_DATABASE_URL is required");
  const databaseUrl = new URL(input);
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    databaseUrl.hostname !== "127.0.0.1" ||
    databaseUrl.port !== "54322"
  ) {
    throw new Error(
      "Production simulation only permits local PostgreSQL at 127.0.0.1:54322",
    );
  }
  // Generated identifier, not user input; PostgreSQL DDL cannot bind schema names.
  const schema = `hq_production_smoke_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
  const secret = randomBytes(32).toString("hex");
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tls = await localPostgresTls(databaseUrl.toString());
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    RUNTIME_MODE: "postgres",
    DATABASE_URL: tls.url(databaseUrl.toString()),
    DATABASE_CA_CERT_PATH: tls.caPath,
    WEBHOOK_VERIFIER: "provider",
    ZENTRA_WEBHOOK_SECRET: secret,
    EMBEDDED_WORKER: "false",
    HOST: undefined,
    PORT: String(port),
    WEB_ORIGIN: baseUrl,
    LOG_LEVEL: "info",
    WORKER_POLL_MS: "25",
    WORKER_MAX_ATTEMPTS: "4",
    NODE_PATH: undefined,
  };
  let api: ReturnType<typeof startProcess> | undefined;
  let worker: ReturnType<typeof startProcess> | undefined;
  let schemaCreated = false;
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    for (const migration of [
      "202609290001_m0_foundation.sql",
      "202609300001_m0_1_data_integrity.sql",
    ]) {
      await pool.query(
        await readFile(resolve("supabase/migrations", migration), "utf8"),
      );
    }
    api = startProcess("apps/api/src/main.ts", environment);
    const runningApi = api;
    await waitFor(async () => {
      runningApi.assertRunning();
      try {
        const response = await fetch(`${baseUrl}/health`);
        const health = z
          .object({
            readiness: z.boolean(),
            storage: z.string(),
            worker: z.null(),
          })
          .parse(await response.json());
        return response.ok && health.readiness && health.storage === "postgres";
      } catch (error: unknown) {
        // Connection refusal is expected only while the child binds its socket.
        if (
          error instanceof TypeError &&
          error.cause instanceof Error &&
          "code" in error.cause &&
          error.cause.code === "ECONNREFUSED"
        )
          return false;
        throw error;
      }
    });
    for (const path of ["context", "overview", "events", "integrations"]) {
      expect((await fetch(`${baseUrl}/v1/${path}`)).status).toBe(401);
    }
    expect(
      (await fetch(`${baseUrl}/v1/events/ingest`, { method: "POST" })).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/v1/webhooks/zentra`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{invalid",
        })
      ).status,
    ).toBe(401);

    const eventId = randomUUID();
    const companyId = randomUUID();
    const userId = randomUUID();
    const event = {
      eventId,
      type: "product.company_created",
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      entity: { type: "company", id: companyId },
      actor: { type: "user", id: userId },
      data: { companyId, createdByUserId: userId },
    };
    const body = JSON.stringify(event);
    const send = async () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      return fetch(`${baseUrl}/v1/webhooks/zentra`, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-zentra-timestamp": timestamp,
          "x-zentra-signature": createZentraWebhookSignature({
            secret,
            timestamp,
            rawBody: Buffer.from(body),
          }),
        },
      });
    };
    const first = await send();
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      accepted: true,
      duplicate: false,
    });
    // API alone persists and enqueues, but cannot normalize without a worker.
    expect(
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM events",
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM event_queue",
        )
      ).rows[0]?.count,
    ).toBe(1);
    worker = startProcess("apps/worker/src/main.ts", environment);
    const runningWorker = worker;
    expect(runningWorker.child.pid).not.toBe(runningApi.child.pid);
    await waitFor(async () => {
      runningApi.assertRunning();
      runningWorker.assertRunning();
      const result = await pool.query<{ complete: boolean }>(
        `SELECT (
          (SELECT count(*) FROM events) = 1
          AND EXISTS (SELECT 1 FROM processing_runs WHERE status = 'succeeded')
          AND EXISTS (SELECT 1 FROM audit_entries WHERE action = 'processing.succeeded')
          AND NOT EXISTS (SELECT 1 FROM event_queue)
        ) AS complete`,
      );
      return result.rows[0]?.complete === true;
    });
    const duplicate = await send();
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({
      accepted: true,
      duplicate: true,
    });
    expect(
      (
        await pool.query<{
          source: string;
          source_account_id: string | null;
          external_event_id: string;
          payload: unknown;
        }>(
          "SELECT source, source_account_id, external_event_id, payload FROM raw_events",
        )
      ).rows,
    ).toEqual([
      {
        source: "zentra",
        source_account_id: null,
        external_event_id: eventId,
        payload: event,
      },
    ]);
    expect(
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM events",
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(runningApi.logs()).not.toContain(secret);
    expect(runningWorker.logs()).not.toContain(secret);
    expect(runningApi.logs() + runningWorker.logs()).not.toContain(
      databaseUrl.toString(),
    );
  } finally {
    try {
      await Promise.all([worker?.stop(), api?.stop()]);
      await tls.cleanup();
    } finally {
      try {
        if (schemaCreated) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    }
  }
}, 45_000);
