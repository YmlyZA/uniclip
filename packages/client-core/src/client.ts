import { ulid } from "ulid";
import { ServerFrameSchema, type ClientFrame } from "@uniclip/protocol";
import { encrypt, decrypt, toBase64, fromBase64, ReplaySet } from "@uniclip/crypto";
import { parseRoomUrl, type ParsedRoom } from "@uniclip/room-code";
import { Backoff } from "./backoff";
import { deriveRoomKey } from "./room-key";

export type Status = "connecting" | "connected" | "disconnected" | "reconnecting";

export type ClientEvent =
  | { kind: "status"; value: Status }
  | { kind: "clip"; text: string; ts: number }
  | { kind: "peer"; count: number }
  | { kind: "room"; backfill: boolean }
  | { kind: "error"; code: string; message: string };

// Per-event handler signatures. `clip` carries the frame's original `ts` so
// backfilled clips sort by when they were sent, not when they were received.
export interface EventHandlers {
  status: (value: Status) => void;
  clip: (text: string, ts: number) => void;
  peer: (count: number) => void;
  room: (backfill: boolean) => void;
  error: (err: { code: string; message: string }) => void;
}

export interface UniclipClientOptions {
  roomUrl: string;
  relayBase: string; // e.g. "wss://uniclip.app" — without /ws path
}

export class UniclipClient {
  private readonly room: ParsedRoom;
  private readonly relayBase: string;
  private key: CryptoKey | null = null;
  private ws: WebSocket | null = null;
  private listeners = new Map<keyof EventHandlers, Set<(...args: never[]) => void>>();
  private replay = new ReplaySet();
  private backoff = new Backoff({ baseMs: 1000, maxMs: 30_000, jitter: 0.2 });
  private disposed = false;

  constructor(opts: UniclipClientOptions) {
    const parsed = parseRoomUrl(opts.roomUrl);
    if (!parsed) throw new Error(`invalid room URL: ${opts.roomUrl}`);
    this.room = parsed;
    this.relayBase = opts.relayBase.replace(/\/$/, "");
  }

  on<K extends keyof EventHandlers>(kind: K, cb: EventHandlers[K]): void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    set.add(cb as (...args: never[]) => void);
  }

  private emit(evt: ClientEvent): void {
    const set = this.listeners.get(evt.kind);
    if (!set) return;
    for (const cb of set) {
      switch (evt.kind) {
        case "status": (cb as EventHandlers["status"])(evt.value); break;
        case "clip": (cb as EventHandlers["clip"])(evt.text, evt.ts); break;
        case "peer": (cb as EventHandlers["peer"])(evt.count); break;
        case "room": (cb as EventHandlers["room"])(evt.backfill); break;
        case "error": (cb as EventHandlers["error"])({ code: evt.code, message: evt.message }); break;
      }
    }
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error("client disposed");
    if (!this.key) {
      this.key = await deriveRoomKey(this.room);
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
        this.emit({ kind: "room", backfill: frame.backfill });
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
