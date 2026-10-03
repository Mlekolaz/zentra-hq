import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createZentraWebhookSignature } from "@zentra/connectors";
import { z } from "zod";

export const migrationFiles = [
  "202609290001_m0_foundation.sql",
  "202609300001_m0_1_data_integrity.sql",
] as const;

export const verifiedMigrationSql = async (root: string): Promise<string> => {
  const manifest = z
    .object({
      normalization: z.literal("UTF-8 with CRLF normalized to LF"),
      migrations: z.array(
        z.object({
          file: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(
          resolve(root, "infra/postgres/migrations.sha256.json"),
          "utf8",
        ),
      ) as unknown,
    );
  if (
    manifest.migrations.length !== migrationFiles.length ||
    manifest.migrations.some(
      (item, index) => item.file !== migrationFiles[index],
    )
  )
    throw new Error("MIGRATION_ORDER_INVALID");
  const sql: string[] = [];
  for (const item of manifest.migrations) {
    const source = (
      await readFile(resolve(root, "supabase/migrations", item.file), "utf8")
    ).replaceAll("\r\n", "\n");
    if (createHash("sha256").update(source).digest("hex") !== item.sha256)
      throw new Error("MIGRATION_CHECKSUM_MISMATCH");
    sql.push(source);
  }
  return [
    "SET LOCAL search_path = public, pg_catalog;",
    "DO $$ BEGIN IF session_user IN ('hq_api', 'hq_worker') THEN RAISE EXCEPTION 'Migrator credential required'; END IF; END $$;",
    ...sql,
  ].join("\n");
};

// Output is intentionally suppressed: client errors must not disclose credentials.
export const runMigrationCommand = async (
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  sql: string,
): Promise<void> => {
  await new Promise<void>((done, reject) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    child.once("error", () =>
      reject(new Error("MIGRATION_CLIENT_UNAVAILABLE")),
    );
    child.stdin.on("error", () => reject(new Error("MIGRATION_INPUT_FAILED")));
    child.once("close", (code) =>
      code === 0 ? done() : reject(new Error("MIGRATION_TRANSACTION_FAILED")),
    );
    child.stdin.end(sql);
  });
};

export const migrationInvocation = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
} | null => {
  const parsed = z.array(z.string()).parse(args);
  if (parsed.length === 0 || (parsed.length === 1 && parsed[0] === "--check"))
    return null;
  if (
    !parsed.includes("--apply") ||
    !parsed.includes("--confirm-hq-migrations") ||
    parsed.length !== 3
  )
    throw new Error("MIGRATION_EXPLICIT_CONFIRMATION_REQUIRED");
  const psqlArgs = [
    "-X",
    "--single-transaction",
    "--set=ON_ERROR_STOP=1",
    "--file=-",
  ];
  const local = parsed.find((arg) => arg.startsWith("--local-container="));
  if (local !== undefined) {
    // Local test adapter only. Never permits arbitrary targets or production databases.
    if (
      local !== "--local-container=supabase_db_zentra-hq" ||
      env.PGHOST !== "127.0.0.1" ||
      env.PGPORT !== "5432" ||
      !/^hq_preflight_[a-f0-9]{32}$/.test(env.PGDATABASE ?? "") ||
      env.PGUSER !== "postgres" ||
      !env.PGPASSWORD
    )
      throw new Error("MIGRATION_LOCAL_TARGET_INVALID");
    return {
      command: "docker",
      args: [
        "exec",
        "-i",
        "--env",
        "PGHOST",
        "--env",
        "PGPORT",
        "--env",
        "PGDATABASE",
        "--env",
        "PGUSER",
        "--env",
        "PGPASSWORD",
        "supabase_db_zentra-hq",
        "psql",
        ...psqlArgs,
      ],
      environment: { ...env, PGSERVICE: undefined, PGSERVICEFILE: undefined },
    };
  }
  const service = parsed.find((arg) => arg.startsWith("--service="))?.slice(10);
  const outsideCheckout = (path: string) => {
    const location = relative(process.cwd(), path);
    return (
      isAbsolute(path) &&
      (location.startsWith(`..${sep}`) || isAbsolute(location))
    );
  };
  if (
    service === undefined ||
    !/^[a-zA-Z0-9_-]+$/.test(service) ||
    !env.PGSERVICEFILE ||
    !outsideCheckout(env.PGSERVICEFILE) ||
    !env.PGPASSFILE ||
    !outsideCheckout(env.PGPASSFILE) ||
    env.PGPASSWORD !== undefined
  )
    throw new Error("MIGRATION_PROTECTED_SERVICE_FILES_REQUIRED");
  // Do not let ambient libpq variables override the explicitly approved service.
  const environment: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("PG")) delete environment[name];
  }
  Object.assign(environment, {
    PGSERVICE: service,
    PGSERVICEFILE: env.PGSERVICEFILE,
    PGPASSFILE: env.PGPASSFILE,
    PGCONNECT_TIMEOUT: "15",
  });
  return {
    command: "psql",
    args: psqlArgs,
    environment,
  };
};

export const createSmokeRequest = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  now = new Date(),
) => {
  if (!args.includes("--confirm-production-smoke"))
    throw new Error("PRODUCTION_SMOKE_CONFIRMATION_REQUIRED");
  const hostname = args.find((arg) => arg.startsWith("--hostname="))?.slice(11);
  const eventIdArg = args
    .find((arg) => arg.startsWith("--event-id="))
    ?.slice(11);
  if (
    args.some(
      (arg) =>
        arg !== "--confirm-production-smoke" &&
        !arg.startsWith("--hostname=") &&
        !arg.startsWith("--event-id="),
    ) ||
    args.length !== (eventIdArg === undefined ? 2 : 3)
  )
    throw new Error("PRODUCTION_SMOKE_ARGUMENTS_INVALID");
  const config = z
    .object({
      hostname: z
        .string()
        .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
        .refine(
          (host) => !host.endsWith(".local") && !host.endsWith(".localhost"),
        ),
      secret: z.string().min(32),
      eventId: z.uuid(),
    })
    .parse({
      hostname,
      secret: env.ZENTRA_WEBHOOK_SECRET,
      eventId: eventIdArg ?? randomUUID(),
    });
  // Stable synthetic content for an explicit replay of the same eventId.
  const body = JSON.stringify({
    eventId: config.eventId,
    type: "ops.receiver_smoke",
    schemaVersion: 1,
    occurredAt: "2026-10-03T00:00:00.000Z",
    entity: { type: "ops_probe", id: config.eventId },
    data: { synthetic: true, purpose: "receiver_readiness" },
  });
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return {
    eventId: config.eventId,
    url: `https://${config.hostname}/v1/webhooks/zentra`,
    init: {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        "x-zentra-timestamp": timestamp,
        "x-zentra-signature": createZentraWebhookSignature({
          secret: config.secret,
          timestamp,
          rawBody: Buffer.from(body),
        }),
      },
      body,
    } satisfies RequestInit,
  };
};

export const sendSmoke = async (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  sender: typeof fetch = fetch,
) => {
  const request = createSmokeRequest(args, env);
  // Exactly one request. Redirects are forbidden; no retry or response-body logging.
  const response = await sender(request.url, request.init);
  if (response.status !== 202) throw new Error("PRODUCTION_SMOKE_NOT_ACCEPTED");
  return { eventId: request.eventId, status: response.status };
};
