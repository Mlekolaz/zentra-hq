import { ConfigurationError } from "@zentra/domain";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const configSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    RUNTIME_MODE: z.enum(["in-memory", "postgres"]).default("in-memory"),
    DATABASE_URL: z.string().url().optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(4100),
    WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    WEBHOOK_DEV_SECRET: z.string().min(12).default("local-development-only"),
    WEBHOOK_VERIFIER: z
      .enum(["development", "provider"])
      .default("development"),
    EMBEDDED_WORKER: booleanString.default(true),
    WORKER_POLL_MS: z.coerce.number().int().min(10).max(60_000).default(100),
    WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(4),
  })
  .superRefine((config, context) => {
    if (
      config.RUNTIME_MODE === "postgres" &&
      config.DATABASE_URL === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "Required in postgres mode",
      });
    }
    if (
      config.NODE_ENV === "production" &&
      config.RUNTIME_MODE !== "postgres"
    ) {
      context.addIssue({
        code: "custom",
        path: ["RUNTIME_MODE"],
        message: "Production requires postgres mode",
      });
    }
    if (
      config.NODE_ENV === "production" &&
      config.WEBHOOK_VERIFIER === "development"
    ) {
      context.addIssue({
        code: "custom",
        path: ["WEBHOOK_VERIFIER"],
        message: "Development webhook verification is forbidden in production",
      });
    }
    if (config.NODE_ENV === "production" && config.EMBEDDED_WORKER) {
      context.addIssue({
        code: "custom",
        path: ["EMBEDDED_WORKER"],
        message: "Production requires the standalone worker process",
      });
    }
    if (config.RUNTIME_MODE === "in-memory" && !config.EMBEDDED_WORKER) {
      context.addIssue({
        code: "custom",
        path: ["EMBEDDED_WORKER"],
        message: "In-memory mode requires the embedded development worker",
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

export const loadConfig = (
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): AppConfig => {
  const result = configSchema.safeParse(environment);
  if (!result.success) {
    throw new ConfigurationError("Environment configuration is invalid", {
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  return result.data;
};
