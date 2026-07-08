import { ulid } from "ulid";
import { ServerFrameSchema, type ClientFrame, ICE_SERVERS, CLOSE_CODES } from "@uniclip/protocol";
import { encrypt, decrypt, toBase64, fromBase64, ReplaySet } from "@uniclip/crypto";
import { parseRoomUrl, type ParsedRoom } from "@uniclip/room-code";
import { Backoff } from "./backoff";
import { deriveRoomKey } from "./room-key";
import { FileTransferManager, type FileClientEvent } from "./file-transfer";
import { PeerLink, type PeerSignal } from "./peer-link";
import { PresenceManager, type Device, type PresenceFrame } from "./presence";
import type { DiagEvent } from "./diag";

const MAX_QUEUE = 100;

// The relay accepts the WS upgrade and only *afterward* closes it for a
// permanent condition — so these codes arrive after onopen has already fired.
// They mean "don't bother reconnecting"; everything else is a transient drop.
const TERMINAL_CLOSE_INFO: Record<number, { code: string; message: string }> = {
  [CLOSE_CODES.ROOM_NOT_FOUND]: { code: "ROOM_NOT_FOUND", message: "This room no longer exists." },
  [CLOSE_CODES.ROOM_EXPIRED]: { code: "ROOM_EXPIRED", message: "This room has expired." },
  [CLOSE_CODES.TOO_LARGE]: { code: "TOO_LARGE", message: "The relay rejected a frame as too large." },
};

export type Status = "connecting" | "connected" | "disconnected" | "reconnecting";

export type ClientEvent =
  | { kind: "status"; value: Status }
  | { kind: "clip"; text: string; ts: number; msgId: string }
  | { kind: "delete"; msgId: string }
  | { kind: "peer"; count: number }
  | { kind: "room"; backfill: boolean; ephemeral: boolean }
  | { kind: "error"; code: string; message: string }
  | { kind: "sent"; msgId: string }
  | { kind: "transport"; value: "p2p" | "relay" }
  | { kind: "presence"; roster: Device[] }
  | DiagEvent
  | FileClientEvent;

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
  "file-offer": (o: { fileId: string; name: string; mime: string; size: number; chunkCount: number; hash: string; inline: boolean }) => void;
  "file-progress": (p: { fileId: string; dir: "send" | "recv"; sent: number; total: number }) => void;
  "file-received": (r: { fileId: string; blob: Blob; name: string; mime: string }) => void;
  "file-error": (e: { fileId: string; code: string; message: string }) => void;
  "file-cancel": (c: { fileId: string; reason: string }) => void;
  transport: (value: "p2p" | "relay") => void;
  presence: (roster: Device[]) => void;
  diag: (e: DiagEvent) => void;
}

export interface UniclipClientOptions {
  roomUrl: string;
  relayBase: string; // e.g. "wss://uniclip.app" — without /ws path
  iceServers?: RTCIceServer[];
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  deviceId?: string;
  deviceName?: string;
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
  private terminated = false;
  private decryptedOk = false;
  private decryptWarned = false;
  private transfers!: FileTransferManager;
  private peer: PeerLink | null = null;
  private transport: "p2p" | "relay" = "relay";
  private readonly iceServers: RTCIceServer[];
  private readonly createConnection: ((config: RTCConfiguration) => RTCPeerConnection) | undefined;
  private presence!: PresenceManager;
  private deviceName: string;

