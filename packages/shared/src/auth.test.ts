import { AuthenticationError, ConfigurationError } from "@zentra/domain";
import { describe, expect, it } from "vitest";
import {
  DevelopmentIdentityProvider,
  ReceiverOnlyIdentityProvider,
} from "./auth.js";

describe("identity boundary", () => {
  it.each(["production", "staging", ""])(
    "rejects development identity in %s",
    (environment) => {
      expect(() => new DevelopmentIdentityProvider(environment)).toThrow(
        ConfigurationError,
      );
    },
  );

  it.each(["development", "test"])(
    "keeps development identity in %s",
    async (environment) => {
      await expect(
        new DevelopmentIdentityProvider(environment).resolve(),
      ).resolves.toMatchObject({ mode: "development" });
    },
  );

  it("never fabricates an operator in receiver-only mode", async () => {
    await expect(new ReceiverOnlyIdentityProvider().resolve()).rejects.toThrow(
      AuthenticationError,
    );
  });
});
