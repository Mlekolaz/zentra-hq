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
});
