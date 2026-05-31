import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false, // we share a single relay
  reporter: process.env.CI ? "github" : "list",
  use: {
    headless: true,
    permissions: ["clipboard-read", "clipboard-write"],
    baseURL: process.env.UNICLIP_WEB ?? "http://localhost:5173",
  },
  webServer: [
    {
      command: "pnpm --filter @uniclip/relay dev",
      port: 3000,
      env: { PORT: "3000" },
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @uniclip/web dev",
      port: 5173,
      env: { VITE_RELAY_BASE: "http://localhost:3000" },
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
