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

  it("emits 'room' with the backfill flag from hello", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    let backfill: boolean | null = null;
    client.on("room", (b: boolean) => (backfill = b));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: true });
    expect(backfill).toBe(true);
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
});
