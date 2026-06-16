import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";
import { attachWebSocket } from "../src/ws-handlers";
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
  return ((await res.json()) as { roomId: string }).roomId;
}

function makeClip() {
  return { type: "clip", msgId: ulid(), iv: "AAAAAAAAAAAAAAAA", ciphertext: "QUFBQQ==", ts: Date.now() };
}

function open(id: string, sink: any[]): Promise<WebSocket> {
  const ws = new WebSocket(`${baseWs}/ws/${id}`);
  ws.onmessage = (e) => sink.push(JSON.parse(e.data as string));
  return new Promise((r) => (ws.onopen = () => r(ws)));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("delete frame fan-out", () => {
  it("broadcasts a delete to peers but not back to the sender", async () => {
    const id = await mintRoom();
    const aMsgs: any[] = [];
    const bMsgs: any[] = [];
    const a = await open(id, aMsgs);
    const b = await open(id, bMsgs);
    const clip = makeClip();
    a.send(JSON.stringify(clip));
    await wait(30);
    a.send(JSON.stringify({ type: "delete", msgId: clip.msgId }));
    await wait(30);

    expect(bMsgs.filter((m) => m.type === "delete").map((m) => m.msgId)).toEqual([clip.msgId]);
    expect(aMsgs.filter((m) => m.type === "delete")).toHaveLength(0);
    a.close();
    b.close();
  });

  it("removes the deleted clip from the backfill ring (late joiner won't get it)", async () => {
    const id = await mintRoom();
    const aMsgs: any[] = [];
    const a = await open(id, aMsgs);
    const f1 = makeClip();
    const f2 = makeClip();
    a.send(JSON.stringify(f1));
    a.send(JSON.stringify(f2));
    await wait(30);
    a.send(JSON.stringify({ type: "delete", msgId: f1.msgId }));
    await wait(30);

    const cMsgs: any[] = [];
    const c = await open(id, cMsgs);
    await wait(30);
    const got = cMsgs.filter((m) => m.type === "clip").map((m) => m.msgId);
    expect(got).toEqual([f2.msgId]); // f1 was deleted from the ring
    a.close();
    c.close();
  });

  it("replays tombstones to a device that joins after the delete", async () => {
    const id = await mintRoom();
    const aMsgs: any[] = [];
    const a = await open(id, aMsgs);
    const clip = makeClip();
    a.send(JSON.stringify(clip));
    await wait(30);
    a.send(JSON.stringify({ type: "delete", msgId: clip.msgId }));
    await wait(30);

    // A new device joins AFTER the delete — it must receive the tombstone.
    const bMsgs: any[] = [];
    const b = await open(id, bMsgs);
    await wait(30);
    expect(bMsgs.filter((m) => m.type === "delete").map((m) => m.msgId)).toContain(clip.msgId);
    a.close();
    b.close();
  });

  it("clears tombstones once the room empties", async () => {
    const id = await mintRoom();
    const aMsgs: any[] = [];
    const a = await open(id, aMsgs);
    const clip = makeClip();
    a.send(JSON.stringify(clip));
    await wait(30);
    a.send(JSON.stringify({ type: "delete", msgId: clip.msgId }));
    await wait(30);
    a.close();
    await wait(40); // room empties → tombstones cleared

    const bMsgs: any[] = [];
    const b = await open(id, bMsgs);
    await wait(30);
    expect(bMsgs.filter((m) => m.type === "delete")).toHaveLength(0);
    b.close();
  });
});
