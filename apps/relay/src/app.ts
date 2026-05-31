import { Hono } from "hono";

const startedAt = Date.now();

export interface AppDeps {
  roomCount: () => number;
}

export function buildApp(deps: AppDeps = { roomCount: () => 0 }): Hono {
  const app = new Hono();
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      rooms: deps.roomCount(),
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );
  return app;
}
