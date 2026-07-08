import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";
import { attachWebSocket, broadcast } from "../src/ws-handlers";
import { ulid } from "ulid";

let server: ReturnType<typeof Bun.serve> | null = null;
let baseHttp = "";
let baseWs = "";
let store: RoomStore;

beforeEach(() => {
  store = new RoomStore();
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
function offer(fileId: string) {
  return { type: "file-offer", fileId, iv: "AAAA", ciphertext: "QUFB" };
}
function chunk(fileId: string, index: number) {
  return { type: "file-chunk", fileId, index, isFinal: true, iv: "AAAA", ciphertext: "QUFB" };
}

describe("relay file-* handling", () => {
  it("fans out a file-offer to peers but stores nothing", async () => {
    const id = await mintRoom();
    const a = new WebSocket(`${baseWs}/ws/${id}`);
    await new Promise((r) => (a.onopen = () => r(null)));
    const bMsgs: any[] = [];
    const b = new WebSocket(`${baseWs}/ws/${id}`);
    b.onmessage = (e) => bMsgs.push(JSON.parse(e.data as string));
    await new Promise((r) => (b.onopen = () => r(null)));
    await new Promise((r) => setTimeout(r, 20));

    const fileId = ulid();
    a.send(JSON.stringify(offer(fileId)));
    a.send(JSON.stringify(chunk(fileId, 0)));
    await new Promise((r) => setTimeout(r, 30));

    expect(bMsgs.some((m) => m.type === "file-offer" && m.fileId === fileId)).toBe(true);
    expect(bMsgs.some((m) => m.type === "file-chunk")).toBe(true);
    const room = store.get(id)!;
    expect(room.recent).toHaveLength(0);
    expect(room.tombstones).toHaveLength(0);
  });

  it("does NOT rate-limit a 42-chunk burst (file-* uses its own budget)", async () => {
    const id = await mintRoom();
    let closeCode = 0;
    const a = new WebSocket(`${baseWs}/ws/${id}`);
    a.onclose = (e) => (closeCode = e.code);
    await new Promise((r) => (a.onopen = () => r(null)));
    const fileId = ulid();
    a.send(JSON.stringify(offer(fileId)));
    for (let i = 0; i < 42; i++) a.send(JSON.stringify({ type: "file-chunk", fileId, index: i, isFinal: i === 41, iv: "AAAA", ciphertext: "QUFB" }));
    await new Promise((r) => setTimeout(r, 150));
    expect(closeCode).toBe(0);
  });

  it("still rate-limits a clip burst on the clip budget", async () => {
    const id = await mintRoom();
    let closeCode = 0;
    const a = new WebSocket(`${baseWs}/ws/${id}`);
    a.onclose = (e) => (closeCode = e.code);
    await new Promise((r) => (a.onopen = () => r(null)));
    for (let i = 0; i < 25; i++) a.send(JSON.stringify({ type: "clip", msgId: ulid(), iv: "AAAA", ciphertext: "QUFB", ts: 0 }));
    await new Promise((r) => setTimeout(r, 150));
    expect(closeCode).toBe(4429);
  });
});

describe("broadcast backpressure gate (spec §8)", () => {
  it("skips a socket whose getBufferedAmount exceeds the ceiling", () => {
    const sentNormal: string[] = [];
    const sentBackpressured: string[] = [];
    const normal = { send: (p: string) => sentNormal.push(p), getBufferedAmount: () => 0 };
    const stuck = { send: (p: string) => sentBackpressured.push(p), getBufferedAmount: () => 9 * 1024 * 1024 };
    const sockets = new Set<unknown>([normal, stuck]);
    const frame = { type: "file-chunk", fileId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", index: 0, isFinal: true, iv: "AAAA", ciphertext: "QUFB" } as any;
    broadcast(sockets, {} as any, frame);
    expect(sentNormal).toHaveLength(1); // delivered
    expect(sentBackpressured).toHaveLength(0); // skipped (buffer > 8 MiB)
  });
});
