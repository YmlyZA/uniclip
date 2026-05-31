import { defineConfig } from "vitest/config";

// The relay test suite runs under Bun (`bun --bun vitest`) because the
// integration tests spin up a real `Bun.serve` with native WebSockets.
// Under Bun's loader, vitest's transform pipeline and Bun's external
// resolution produce two copies of some CJS/ESM packages, which strips
// their named exports (e.g. `z.object` becomes undefined). Inlining these
// deps forces them through vitest's own transform so the module graph is
// unified. See packages/relay test notes.
export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [/zod/, /hono/, /ulid/],
      },
    },
  },
});
