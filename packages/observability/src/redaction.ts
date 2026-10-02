import { AppError } from "@zentra/domain";

const sensitiveKey =
  /^(authorization|proxy-authorization|cookie|set-cookie|access_?token|refresh_?token|api_?key|apikey|password|secret|webhook_?secret|zentra_?webhook_?secret|signature|x-zentra-signature|service_?role|client_?secret)$/i;
const serviceRoleLike =
  /(?:service[_-]?role|eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,})/i;

const redactString = (value: string): string =>
  serviceRoleLike.test(value) ? "[REDACTED]" : value;

export const redactSensitive = (
  value: unknown,
  seen = new WeakSet<object>(),
): unknown => {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value))
    return value.map((entry) => redactSensitive(entry, seen));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = sensitiveKey.test(key)
      ? "[REDACTED]"
      : redactSensitive(entry, seen);
  }
  return output;
};

const allowedHeaderNames = new Set([
  "content-type",
  "user-agent",
  "x-request-id",
  "x-provider-event",
]);

export const sanitizeHeaders = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (!allowedHeaderNames.has(normalized) || value === undefined) continue;
    result[normalized] = Array.isArray(value) ? value.join(",") : value;
  }
  return result;
};

export const safeErrorSummary = (
  error: unknown,
): { code: string; message: string; retryable: boolean } => {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.safeMessage,
      retryable: error.retryable,
    };
  }
  return {
    code: "UNEXPECTED_ERROR",
    message: "Unexpected internal error",
    retryable: false,
  };
};
