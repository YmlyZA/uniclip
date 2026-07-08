import { buildApp } from "./app";
import { RoomStore } from "./rooms";
import { attachWebSocket } from "./ws-handlers";
import { SlidingWindowLimiter } from "./rate-limit";
import { Metrics } from "./metrics";
import { staticHandler } from "./static";
import { log } from "./log";
import { UpdateChecker, fetchLatestRelease } from "./version";
import rootPkg from "../../../package.json";

process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
  log.error({ err }, "uncaughtException");
  // Undefined state after an uncaught throw — exit so the orchestrator
  // (restart: unless-stopped + the new healthcheck) restarts a clean process.
  process.exit(1);
});

const version = rootPkg.version;
const gitSha = process.env.UNICLIP_GIT_SHA ?? "dev";

const turnUrls = (process.env.TURN_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const turnSecret = process.env.TURN_SECRET ?? "";
const turnTtl = Number(process.env.TURN_TTL ?? 86400) || 86400;
const turn = turnUrls.length > 0 && turnSecret ? { urls: turnUrls, secret: turnSecret, ttlSeconds: turnTtl } : undefined;

const updateEnabled = !/^(off|0|false)$/i.test((process.env.UPDATE_CHECK ?? "").trim());
const updateRepo = process.env.UPDATE_REPO ?? "YmlyZA/uniclip";
const updateChecker = new UpdateChecker({
  current: version,
  enabled: updateEnabled,
  ttlMs: 3_600_000,
  fetchLatest: () => fetchLatestRelease(updateRepo),
});

const store = new RoomStore({ db: process.env.ROOM_DB_PATH ?? ":memory:" });
const metrics = new Metrics();
const roomIpLimit = Number(process.env.ROOM_IP_LIMIT ?? 10) || 10;
const ipLimiter = {
  inner: new SlidingWindowLimiter(roomIpLimit, 3600_000),
  allow(ip: string) {
    return this.inner.allow(ip);
  },
};
const wsConnectLimit = Number(process.env.WS_CONNECT_IP_LIMIT ?? 30) || 30;
const wsConnectLimiter = new SlidingWindowLimiter(wsConnectLimit, 10_000);

const app = buildApp({
  roomCount: () => store.totalCount,
  store,
  metrics,
  ipLimiter,
  version,
  gitSha,
  ...(turn ? { turn } : {}),
  updateStatus: () => updateChecker.snapshot(),
  ...(process.env.STATIC_ROOT ? { staticRoot: process.env.STATIC_ROOT } : {}),
});
const { websocket, fetch, frameLimiter, chunkLimiter, signalLimiter } = attachWebSocket(
  app,
  store,
  metrics,
  wsConnectLimiter,
);

setInterval(() => {
  const { aged, idle, expiredSockets } = store.gc();
  if (aged > 0 || idle > 0) log.info({ aged, idle }, "gc");
  if (expiredSockets > 0) {
    metrics.inc("uniclip_ws_closed_total", expiredSockets, { code: "ROOM_EXPIRED" });
  }
}, 60_000);
// Keep in sync with the five limiters in play (frame/chunk/signal from
// attachWebSocket, ipLimiter.inner, wsConnectLimiter) — an unswept limiter
// leaks a Map entry per never-reused key forever.
setInterval(() => {
  frameLimiter.sweep();
  chunkLimiter.sweep();
  signalLimiter.sweep();
  ipLimiter.inner.sweep();
  wsConnectLimiter.sweep();
}, 60_000);

const serveStatic = process.env.STATIC_ROOT
  ? staticHandler(process.env.STATIC_ROOT)
  : null;

// Optional native TLS: set TLS_CERT and TLS_KEY (PEM file paths) to serve HTTPS
// directly — used for LAN cross-device testing where clipboard APIs require a
// secure context. Unset (the default, and production behind a TLS proxy) keeps
// plain HTTP unchanged.
const tlsCert = process.env.TLS_CERT;
const tlsKey = process.env.TLS_KEY;
const tls =
  tlsCert && tlsKey ? { cert: Bun.file(tlsCert), key: Bun.file(tlsKey) } : undefined;

const port = Number(process.env.PORT ?? 3000);
Bun.serve({
  port,
  ...(tls ? { tls } : {}),
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
log.info({ port, tls: Boolean(tls) }, "relay listening");
