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
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0 });
    expect(statuses).toContain("connected");
  });

  it("send() encrypts and writes a clip frame", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0 });
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
    senderWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0 });
    receiverWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0 });

    const received: string[] = [];
    receiver.on("clip", (text: string) => received.push(text));

    await sender.send("ping from A");
    const wireFrame = JSON.parse(senderWs.sent[0]!);
    receiverWs.emit(wireFrame);
    // give the async decrypt a tick
    await new Promise((r) => setTimeout(r, 0));
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
    senderWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0 });
    receiverWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0 });

    const received: string[] = [];
    receiver.on("clip", (t: string) => received.push(t));

    await sender.send("once");
    const wire = JSON.parse(senderWs.sent[0]!);
    receiverWs.emit(wire);
    receiverWs.emit(wire); // duplicate
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual(["once"]);
  });
});
