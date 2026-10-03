import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createZentraWebhookSignature } from "@zentra/connectors";
import { expect, it } from "vitest";
import { localDatabaseFixture } from "./ops/local-postgres-fixture.js";

const exec = promisify(execFile);
const docker = async (args: string[], env = process.env) => {
  const result = await exec("docker", args, {
    env,
    timeout: 30_000,
    maxBuffer: 4_000_000,
    windowsHide: true,
  });
  return (
    args[0] === "logs" ? result.stdout + result.stderr : result.stdout
  ).trim();
};
const waitFor = async (condition: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) return;
    await new Promise<void>((done) => setTimeout(done, 100));
  }
  throw new Error("LOCAL_CONTAINER_FLOW_TIMEOUT");
};

it("runs the final Linux production-only image as separate non-root API/worker with grants, no baked secrets and graceful SIGTERM", async () => {
  const image = process.env.HQ_TEST_IMAGE;
  if (!image || !/^zentra-hq-preflight:[a-z0-9_-]+$/.test(image))
    throw new Error("LOCAL_PREFLIGHT_IMAGE_REQUIRED");
  expect(await docker(["image", "inspect", image, "--format", "{{.Os}}"])).toBe(
    "linux",
  );
  const fixture = await localDatabaseFixture(true);
  const suffix = randomUUID().replaceAll("-", "");
  const api = `hq-preflight-api-${suffix}`;
  const worker = `hq-preflight-worker-${suffix}`;
  const invalid = `hq-preflight-invalid-${suffix}`;
  const containers: string[] = [];
  const removeOwnedContainer = async (container: string) => {
    if (
      (await docker([
        "inspect",
        container,
        "--format",
        '{{index .Config.Labels "zentra.hq.preflight"}}',
      ])) !== suffix
    )
      throw new Error("LOCAL_CONTAINER_OWNERSHIP_CHANGED");
    await docker(["rm", "--force", container]);
  };
  const secret = randomBytes(32).toString("hex");
  const inContainer = (input: string) => {
    const url = new URL(input);
    // Docker Desktop's local host bridge, never a production database.
    url.hostname = "host.docker.internal";
    return url.toString();
  };
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    RUNTIME_MODE: "postgres",
    WEBHOOK_VERIFIER: "provider",
    ZENTRA_WEBHOOK_SECRET: secret,
    EMBEDDED_WORKER: "false",
    WEB_ORIGIN: "https://hq.example.com",
    HOST: "0.0.0.0",
    PORT: "4100",
    WORKER_POLL_MS: "25",
    LOG_LEVEL: "info",
    DATABASE_URL: inContainer(fixture.apiUrl),
  };
  const names = [
    "NODE_ENV",
    "RUNTIME_MODE",
    "WEBHOOK_VERIFIER",
    "ZENTRA_WEBHOOK_SECRET",
    "EMBEDDED_WORKER",
    "WEB_ORIGIN",
    "HOST",
    "PORT",
    "WORKER_POLL_MS",
    "LOG_LEVEL",
    "DATABASE_URL",
  ];
  const envArgs = names.flatMap((name) => ["--env", name]);
  const run = async (
    name: string,
    env: NodeJS.ProcessEnv,
    extra: string[],
    command: string[],
  ) => {
    await docker(
      [
        "create",
        "--name",
        name,
        "--label",
        `zentra.hq.preflight=${suffix}`,
        ...envArgs,
        ...extra,
        image,
        ...command,
      ],
      env,
    );
    containers.push(name);
    await docker(["start", name]);
  };
  try {
    await run(invalid, { ...environment, WEB_ORIGIN: undefined }, [], []);
    expect(await docker(["wait", invalid])).toBe("1");
    expect(await docker(["logs", invalid])).toContain("configuration");
    expect(
      await docker(["inspect", invalid, "--format", "{{.State.Running}}"]),
    ).toBe("false");

    await run(api, environment, ["--publish", "127.0.0.1::4100"], []);
    const binding = await docker(["port", api, "4100/tcp"]);
    const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
    if (!port) throw new Error("LOCAL_CONTAINER_BIND_INVALID");
    const origin = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      if (
        (await docker(["inspect", api, "--format", "{{.State.Running}}"])) !==
        "true"
      )
        throw new Error("LOCAL_API_CONTAINER_EXITED_BEFORE_READY");
      try {
        return (await fetch(`${origin}/health`)).ok;
      } catch (error: unknown) {
        if (
          error instanceof TypeError &&
          error.cause instanceof Error &&
          "code" in error.cause &&
          ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(
            String(error.cause.code),
          )
        )
          return false;
        throw error;
      }
    });
    const health = await fetch(`${origin}/health`);
    expect(await health.json()).toMatchObject({
      readiness: true,
      storage: "postgres",
      worker: null,
      queueDepth: 0,
    });
    expect(
      (
        await fetch(`${origin}/v1/webhooks/zentra`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    const companyId = randomUUID();
    const userId = randomUUID();
    const body = JSON.stringify({
      eventId: randomUUID(),
      type: "product.company_created",
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      entity: { type: "company", id: companyId },
      actor: { type: "user", id: userId },
      data: { companyId, createdByUserId: userId },
    });
    const send = async () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      return fetch(`${origin}/v1/webhooks/zentra`, {
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
    expect((await send()).status).toBe(202);
    expect(
      (await fixture.owner.query("SELECT 1 FROM event_queue")).rowCount,
    ).toBe(1);
    expect((await fixture.owner.query("SELECT 1 FROM events")).rowCount).toBe(
      0,
    );
    await run(
      worker,
      { ...environment, DATABASE_URL: inContainer(fixture.workerUrl) },
      [],
      ["node", "--import", "tsx", "apps/worker/src/main.ts"],
    );
    await waitFor(
      async () =>
        (
          await fixture.owner.query<{ complete: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM events) AND EXISTS (SELECT 1 FROM processing_runs WHERE status = 'succeeded')
      AND EXISTS (SELECT 1 FROM audit_entries WHERE action = 'processing.succeeded')
      AND NOT EXISTS (SELECT 1 FROM event_queue) AS complete`)
        ).rows[0]?.complete === true,
    );
    expect(await (await send()).json()).toMatchObject({ duplicate: true });
    expect(
      (await fixture.owner.query("SELECT 1 FROM raw_events")).rowCount,
    ).toBe(1);
    expect(await docker(["port", worker])).toBe("");
    for (const container of [api, worker]) {
      expect(await docker(["exec", container, "id", "-u"])).toBe("1000");
      expect(
        await docker([
          "exec",
          container,
          "node",
          "-e",
          "if(process.env.NODE_ENV!=='production')process.exit(1);console.log(process.env.NODE_ENV)",
        ]),
      ).toBe("production");
      expect(
        await docker([
          "exec",
          container,
          "node",
          "--input-type=module",
          "-e",
          `
        import { createRequire } from 'node:module'; import { readdirSync, readFileSync } from 'node:fs';
        const req = createRequire('/app/package.json');
        for (const name of ['typescript','vitest','eslint','@types/node']) {
          try { req.resolve(name+'/package.json'); throw new Error('Developer dependency present'); }
          catch (error) { if(error.code!=='MODULE_NOT_FOUND') throw error; }
        }
        req.resolve('tsx');
        const walk = (dir) => { for(const item of readdirSync(dir,{withFileTypes:true})) {
          const path=dir+'/'+item.name;
          if(item.isDirectory()) walk(path);
          else if(item.isFile()) {
            if(item.name==='.env'||item.name.startsWith('.env.')) throw new Error('Env file baked into image');
            if(readFileSync(path).includes(Buffer.from(process.env.ZENTRA_WEBHOOK_SECRET))) throw new Error('Secret baked into file');
          }
        }}; walk('/app'); console.log('production-only clean image');
      `,
        ]),
      ).toBe("production-only clean image");
    }
    // Wait for existing 30-second heartbeat, no worker HTTP endpoint added.
    await waitFor(async () =>
      (await docker(["logs", worker])).includes("worker heartbeat"),
    );
    for (const container of [worker, api]) {
      await docker(["stop", "--time", "10", container]);
      expect(
        await docker([
          "inspect",
          container,
          "--format",
          "{{.State.ExitCode}} {{.State.OOMKilled}}",
        ]),
      ).toBe("0 false");
      const logs = await docker(["logs", container]);
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain(fixture.apiUrl);
      expect(logs).not.toContain(fixture.workerUrl);
      expect(logs).not.toContain(body);
    }
    expect(await docker(["logs", worker])).toContain("worker stopped");
  } finally {
    try {
      for (const container of containers.reverse()) {
        // Refuse deletion if the exact test ownership label no longer matches.
        await removeOwnedContainer(container);
      }
    } finally {
      await fixture.cleanup();
    }
  }
});
