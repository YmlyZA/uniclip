import { Hono } from "hono";
import { z } from "zod";
import type { RoomStore } from "./rooms";

const startedAt = Date.now();

export interface AppDeps {
  roomCount: () => number;
  store?: RoomStore;
}

const CreateRoomBody = z.object({ mode: z.enum(["A", "B"]) });

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      rooms: deps.roomCount(),
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );

  app.post("/api/room", async (c) => {
    if (!deps.store) return c.json({ error: "store not configured" }, 500);
    const json = await c.req.json().catch(() => null);
    const parsed = CreateRoomBody.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const room = deps.store.create(parsed.data.mode);
    const expiresAt = new Date(room.createdAt + 24 * 3600_000).toISOString();
    return c.json({ roomId: room.id, expiresAt });
  });

  return app;
}
