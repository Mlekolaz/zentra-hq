import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError } from "@zentra/domain";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPoolConfig } from "./postgres-config.js";

const production = {
  NODE_ENV: "production" as const,
  DATABASE_URL:
    "postgresql://hq_api:synthetic%40password@db.example.supabase.co:5432/postgres",
};
afterEach(() => vi.unstubAllEnvs());

describe("production PostgreSQL TLS", () => {
  it("derives credentials/endpoint from URL and uses the bundled verified Root CA", () => {
    const config = postgresPoolConfig(production, 10);
    expect(config).toMatchObject({
      host: "db.example.supabase.co",
      port: 5432,
      user: "hq_api",
      password: "synthetic@password",
      database: "postgres",
      max: 10,
    });
    expect(config.connectionString).toBeUndefined();
    expect(config.ssl).toMatchObject({
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      servername: "db.example.supabase.co",
    });
    if (typeof config.ssl !== "object" || typeof config.ssl.ca !== "string")
      throw new Error("EXPLICIT_CA_REQUIRED");
    const ca = new X509Certificate(config.ssl.ca);
    expect(ca.subject).toContain("Supabase Root 2021 CA");
    expect(ca.ca).toBe(true);
    expect(ca.fingerprint256).toBe(
      "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
    );
    expect(ca.verify(ca.publicKey)).toBe(true);
    // Exercise the actual pg parser without making a connection.
    const client = new pg.Client(config);
    expect(client.ssl).toEqual(config.ssl);
    expect(
      config.ssl.checkServerIdentity?.("ignored.example", {
        ...ca.toLegacyObject(),
        subjectaltname: "DNS:untrusted.example",
      }),
    ).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it.each([
    "sslmode=require",
    "sslmode=disable",
    "sslmode=no-verify",
    "sslmode=verify-full",
    "sslrootcert=ca.crt",
    "sslcert=cert.pem",
    "sslkey=key.pem",
    "ssl=false",
    "ssl=0",
    "uselibpqcompat=true",
    "sslnegotiation=direct",
    "host=localhost",
    "password=other",
    "SSLMode=require",
  ])("rejects competing URL configuration %s", (query) => {
    expect(() =>
      postgresPoolConfig(
        { ...production, DATABASE_URL: `${production.DATABASE_URL}?${query}` },
        5,
      ),
    ).toThrow(ConfigurationError);
  });
  it.each([
    "not-a-url",
    "https://example.com",
    "postgres://hq_api:password@localhost:65536/postgres",
    "postgres://localhost/postgres",
    "postgres://hq_api:password@localhost",
    "postgres://hq_api:%ZZ@localhost/postgres",
    "postgres://hq_api:password@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
    "postgres://hq_worker:password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
    "postgres://hq_api:password@aws-0-eu-central-1.POOLER.SUPABASE.COM:5432/postgres",
  ])("fails safely on invalid/ambiguous/non-direct URL", (url) => {
    let error: unknown;
    try {
      postgresPoolConfig({ ...production, DATABASE_URL: url }, 5);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(String(error)).not.toContain(url);
  });
  it("refuses globally disabled certificate verification", () => {
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    expect(() => postgresPoolConfig(production, 5)).toThrow(
      "Insecure global TLS",
    );
  });
  it("fails before Pool creation when CA is missing or invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hq-ca-validation-"));
    const path = join(directory, "ca.pem");
    try {
      expect(() =>
        postgresPoolConfig({ ...production, DATABASE_CA_CERT_PATH: path }, 5),
      ).toThrow("Root CA is missing");
      await writeFile(path, "not a certificate");
      expect(() =>
        postgresPoolConfig({ ...production, DATABASE_CA_CERT_PATH: path }, 5),
      ).toThrow("Root CA is missing");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("ignores PGSSLMODE/PGHOST ambient overrides, preserving the explicit URL and TLS", () => {
    vi.stubEnv("PGSSLMODE", "disable");
    vi.stubEnv("PGHOST", "untrusted.example");
    const config = postgresPoolConfig(production, 5);
    expect(config.host).toBe("db.example.supabase.co");
    expect(new pg.Client(config).ssl).toMatchObject({
      rejectUnauthorized: true,
    });
  });
  it("retains search_path options without parsing TLS from the URL", () => {
    expect(
      postgresPoolConfig(
        {
          ...production,
          DATABASE_URL: `${production.DATABASE_URL}?options=-c%20search_path%3Dpublic&application_name=hq_api`,
        },
        5,
      ),
    ).toMatchObject({
      options: "-c search_path=public",
      application_name: "hq_api",
    });
  });
  it.each(["development", "test"] as const)(
    "preserves the existing %s connection workflow",
    (NODE_ENV) => {
      const DATABASE_URL =
        "postgres://postgres:postgres@127.0.0.1:54322/postgres";
      expect(postgresPoolConfig({ NODE_ENV, DATABASE_URL }, 5)).toEqual({
        connectionString: DATABASE_URL,
        max: 5,
      });
    },
  );
});
