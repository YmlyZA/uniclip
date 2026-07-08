import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRoomUrl } from "@uniclip/room-code";
import { encrypt, toBase64 } from "@uniclip/crypto";
import { UniclipClient } from "./client";
import { deriveRoomKey } from "./room-key";
import { Backoff } from "./backoff";
import { CLOSE_CODES, PROTOCOL_VERSION } from "@uniclip/protocol";

// Build an encrypted file-offer wire frame the way FileTransferManager.sendFile
// does (metadata is no longer plaintext on the wire): {type,fileId,iv,ciphertext}.
async function encryptedOffer(
  roomUrl: string,
  fileId: string,
  meta: { name: string; mime: string; size: number; chunkCount: number; hash: string; inline: boolean },
) {
  const room = parseRoomUrl(roomUrl)!;
  const key = await deriveRoomKey(room);
  const env = await encrypt({
    key,
    plaintext: JSON.stringify(meta),
    aad: `file-offer:${room.routingId}:${fileId}`,
  });
  return { type: "file-offer", fileId, iv: toBase64(env.iv), ciphertext: toBase64(env.ciphertext) };
}

// Minimal MockWebSocket compatible with `globalThis.WebSocket`
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  url: string;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: 1000 }));
  }
  emit(payload: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

// Node's vitest environment has no DOM `CloseEvent`; the harness's close()
// constructs one. Polyfill a minimal shim so disconnect() paths can run.
if (typeof (globalThis as any).CloseEvent === "undefined") {
  (globalThis as any).CloseEvent = class CloseEvent extends Event {
    code: number;
    constructor(type: string, init?: { code?: number }) {
      super(type);
      this.code = init?.code ?? 0;
    }
  };
}

beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as any).WebSocket = MockWebSocket;
});
afterEach(() => {
  vi.useRealTimers();
});

