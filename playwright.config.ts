import { defineConfig, devices } from "@playwright/test";

// アプリを起動した状態（docker compose up）で npm run test:e2e
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000", ...devices["Pixel 7"] },
});
