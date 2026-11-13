import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests share one local database. Running files in parallel
    // would let one test's writes change another's fixture, so the suite is
    // serial by file. It stays fast because each test is a single statement
    // against a local Postgres.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