// The receive path awaits an async WebCrypto decrypt, so a fixed setTimeout is
// racy under load (decrypt may not have resolved yet). Poll for the condition.
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("UniclipClient", () => {
  it("derives key + connects + emits status:connected on hello", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const statuses: string[] = [];
    client.on("status", (s: string) => statuses.push(s));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    expect(statuses).toContain("connected");
  });

  it("send() encrypts and writes a clip frame", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    await client.send("hello universe");

    // Presence announces asynchronously on hello; filter it out to focus on the clip.
    const clipSent = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === "clip");
    expect(clipSent).toBeDefined();
    const sent = clipSent;
    expect(sent.msgId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(typeof sent.iv).toBe("string");
    expect(typeof sent.ciphertext).toBe("string");
    expect(typeof sent.ts).toBe("number");
  });

  it("decrypts an incoming clip frame and emits 'clip' with plaintext", async () => {
    const sender = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const receiver = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await sender.connect();
    await receiver.connect();
    const senderWs = MockWebSocket.instances[0]!;
    const receiverWs = MockWebSocket.instances[1]!;
    senderWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    receiverWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });

    const received: string[] = [];
    receiver.on("clip", (text: string) => received.push(text));

    await sender.send("ping from A");
    const wireFrame = JSON.parse(senderWs.sent.find((s) => JSON.parse(s).type === "clip")!);
    receiverWs.emit(wireFrame);
    await waitFor(() => received.length > 0);
    expect(received).toEqual(["ping from A"]);
  });

  it("drops a replayed msgId on the receiver", async () => {
    const sender = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const receiver = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await sender.connect();
    await receiver.connect();
    const senderWs = MockWebSocket.instances[0]!;
    const receiverWs = MockWebSocket.instances[1]!;
    senderWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    receiverWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });

    const received: string[] = [];
    receiver.on("clip", (t: string) => received.push(t));

    await sender.send("once");
    const wire = JSON.parse(senderWs.sent.find((s) => JSON.parse(s).type === "clip")!);
    receiverWs.emit(wire);
    receiverWs.emit(wire); // duplicate (rejected synchronously by replay.admit)
    await waitFor(() => received.length > 0);
    expect(received).toEqual(["once"]);
  });

  it("emits the frame's original ts with 'clip' (so backfilled clips sort correctly)", async () => {
    const sender = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const receiver = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await sender.connect();
    await receiver.connect();
    const senderWs = MockWebSocket.instances[0]!;
    const receiverWs = MockWebSocket.instances[1]!;
    senderWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    receiverWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });

    let gotTs = -1;
    receiver.on("clip", (_text: string, ts: number) => (gotTs = ts));
    await sender.send("hi");
    const wire = JSON.parse(senderWs.sent.find((s) => JSON.parse(s).type === "clip")!);
    receiverWs.emit(wire);
    await waitFor(() => gotTs >= 0);
    expect(gotTs).toBe(wire.ts);
  });

  it("emits 'room' with backfill + ephemeral from hello", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    let info: { backfill: boolean; ephemeral: boolean } | null = null;
    client.on("room", (i: { backfill: boolean; ephemeral: boolean }) => (info = i));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: true, ephemeral: true });
    expect(info).toEqual({ backfill: true, ephemeral: true });
  });

  it("emits VERSION_MISMATCH when hello.protocolVersion differs from the client's, but stays connected", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const statuses: string[] = [];
    const errors: { code: string; message: string }[] = [];
    client.on("status", (s: string) => statuses.push(s));
    client.on("error", (e: { code: string; message: string }) => errors.push(e));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({
      type: "hello",
      roomId: "qx7k2p",
      peerCount: 1,
      serverTime: 0,
      backfill: false,
      protocolVersion: PROTOCOL_VERSION + 1,
    });
    expect(errors.some((e) => e.code === "VERSION_MISMATCH")).toBe(true);
    expect(statuses).toContain("connected");
  });

  it("does not emit VERSION_MISMATCH when hello.protocolVersion matches the client's", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const errors: { code: string; message: string }[] = [];
    client.on("error", (e: { code: string; message: string }) => errors.push(e));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({
      type: "hello",
      roomId: "qx7k2p",
      peerCount: 1,
      serverTime: 0,
      backfill: false,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(errors.some((e) => e.code === "VERSION_MISMATCH")).toBe(false);
  });

  it("emits VERSION_MISMATCH at most once across repeated mismatched hellos (reconnects)", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const errors: { code: string; message: string }[] = [];
    client.on("error", (e: { code: string; message: string }) => errors.push(e));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    const mismatchedHello = {
      type: "hello",
      roomId: "qx7k2p",
      peerCount: 1,
      serverTime: 0,
      backfill: false,
      protocolVersion: PROTOCOL_VERSION + 1,
    };
    ws.emit(mismatchedHello); // first hello (initial connect)
    ws.emit(mismatchedHello); // second hello (simulated reconnect against the same skewed relay)
    expect(errors.filter((e) => e.code === "VERSION_MISMATCH")).toHaveLength(1);
  });

  it("send() returns the minted msgId and ts matching the wire frame", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    const res = await client.send("x");
    const wire = JSON.parse(ws.sent.find((s) => JSON.parse(s).type === "clip")!);
    expect(res.msgId).toBe(wire.msgId);
    expect(res.ts).toBe(wire.ts);
  });

  it("keeps reconnecting when a connect attempt fails with onerror but no onclose (Node/undici)", async () => {
    // Node's global WebSocket (undici) fires onerror WITHOUT onclose on a failed
    // connect. The reconnect loop must still reschedule the next attempt, or it
    // dies after one failure — a real "can't auto-reconnect" bug found on
    // hardware. (Browsers fire onerror THEN onclose, so the reschedule must run
    // exactly once, not twice.)
    const created: unknown[] = [];
    class ErrOnlyWS {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 0;
      url: string;
      onopen: ((e: unknown) => void) | null = null;
      onmessage: ((e: unknown) => void) | null = null;
      onclose: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      constructor(url: string) {
        this.url = url;
        created.push(this);
        queueMicrotask(() => this.onerror?.(new Event("error"))); // connect fails, error only
      }
      send() {}
      close() {}
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = ErrOnlyWS;
    vi.useFakeTimers();
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect(); // opens WS #1; its onerror is queued
    await vi.advanceTimersByTimeAsync(0); // flush the onerror microtask → schedule reconnect
    await vi.advanceTimersByTimeAsync(1500); // fire the backoff reconnect → opens WS #2
    expect(created.length).toBeGreaterThanOrEqual(2); // loop survived an onerror-only failure
    vi.useRealTimers();
  });

  it("emits the frame's msgId with 'clip' (for persist dedup)", async () => {
    const sender = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const receiver = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await sender.connect();
    await receiver.connect();
    const senderWs = MockWebSocket.instances[0]!;
    const receiverWs = MockWebSocket.instances[1]!;
    senderWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    receiverWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });

    let gotMsgId = "";
    receiver.on("clip", (_text: string, _ts: number, msgId: string) => (gotMsgId = msgId));
    await sender.send("hi");
    const wire = JSON.parse(senderWs.sent.find((s) => JSON.parse(s).type === "clip")!);
    receiverWs.emit(wire);
    await waitFor(() => gotMsgId !== "");
    expect(gotMsgId).toBe(wire.msgId);
  });

  it("delete(msgId) writes a delete frame", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    client.delete("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    // Presence announces asynchronously; find the delete frame specifically.
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).type === "delete"));
    const deleteFrame = JSON.parse(ws.sent.find((s) => JSON.parse(s).type === "delete")!);
    expect(deleteFrame).toEqual({ type: "delete", msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
  });

  it("delete() while the socket is not OPEN queues the delete and flushes it on the next hello", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.readyState = MockWebSocket.CLOSED; // offline
    client.delete("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    // No clip/delete frames sent while offline (presence guard also skips closed socket).
    expect(ws.sent.filter((s) => ["clip", "delete"].includes(JSON.parse(s).type))).toHaveLength(0);

    ws.readyState = MockWebSocket.OPEN; // back online
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).type === "delete"));
    expect(JSON.parse(ws.sent.find((s) => JSON.parse(s).type === "delete")!)).toEqual({ type: "delete", msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
  });

  it("delete() of a still-queued clip drops it from the queue instead of sending a delete", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.readyState = MockWebSocket.CLOSED; // offline
    const a = await client.send("composed then deleted offline");
    client.delete(a.msgId); // delete it before it was ever sent

    ws.readyState = MockWebSocket.OPEN;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    await new Promise((r) => setTimeout(r, 20));
    // The clip was dropped from the queue and no delete was queued: peers never
    // saw it, so there is nothing content-wise to send at all.
    // (Presence announces asynchronously — exclude it from the check.)
    const contentSent = ws.sent.filter((s) => ["clip", "delete"].includes(JSON.parse(s).type));
    expect(contentSent).toHaveLength(0);
  });

  it("flushQueue emits 'sent' only for clip frames, not queued deletes", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.readyState = MockWebSocket.CLOSED;
    const a = await client.send("a clip");
    client.delete("01ARZ3NDEKTSV4RRFFQ69G5FAV"); // a delete for an item not in the queue

    const sentIds: string[] = [];
    client.on("sent", (id: string) => sentIds.push(id));
    ws.readyState = MockWebSocket.OPEN;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });

    // Presence announces asynchronously; filter to the flushed content frames only.
    const flushed = ws.sent.filter((s) => ["clip", "delete"].includes(JSON.parse(s).type));
    expect(flushed).toHaveLength(2); // clip then delete, in order
    expect(sentIds).toEqual([a.msgId]); // 'sent' fired only for the clip
  });

  it("emits 'delete' with the msgId when a delete frame arrives", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    let got = "";
    client.on("delete", (msgId: string) => (got = msgId));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.emit({ type: "delete", msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    await waitFor(() => got !== "");
    expect(got).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("send() while the socket is not OPEN enqueues and returns queued:true", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.readyState = MockWebSocket.CLOSED; // offline, without triggering reconnect
    const res = await client.send("queued while offline");
    expect(res.queued).toBe(true);
    expect(ws.sent).toHaveLength(0);
  });

  it("flushes queued frames in order on the next hello, emitting 'sent'", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.readyState = MockWebSocket.CLOSED;
    const a = await client.send("one");
    const b = await client.send("two");
    expect(ws.sent).toHaveLength(0);

    const sentIds: string[] = [];
    client.on("sent", (id: string) => sentIds.push(id));
    ws.readyState = MockWebSocket.OPEN; // socket back
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });

    // Presence announces asynchronously; filter to clip frames only.
    const clipsSent = ws.sent.filter((s) => JSON.parse(s).type === "clip");
    expect(clipsSent).toHaveLength(2);
    expect(JSON.parse(clipsSent[0]!).msgId).toBe(a.msgId);
    expect(JSON.parse(clipsSent[1]!).msgId).toBe(b.msgId);
    expect(JSON.parse(clipsSent[0]!).ts).toBe(a.ts); // ts frozen at composition
    expect(sentIds).toEqual([a.msgId, b.msgId]);
  });

  it("bounds the queue to MAX_QUEUE (drops oldest, emits QUEUE_FULL)", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.readyState = MockWebSocket.CLOSED;

    let queueFull = 0;
    client.on("error", (e: { code: string }) => { if (e.code === "QUEUE_FULL") queueFull++; });

    const first = await client.send("oldest");
    for (let i = 0; i < 100; i++) await client.send(`m${i}`); // 101 enqueued, one overflow

    expect(queueFull).toBe(1);
    ws.readyState = MockWebSocket.OPEN;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });

    // Presence announces asynchronously; count only the flushed clip frames.
    const flushedClips = ws.sent.filter((s) => JSON.parse(s).type === "clip");
    expect(flushedClips).toHaveLength(100); // capped at MAX_QUEUE
    expect(flushedClips.some((s) => JSON.parse(s).msgId === first.msgId)).toBe(false); // oldest dropped
  });

  it("emits DECRYPT_FAILED when frames can't be decrypted (wrong/missing key)", async () => {
    // Sender is Mode A (has the #secret). Receiver opens the SAME routingId WITHOUT
    // the secret → Mode B → derives a different key → every frame fails to decrypt.
    const sender = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const receiver = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p",
      relayBase: "wss://uniclip.app",
    });
    await sender.connect();
    await receiver.connect();
    const senderWs = MockWebSocket.instances[0]!;
    const receiverWs = MockWebSocket.instances[1]!;
    senderWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    receiverWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });

    let errCode = "";
    const clips: string[] = [];
    receiver.on("error", (e: { code: string }) => (errCode = e.code));
    receiver.on("clip", (t: string) => clips.push(t));

    await sender.send("secret text");
    const wire = JSON.parse(senderWs.sent.find((s) => JSON.parse(s).type === "clip")!);
    receiverWs.emit(wire);

    await waitFor(() => errCode !== "");
    expect(errCode).toBe("DECRYPT_FAILED");
    expect(clips).toEqual([]);
  });

  it("sendFile writes a file-offer frame through the socket", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    await client.sendFile({ name: "a.txt", mime: "text/plain", bytes: new TextEncoder().encode("hello") });
    expect(ws.sent.some((s) => JSON.parse(s).type === "file-offer")).toBe(true);
  });

  it("routes an incoming file-offer to a file-offer event", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    let offered = "";
    client.on("file-offer", (o: { fileId: string }) => (offered = o.fileId));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.emit(await encryptedOffer("https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr", "01ARZ3NDEKTSV4RRFFQ69G5FAV", { name: "f", mime: "text/plain", size: 1, chunkCount: 1, hash: "a".repeat(64), inline: false }));
    await waitFor(() => offered !== "");
    expect(offered).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("aborts in-progress transfers on disconnect", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const errs: string[] = [];
    client.on("file-error", (e: { code: string }) => errs.push(e.code));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    client.on("file-offer", (o: { fileId: string }) => client.acceptFile(o.fileId));
    ws.emit(await encryptedOffer("https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr", "01ARZ3NDEKTSV4RRFFQ69G5FAV", { name: "f", mime: "text/plain", size: 1, chunkCount: 2, hash: "a".repeat(64), inline: false }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).type === "file-accept"));
    client.disconnect();
    expect(errs).toContain("DISCONNECTED");
  });

  it("emits a decrypt-fail diag carrying only the msgId (no plaintext/ciphertext)", async () => {
    const sender = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#aaaaaaaaaaaaaaaaaa",
      relayBase: "wss://uniclip.app",
    });
    const receiver = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#bbbbbbbbbbbbbbbbbb", // different secret → different key
      relayBase: "wss://uniclip.app",
    });
    const diags: import("./diag").DiagEvent[] = [];
    receiver.on("diag", (e) => diags.push(e));
    await sender.connect();
    await receiver.connect();
    const senderWs = MockWebSocket.instances[0]!;
    const receiverWs = MockWebSocket.instances[1]!;
    senderWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    receiverWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });

    await sender.send("secret plaintext payload");
    const wire = JSON.parse(senderWs.sent.find((s) => JSON.parse(s).type === "clip")!);
    receiverWs.emit(wire);
    await waitFor(() => diags.some((e) => e.phase === "decrypt-fail"));

    const d = diags.find((e) => e.phase === "decrypt-fail")!;
    expect(d.data).toEqual({ msgId: wire.msgId });
    // Privacy lock: neither plaintext nor the wire ciphertext/iv leak into the event.
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain("secret plaintext payload");
    expect(serialized).not.toContain(wire.ciphertext);
    expect(serialized).not.toContain(wire.iv);
  });

  it("emits a transport diag when the channel opens (p2p) and closes (relay)", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const diags: import("./diag").DiagEvent[] = [];
    client.on("diag", (e) => diags.push(e));
    await client.connect();
    // ws lifecycle diag fires on connect/open:
    await waitFor(() => diags.some((e) => e.phase === "ws" && e.data?.event === "open"));
    expect(diags.some((e) => e.phase === "ws" && e.data?.event === "connecting")).toBe(true);
  });

  it("aborts in-progress transfers when the socket drops (transient close, not disconnect)", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const errs: string[] = [];
    client.on("file-error", (e: { code: string }) => errs.push(e.code));
    client.on("file-offer", (o: { fileId: string }) => client.acceptFile(o.fileId));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.emit(await encryptedOffer("https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr", "01ARZ3NDEKTSV4RRFFQ69G5FAV", { name: "f", mime: "text/plain", size: 1, chunkCount: 2, hash: "a".repeat(64), inline: false }));
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).type === "file-accept")); // accept registered an incoming transfer

    // Transient drop (NOT disconnect): onclose → handleClose → abortAll, then a
    // reconnect is scheduled. Use fake timers so that reconnect timer can't leak.
    vi.useFakeTimers();
    ws.close(); // transient close path → handleClose → abortAll
    expect(errs).toContain("DISCONNECTED");

    client.disconnect(); // dispose so the next openSocket is a no-op path
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

