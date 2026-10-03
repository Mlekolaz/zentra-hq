import { defineConfig } from "vitest/config";

if (
  process.env.TEST_DATABASE_URL === undefined ||
  process.env.HQ_TEST_IMAGE === undefined
)
  throw new Error(
    "TEST_DATABASE_URL and locally built HQ_TEST_IMAGE are required",
  );

export default defineConfig({
  test: {
    include: ["apps/api/**/*.container.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
