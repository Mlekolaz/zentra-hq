import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const productionEnvironment = {
  NODE_ENV: "production",
  RUNTIME_MODE: "postgres",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  WEBHOOK_VERIFIER: "provider",
  ZENTRA_WEBHOOK_SECRET: "local-test-secret-with-at-least-32-characters",
  EMBEDDED_WORKER: "false",
  WEB_ORIGIN: "https://hq-web.example.test",
};

describe("environment configuration", () => {
  it("preserves an explicit public database CA path and rejects empty values", () => {
    expect(
      loadConfig({
        ...productionEnvironment,
        DATABASE_CA_CERT_PATH: "/run/database-ca.crt",
      }).DATABASE_CA_CERT_PATH,
    ).toBe("/run/database-ca.crt");
    expect(() =>
      loadConfig({ ...productionEnvironment, DATABASE_CA_CERT_PATH: "" }),
    ).toThrow("Environment configuration is invalid");
  });
  it("fails fast for invalid values", () => {
    expect(() => loadConfig({ PORT: "99999" })).toThrow(
      "Environment configuration is invalid",
    );
  });

  it("fails when production storage and verifier config are missing", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      "Environment configuration is invalid",
    );
  });

  it("uses explicit safe development defaults", () => {
    expect(loadConfig({})).toMatchObject({
      NODE_ENV: "development",
      RUNTIME_MODE: "in-memory",
      EMBEDDED_WORKER: true,
      WEBHOOK_VERIFIER: "development",
      HOST: "127.0.0.1",
      WEB_ORIGIN: "http://localhost:5173",
    });
  });

  it("binds production containers on all IPv4 interfaces and honors runtime PORT", () => {
    expect(
      loadConfig({ ...productionEnvironment, PORT: "8765" }),
    ).toMatchObject({
      HOST: "0.0.0.0",
      PORT: 8765,
      EMBEDDED_WORKER: false,
    });
  });

  it("honors an explicit HOST", () => {
    expect(
      loadConfig({ ...productionEnvironment, HOST: "127.0.0.1" }).HOST,
    ).toBe("127.0.0.1");
    expect(loadConfig({ HOST: "0.0.0.0" }).HOST).toBe("0.0.0.0");
  });

  it.each(["", "0", "65536", "not-a-port", "4100.5"])(
    "rejects invalid PORT %s",
    (PORT) => {
      expect(() => loadConfig({ ...productionEnvironment, PORT })).toThrow();
    },
  );

  it.each(["", "http://localhost", "bad host"])(
    "rejects invalid HOST %s",
    (HOST) => {
      expect(() => loadConfig({ ...productionEnvironment, HOST })).toThrow();
    },
  );

  it.each([
    { RUNTIME_MODE: "in-memory" },
    { RUNTIME_MODE: undefined },
    { DATABASE_URL: undefined },
    { DATABASE_URL: "https://example.com/database" },
    { DATABASE_URL: "not-a-url" },
    { WEBHOOK_VERIFIER: "development" },
    { WEBHOOK_VERIFIER: undefined },
    { EMBEDDED_WORKER: "true" },
    { EMBEDDED_WORKER: undefined },
    { ZENTRA_WEBHOOK_SECRET: undefined },
    { ZENTRA_WEBHOOK_SECRET: "too-short" },
    { WEB_ORIGIN: undefined },
    { WEB_ORIGIN: "" },
    { WEB_ORIGIN: "not-a-url" },
  ])("fails closed for unsafe production overrides %j", (overrides) => {
    expect(() =>
      loadConfig({ ...productionEnvironment, ...overrides }),
    ).toThrow("Environment configuration is invalid");
  });

  it("fails fast when provider verification has no Zentra secret", () => {
    expect(() => loadConfig({ WEBHOOK_VERIFIER: "provider" })).toThrow(
      "Environment configuration is invalid",
    );
  });

  it("rejects a Zentra webhook secret shorter than 32 characters", () => {
    expect(() => loadConfig({ ZENTRA_WEBHOOK_SECRET: "too-short" })).toThrow(
      "Environment configuration is invalid",
    );
  });

  it("accepts a fully configured production Zentra channel", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        RUNTIME_MODE: "postgres",
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/hq",
        WEBHOOK_VERIFIER: "provider",
        ZENTRA_WEBHOOK_SECRET: "a-secure-secret-with-at-least-32-chars",
        EMBEDDED_WORKER: "false",
        WEB_ORIGIN: "https://hq-web.example.test",
      }),
    ).toMatchObject({
      NODE_ENV: "production",
      WEBHOOK_VERIFIER: "provider",
      WEB_ORIGIN: "https://hq-web.example.test",
    });
  });
});
