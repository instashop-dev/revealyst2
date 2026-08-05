import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4174",
  },
  webServer: {
    command: "node e2e/server.mjs",
    port: 4174,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
