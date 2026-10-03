import { postgresPoolConfig } from "@zentra/database";
import pg from "pg";
import { expect, it } from "vitest";
import { localPostgresTls } from "./ops/local-postgres-tls.js";

it("connects through verified local TLS and rejects an untrusted CA, wrong hostname and plaintext downgrade", async () => {
  const input = process.env.TEST_DATABASE_URL;
  if (!input) throw new Error("TEST_DATABASE_URL_REQUIRED");
  const tls = await localPostgresTls(input);
  const config = {
    NODE_ENV: "production" as const,
    DATABASE_URL: tls.url(input),
    DATABASE_CA_CERT_PATH: tls.caPath,
  };
  const pool = new pg.Pool(postgresPoolConfig(config, 1));
  try {
    expect(
      (await pool.query<{ value: number }>("SELECT 42::int AS value")).rows[0]
        ?.value,
    ).toBe(42);
    const untrusted = new pg.Client({
      ...postgresPoolConfig({ ...config, DATABASE_CA_CERT_PATH: undefined }, 1),
      connectionTimeoutMillis: 3000,
    });
    try {
      await expect(untrusted.connect()).rejects.toMatchObject({
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      });
    } finally {
      await untrusted.end();
    }
    const mismatched = await localPostgresTls(input, false, true);
    const wrongHost = new pg.Client({
      ...postgresPoolConfig(
        {
          ...config,
          DATABASE_URL: mismatched.url(input),
          DATABASE_CA_CERT_PATH: mismatched.caPath,
        },
        1,
      ),
      connectionTimeoutMillis: 3000,
    });
    try {
      await expect(wrongHost.connect()).rejects.toMatchObject({
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      });
    } finally {
      await wrongHost.end();
      await mismatched.cleanup();
    }
    // The unchanged local plaintext server must not be accepted by production.
    const plaintext = new pg.Client({
      ...postgresPoolConfig({ ...config, DATABASE_URL: input }, 1),
      connectionTimeoutMillis: 3000,
    });
    try {
      await expect(plaintext.connect()).rejects.toThrow("does not support SSL");
    } finally {
      await plaintext.end();
    }
  } finally {
    await pool.end();
    await tls.cleanup();
  }
});