  constructor(opts: UniclipClientOptions) {
    const parsed = parseRoomUrl(opts.roomUrl);
    if (!parsed) throw new Error(`invalid room URL: ${opts.roomUrl}`);
    this.room = parsed;
    this.relayBase = opts.relayBase.replace(/\/$/, "");
    this.iceServers = opts.iceServers ?? ICE_SERVERS;
    this.createConnection = opts.createConnection;
    this.transfers = new FileTransferManager({
      routingId: this.room.routingId,
      getKey: () => this.key,
      send: (frame) => this.sendFrame(frame),
      emit: (evt) => this.emit(evt),
    });
    this.deviceName = (opts.deviceName ?? "This device").slice(0, 40);
    const selfId = opts.deviceId ?? ulid();
    this.presence = new PresenceManager({
      routingId: this.room.routingId,
      selfId,
      getKey: () => this.key,
      getName: () => this.deviceName,
      send: (frame: PresenceFrame) => {
        // Presence rides the WS so the relay fans it to ALL peers (rooms can be >2).
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
      },
      emit: (roster) => this.emit({ kind: "presence", roster }),
    });
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
        case "file-offer": (cb as EventHandlers["file-offer"])(evt); break;
        case "file-progress": (cb as EventHandlers["file-progress"])(evt); break;
        case "file-received": (cb as EventHandlers["file-received"])(evt); break;
        case "file-error": (cb as EventHandlers["file-error"])(evt); break;
        case "file-cancel": (cb as EventHandlers["file-cancel"])(evt); break;
        case "transport": (cb as EventHandlers["transport"])(evt.value); break;
        case "presence": (cb as EventHandlers["presence"])(evt.roster); break;
        case "diag": (cb as EventHandlers["diag"])(evt); break;
      }
    }
  }

  private diag(phase: DiagEvent["phase"], level: DiagEvent["level"], detail: string, data?: Record<string, string | number>): void {
    this.emit({ kind: "diag", phase, level, detail, ...(data ? { data } : {}) });
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error("client disposed");
    if (!this.key) {
      this.key = await deriveRoomKey(this.room);
    }
    this.openSocket();
  }

  private openSocket(): void {
    if (this.terminated) return; // a stray call after a terminal close must not restart the loop
    this.emit({ kind: "status", value: "connecting" });
    this.diag("ws", "info", "connecting", { event: "connecting" });
    const ws = new WebSocket(`${this.relayBase}/ws/${this.room.routingId}`);
    this.ws = ws;
    ws.onopen = () => {
      // Don't reset backoff here: the relay accepts the WS upgrade and only
      // afterward closes it for a permanent condition (see TERMINAL_CLOSE_INFO),
      // so resetting on open would defeat backoff against a dead room. A `hello`
      // is the genuine signal the connection succeeded end-to-end — reset there.
      this.diag("ws", "info", "open", { event: "open" });
    };
    ws.onmessage = (ev) => this.handleFrame(ev.data as string).catch(() => undefined);
    // The socket can die two ways, and the runtimes disagree on which fires:
    // browsers fire onerror THEN onclose; Node's global WebSocket (undici) fires
    // onerror WITHOUT onclose on a *failed connect*. Route both through one
    // idempotent path so a failed reconnect still schedules the next attempt —
    // otherwise the reconnect loop dies after the first offline retry (it never
    // recovers when the network returns). `down` fires at most once per socket.
    let handledDown = false;
    const down = (code?: number) => {
      if (handledDown) return;
      handledDown = true;
      this.diag("ws", "warn", code ? `closed (${code})` : "closed", { event: "close", ...(typeof code === "number" ? { code } : {}) });
      this.handleClose(code);
    };
    ws.onclose = (ev) => down((ev as CloseEvent | undefined)?.code);
    ws.onerror = () => {
      this.emit({ kind: "error", code: "WS_ERROR", message: "websocket error" });
      down();
    };
  }

  private handleClose(code?: number): void {
    // File transfers are live-only — they cannot survive a socket drop. Abort
    // any in-flight transfer on EVERY close (including a transient drop during
    // auto-reconnect), not just explicit disconnect(). Otherwise a receiver's
    // `incoming` entry leaks (the receiver has no stall timer; only the sender does).
    this.transfers.abortAll("disconnected");
    this.teardownPeer(); // a fresh hello re-arms once a peer is present again
    this.presence.stop();
    this.ws = null;
    const terminalInfo = code !== undefined ? TERMINAL_CLOSE_INFO[code] : undefined;
    if (terminalInfo) {
      // Permanent condition (room gone/expired, frame too large): reconnecting
      // would just repeat the same rejection. Stop for good.
      this.terminated = true;
      this.emit({ kind: "error", code: terminalInfo.code, message: terminalInfo.message });
      this.emit({ kind: "status", value: "disconnected" });
      return;
    }
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
      const frame = JSON.parse(payload) as ClientFrame;
      // `sent` clears a clip's pending UI; a flushed delete has no pending item.
      if (frame.type === "clip") this.emit({ kind: "sent", msgId: frame.msgId });
    }
  }

  // Append a serialized frame to the offline queue, bounded FIFO. Shared by the
  // offline paths of send() and delete().
  private enqueue(payload: string): void {
    this.queue.push(payload);
    if (this.queue.length > MAX_QUEUE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE);
      this.emit({
        kind: "error",
        code: "QUEUE_FULL",
        message: "offline queue full — oldest unsent items dropped",
      });
    }
  }

  private async handleFrame(raw: string, via: "ws" | "p2p" = "ws"): Promise<void> {
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
        // A hello is the genuine signal the connection succeeded end-to-end
        // (the WS upgrade alone isn't — see TERMINAL_CLOSE_INFO); reset backoff here.
        this.backoff.reset();
        this.emit({ kind: "status", value: "connected" });
        this.emit({ kind: "peer", count: frame.peerCount });
        this.emit({ kind: "room", backfill: frame.backfill, ephemeral: frame.ephemeral });
        this.flushQueue();
        // Arm a PeerLink; the rtc-hello identity handshake decides who initiates.
        if (frame.peerCount >= 2) this.armPeer();
        this.presence.start(); // idempotent; announces self + starts heartbeat/sweep
        return;
      case "peer-joined":
        this.emit({ kind: "peer", count: frame.peerCount });
        if (frame.peerCount >= 2 && !this.peer) this.armPeer();
        this.presence.onPeerChange(false);
        return;
      case "peer-left":
        this.emit({ kind: "peer", count: frame.peerCount });
        if (frame.peerCount < 2) this.teardownPeer();
        this.presence.onPeerChange(true);
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
          this.diag("decrypt-fail", "warn", "decrypt failed", { msgId: frame.msgId });
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
      case "file-offer":
      case "file-accept":
      case "file-decline":
      case "file-chunk":
      case "file-ack":
      case "file-complete":
      case "file-cancel":
        await this.transfers.handle(frame);
        return;
      case "sdp":
      case "ice":
      case "rtc-hello":
        if (via !== "ws") return;
        this.diag("signal", "info", `<- ${frame.type}`, { dir: "recv", type: frame.type });
        await this.peer?.handleSignal(frame as PeerSignal);
        return;
      case "presence":
        if (via !== "ws") return;
        await this.presence.handlePresence(frame);
        return;
      case "error":
        if (via !== "ws") return;
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
    if (this.sendFrame(frame)) {
      return { msgId, ts, queued: false };
    }
    // Offline: queue for flush on the next hello. ts is frozen at composition.
    this.enqueue(payload);
    return { msgId, ts, queued: true };
  }

  delete(msgId: string): void {
    const frame: ClientFrame = { type: "delete", msgId };
    const payload = JSON.stringify(frame);
    if (this.sendFrame(frame)) {
      return;
    }
    // Offline. If the target clip is itself still queued (composed but never
    // sent), drop it from the queue rather than queue a delete — no peer ever
    // saw it, so there is nothing to delete remotely.
    const i = this.queue.findIndex((p) => {
      const f = JSON.parse(p) as ClientFrame;
      return f.type === "clip" && f.msgId === msgId;
    });
    if (i >= 0) {
      this.queue.splice(i, 1);
      return;
    }
    this.enqueue(payload);
  }

  // Prefer the P2P data channel; fall back to the WS. Returns false only when
  // BOTH are unavailable (caller decides whether to queue).
  private sendFrame(frame: ClientFrame): boolean {
    const payload = JSON.stringify(frame);
    if (this.peer?.isOpen()) {
      if (this.peer.send(payload)) return true;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return true;
    }
    return false;
  }

  private setTransport(value: "p2p" | "relay"): void {
    if (this.transport === value) return;
    this.transport = value;
    this.diag("transport", "info", value === "p2p" ? "relay -> p2p" : "p2p -> relay", { value });
    this.emit({ kind: "transport", value });
  }

  private armPeer(): void {
    this.peer?.close();
    this.peer = new PeerLink({
      iceServers: this.iceServers,
      ...(this.createConnection ? { createConnection: this.createConnection } : {}),
      signal: (s: PeerSignal) => {
        this.diag("signal", "info", `-> ${s.type}`, { dir: "send", type: s.type });
        // Signaling ALWAYS rides the WS — never the channel it is establishing.
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(s));
      },
      onDiag: (e) => this.emit(e),
      onOpen: () => this.setTransport("p2p"),
      onMessage: (data) => void this.handleFrame(data, "p2p").catch(() => undefined),
      onClose: () => {
        this.setTransport("relay");
        this.transfers.abortAll("disconnected"); // live-only transfers cannot survive a channel drop
      },
    });
    this.peer.start();
  }

  private teardownPeer(): void {
    this.peer?.close();
    this.peer = null;
    this.setTransport("relay");
  }

  async sendFile(file: { name: string; mime: string; bytes: Uint8Array }): Promise<{ fileId: string; chunkCount: number } | null> {
    return this.transfers.sendFile(file);
  }
  acceptFile(fileId: string): void { this.transfers.acceptFile(fileId); }
  declineFile(fileId: string): void { this.transfers.declineFile(fileId); }
  cancelFile(fileId: string): void { this.transfers.cancelFile(fileId); }

  setDeviceName(name: string): void {
    this.deviceName = name.slice(0, 40);
    this.presence.onNameChange();
  }

  disconnect(): void {
    this.disposed = true;
    this.transfers.abortAll("disconnected");
    this.peer?.close();
    this.peer = null;
    this.presence.stop();
    this.ws?.close();
    this.ws = null;
  }
}
