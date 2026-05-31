import { buildApp } from "./app";
import { RoomStore } from "./rooms";
import { attachWebSocket } from "./ws-handlers";
import { SlidingWindowLimiter } from "./rate-limit";
import { Metrics } from "./metrics";
import { log } from "./log";

const store = new RoomStore();
const metrics = new Metrics();
const ipLimiter = {
  inner: new SlidingWindowLimiter(10, 3600_000),
  allow(ip: string) {
    return this.inner.allow(ip);
  },
};

const app = buildApp({
  roomCount: () => store.count,
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

const port = Number(process.env.PORT ?? 3000);
Bun.serve({
  port,
  fetch,
  websocket: {
    ...websocket,
    idleTimeout: 60, // seconds — Bun also pings/pongs internally
  },
});
log.info({ port }, "relay listening");
