import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
  resolve: {
    alias: { "@nekord/bot-sdk": path.resolve("packages/bot-sdk/src/index.ts") },
  },
});
