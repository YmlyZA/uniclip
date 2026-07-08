import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";
import { attachWebSocket } from "../src/ws-handlers";
import { SlidingWindowLimiter } from "../src/rate-limit";
import { Metrics } from "../src/metrics";

function boot(connectLimit: number) {
  const store = new RoomStore();
  const metrics = new Metrics();
  const app = buildApp({ roomCount: () => store.count, store, metrics });
  const limiter = new SlidingWindowLimiter(connectLimit, 10_000);
  const { websocket, fetch } = attachWebSocket(app, store, metrics, limiter);
  const server = Bun.serve({ port: 0, fetch, websocket });
  return { server, url: `ws://localhost:${server.port}`, metrics };
}

function waitClosed(url: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url}/ws/NOROOM`);
    ws.onclose = (e) => resolve(e.code);
  });
}

describe("uniclip_ws_closed_total metric", () => {
  it("increments on ROOM_NOT_FOUND close", async () => {
    const { server, url, metrics } = boot(10);
    await waitClosed(url);
    const out = metrics.render();
    expect(out).toContain('uniclip_ws_closed_total{code="ROOM_NOT_FOUND"} 1');
    server.stop(true);
  });

  it("increments on RATE_LIMIT close once the connect limiter trips", async () => {
    const { server, url, metrics } = boot(1);
    await waitClosed(url); // under limit → ROOM_NOT_FOUND
    await waitClosed(url); // over limit → RATE_LIMIT
    const out = metrics.render();
    expect(out).toContain('uniclip_ws_closed_total{code="ROOM_NOT_FOUND"} 1');
    expect(out).toContain('uniclip_ws_closed_total{code="RATE_LIMIT"} 1');
    server.stop(true);
  });
});
