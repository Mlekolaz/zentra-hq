// Test-only isolated database. This module is never imported by application bootstrap.
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { postgresPoolConfig } from "@zentra/database";
import { localPostgresTls } from "./local-postgres-tls.js";
import {
  migrationInvocation,
  runMigrationCommand,
  verifiedMigrationSql,
} from "./operator-tools.js";

export const localDatabaseFixture = async (usePsqlRunner = false) => {
  const input = process.env.TEST_DATABASE_URL;
  if (input === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
  const url = new URL(input);
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "54322"
  )
    throw new Error("ONLY_LOCAL_POSTGRES_127_0_0_1_54322_ALLOWED");
  const database = `hq_preflight_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: input });
  const apiPassword = randomBytes(32).toString("hex");
  const workerPassword = randomBytes(32).toString("hex");
  let databaseCreated = false;
  let rolesCreated = false;
  let owner: pg.Pool | undefined;
  let api: pg.Pool | undefined;
  let worker: pg.Pool | undefined;
  let tls: Awaited<ReturnType<typeof localPostgresTls>> | undefined;
  const cleanup = async () => {
    try {
      await Promise.all([api?.end(), worker?.end(), owner?.end()]);
      await tls?.cleanup();
      if (databaseCreated) await admin.query(`DROP DATABASE ${database}`);
      if (rolesCreated) await admin.query("DROP ROLE hq_api, hq_worker");
    } finally {
      await admin.end();
    }
  };
  try {
    // Roles are cluster-wide. Never alter/drop any pre-existing user identities.
    const existing = await admin.query(
      "SELECT 1 FROM pg_roles WHERE rolname IN ('hq_api','hq_worker')",
    );
    if (existing.rowCount !== 0)
      throw new Error("LOCAL_RUNTIME_ROLE_NAMES_ALREADY_EXIST");
    await admin.query(`CREATE DATABASE ${database}`);
    databaseCreated = true;
    url.pathname = `/${database}`;
    url.search = "";
    owner = new pg.Pool({ connectionString: url.toString(), max: 1 });
    const sql = await verifiedMigrationSql(process.cwd());
    if (usePsqlRunner) {
      const invocation = migrationInvocation(
        [
          "--apply",
          "--confirm-hq-migrations",
          "--local-container=supabase_db_zentra-hq",
        ],
        {
          ...process.env,
          PGHOST: "127.0.0.1",
          PGPORT: "5432",
          PGDATABASE: database,
          PGUSER: "postgres",
          PGPASSWORD: decodeURIComponent(url.password),
        },
      );
      if (invocation === null) throw new Error("MISSING_LOCAL_MIGRATOR");
      await runMigrationCommand(
        invocation.command,
        invocation.args,
        invocation.environment,
        sql,
      );
    } else {
      await owner.query("BEGIN");
      try {
        await owner.query(sql);
        await owner.query("COMMIT");
      } catch (error: unknown) {
        await owner.query("ROLLBACK");
        throw error;
      }
    }
    await owner.query("BEGIN");
    try {
      // Model managed-provider explicit grants, but only in this fresh test DB.
      await owner.query(`DO $$ DECLARE provider_role text; BEGIN
        FOREACH provider_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = provider_role) THEN
            EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', provider_role);
            EXECUTE format('GRANT ALL ON TABLE raw_events, events, processing_runs,
              dead_letters, audit_entries, event_queue, action_requests, approval_requests TO %I', provider_role);
          END IF;
        END LOOP;
      END $$`);
      await owner.query(
        await readFile(resolve("infra/postgres/runtime-roles.sql"), "utf8"),
      );
      await owner.query("COMMIT");
      rolesCreated = true;
    } catch (error: unknown) {
      await owner.query("ROLLBACK");
      throw error;
    }
    // Bind passwords as data; quote identifiers/literals on the database server only.
    await owner.query("BEGIN");
    try {
      await owner.query(
        "SELECT set_config('hq.api_test_password', $1, true), set_config('hq.worker_test_password', $2, true)",
        [apiPassword, workerPassword],
      );
      await owner.query(`DO $$ BEGIN
        EXECUTE format('ALTER ROLE hq_api PASSWORD %L', current_setting('hq.api_test_password'));
        EXECUTE format('ALTER ROLE hq_worker PASSWORD %L', current_setting('hq.worker_test_password'));
      END $$`);
      await owner.query("COMMIT");
    } catch (error: unknown) {
      await owner.query("ROLLBACK");
      throw error;
    }
    const runtimeUrl = (role: string, password: string) => {
      const runtime = new URL(url);
      runtime.username = role;
      runtime.password = password;
      return runtime.toString();
    };
    const apiUrl = runtimeUrl("hq_api", apiPassword);
    const workerUrl = runtimeUrl("hq_worker", workerPassword);
    tls = await localPostgresTls(input, usePsqlRunner);
    const apiTlsUrl = tls.url(apiUrl);
    const workerTlsUrl = tls.url(workerUrl);
    api = new pg.Pool(
      postgresPoolConfig(
        {
          NODE_ENV: "production",
          DATABASE_URL: apiTlsUrl,
          DATABASE_CA_CERT_PATH: tls.caPath,
        },
        5,
      ),
    );
    worker = new pg.Pool(
      postgresPoolConfig(
        {
          NODE_ENV: "production",
          DATABASE_URL: workerTlsUrl,
          DATABASE_CA_CERT_PATH: tls.caPath,
        },
        5,
      ),
    );
    return {
      owner,
      api,
      worker,
      apiUrl: apiTlsUrl,
      workerUrl: workerTlsUrl,
      tls,
      database,
      cleanup,
    };
  } catch (error: unknown) {
    await cleanup();
    throw error;
  }
};
