import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";
import { attachWebSocket } from "../src/ws-handlers";

let server: ReturnType<typeof Bun.serve> | null = null;
let baseHttp = "";
let baseWs = "";

beforeEach(() => {
  const store = new RoomStore();
  const app = buildApp({ roomCount: () => store.count, store });
  const { websocket, fetch } = attachWebSocket(app, store);
  server = Bun.serve({ port: 0, fetch, websocket });
  baseHttp = `http://localhost:${server.port}`;
  baseWs = `ws://localhost:${server.port}`;
});
afterEach(() => { server?.stop(true); server = null; });

async function mintRoom(): Promise<string> {
  const res = await fetch(`${baseHttp}/api/room`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "A" }),
  });
  return ((await res.json()) as { roomId: string }).roomId;
}
function open(url: string): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: any[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(e.data as string));
    ws.onopen = () => resolve({ ws, messages });
    ws.onerror = reject;
  });
}

describe("signaling fan-out", () => {
  it("forwards an sdp frame to the OTHER peer only, and never to a later joiner", async () => {
    const id = await mintRoom();
    const a = await open(`${baseWs}/ws/${id}`);
    const b = await open(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 30));
    a.ws.send(JSON.stringify({ type: "sdp", from: "A", description: { type: "offer", sdp: "v=0" } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(b.messages.some((m) => m.type === "sdp" && m.description?.sdp === "v=0")).toBe(true);
    expect(a.messages.some((m) => m.type === "sdp")).toBe(false); // not echoed to sender

    // A late joiner must NOT receive the earlier signaling (it is not buffered).
    const c = await open(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.messages.some((m) => m.type === "sdp")).toBe(false);
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  it("does not trip the clip limiter under ICE trickle (uses signalLimiter)", async () => {
    const id = await mintRoom();
    const a = await open(`${baseWs}/ws/${id}`);
    await open(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 20));
    let closed = false;
    a.ws.onclose = () => (closed = true);
    for (let i = 0; i < 60; i++) a.ws.send(JSON.stringify({ type: "ice", from: "A", candidate: `c${i}` }));
    await new Promise((r) => setTimeout(r, 60));
    expect(closed).toBe(false); // 60 ICE frames > clip limit (20) but < signal limit (200)
    a.ws.close();
  });

  it("fans out rtc-hello to the other peer and never replays it to a late joiner", async () => {
    const id = await mintRoom();
    const a = await open(`${baseWs}/ws/${id}`);
    const b = await open(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 30));
    a.ws.send(JSON.stringify({ type: "rtc-hello", from: "AAAA" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(b.messages.some((m) => m.type === "rtc-hello" && m.from === "AAAA")).toBe(true);
    expect(a.messages.some((m) => m.type === "rtc-hello")).toBe(false); // not echoed to sender

    const c = await open(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.messages.some((m) => m.type === "rtc-hello")).toBe(false); // not buffered/replayed
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  it("bills rtc-hello to the signalLimiter, not the clip limiter", async () => {
    const id = await mintRoom();
    const a = await open(`${baseWs}/ws/${id}`);
    await open(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 20));
    let closed = false;
    a.ws.onclose = () => (closed = true);
    for (let i = 0; i < 60; i++) a.ws.send(JSON.stringify({ type: "rtc-hello", from: `p${i}` }));
    await new Promise((r) => setTimeout(r, 60));
    expect(closed).toBe(false); // 60 > clip limit (20) but < signal limit (200)
    a.ws.close();
  });

  it("fans out presence to the other peer, never replays it, and uses the signal budget", async () => {
    const id = await mintRoom();
    const a = await open(`${baseWs}/ws/${id}`);
    const b = await open(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 30));
    a.ws.send(JSON.stringify({ type: "presence", iv: "AAAA", ciphertext: "QUFB" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(b.messages.some((m) => m.type === "presence" && m.ciphertext === "QUFB")).toBe(true);
    expect(a.messages.some((m) => m.type === "presence")).toBe(false); // not echoed
    const c = await open(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.messages.some((m) => m.type === "presence")).toBe(false); // not buffered
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  it("bills presence to the signalLimiter, not the clip limiter", async () => {
    const id = await mintRoom();
    const a = await open(`${baseWs}/ws/${id}`);
    await open(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 20));
    let closed = false;
    a.ws.onclose = () => (closed = true);
    for (let i = 0; i < 60; i++) a.ws.send(JSON.stringify({ type: "presence", iv: "AAAA", ciphertext: "QUFB" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(closed).toBe(false); // 60 > clip limit (20), < signal limit (200)
    a.ws.close();
  });
});
