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
      // Poll a real route, not just the open port: Bun `--hot` accepts TCP
      // connections before the relay's routes finish first-request JIT warmup,
      // so a `port` gate lets tests race an un-ready relay (POST /api/room
      // hits a server that isn't serving yet). `/api/health` 200 means routes
      // are live.
      url: "http://localhost:3000/api/health",
      env: { PORT: "3000" },
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @uniclip/web dev",
      url: "http://localhost:5173",
      env: { VITE_RELAY_BASE: "http://localhost:3000" },
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
