import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthenticationError, ConfigurationError } from "@zentra/domain";
import type {
  WebhookVerificationInput,
  WebhookVerificationResult,
  WebhookVerifier,
} from "./webhook-verifier.js";

const signaturePrefix = "sha256=";
const signaturePattern = /^sha256=([a-f0-9]{64})$/;
const timestampPattern = /^\d{10,}$/;

export const zentraWebhookHeaders = {
  signature: "x-zentra-signature",
  timestamp: "x-zentra-timestamp",
} as const;

export type ZentraWebhookClock = {
  now(): number;
};

export const createZentraWebhookSignature = (input: {
  secret: string;
  timestamp: string;
  rawBody: Buffer;
}): string => {
  if (input.secret.length < 32) {
    throw new ConfigurationError(
      "Zentra webhook secret must contain at least 32 characters",
    );
  }
  const digest = createHmac("sha256", input.secret)
    .update(Buffer.from(`${input.timestamp}.`, "utf8"))
    .update(input.rawBody)
    .digest("hex");
  return `${signaturePrefix}${digest}`;
};

export class ZentraWebhookVerifier implements WebhookVerifier {
  readonly #secret: string;

  public constructor(
    secret: string,
    private readonly allowedClockSkewMs = 5 * 60_000,
    private readonly clock: ZentraWebhookClock = { now: () => Date.now() },
  ) {
    if (secret.length < 32) {
      throw new ConfigurationError(
        "Zentra webhook secret must contain at least 32 characters",
      );
    }
    if (allowedClockSkewMs <= 0) {
      throw new ConfigurationError(
        "Zentra webhook clock skew must be positive",
      );
    }
    this.#secret = secret;
  }

  public async verify(
    input: WebhookVerificationInput,
  ): Promise<WebhookVerificationResult> {
    const timestamp = input.headers[zentraWebhookHeaders.timestamp];
    const suppliedSignature = input.headers[zentraWebhookHeaders.signature];
    if (
      timestamp === undefined ||
      suppliedSignature === undefined ||
      !timestampPattern.test(timestamp) ||
      !signaturePattern.test(suppliedSignature)
    ) {
      throw new AuthenticationError("Webhook verification failed");
    }

    const timestampSeconds = Number(timestamp);
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(this.clock.now() - timestampSeconds * 1000) >
        this.allowedClockSkewMs
    ) {
      throw new AuthenticationError("Webhook verification failed");
    }

    const expectedSignature = createZentraWebhookSignature({
      secret: this.#secret,
      timestamp,
      rawBody: input.rawBody,
    });
    const suppliedBytes = Buffer.from(
      suppliedSignature.slice(signaturePrefix.length),
      "hex",
    );
    const expectedBytes = Buffer.from(
      expectedSignature.slice(signaturePrefix.length),
      "hex",
    );
    const valid =
      suppliedBytes.length === expectedBytes.length &&
      timingSafeEqual(suppliedBytes, expectedBytes);
    if (!valid) throw new AuthenticationError("Webhook verification failed");

    return { verified: true, verifier: "zentra-hmac-sha256" };
  }
}