// A fake RTCPeerConnection sufficient for UniclipClient wiring tests: it opens
// its data channel synchronously so we can assert the transport switch.
// `setRemoteDescriptionCalls` is a shared array the caller can pass in to
// record every setRemoteDescription invocation across all PC instances created
// by one factory (used by the via-guard regression test).
function fakePcFactory(setRemoteDescriptionCalls?: { type: string; sdp: string }[]) {
  return () => {
    const pc: any = {
      _ch: null as RTCDataChannel | null,
      signalingState: "stable" as RTCSignalingState,
      connectionState: "new" as RTCPeerConnectionState,
      localDescription: { type: "offer", sdp: "X" },
      onicecandidate: null,
      ondatachannel: null,
      onnegotiationneeded: null,
      onconnectionstatechange: null,
      createDataChannel() {
        const ch: any = { readyState: "open", send: vi.fn(), close() { this.readyState = "closed"; this.onclose?.(); }, onopen: null, onclose: null, onmessage: null };
        pc._ch = ch;
        queueMicrotask(() => ch.onopen?.());
        return ch;
      },
      async createOffer() { return { type: "offer", sdp: "X" }; },
      async createAnswer() { return { type: "answer", sdp: "Y" }; },
      async setLocalDescription() {},
      async setRemoteDescription(d: { type: string; sdp: string }) {
        setRemoteDescriptionCalls?.push(d);
      },
      async addIceCandidate() {},
      close() { pc.connectionState = "closed"; pc.onconnectionstatechange?.(); },
    };
    return pc as RTCPeerConnection;
  };
}

