import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("environment configuration", () => {
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
    });
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
      }),
    ).toMatchObject({
      NODE_ENV: "production",
      WEBHOOK_VERIFIER: "provider",
    });
  });
});
