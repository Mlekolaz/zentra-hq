import { ConfigurationError } from "@zentra/domain";
import { describe, expect, it, vi } from "vitest";
import {
  DevelopmentWebhookVerifier,
  WebhookVerifierRegistry,
  type WebhookVerifier,
} from "./webhook-verifier.js";

describe("WebhookVerifierRegistry", () => {
  it("selects a verifier using the trusted source", async () => {
    const verify = vi.fn<WebhookVerifier["verify"]>(async (input) => ({
      verified: true,
      verifier: input.source,
    }));
    const registry = new WebhookVerifierRegistry([
      { source: "trusted-provider", verifier: { verify } },
    ]);
    await expect(
      registry.verify("trusted-provider", {
        headers: {},
        rawBody: Buffer.from("payload"),
      }),
    ).resolves.toEqual({ verified: true, verifier: "trusted-provider" });
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ source: "trusted-provider" }),
    );
  });

  it("fails closed for an unknown trusted source", async () => {
    const registry = new WebhookVerifierRegistry([]);
    await expect(
      registry.verify("unknown", { headers: {}, rawBody: Buffer.alloc(0) }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("never permits the development verifier in production", () => {
    expect(
      () => new DevelopmentWebhookVerifier("long-enough-secret", "production"),
    ).toThrow(ConfigurationError);
  });
});
