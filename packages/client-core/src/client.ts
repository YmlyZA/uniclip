import { ulid } from "ulid";
import { ServerFrameSchema, type ClientFrame } from "@uniclip/protocol";
import { encrypt, decrypt, toBase64, fromBase64, ReplaySet } from "@uniclip/crypto";
import { parseRoomUrl, type ParsedRoom } from "@uniclip/room-code";
import { Backoff } from "./backoff";
import { deriveRoomKey } from "./room-key";

const MAX_QUEUE = 100;

export type Status = "connecting" | "connected" | "disconnected" | "reconnecting";

export type ClientEvent =
  | { kind: "status"; value: Status }
  | { kind: "clip"; text: string; ts: number; msgId: string }
  | { kind: "delete"; msgId: string }
  | { kind: "peer"; count: number }
  | { kind: "room"; backfill: boolean; ephemeral: boolean }
  | { kind: "error"; code: string; message: string }
  | { kind: "sent"; msgId: string };

// Per-event handler signatures. `clip` carries the frame's original `ts` so
// backfilled clips sort by when they were sent, not when they were received.
export interface EventHandlers {
  status: (value: Status) => void;
  clip: (text: string, ts: number, msgId: string) => void;
  delete: (msgId: string) => void;
  peer: (count: number) => void;
  room: (info: { backfill: boolean; ephemeral: boolean }) => void;
  error: (err: { code: string; message: string }) => void;
  sent: (msgId: string) => void;
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
  private queue: string[] = [];
  private backoff = new Backoff({ baseMs: 1000, maxMs: 30_000, jitter: 0.2 });
  private disposed = false;
  private decryptedOk = false;
  private decryptWarned = false;

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
        case "clip": (cb as EventHandlers["clip"])(evt.text, evt.ts, evt.msgId); break;
        case "delete": (cb as EventHandlers["delete"])(evt.msgId); break;
        case "peer": (cb as EventHandlers["peer"])(evt.count); break;
        case "room": (cb as EventHandlers["room"])({ backfill: evt.backfill, ephemeral: evt.ephemeral }); break;
        case "error": (cb as EventHandlers["error"])({ code: evt.code, message: evt.message }); break;
        case "sent": (cb as EventHandlers["sent"])(evt.msgId); break;
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

  private flushQueue(): void {
    while (this.queue.length > 0) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return; // remainder stays queued
      const payload = this.queue.shift()!;
      this.ws.send(payload);
      const { msgId } = JSON.parse(payload) as ClientFrame;
      this.emit({ kind: "sent", msgId });
    }
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
        this.emit({ kind: "room", backfill: frame.backfill, ephemeral: frame.ephemeral });
        this.flushQueue();
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
          this.decryptedOk = true;
          this.emit({ kind: "clip", text, ts: frame.ts, msgId: frame.msgId });
        } catch {
          // Frames arrive but never decrypt: almost always a wrong/missing key —
          // e.g. a Mode-A room opened without its #secret (some apps strip the
          // fragment from shared links), so the client derived a Mode-B key.
          // Surface it once instead of silently dropping every clip.
          if (!this.decryptedOk && !this.decryptWarned) {
            this.decryptWarned = true;
            this.emit({
              kind: "error",
              code: "DECRYPT_FAILED",
              message:
                "Connected, but can't decrypt this room. Open the full share link — it carries the secret key.",
            });
          }
        }
        return;
      }
      case "delete":
        this.emit({ kind: "delete", msgId: frame.msgId });
        return;
      case "error":
        this.emit({ kind: "error", code: frame.code, message: frame.message });
        return;
    }
  }

  async send(text: string): Promise<{ msgId: string; ts: number; queued: boolean }> {
    if (!this.key) throw new Error("no key");
    const msgId = ulid();
    const ts = Date.now();
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
      ts,
    };
    const payload = JSON.stringify(frame);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return { msgId, ts, queued: false };
    }
    // Offline: queue for flush on the next hello. ts is frozen at composition.
    this.queue.push(payload);
    if (this.queue.length > MAX_QUEUE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE);
      this.emit({
        kind: "error",
        code: "QUEUE_FULL",
        message: "offline queue full — oldest unsent items dropped",
      });
    }
    return { msgId, ts, queued: true };
  }

  delete(msgId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const frame: ClientFrame = { type: "delete", msgId };
    this.ws.send(JSON.stringify(frame));
  }

  disconnect(): void {
    this.disposed = true;
    this.ws?.close();
    this.ws = null;
  }
}
