import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createSmokeRequest,
  migrationInvocation,
  sendSmoke,
  migrationFiles,
  verifiedMigrationSql,
} from "./operator-tools.js";

it("verifies the exact two migration checksums and order without connecting", async () => {
  const sql = await verifiedMigrationSql(process.cwd());
  expect(sql.indexOf("CREATE TABLE raw_events")).toBeLessThan(
    sql.indexOf("DROP INDEX raw_events_provider_identity_unique"),
  );
  expect(migrationInvocation([], {})).toBeNull();
  expect(migrationInvocation(["--check"], {})).toBeNull();
  expect(() => migrationInvocation(["--apply"], {})).toThrow("CONFIRMATION");
  expect(() =>
    migrationInvocation(
      ["--apply", "--confirm-hq-migrations", "--service=hq"],
      {},
    ),
  ).toThrow("PROTECTED");
  const invocation = migrationInvocation(
    ["--apply", "--confirm-hq-migrations", "--service=hq"],
    {
      PGSERVICEFILE: resolve(tmpdir(), "hq-operator-protected/service.conf"),
      PGPASSFILE: resolve(tmpdir(), "hq-operator-protected/pass.conf"),
      PGHOST: "unapproved-target",
      PGDATABASE: "unapproved-database",
    },
  );
  expect(invocation?.args).toEqual([
    "-X",
    "--single-transaction",
    "--set=ON_ERROR_STOP=1",
    "--file=-",
  ]);
  expect(invocation?.environment.PGSERVICE).toBe("hq");
  expect(invocation?.environment.PGHOST).toBeUndefined();
  expect(invocation?.environment.PGDATABASE).toBeUndefined();
});

it("refuses a changed migration or reordered checksum manifest", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "hq-migration-checksum-"));
  try {
    await mkdir(resolve(directory, "infra/postgres"), { recursive: true });
    await mkdir(resolve(directory, "supabase/migrations"), { recursive: true });
    const manifestPath = resolve(
      directory,
      "infra/postgres/migrations.sha256.json",
    );
    await copyFile(
      resolve("infra/postgres/migrations.sha256.json"),
      manifestPath,
    );
    for (const file of migrationFiles)
      await copyFile(
        resolve("supabase/migrations", file),
        resolve(directory, "supabase/migrations", file),
      );
    const first = resolve(directory, "supabase/migrations", migrationFiles[0]);
    const source = await readFile(first, "utf8");
    await writeFile(first, source + "\n-- unreviewed change\n");
    await expect(verifiedMigrationSql(directory)).rejects.toThrow(
      "CHECKSUM_MISMATCH",
    );
    await writeFile(first, source);
    await writeFile(
      manifestPath,
      JSON.stringify({
        normalization: "UTF-8 with CRLF normalized to LF",
        migrations: [...migrationFiles]
          .reverse()
          .map((file) => ({ file, sha256: "0".repeat(64) })),
      }),
    );
    await expect(verifiedMigrationSql(directory)).rejects.toThrow(
      "ORDER_INVALID",
    );
  } finally {
    // Exact fresh mkdtemp result, never a caller-provided path.
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses unconfirmed smoke, URL paths, insecure input and short secrets before any request", async () => {
  const sender = vi.fn<typeof fetch>();
  await expect(sendSmoke([], {}, sender)).rejects.toThrow("CONFIRMATION");
  for (const hostname of [
    "http://localhost",
    "localhost",
    "hq.example.com/path",
    "hq.example.local",
  ]) {
    await expect(
      sendSmoke(
        ["--confirm-production-smoke", `--hostname=${hostname}`],
        {
          ZENTRA_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
        },
        sender,
      ),
    ).rejects.toThrow();
  }
  await expect(
    sendSmoke(
      ["--confirm-production-smoke", "--hostname=hq.example.com"],
      {
        ZENTRA_WEBHOOK_SECRET: "short",
      },
      sender,
    ),
  ).rejects.toThrow();
  expect(sender).not.toHaveBeenCalled();
});

it("signs timestamp.exactRawBody and preserves synthetic replay identity with one request", async () => {
  const secret = randomBytes(32).toString("hex");
  const eventId = randomUUID();
  const args = [
    "--confirm-production-smoke",
    "--hostname=api.hq.example.com",
    `--event-id=${eventId}`,
  ];
  const request = createSmokeRequest(
    args,
    { ZENTRA_WEBHOOK_SECRET: secret },
    new Date("2026-10-03T12:00:00Z"),
  );
  expect(request.url).toBe("https://api.hq.example.com/v1/webhooks/zentra");
  expect(request.init.redirect).toBe("error");
  expect(request.init.headers["x-zentra-signature"]).toBe(
    "sha256=" +
      createHmac("sha256", secret)
        .update(
          request.init.headers["x-zentra-timestamp"] + "." + request.init.body,
        )
        .digest("hex"),
  );
  expect(request.init.body).toBe(
    createSmokeRequest(args, { ZENTRA_WEBHOOK_SECRET: secret }).init.body,
  );
  expect(request.init.body).toContain("ops.receiver_smoke");
  expect(request.init.body).not.toContain(secret);
  const sender = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 202 }));
  await expect(
    sendSmoke(args, { ZENTRA_WEBHOOK_SECRET: secret }, sender),
  ).resolves.toEqual({ eventId, status: 202 });
  expect(sender).toHaveBeenCalledTimes(1);
});

it("never retries a timeout, network failure or non-202 response", async () => {
  for (const result of [
    new Response(null, { status: 500 }),
    new Error("network"),
  ]) {
    const sender = vi.fn<typeof fetch>();
    if (result instanceof Error) sender.mockRejectedValue(result);
    else sender.mockResolvedValue(result);
    await expect(
      sendSmoke(
        ["--confirm-production-smoke", "--hostname=hq.example.com"],
        {
          ZENTRA_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
        },
        sender,
      ),
    ).rejects.toThrow();
    expect(sender).toHaveBeenCalledTimes(1);
  }
});
