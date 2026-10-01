import { timingSafeEqual } from "node:crypto";
import { AuthenticationError, ConfigurationError } from "@zentra/domain";

export type WebhookVerificationInput = {
  source: string;
  headers: Readonly<Record<string, string | undefined>>;
  rawBody: Buffer;
};

export type WebhookVerificationResult = {
  verified: true;
  verifier: string;
};

export interface WebhookVerifier {
  verify(input: WebhookVerificationInput): Promise<WebhookVerificationResult>;
}

export type WebhookVerifierRegistration = {
  source: string;
  verifier: WebhookVerifier;
};

export class WebhookVerifierRegistry {
  readonly #verifiers = new Map<string, WebhookVerifier>();

  public constructor(registrations: readonly WebhookVerifierRegistration[]) {
    for (const registration of registrations) {
      if (this.#verifiers.has(registration.source)) {
        throw new ConfigurationError(
          `Webhook verifier is registered twice for ${registration.source}`,
        );
      }
      this.#verifiers.set(registration.source, registration.verifier);
    }
  }

  public async verify(
    trustedSource: string,
    input: Omit<WebhookVerificationInput, "source">,
  ): Promise<WebhookVerificationResult> {
    const verifier = this.#verifiers.get(trustedSource);
    if (verifier === undefined) {
      throw new AuthenticationError("Webhook verification failed");
    }
    return verifier.verify({ ...input, source: trustedSource });
  }
}

export class DevelopmentWebhookVerifier implements WebhookVerifier {
  readonly #secret: Buffer;

  public constructor(secret: string, nodeEnvironment: string) {
    if (nodeEnvironment === "production") {
      throw new ConfigurationError(
        "Development webhook verification cannot run in production",
      );
    }
    if (secret.length < 12) {
      throw new ConfigurationError(
        "Development webhook secret must contain at least 12 characters",
      );
    }
    this.#secret = Buffer.from(secret);
  }

  public async verify(
    input: WebhookVerificationInput,
  ): Promise<WebhookVerificationResult> {
    const supplied = Buffer.from(
      input.headers["x-zentra-webhook-secret"] ?? "",
    );
    const valid =
      supplied.length === this.#secret.length &&
      timingSafeEqual(supplied, this.#secret);
    if (!valid) throw new AuthenticationError("Webhook verification failed");
    return { verified: true, verifier: "development-secret" };
  }
}
