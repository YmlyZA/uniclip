import { buildApp } from "./app";
import { RoomStore } from "./rooms";
import { attachWebSocket } from "./ws-handlers";
import { SlidingWindowLimiter } from "./rate-limit";
import { Metrics } from "./metrics";
import { staticHandler } from "./static";
import { log } from "./log";

const store = new RoomStore({ db: process.env.ROOM_DB_PATH ?? ":memory:" });
const metrics = new Metrics();
const ipLimiter = {
  inner: new SlidingWindowLimiter(10, 3600_000),
  allow(ip: string) {
    return this.inner.allow(ip);
  },
};

const app = buildApp({
  roomCount: () => store.totalCount,
  store,
  metrics,
  ipLimiter,
});
const { websocket, fetch, frameLimiter } = attachWebSocket(app, store, metrics);

setInterval(() => store.gc(), 60_000);
setInterval(() => {
  frameLimiter.sweep();
  ipLimiter.inner.sweep();
}, 60_000);

const serveStatic = process.env.STATIC_ROOT
  ? staticHandler(process.env.STATIC_ROOT)
  : null;

const port = Number(process.env.PORT ?? 3000);
Bun.serve({
  port,
  fetch: async (req, srv) => {
    const honoRes = await fetch(req, srv);
    if (honoRes.status !== 404 || !serveStatic) return honoRes;
    const fallback = await serveStatic(req);
    return fallback ?? honoRes;
  },
  websocket: {
    ...websocket,
    idleTimeout: 60,
  },
});
log.info({ port }, "relay listening");
