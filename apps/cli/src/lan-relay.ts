import { WebSocketServer, type WebSocket } from "ws";
import { ClientFrameSchema, MAX_FRAME_BYTES } from "@uniclip/protocol";

export interface LanRelay {
  port: number;
  close(): void;
}

// The embedded relay binds 0.0.0.0 on an open LAN port, so it needs the same
// DoS backstops the public relay has, sized for the offline use case:
//  - a connection cap bounds socket/Set growth from a peer opening floods of
//    connections (the CLI use is a host + a few joiners);
//  - a two-tier per-socket sliding-window frame budget bounds fan-out amplification:
//      * file-* cap (fileLimit, default 2000/10 s): applied to file-chunk/ack/offer/…
//        after schema validation — these ride the higher budget because chunked file
//        transfers on a relay fallback legitimately burst well above the clip limit
//        (mirrors the public relay's chunkLimiter);
//      * non-file cap (frameLimit, default 500/10 s): applied to clip/signaling/
//        presence/delete after schema validation — stricter because fan-out
//        amplification risk is higher for small frequent frames.
//    The two budgets are INDEPENDENT per socket: file-* consumption does not steal
//    headroom from non-file frames and vice versa; a flooding clip sender cannot
//    starve a concurrent file transfer, and a file flood cannot exhaust the clip
//    budget. Junk (parse/schema failures) is free — no rate bucket; the MAX_FRAME_BYTES
//    gate + ws library backpressure bound the worst case cost per junk frame.
//    Over budget → the frame is dropped, the socket kept.
// These bound the socket-count and per-socket frame-rate vectors. Connection
// *event* rate (rapid connect/disconnect churn → peer-joined/left broadcasts)
// is NOT throttled — an accepted limitation on an open LAN port (see the
// security review); the secret keeps content opaque regardless.
const DEFAULT_MAX_PEERS = 8;
const DEFAULT_FRAME_LIMIT = 500;   // non-file frames (clips/signaling/presence) per window, per socket
const DEFAULT_FILE_LIMIT = 2000;   // file-* frames per window, per socket (mirrors the public relay's chunkLimiter)
const DEFAULT_FRAME_WINDOW_MS = 10_000;

const WS_OPEN = 1;
const CLOSE_ROOM_FULL = 1013; // RFC 6455 "Try Again Later"

// A minimal single-room WebSocket fan-out — the relay's wire protocol with
// everything offline doesn't need stripped out (no backfill, tombstones,
// persistence, or metrics). The host runs this and points its own UniclipClient
// at it; a LAN joiner connects too. Frames stay opaque: the relay validates
// shape and fans ciphertext + signaling to the OTHER sockets.
export function startLanRelay(opts: {
  routingId: string;
  host?: string;
  maxPeers?: number;
  frameLimit?: number;
  fileLimit?: number;
  frameWindowMs?: number;
}): Promise<LanRelay> {
  const maxPeers = opts.maxPeers ?? DEFAULT_MAX_PEERS;
  const frameLimit = opts.frameLimit ?? DEFAULT_FRAME_LIMIT;
  const fileLimit = opts.fileLimit ?? DEFAULT_FILE_LIMIT;
  const frameWindowMs = opts.frameWindowMs ?? DEFAULT_FRAME_WINDOW_MS;
  const wss = new WebSocketServer({ port: 0, host: opts.host ?? "0.0.0.0" });
  const sockets = new Set<WebSocket>();
  const typeHits = new WeakMap<WebSocket, number[]>(); // non-file valid frames — stricter cap (frameLimit)
  const fileHits = new WeakMap<WebSocket, number[]>(); // file-* valid frames — higher cap (fileLimit)

  const broadcast = (from: WebSocket | null, payload: string) => {
    for (const s of sockets) {
      if (s === from) continue;
      if (s.readyState === WS_OPEN) {
        try { s.send(payload); } catch { /* a failing socket must not block the rest */ }
      }
    }
  };

  // Generic per-socket sliding window against `map` with `limit`.
  const admit = (map: WeakMap<WebSocket, number[]>, ws: WebSocket, limit: number): boolean => {
    const now = Date.now();
    const arr = map.get(ws) ?? [];
    const cutoff = now - frameWindowMs;
    while (arr.length && arr[0]! < cutoff) arr.shift();
    if (arr.length >= limit) { map.set(ws, arr); return false; }
    arr.push(now);
    map.set(ws, arr);
    return true;
  };

  wss.on("connection", (ws) => {
    // Connection cap: refuse beyond maxPeers (bounds memory + fan-out).
    if (sockets.size >= maxPeers) {
      try { ws.close(CLOSE_ROOM_FULL, "room full"); } catch { /* already gone */ }
      return;
    }
    sockets.add(ws);
    ws.send(JSON.stringify({
      type: "hello", roomId: opts.routingId, peerCount: sockets.size,
      serverTime: Date.now(), backfill: false, ephemeral: true,
    }));
    broadcast(ws, JSON.stringify({ type: "peer-joined", peerCount: sockets.size }));

    ws.on("message", (data) => {
      const str = data.toString("utf8");
      if (Buffer.byteLength(str, "utf8") > MAX_FRAME_BYTES) return;
      let parsed: unknown;
      try { parsed = JSON.parse(str); } catch { return; }
      const result = ClientFrameSchema.safeParse(parsed);
      if (!result.success) return;
      // Per-category caps: file-* ride the higher budget; non-file get the stricter cap.
      // The two budgets are independent — file-* consumption does not steal non-file headroom
      // and vice versa; a flooding clip sender cannot starve a concurrent file transfer.
      const isFile = result.data.type.startsWith("file-");
      if (isFile && !admit(fileHits, ws, fileLimit)) return;
      if (!isFile && !admit(typeHits, ws, frameLimit)) return;
      broadcast(ws, str); // already validated; str is the opaque frame
    });

    ws.on("close", () => {
      sockets.delete(ws);
      broadcast(null, JSON.stringify({ type: "peer-left", peerCount: sockets.size }));
    });
  });

  return new Promise<LanRelay>((resolve) => {
    wss.on("listening", () => {
      const port = (wss.address() as { port: number }).port;
      resolve({ port, close: () => wss.close() });
    });
  });
}
