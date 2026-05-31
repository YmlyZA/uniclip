import { ulid } from "ulid";
import { ServerFrameSchema, type ClientFrame } from "@uniclip/protocol";
import { deriveKey, encrypt, decrypt, toBase64, fromBase64, ReplaySet } from "@uniclip/crypto";
import { parseRoomUrl, MODE_B_SALT, type ParsedRoom } from "@uniclip/room-code";
import { Backoff } from "./backoff";

export type ClientEvent =
  | { kind: "status"; value: "connecting" | "connected" | "disconnected" | "reconnecting" }
  | { kind: "clip"; text: string; ts: number }
  | { kind: "peer"; count: number }
  | { kind: "error"; code: string; message: string };

type Listener<K extends ClientEvent["kind"]> = (
  arg: K extends "status"
    ? "connecting" | "connected" | "disconnected" | "reconnecting"
    : K extends "clip"
      ? string
      : K extends "peer"
        ? number
        : { code: string; message: string },
) => void;

export interface UniclipClientOptions {
  roomUrl: string;
  relayBase: string; // e.g. "wss://uniclip.app" — without /ws path
}

export class UniclipClient {
  private readonly room: ParsedRoom;
  private readonly relayBase: string;
  private key: CryptoKey | null = null;
  private ws: WebSocket | null = null;
  private listeners = new Map<ClientEvent["kind"], Set<Listener<ClientEvent["kind"]>>>();
  private replay = new ReplaySet();
  private backoff = new Backoff({ baseMs: 1000, maxMs: 30_000, jitter: 0.2 });
  private disposed = false;

  constructor(opts: UniclipClientOptions) {
    const parsed = parseRoomUrl(opts.roomUrl);
    if (!parsed) throw new Error(`invalid room URL: ${opts.roomUrl}`);
    this.room = parsed;
    this.relayBase = opts.relayBase.replace(/\/$/, "");
  }

  on<K extends ClientEvent["kind"]>(kind: K, cb: Listener<K>): void {
    if (!this.listeners.has(kind)) this.listeners.set(kind, new Set());
    this.listeners.get(kind)!.add(cb as Listener<ClientEvent["kind"]>);
  }

  private emit(evt: ClientEvent): void {
    const set = this.listeners.get(evt.kind);
    if (!set) return;
    for (const cb of set) {
      switch (evt.kind) {
        case "status": cb(evt.value as never); break;
        case "clip": cb(evt.text as never); break;
        case "peer": cb(evt.count as never); break;
        case "error": cb({ code: evt.code, message: evt.message } as never); break;
      }
    }
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error("client disposed");
    if (!this.key) {
      if (this.room.mode === "A") {
        this.key = await deriveKey({ secret: this.room.secret, salt: this.room.routingId });
      } else {
        this.key = await deriveKey({ secret: this.room.routingId, salt: MODE_B_SALT });
      }
    }
    this.openSocket();
  }

  private openSocket(): void {
    this.emit({ kind: "status", value: "connecting" });
    const ws = new WebSocket(`${this.relayBase}/ws/${this.room.routingId}`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff.reset();
    };
    ws.onmessage = (ev) => this.handleFrame(ev.data as string).catch(() => undefined);
    ws.onclose = () => this.handleClose();
    ws.onerror = () => this.emit({ kind: "error", code: "WS_ERROR", message: "websocket error" });
  }

  private handleClose(): void {
    this.ws = null;
    if (this.disposed) {
      this.emit({ kind: "status", value: "disconnected" });
      return;
    }
    const delay = this.backoff.next();
    this.emit({ kind: "status", value: "reconnecting" });
    setTimeout(() => this.openSocket(), delay);
  }

  private async handleFrame(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const result = ServerFrameSchema.safeParse(parsed);
    if (!result.success) return;
    const frame = result.data;
    switch (frame.type) {
      case "hello":
        this.emit({ kind: "status", value: "connected" });
        this.emit({ kind: "peer", count: frame.peerCount });
        return;
      case "peer-joined":
      case "peer-left":
        this.emit({ kind: "peer", count: frame.peerCount });
        return;
      case "clip": {
        if (!this.key) return;
        if (!this.replay.admit(frame.msgId)) return;
        try {
          const text = await decrypt({
            key: this.key,
            iv: fromBase64(frame.iv),
            ciphertext: fromBase64(frame.ciphertext),
            aad: `${this.room.routingId}:${frame.msgId}`,
          });
          this.emit({ kind: "clip", text, ts: frame.ts });
        } catch {
          // bad key / tampered / wrong room — drop silently
        }
        return;
      }
      case "error":
        this.emit({ kind: "error", code: frame.code, message: frame.message });
        return;
    }
  }

  async send(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    if (!this.key) throw new Error("no key");
    const msgId = ulid();
    const env = await encrypt({
      key: this.key,
      plaintext: text,
      aad: `${this.room.routingId}:${msgId}`,
    });
    const frame: ClientFrame = {
      type: "clip",
      msgId,
      iv: toBase64(env.iv),
      ciphertext: toBase64(env.ciphertext),
      ts: Date.now(),
    };
    this.ws.send(JSON.stringify(frame));
  }

  disconnect(): void {
    this.disposed = true;
    this.ws?.close();
    this.ws = null;
  }
}
