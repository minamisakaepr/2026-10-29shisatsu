import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    globalSetup: ["tests/globalSetup.ts"],
    setupFiles: ["tests/setupEnv.ts"],
    // DB を使うテストは順番に（台帳のハッシュチェーンが1本の列のため）
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
