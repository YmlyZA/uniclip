import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startLanRelay } from "./lan-relay";

const RID = "abc123";
let relay: { port: number; close: () => void } | undefined;
afterEach(() => relay?.close());

// Open a ws client and collect parsed frames; resolves once `predicate` is met.
function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${RID}`);
  const frames: any[] = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString("utf8"))));
  const ready = new Promise<void>((res) => ws.on("open", () => res()));
  const waitFor = (pred: () => boolean, ms = 2000) =>
    new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout waiting on frames: " + JSON.stringify(frames))), ms);
      const i = setInterval(() => { if (pred()) { clearInterval(i); clearTimeout(t); res(); } }, 20);
    });
  return { ws, frames, ready, waitFor, send: (o: unknown) => ws.send(JSON.stringify(o)) };
}

describe("lan-relay", () => {
  it("sends a strict-schema hello on connect", async () => {
    relay = await startLanRelay({ routingId: RID, host: "127.0.0.1" });
    const a = client(relay.port);
    await a.ready;
    await a.waitFor(() => a.frames.some((f) => f.type === "hello"));
    const hello = a.frames.find((f) => f.type === "hello");
    expect(hello).toMatchObject({ type: "hello", roomId: RID, peerCount: 1, backfill: false, ephemeral: true });
    expect(typeof hello.serverTime).toBe("number");
    a.ws.close();
  });

  it("broadcasts peer-joined / peer-left and fans a clip to the OTHER socket only", async () => {
    relay = await startLanRelay({ routingId: RID, host: "127.0.0.1" });
    const a = client(relay.port); await a.ready;
    const b = client(relay.port); await b.ready;
    // a sees peer-joined when b connects
    await a.waitFor(() => a.frames.some((f) => f.type === "peer-joined" && f.peerCount === 2));
    // a sends a clip; b receives it, a does not get it echoed back
    // msgId must be a valid ULID (26 chars, Crockford alphabet) per ClipboardFrameSchema
    const clip = { type: "clip", msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", iv: "i", ciphertext: "c", ts: 1 };
    a.send(clip);
    await b.waitFor(() => b.frames.some((f) => f.type === "clip" && f.msgId === "01ARZ3NDEKTSV4RRFFQ69G5FAV"));
    expect(a.frames.some((f) => f.type === "clip")).toBe(false);
    // b leaves → a sees peer-left
    b.ws.close();
    await a.waitFor(() => a.frames.some((f) => f.type === "peer-left" && f.peerCount === 1));
    a.ws.close();
  });

  it("drops an invalid frame instead of fanning it out", async () => {
    relay = await startLanRelay({ routingId: RID, host: "127.0.0.1" });
    const a = client(relay.port); await a.ready;
    const b = client(relay.port); await b.ready;
    await a.waitFor(() => a.frames.some((f) => f.type === "peer-joined"));
    a.send({ type: "nonsense" });
    // msgId must be a valid ULID per ClipboardFrameSchema
    a.send({ type: "clip", msgId: "01ARZ3NDEKTSV4RRFFQ69G5FB0", iv: "i", ciphertext: "c", ts: 2 }); // valid, after the junk
    await b.waitFor(() => b.frames.some((f) => f.type === "clip" && f.msgId === "01ARZ3NDEKTSV4RRFFQ69G5FB0"));
    expect(b.frames.some((f) => f.type === "nonsense")).toBe(false);
    a.ws.close(); b.ws.close();
  });
});
