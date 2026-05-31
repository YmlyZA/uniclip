import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";
import { attachWebSocket } from "../src/ws-handlers";
import { ulid } from "ulid";

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

afterEach(() => {
  server?.stop(true);
  server = null;
});

async function mintRoom(): Promise<string> {
  const res = await fetch(`${baseHttp}/api/room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "A" }),
  });
  return (await res.json() as { roomId: string }).roomId;
}

function makeFrame() {
  return {
    type: "clip",
    msgId: ulid(),
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "QUFBQQ==",
    ts: Date.now(),
  };
}

describe("clip fan-out", () => {
  it("delivers from A to B but not back to A", async () => {
    const id = await mintRoom();
    const aMsgs: any[] = [];
    const bMsgs: any[] = [];
    const a = new WebSocket(`${baseWs}/ws/${id}`);
    a.onmessage = (e) => aMsgs.push(JSON.parse(e.data));
    await new Promise((r) => (a.onopen = () => r(null)));
    const b = new WebSocket(`${baseWs}/ws/${id}`);
    b.onmessage = (e) => bMsgs.push(JSON.parse(e.data));
    await new Promise((r) => (b.onopen = () => r(null)));
    await new Promise((r) => setTimeout(r, 20));

    const frame = makeFrame();
    a.send(JSON.stringify(frame));
    await new Promise((r) => setTimeout(r, 30));

    expect(bMsgs.some((m) => m.type === "clip" && m.msgId === frame.msgId)).toBe(true);
    expect(aMsgs.some((m) => m.type === "clip" && m.msgId === frame.msgId)).toBe(false);
    a.close();
    b.close();
  });

  it("rejects an oversize frame with close 4413", async () => {
    const id = await mintRoom();
    const a = new WebSocket(`${baseWs}/ws/${id}`);
    await new Promise((r) => (a.onopen = () => r(null)));
    const huge = "x".repeat(65 * 1024);
    await new Promise<void>((resolve) => {
      a.onclose = (e) => {
        expect(e.code).toBe(4413);
        resolve();
      };
      a.send(JSON.stringify({ ...makeFrame(), ciphertext: huge }));
    });
  });

  it("ignores malformed JSON without dropping the socket", async () => {
    const id = await mintRoom();
    const a = new WebSocket(`${baseWs}/ws/${id}`);
    await new Promise((r) => (a.onopen = () => r(null)));
    let closed = false;
    a.onclose = () => { closed = true; };
    a.send("{not json");
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false);
    a.close();
  });
});
