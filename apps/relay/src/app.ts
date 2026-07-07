import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoomStore } from "./rooms";
import { RoomConflictError } from "./rooms";
import type { Metrics } from "./metrics";
import { renderSetupScript } from "./installer";
import type { UpdateSnapshot } from "./version";
import { ICE_SERVERS } from "@uniclip/protocol";
import { mintIceCredentials, type TurnConfig } from "./turn";
import { canonicalizeCode, isValidCustomCode } from "@uniclip/room-code";

const startedAt = Date.now();

export interface AppDeps {
  roomCount: () => number;
  store?: RoomStore;
  metrics?: Metrics;
  ipLimiter?: { allow: (ip: string) => boolean };
  staticRoot?: string;
  version?: string;
  gitSha?: string;
  updateStatus?: () => UpdateSnapshot;
  turn?: TurnConfig;
}

// "<sha256>  uniclip-<os>-<arch>" lines → { "uniclip-os-arch": "<sha256>" }.
function readChecksums(staticRoot: string): Record<string, string> {
  try {
    const txt = readFileSync(join(staticRoot, "dl", "checksums.txt"), "utf8");
    const out: Record<string, string> = {};
    for (const line of txt.split("\n")) {
      const m = line.trim().match(/^([0-9a-f]{64})\s+(\S+)$/i);
      if (m) out[m[2]!] = m[1]!;
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`readChecksums: ${(err as Error).message}`);
    return {};
  }
}

const CreateRoomBody = z.object({
  mode: z.enum(["A", "B"]),
  // Whether late joiners get recent clips. Defaults on; forced off for Mode B.
  backfill: z.boolean().optional(),
  // Ephemeral rooms persist nothing on any device and auto-expire items.
  ephemeral: z.boolean().optional(),
  // Optional user-chosen Mode-B code (e.g. "pizza-42"). Ignored for Mode A.
  customCode: z.string().optional(),
});

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  // The SPA may be served from a different origin than the relay (local dev,
  // E2E, or a separately-hosted front end). The relay is zero-knowledge and
  // uses no cookies/auth, so permissive CORS on the JSON API is safe.
  app.use("/api/*", cors());

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      version: deps.version ?? "dev",
      rooms: deps.roomCount(),
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );

  app.get("/api/version", (c) =>
    c.json({
      version: deps.version ?? "dev",
      gitSha: deps.gitSha ?? "dev",
      ...(deps.updateStatus?.() ?? { latest: null, updateAvailable: false, checkedAt: null }),
    }),
  );

  app.get("/api/ice", (c) =>
    c.json(deps.turn ? mintIceCredentials(deps.turn, Date.now()) : { iceServers: ICE_SERVERS }),
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
    let customId: string | undefined;
    if (parsed.data.mode === "B" && parsed.data.customCode !== undefined) {
      customId = canonicalizeCode(parsed.data.customCode);
      if (!isValidCustomCode(customId)) return c.json({ error: "invalid code" }, 400);
    }
    try {
      const room = deps.store.create(
        parsed.data.mode,
        parsed.data.backfill ?? true,
        parsed.data.ephemeral ?? false,
        customId,
      );
      const expiresAt = new Date(room.createdAt + 24 * 3600_000).toISOString();
      return c.json({ roomId: room.id, expiresAt });
    } catch (e) {
      if (e instanceof RoomConflictError) return c.json({ error: "code_taken" }, 409);
      throw e;
    }
  });

  app.get("/api/metrics", (c) => {
    if (!deps.metrics) return c.text("", 200);
    deps.metrics.setGauge("uniclip_rooms_total", deps.roomCount());
    return c.text(deps.metrics.render(), 200, {
      "content-type": "text/plain; version=0.0.4",
    });
  });

  if (deps.staticRoot) {
    const staticRoot = deps.staticRoot;
    app.get("/setup.sh", (c) => {
      const host = c.req.header("host") ?? "localhost";
      const scheme = c.req.header("x-forwarded-proto") ?? "http";
      try {
        const script = renderSetupScript({
          base: `${scheme}://${host}`,
          checksums: readChecksums(staticRoot),
        });
        return c.text(script, 200, { "content-type": "text/x-shellscript; charset=utf-8" });
      } catch {
        return c.text("bad request", 400);
      }
    });
  }

  return app;
}