const MIN_FROM = "00000000000000000000000000";

describe("UniclipClient transport seam", () => {
  it("opens P2P via the identity handshake and sends a clip over the channel (not the WS)", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app", iceServers: [], createConnection: fakePcFactory(),
    });
    const transports: string[] = [];
    client.on("transport", (v: string) => transports.push(v));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    // client armed → it announced rtc-hello over the WS:
    expect(ws.sent.some((p) => JSON.parse(p).type === "rtc-hello")).toBe(true);
    // peer announces a smaller from → client becomes initiator → channel opens:
    ws.emit({ type: "rtc-hello", from: MIN_FROM });
    await waitFor(() => transports.includes("p2p"));
    const before = ws.sent.length;
    await client.send("over p2p");
    expect(ws.sent.length).toBe(before); // clip went over the data channel, not the WS
  });

  it("falls back to relay transport when the peer leaves", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app", iceServers: [], createConnection: fakePcFactory(),
    });
    const transports: string[] = [];
    client.on("transport", (v: string) => transports.push(v));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    ws.emit({ type: "rtc-hello", from: MIN_FROM });
    await waitFor(() => transports.includes("p2p"));
    ws.emit({ type: "peer-left", peerCount: 1 });
    await waitFor(() => transports.at(-1) === "relay");
    await client.send("after p2p");
    expect(JSON.parse(ws.sent.at(-1)!).type).toBe("clip"); // back on the WS
  });

  it("drops signaling (sdp/ice/rtc-hello) arriving over the p2p pipe; does not surface as content", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app", iceServers: [], createConnection: fakePcFactory(),
    });
    let clips = 0;
    client.on("clip", () => clips++);
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    ws.emit({ type: "ice", from: "peer", candidate: "" });
    ws.emit({ type: "rtc-hello", from: MIN_FROM });
    await new Promise((r) => setTimeout(r, 10));
    expect(clips).toBe(0); // signaling never surfaces as content
  });

  it("re-announces its identity on reconnect (re-arm)", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app", iceServers: [], createConnection: fakePcFactory(),
    });
    await client.connect();
    const ws1 = MockWebSocket.instances.at(-1)!;
    ws1.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    expect(ws1.sent.filter((p) => JSON.parse(p).type === "rtc-hello").length).toBe(1);
    ws1.close(); // triggers reconnect → new socket
    await waitFor(() => MockWebSocket.instances.length >= 2);
    const ws2 = MockWebSocket.instances.at(-1)!;
    ws2.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    expect(ws2.sent.some((p) => JSON.parse(p).type === "rtc-hello")).toBe(true); // re-announced
  });

  it("via-guard: sdp offer over the p2p channel is silently dropped (no setRemoteDescription); same offer over WS IS processed", async () => {
    // Regression guard for the `if (via !== "ws") return;` check in handleFrame.
    // If that line is deleted, an sdp offer delivered over the data channel would
    // be forwarded to peer.handleSignal, which calls setRemoteDescription — a
    // detectable side-effect. We instrument the fake PC to record those calls.
    // PeerLink stores the channel as the private `channel` field — access it via
    // (peer as any).channel so we can inject a message on the p2p pipe directly.
    const srdCalls: { type: string; sdp: string }[] = [];

    // --- P2P leg: deliver sdp offer OVER THE CHANNEL ---
    const clientA = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app", iceServers: [], createConnection: fakePcFactory(srdCalls),
    });
    await clientA.connect();
    const wsA = MockWebSocket.instances.at(-1)!;
    wsA.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    // Peer announces smaller from → clientA is initiator → createDataChannel → channel opens
    wsA.emit({ type: "rtc-hello", from: MIN_FROM });
    // Wait for the transport to switch to p2p (channel's onopen fired)
    await waitFor(() => (clientA as any).transport === "p2p");

    // Deliver an sdp offer through the data channel's onmessage (the p2p pipe).
    // PeerLink wires ch.onmessage → opts.onMessage(ev.data) → handleFrame(data, "p2p").
    const sdpOffer = { type: "sdp", from: MIN_FROM, description: { type: "offer", sdp: "OFFER" } };
    const ch = (clientA as any).peer?.channel;
    const countBefore = srdCalls.length;
    ch?.onmessage?.({ data: JSON.stringify(sdpOffer) });
    await new Promise((r) => setTimeout(r, 30)); // let any async path settle
    // GUARD: setRemoteDescription must NOT have been called (frame was via "p2p")
    expect(srdCalls.length).toBe(countBefore);

    // --- WS leg (positive control): same sdp offer over the WS IS processed ---
    const srdCallsB: { type: string; sdp: string }[] = [];
    const clientB = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app", iceServers: [], createConnection: fakePcFactory(srdCallsB),
    });
    await clientB.connect();
    const wsB = MockWebSocket.instances.at(-1)!;
    wsB.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    wsB.emit({ type: "rtc-hello", from: MIN_FROM }); // arm peer (initiator)
    await waitFor(() => (clientB as any).transport === "p2p");
    const countBeforeB = srdCallsB.length;
    wsB.emit(sdpOffer); // deliver the same offer over the WS (via = "ws")
    await new Promise((r) => setTimeout(r, 30));
    // POSITIVE CONTROL: setRemoteDescription WAS called (guard allows "ws" frames)
    expect(srdCallsB.length).toBeGreaterThan(countBeforeB);

    clientA.disconnect();
    clientB.disconnect();
  });

  it("via-guard: an error frame arriving over the p2p pipe is dropped; the same frame over WS still emits", async () => {
    // Regression guard for the `if (via !== "ws") return;` check on the "error"
    // case in handleFrame. A malicious room peer could otherwise send an
    // { type: "error", message } frame over the open RTCDataChannel to have
    // its unsanitized message surface as content (e.g. terminal-escape
    // injection in a CLI's note display).
    const errorFrame = { type: "error", code: "RATE_LIMIT", message: "\x1b]52;c;ZXZpbA==\x07boom" };

    // --- P2P leg: deliver the error frame OVER THE CHANNEL ---
    const clientA = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app", iceServers: [], createConnection: fakePcFactory(),
    });
    const errorsA: unknown[] = [];
    clientA.on("error", (e: unknown) => errorsA.push(e));
    await clientA.connect();
    const wsA = MockWebSocket.instances.at(-1)!;
    wsA.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    wsA.emit({ type: "rtc-hello", from: MIN_FROM }); // clientA becomes initiator → channel opens
    await waitFor(() => (clientA as any).transport === "p2p");
    const ch = (clientA as any).peer?.channel;
    ch?.onmessage?.({ data: JSON.stringify(errorFrame) });
    await new Promise((r) => setTimeout(r, 30));
    // GUARD: no error event surfaced from the p2p-delivered frame
    expect(errorsA.length).toBe(0);

    // --- WS leg (positive control): same error frame over the WS IS emitted ---
    const clientB = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app", iceServers: [], createConnection: fakePcFactory(),
    });
    const errorsB: unknown[] = [];
    clientB.on("error", (e: unknown) => errorsB.push(e));
    await clientB.connect();
    const wsB = MockWebSocket.instances.at(-1)!;
    wsB.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    wsB.emit(errorFrame); // delivered over the WS (via = "ws")
    await waitFor(() => errorsB.length > 0);
    expect(errorsB[0]).toEqual({ code: "RATE_LIMIT", message: errorFrame.message });

    clientA.disconnect();
    clientB.disconnect();
  });
});


