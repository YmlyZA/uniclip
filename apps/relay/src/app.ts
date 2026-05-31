import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { RoomStore } from "./rooms";
import type { Metrics } from "./metrics";

const startedAt = Date.now();

export interface AppDeps {
  roomCount: () => number;
  store?: RoomStore;
  metrics?: Metrics;
  ipLimiter?: { allow: (ip: string) => boolean };
}

const CreateRoomBody = z.object({ mode: z.enum(["A", "B"]) });

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  // The SPA may be served from a different origin than the relay (local dev,
  // E2E, or a separately-hosted front end). The relay is zero-knowledge and
  // uses no cookies/auth, so permissive CORS on the JSON API is safe.
  app.use("/api/*", cors());

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      rooms: deps.roomCount(),
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );

  app.post("/api/room", async (c) => {
    if (!deps.store) return c.json({ error: "store not configured" }, 500);
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (deps.ipLimiter && !deps.ipLimiter.allow(ip)) {
      return c.json({ error: "rate limited" }, 429);
    }
    const json = await c.req.json().catch(() => null);
    const parsed = CreateRoomBody.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const room = deps.store.create(parsed.data.mode);
    const expiresAt = new Date(room.createdAt + 24 * 3600_000).toISOString();
    return c.json({ roomId: room.id, expiresAt });
  });

  app.get("/api/metrics", (c) => {
    if (!deps.metrics) return c.text("", 200);
    deps.metrics.setGauge("uniclip_rooms_total", deps.roomCount());
    return c.text(deps.metrics.render(), 200, {
      "content-type": "text/plain; version=0.0.4",
    });
  });

  return app;
}
