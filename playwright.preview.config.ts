import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["static-preview.spec.ts", "life-board.spec.ts", "reading-revisit.spec.ts", "thoughts-blog.spec.ts", "finance.spec.ts", "workspace-lock.spec.ts", "life-overview.spec.ts", "navigation-badges.spec.ts", "weread-github-sync.spec.ts", "media-trakt.spec.ts", "media-posters-worker.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3200/codex/",
    headless: true,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run serve:preview",
    url: "http://127.0.0.1:3200/codex/",
    reuseExistingServer: false,
    timeout: 30_000,
    env: { LIFE_PREVIEW_PORT: "3200" },
  },
});
