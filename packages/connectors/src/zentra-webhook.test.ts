import { describe, expect, it } from "vitest";
import {
  createZentraWebhookSignature,
  ZentraWebhookVerifier,
} from "./zentra-webhook.js";

const secret = "zentra-test-secret-that-is-at-least-32-chars";
const wrongSecret = "wrong--test-secret-that-is-at-least-32-chars";
const now = 1_760_000_000_000;
const currentTimestamp = String(now / 1000);
const body = Buffer.from('{"eventId":"event-1","value":1}', "utf8");

const signatureFor = (
  rawBody: Buffer = body,
  timestamp: string = currentTimestamp,
  signingSecret: string = secret,
) =>
  createZentraWebhookSignature({ secret: signingSecret, timestamp, rawBody });

const verify = async (input?: {
  rawBody?: Buffer;
  timestamp?: string;
  signature?: string;
  omitTimestamp?: boolean;
  omitSignature?: boolean;
}) => {
  const rawBody = input?.rawBody ?? body;
  const timestamp = input?.timestamp ?? currentTimestamp;
  const headers: Record<string, string> = {};
  if (!input?.omitTimestamp) headers["x-zentra-timestamp"] = timestamp;
  if (!input?.omitSignature)
    headers["x-zentra-signature"] =
      input?.signature ?? signatureFor(rawBody, timestamp);
  return new ZentraWebhookVerifier(secret, 5 * 60_000, {
    now: () => now,
  }).verify({ source: "zentra", headers, rawBody });
};

describe("ZentraWebhookVerifier", () => {
  it("accepts a valid signature with a current timestamp", async () => {
    await expect(verify()).resolves.toEqual({
      verified: true,
      verifier: "zentra-hmac-sha256",
    });
  });

  it("rejects a timestamp older than the replay window", async () => {
    const timestamp = String((now - 5 * 60_000 - 1_000) / 1000);
    await expect(
      verify({ timestamp, signature: signatureFor(body, timestamp) }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("rejects a timestamp too far in the future", async () => {
    const timestamp = String((now + 5 * 60_000 + 1_000) / 1000);
    await expect(
      verify({ timestamp, signature: signatureFor(body, timestamp) }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("rejects an invalid timestamp", async () => {
    await expect(
      verify({ timestamp: "not-a-timestamp" }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("rejects a missing timestamp", async () => {
    await expect(verify({ omitTimestamp: true })).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("rejects an invalid signature", async () => {
    await expect(
      verify({ signature: `sha256=${"0".repeat(64)}` }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("rejects a missing signature", async () => {
    await expect(verify({ omitSignature: true })).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("rejects a malformed signature", async () => {
    await expect(verify({ signature: "md5=abc" })).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("rejects a signature with a mismatched byte length", async () => {
    await expect(verify({ signature: "sha256=00" })).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("rejects a body modified after signing", async () => {
    const modified = Buffer.from('{"eventId":"event-1","value":2}', "utf8");
    await expect(
      verify({ rawBody: modified, signature: signatureFor(body) }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("rejects a timestamp modified after signing", async () => {
    const modifiedTimestamp = String(now / 1000 + 1);
    await expect(
      verify({
        timestamp: modifiedTimestamp,
        signature: signatureFor(body, currentTimestamp),
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("rejects a signature created with the wrong secret", async () => {
    await expect(
      verify({ signature: signatureFor(body, currentTimestamp, wrongSecret) }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("signs exact bytes rather than parsed JSON", async () => {
    const compact = Buffer.from('{"a":1,"b":2}', "utf8");
    const formatted = Buffer.from('{\n  "a": 1,\n  "b": 2\n}', "utf8");
    expect(signatureFor(compact)).not.toBe(signatureFor(formatted));
    await expect(
      verify({ rawBody: formatted, signature: signatureFor(compact) }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });
});
