import { buildApp } from "./app";
import { RoomStore } from "./rooms";
import { attachWebSocket } from "./ws-handlers";
import { log } from "./log";

const store = new RoomStore();
const app = buildApp({ roomCount: () => store.count, store });
const { websocket, fetch } = attachWebSocket(app, store);

setInterval(() => store.gc(), 60_000);

const port = Number(process.env.PORT ?? 3000);
Bun.serve({ port, fetch, websocket });
log.info({ port }, "relay listening");
