import { buildApp } from "./app";
import { RoomStore } from "./rooms";
import { log } from "./log";

const store = new RoomStore();
const app = buildApp({ roomCount: () => store.count, store });
const port = Number(process.env.PORT ?? 3000);

setInterval(() => store.gc(), 60_000);

Bun.serve({
  port,
  fetch: app.fetch,
});

log.info({ port }, "relay listening");
