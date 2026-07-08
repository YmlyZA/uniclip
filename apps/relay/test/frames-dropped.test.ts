import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";
import { attachWebSocket } from "../src/ws-handlers";
import { Metrics } from "../src/metrics";

let server: ReturnType<typeof Bun.serve> | null = null;
let baseHttp = "";
let baseWs = "";
let metrics: Metrics;

beforeEach(async () => {
  const store = new RoomStore();
  metrics = new Metrics();
  const app = buildApp({ roomCount: () => store.count, store, metrics });
  const { websocket, fetch } = attachWebSocket(app, store, metrics);
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

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = reject;
  });
}

describe("dropped-frame metrics", () => {
  it("counts a schema-invalid frame as uniclip_frames_dropped_total{reason=\"schema\"}", async () => {
    const id = await mintRoom("A");
    const ws = await openSocket(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 30));
    // Valid JSON, but not a recognized ClientFrame shape.
    ws.send(JSON.stringify({ type: "not-a-real-frame", foo: "bar" }));
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    const out = metrics.render();
    expect(out).toContain('uniclip_frames_dropped_total{reason="schema"} 1');
  });

  it("counts a non-JSON frame as uniclip_frames_dropped_total{reason=\"json\"}", async () => {
    const id = await mintRoom("A");
    const ws = await openSocket(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 30));
    ws.send("not valid json{{{");
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    const out = metrics.render();
    expect(out).toContain('uniclip_frames_dropped_total{reason="json"} 1');
  });
});