describe("UniclipClient presence", () => {
  it("surfaces a presence roster from a frame received over the WS", async () => {
    // Two clients in the same room so the presence blob decrypts.
    // Use fakePcFactory so armPeer() works in Node (no native RTCPeerConnection).
    const url = "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr";
    const a = new UniclipClient({ roomUrl: url, relayBase: "wss://uniclip.app", deviceId: "A", deviceName: "Alice", iceServers: [], createConnection: fakePcFactory() });
    await a.connect();
    const wsA = MockWebSocket.instances.at(-1)!;
    wsA.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    // a announced over the WS; capture the presence frame it sent
    await waitFor(() => wsA.sent.some((p) => JSON.parse(p).type === "presence"));
    const presenceFrame = JSON.parse(wsA.sent.find((p) => JSON.parse(p).type === "presence")!);

    const b = new UniclipClient({ roomUrl: url, relayBase: "wss://uniclip.app", deviceId: "B", deviceName: "Bob", iceServers: [], createConnection: fakePcFactory() });
    const rosters: any[] = [];
    b.on("presence", (r: any) => rosters.push(r));
    await b.connect();
    const wsB = MockWebSocket.instances.at(-1)!;
    wsB.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    wsB.emit(presenceFrame); // A's presence arrives at B over the WS
    await waitFor(() => rosters.some((r) => r.some((d: any) => d.id === "A" && d.name === "Alice")));
    expect(rosters.at(-1).some((d: any) => d.self && d.id === "B")).toBe(true);
  });

  it("drops a presence frame arriving over the p2p pipe", async () => {
    const url = "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr";
    const a = new UniclipClient({ roomUrl: url, relayBase: "wss://uniclip.app", deviceId: "A", deviceName: "Alice", iceServers: [], createConnection: fakePcFactory() });
    await a.connect();
    const wsA = MockWebSocket.instances.at(-1)!;
    wsA.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    await waitFor(() => wsA.sent.some((p) => JSON.parse(p).type === "presence"));
    const presenceFrame = JSON.parse(wsA.sent.find((p) => JSON.parse(p).type === "presence")!);

    const b = new UniclipClient({
      roomUrl: url, relayBase: "wss://uniclip.app", deviceId: "B", deviceName: "Bob",
      iceServers: [], createConnection: fakePcFactory(),
    });
    const rosters: any[] = [];
    b.on("presence", (r: any) => rosters.push(r));
    await b.connect();
    const wsB = MockWebSocket.instances.at(-1)!;
    wsB.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    wsB.emit({ type: "rtc-hello", from: MIN_FROM }); // open p2p (b becomes initiator since its from > MIN_FROM)
    await waitFor(() => (b as any).transport === "p2p");
    // Deliver A's presence over the data channel (p2p pipe); it must be ignored.
    const before = rosters.length;
    // Access the data channel directly via the private PeerLink.channel field.
    const ch = (b as any).peer?.channel;
    expect(ch).toBeTruthy();
    expect(ch.onmessage).toBeTruthy();
    ch.onmessage!({ data: JSON.stringify(presenceFrame) });
    await new Promise((r) => setTimeout(r, 20));
    // No new roster entry for A (the p2p-delivered presence was dropped).
    expect(rosters.slice(before).some((r: any) => r.some((d: any) => d.id === "A"))).toBe(false);
  });

  describe("reconnect backoff + terminal close codes", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("does not reset backoff on bare open — repeated opens-without-hello back off exponentially", async () => {
      vi.useFakeTimers();
      const resetSpy = vi.spyOn(Backoff.prototype, "reset");
      const nextSpy = vi.spyOn(Backoff.prototype, "next");
      const client = new UniclipClient({
        roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
        relayBase: "wss://uniclip.app",
      });
      await client.connect();
      await vi.advanceTimersByTimeAsync(0); // flush ws1's onopen microtask
      expect(resetSpy).not.toHaveBeenCalled(); // open alone must NOT reset backoff

      const ws1 = MockWebSocket.instances.at(-1)!;
      ws1.onclose?.(new CloseEvent("close", { code: 1006 })); // transient drop, hello never arrived
      await vi.advanceTimersByTimeAsync(0);
      expect(nextSpy).toHaveBeenCalledTimes(1);
      const delay1 = nextSpy.mock.results[0]!.value as number;
      await vi.advanceTimersByTimeAsync(delay1 + 50); // fire the reconnect timer → ws2

      const ws2 = MockWebSocket.instances.at(-1)!;
      expect(ws2).not.toBe(ws1);
      await vi.advanceTimersByTimeAsync(0); // flush ws2's onopen microtask
      expect(resetSpy).not.toHaveBeenCalled(); // still never reset — no hello yet

      ws2.onclose?.(new CloseEvent("close", { code: 1006 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(nextSpy).toHaveBeenCalledTimes(2);
      const delay2 = nextSpy.mock.results[1]!.value as number;
      expect(delay2).toBeGreaterThan(delay1); // backoff grew — proof it was never reset by a bare open
      vi.useRealTimers();
    });

    it("a hello frame resets backoff — a drop right after hello reconnects at baseMs again", async () => {
      vi.useFakeTimers();
      const resetSpy = vi.spyOn(Backoff.prototype, "reset");
      const nextSpy = vi.spyOn(Backoff.prototype, "next");
      const client = new UniclipClient({
        roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
        relayBase: "wss://uniclip.app",
      });
      await client.connect();
      await vi.advanceTimersByTimeAsync(0);
      const ws1 = MockWebSocket.instances.at(-1)!;

      // Bump the backoff up twice, without a hello, so the doubled range
      // (~1600-2400) can't overlap the base range (~800-1200) checked below.
      ws1.onclose?.(new CloseEvent("close", { code: 1006 }));
      await vi.advanceTimersByTimeAsync(0);
      const delay1 = nextSpy.mock.results[0]!.value as number;
      await vi.advanceTimersByTimeAsync(delay1 + 50);

      const ws2 = MockWebSocket.instances.at(-1)!;
      await vi.advanceTimersByTimeAsync(0);
      ws2.onclose?.(new CloseEvent("close", { code: 1006 }));
      await vi.advanceTimersByTimeAsync(0);
      const delay2 = nextSpy.mock.results[1]!.value as number; // doubled range, ~1600-2400
      await vi.advanceTimersByTimeAsync(delay2 + 50);

      const ws3 = MockWebSocket.instances.at(-1)!;
      await vi.advanceTimersByTimeAsync(0);
      expect(resetSpy).not.toHaveBeenCalled();

      // A hello resets it back to baseMs.
      ws3.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
      expect(resetSpy).toHaveBeenCalledTimes(1);

      ws3.onclose?.(new CloseEvent("close", { code: 1006 }));
      await vi.advanceTimersByTimeAsync(0);
      const postHelloDelay = nextSpy.mock.results[2]!.value as number; // back to base range, ~800-1200
      expect(postHelloDelay).toBeLessThan(delay2); // reset, not the continued doubled sequence
      vi.useRealTimers();
    });

    it.each([
      ["ROOM_NOT_FOUND", CLOSE_CODES.ROOM_NOT_FOUND],
      ["ROOM_EXPIRED", CLOSE_CODES.ROOM_EXPIRED],
      ["TOO_LARGE", CLOSE_CODES.TOO_LARGE],
    ] as const)(
      "terminal close code %s (%d) stops reconnecting and emits a terminal error + disconnected status",
      async (expectedCode, code) => {
        vi.useFakeTimers();
        const client = new UniclipClient({
          roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
          relayBase: "wss://uniclip.app",
        });
        const statuses: string[] = [];
        const errors: { code: string; message: string }[] = [];
        client.on("status", (s: string) => statuses.push(s));
        client.on("error", (e: { code: string; message: string }) => errors.push(e));
        await client.connect();
        await vi.advanceTimersByTimeAsync(0);
        const ws = MockWebSocket.instances.at(-1)!;
        const countBefore = MockWebSocket.instances.length;

        ws.onclose?.(new CloseEvent("close", { code }));
        await vi.advanceTimersByTimeAsync(60_000); // long enough that a normal backoff would have fired

        expect(MockWebSocket.instances.length).toBe(countBefore); // no reconnect socket opened
        expect(statuses.at(-1)).toBe("disconnected");
        expect(errors.some((e) => e.code === expectedCode)).toBe(true);
        vi.useRealTimers();
      },
    );

    it("RATE_LIMIT (4429) is not terminal — it still reconnects", async () => {
      vi.useFakeTimers();
      const client = new UniclipClient({
        roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
        relayBase: "wss://uniclip.app",
      });
      const statuses: string[] = [];
      client.on("status", (s: string) => statuses.push(s));
      await client.connect();
      await vi.advanceTimersByTimeAsync(0);
      const ws1 = MockWebSocket.instances.at(-1)!;
      const countBefore = MockWebSocket.instances.length;

      ws1.onclose?.(new CloseEvent("close", { code: CLOSE_CODES.RATE_LIMIT }));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(MockWebSocket.instances.length).toBeGreaterThan(countBefore); // reconnect socket opened
      expect(statuses).toContain("reconnecting");
      vi.useRealTimers();
    });

    it("disconnect() during a pending reconnect timer prevents the timer from reopening a socket", async () => {
      vi.useFakeTimers();
      const nextSpy = vi.spyOn(Backoff.prototype, "next");
      const client = new UniclipClient({
        roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
        relayBase: "wss://uniclip.app",
      });
      await client.connect();
      await vi.advanceTimersByTimeAsync(0); // flush onopen
      const ws1 = MockWebSocket.instances.at(-1)!;
      const countBefore = MockWebSocket.instances.length;

      ws1.onclose?.(new CloseEvent("close", { code: 1006 })); // transient drop → schedules a reconnect timer
      await vi.advanceTimersByTimeAsync(0);
      expect(nextSpy).toHaveBeenCalledTimes(1);
      const delay = nextSpy.mock.results[0]!.value as number;

      client.disconnect(); // disposed just before the pending reconnect timer fires
      await vi.advanceTimersByTimeAsync(delay + 50); // let the timer fire

      expect(MockWebSocket.instances.length).toBe(countBefore); // openSocket() must no-op on disposed
      vi.useRealTimers();
    });

    it("connect() throws once the client has entered a terminal state (ROOM_NOT_FOUND)", async () => {
      vi.useFakeTimers();
      const client = new UniclipClient({
        roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
        relayBase: "wss://uniclip.app",
      });
      await client.connect();
      await vi.advanceTimersByTimeAsync(0);
      const ws = MockWebSocket.instances.at(-1)!;

      ws.onclose?.(new CloseEvent("close", { code: CLOSE_CODES.ROOM_NOT_FOUND }));
      await vi.advanceTimersByTimeAsync(0);

      await expect(client.connect()).rejects.toThrow(/terminated/i);
      vi.useRealTimers();
    });

    it("connect() throws once the client has been disconnect()ed (disposed)", async () => {
      const client = new UniclipClient({
        roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
        relayBase: "wss://uniclip.app",
      });
      await client.connect();
      client.disconnect();
      await expect(client.connect()).rejects.toThrow(/disposed/i);
    });

    it("disconnect() emits exactly one disconnected status when the socket is open", async () => {
      const client = new UniclipClient({
        roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
        relayBase: "wss://uniclip.app",
      });
      const statuses: string[] = [];
      client.on("status", (s: string) => statuses.push(s));
      await client.connect();
      const ws = MockWebSocket.instances.at(-1)!;
      ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
      // MockWebSocket.close() fires onclose synchronously, so this exercises both
      // disconnect()'s own emit AND the resulting handleClose(disposed) path in
      // one call — the two must not both emit.
      client.disconnect();
      expect(statuses.filter((s) => s === "disconnected")).toHaveLength(1);
    });

    it("disconnect() emits disconnected when called while the socket is already null (pending reconnect)", async () => {
      vi.useFakeTimers();
      const client = new UniclipClient({
        roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
        relayBase: "wss://uniclip.app",
      });
      const statuses: string[] = [];
      client.on("status", (s: string) => statuses.push(s));
      await client.connect();
      await vi.advanceTimersByTimeAsync(0); // flush onopen
      const ws1 = MockWebSocket.instances.at(-1)!;

      // Transient drop: handleClose nulls this.ws and schedules a reconnect timer.
      ws1.onclose?.(new CloseEvent("close", { code: 1006 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(statuses.at(-1)).toBe("reconnecting");

      // disconnect() runs BEFORE the pending reconnect timer fires — this.ws is
      // already null here, so `this.ws?.close()` is a no-op and handleClose never
      // runs. Previously this left the UI stuck on "reconnecting" forever.
      client.disconnect();
      expect(statuses.at(-1)).toBe("disconnected");
      expect(statuses.filter((s) => s === "disconnected")).toHaveLength(1);
      vi.useRealTimers();
    });
  });
});
