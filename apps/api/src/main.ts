import { resolve } from "node:path";
import { loadConfig } from "@zentra/shared";
import { config as loadDotenv } from "dotenv";
import { safeErrorSummary } from "@zentra/observability";
import { buildApp } from "./app.js";
import { createKernel } from "./kernel.js";

loadDotenv({
  path: resolve(import.meta.dirname, "../../../.env"),
  quiet: true,
});
const config = loadConfig(process.env);
const kernel = createKernel(config);
const app = await buildApp(config, kernel);
const abortController = new AbortController();
const workerPromise =
  kernel.workerRuntime?.start(abortController.signal) ?? Promise.resolve();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    abortController.abort();
    void app.close().catch((error: unknown) => {
      kernel.logger.error(
        { error: safeErrorSummary(error) },
        "API shutdown failed",
      );
    });
  });
}

app.addHook("onClose", async () => {
  abortController.abort();
  await workerPromise;
  await kernel.close();
});

try {
  await app.listen({ port: config.PORT, host: "127.0.0.1" });
} catch (error: unknown) {
  kernel.logger.fatal(
    { error: safeErrorSummary(error) },
    "API failed to start",
  );
  abortController.abort();
  await kernel.close();
  process.exitCode = 1;
}
