import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UniclipClient } from "./client";

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

    expect(ws.sent).toHaveLength(1);
    const sent = JSON.parse(ws.sent[0]!);
    expect(sent.type).toBe("clip");
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
    const wireFrame = JSON.parse(senderWs.sent[0]!);
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
    const wire = JSON.parse(senderWs.sent[0]!);
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
    const wire = JSON.parse(senderWs.sent[0]!);
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

  it("send() returns the minted msgId and ts matching the wire frame", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    const res = await client.send("x");
    const wire = JSON.parse(ws.sent[0]!);
    expect(res.msgId).toBe(wire.msgId);
    expect(res.ts).toBe(wire.ts);
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
    const wire = JSON.parse(senderWs.sent[0]!);
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
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "delete", msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
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
    expect(ws.sent).toHaveLength(0); // nothing went out while offline

    ws.readyState = MockWebSocket.OPEN; // back online
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "delete", msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
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
    // The clip was dropped from the queue and no delete was queued: peers never
    // saw it, so there is nothing to send at all.
    expect(ws.sent).toHaveLength(0);
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

    expect(ws.sent).toHaveLength(2); // clip then delete, in order
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

    expect(ws.sent).toHaveLength(2);
    expect(JSON.parse(ws.sent[0]!).msgId).toBe(a.msgId);
    expect(JSON.parse(ws.sent[1]!).msgId).toBe(b.msgId);
    expect(JSON.parse(ws.sent[0]!).ts).toBe(a.ts); // ts frozen at composition
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

    expect(ws.sent).toHaveLength(100); // capped at MAX_QUEUE
    expect(ws.sent.some((s) => JSON.parse(s).msgId === first.msgId)).toBe(false); // oldest dropped
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
    const wire = JSON.parse(senderWs.sent[0]!);
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
    ws.emit({ type: "file-offer", fileId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "f", mime: "text/plain", size: 1, chunkCount: 1, hash: "a".repeat(64), inline: false });
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
    ws.emit({ type: "file-offer", fileId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "f", mime: "text/plain", size: 1, chunkCount: 2, hash: "a".repeat(64), inline: false });
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).type === "file-accept"));
    client.disconnect();
    expect(errs).toContain("DISCONNECTED");
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
    ws.emit({ type: "file-offer", fileId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "f", mime: "text/plain", size: 1, chunkCount: 2, hash: "a".repeat(64), inline: false });
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
function fakePcFactory() {
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
      async setRemoteDescription() {},
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
});
