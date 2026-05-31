import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";
import { attachWebSocket } from "../src/ws-handlers";

let server: ReturnType<typeof Bun.serve> | null = null;
let baseHttp = "";
let baseWs = "";

beforeEach(async () => {
  const store = new RoomStore();
  const app = buildApp({ roomCount: () => store.count, store });
  const { websocket, fetch } = attachWebSocket(app, store);
  server = Bun.serve({ port: 0, fetch, websocket });
  baseHttp = `http://localhost:${server.port}`;
  baseWs = `ws://localhost:${server.port}`;
});

afterEach(() => {
  server?.stop(true);
  server = null;
});

async function mintRoom(mode: "A" | "B"): Promise<string> {
  const res = await fetch(`${baseHttp}/api/room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const body = (await res.json()) as { roomId: string };
  return body.roomId;
}

function openSocket(url: string): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: any[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    ws.onopen = () => resolve({ ws, messages });
    ws.onerror = reject;
  });
}

describe("WebSocket lifecycle", () => {
  it("closes with 4404 for an unknown room", async () => {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${baseWs}/ws/zzzzzz`);
      ws.onclose = (e) => {
        expect(e.code).toBe(4404);
        resolve();
      };
    });
  });

  it("sends hello on connect", async () => {
    const id = await mintRoom("A");
    const { ws, messages } = await openSocket(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 30));
    expect(messages[0]).toMatchObject({
      type: "hello",
      roomId: id,
      peerCount: 1,
    });
    ws.close();
  });

  it("broadcasts peer-joined and peer-left", async () => {
    const id = await mintRoom("A");
    const a = await openSocket(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 20));
    const b = await openSocket(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 30));
    expect(a.messages.some((m) => m.type === "peer-joined" && m.peerCount === 2)).toBe(true);
    b.ws.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(a.messages.some((m) => m.type === "peer-left" && m.peerCount === 1)).toBe(true);
    a.ws.close();
  });
});
