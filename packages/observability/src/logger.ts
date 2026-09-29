import pino from "pino";
import type { Logger, LoggerOptions } from "pino";
import { redactSensitive } from "./redaction.js";

export type LogLevel =
  "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export const createLogger = (
  level: LogLevel = "info",
  destination?: pino.DestinationStream,
): Logger => {
  const options: LoggerOptions = {
    level,
    base: { product: "zentra-hq" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      log(object) {
        return redactSensitive(object) as Record<string, unknown>;
      },
    },
    redact: {
      paths: [
        "authorization",
        "cookie",
        "access_token",
        "refresh_token",
        "api_key",
        "apikey",
        "password",
        "secret",
        "service_role",
        "client_secret",
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
      ],
      censor: "[REDACTED]",
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
};
