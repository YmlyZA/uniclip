import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";
import { attachWebSocket } from "../src/ws-handlers";
import { SlidingWindowLimiter } from "../src/rate-limit";
import { CLOSE_CODES } from "@uniclip/protocol";

function boot(connectLimit: number) {
  const store = new RoomStore();
  const app = buildApp({ roomCount: () => store.count, store });
  const limiter = new SlidingWindowLimiter(connectLimit, 10_000);
  const { websocket, fetch } = attachWebSocket(app, store, undefined, limiter);
  const server = Bun.serve({ port: 0, fetch, websocket });
  return { server, url: `ws://localhost:${server.port}` };
}

function closeCode(url: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url}/ws/NOROOM`);
    ws.onclose = (e) => resolve(e.code);
  });
}

describe("WS connect rate-limit", () => {
  it("closes over-limit connection attempts with RATE_LIMIT", async () => {
    const { server, url } = boot(2);
    const c1 = await closeCode(url); // under limit → ROOM_NOT_FOUND
    const c2 = await closeCode(url);
    const c3 = await closeCode(url); // over limit → RATE_LIMIT
    expect(c1).toBe(CLOSE_CODES.ROOM_NOT_FOUND);
    expect(c2).toBe(CLOSE_CODES.ROOM_NOT_FOUND);
    expect(c3).toBe(CLOSE_CODES.RATE_LIMIT);
    server.stop(true);
  });
});
