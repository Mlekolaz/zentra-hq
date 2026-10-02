import { defineConfig } from "vitest/config";

if (process.env.TEST_DATABASE_URL === undefined) {
  throw new Error(
    "PostgreSQL integration tests were NOT RUN: set TEST_DATABASE_URL to an isolated test database.",
  );
}

export default defineConfig({
  test: {
    include: [
      "packages/database/src/**/*.postgres.test.ts",
      "apps/api/src/**/*.postgres.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
