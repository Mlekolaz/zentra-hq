import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { redactSensitive, sanitizeHeaders } from "./redaction.js";

describe("secret redaction", () => {
  it("redacts authorization headers", () => {
    expect(
      redactSensitive({ headers: { authorization: "Bearer private" } }),
    ).toEqual({
      headers: { authorization: "[REDACTED]" },
    });
  });

  it("redacts nested access tokens and passwords", () => {
    expect(
      redactSensitive({
        data: { access_token: "token-123", password: "password-123" },
      }),
    ).toEqual({
      data: { access_token: "[REDACTED]", password: "[REDACTED]" },
    });
  });

  it("does not retain sensitive headers in raw-event metadata", () => {
    expect(
      sanitizeHeaders({
        authorization: "secret",
        cookie: "session=secret",
        "content-type": "application/json",
      }),
    ).toEqual({ "content-type": "application/json" });
  });

  it("does not emit a service-role-looking value in structured logs", () => {
    const lines: string[] = [];
    const logger = createLogger("info", {
      write: (message: string) => lines.push(message),
    });
    logger.info(
      { nested: { value: "service_role=super-secret-value" } },
      "test",
    );
    expect(lines.join("\n")).not.toContain("super-secret-value");
    expect(lines.join("\n")).toContain("[REDACTED]");
  });
});
