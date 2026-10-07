import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "workflow.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    headless: true,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://127.0.0.1:3100/api/tasks",
    reuseExistingServer: false,
    timeout: 90_000,
    env: { LIFE_DATA_DIR: `/tmp/life-workbench-e2e-${process.pid}`, NEXT_TELEMETRY_DISABLED: "1" },
  },
});
