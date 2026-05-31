import { buildApp } from "./app";
import { log } from "./log";

const app = buildApp();
const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  fetch: app.fetch,
});

log.info({ port }, "relay listening");
