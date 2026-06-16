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

async function mintRoom(body: { mode: "A" | "B"; backfill?: boolean; ephemeral?: boolean }): Promise<string> {
  const res = await fetch(`${baseHttp}/api/room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return ((await res.json()) as { roomId: string }).roomId;
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

function open(id: string, sink: any[]): Promise<WebSocket> {
  const ws = new WebSocket(`${baseWs}/ws/${id}`);
  ws.onmessage = (e) => sink.push(JSON.parse(e.data as string));
  return new Promise((r) => (ws.onopen = () => r(ws)));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Mode-A backfill to late joiners", () => {
  it("replays buffered clips to a device that joins after they were sent", async () => {
    const id = await mintRoom({ mode: "A" });
    const aMsgs: any[] = [];
    const a = await open(id, aMsgs);
    const f1 = makeFrame();
    const f2 = makeFrame();
    a.send(JSON.stringify(f1));
    a.send(JSON.stringify(f2));
    await wait(30);

    const bMsgs: any[] = [];
    const b = await open(id, bMsgs);
    await wait(30);

    const clips = bMsgs.filter((m) => m.type === "clip").map((m) => m.msgId);
    expect(clips).toEqual([f1.msgId, f2.msgId]); // exact, in order, no dupes
    // The sender must not receive its own buffered frames back on B's join.
    expect(aMsgs.filter((m) => m.type === "clip")).toHaveLength(0);
    a.close();
    b.close();
  });

  it("hello carries backfill:true for a Mode-A room with it enabled", async () => {
    const id = await mintRoom({ mode: "A" });
    const msgs: any[] = [];
    const a = await open(id, msgs);
    await wait(20);
    expect(msgs[0].type).toBe("hello");
    expect(msgs[0].backfill).toBe(true);
    a.close();
  });

  it("hello carries ephemeral:true for an ephemeral room", async () => {
    const id = await mintRoom({ mode: "A", ephemeral: true });
    const msgs: any[] = [];
    const a = await open(id, msgs);
    await wait(20);
    expect(msgs[0].type).toBe("hello");
    expect(msgs[0].ephemeral).toBe(true);
    expect(msgs[0].backfill).toBe(false);
    a.close();
  });

  it("does not backfill when the creator disabled it", async () => {
    const id = await mintRoom({ mode: "A", backfill: false });
    const aMsgs: any[] = [];
    const a = await open(id, aMsgs);
    a.send(JSON.stringify(makeFrame()));
    await wait(30);

    const bMsgs: any[] = [];
    const b = await open(id, bMsgs);
    await wait(30);
    expect(bMsgs.filter((m) => m.type === "clip")).toHaveLength(0);
    expect(aMsgs[0].backfill).toBe(false);
    a.close();
    b.close();
  });

  it("never backfills a Mode-B room (relay could decrypt)", async () => {
    const id = await mintRoom({ mode: "B" });
    const aMsgs: any[] = [];
    const a = await open(id, aMsgs);
    a.send(JSON.stringify(makeFrame()));
    await wait(30);

    const bMsgs: any[] = [];
    const b = await open(id, bMsgs);
    await wait(30);
    expect(bMsgs.filter((m) => m.type === "clip")).toHaveLength(0);
    expect(aMsgs[0].backfill).toBe(false);
    a.close();
    b.close();
  });

  it("clears the buffer once the room is empty (history lives only while connected)", async () => {
    const id = await mintRoom({ mode: "A" });
    const aMsgs: any[] = [];
    const a = await open(id, aMsgs);
    a.send(JSON.stringify(makeFrame()));
    await wait(30);
    a.close();
    await wait(40); // let onClose run and empty the room

    const bMsgs: any[] = [];
    const b = await open(id, bMsgs);
    await wait(30);
    expect(bMsgs.filter((m) => m.type === "clip")).toHaveLength(0);
    b.close();
  });
});
