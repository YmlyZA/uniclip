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
//  - a per-socket sliding-window frame budget bounds fan-out amplification from
//    a flooding peer (counted on raw inbound, before parse, so junk floods are
//    capped too). Over budget → the frame is dropped, the socket kept.
// These bound the socket-count and per-socket frame-rate vectors. Connection
// *event* rate (rapid connect/disconnect churn → peer-joined/left broadcasts)
// is NOT throttled — an accepted limitation on an open LAN port (see the
// security review); the secret keeps content opaque regardless.
const DEFAULT_MAX_PEERS = 8;
const DEFAULT_FRAME_LIMIT = 500;
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
  frameWindowMs?: number;
}): Promise<LanRelay> {
  const maxPeers = opts.maxPeers ?? DEFAULT_MAX_PEERS;
  const frameLimit = opts.frameLimit ?? DEFAULT_FRAME_LIMIT;
  const frameWindowMs = opts.frameWindowMs ?? DEFAULT_FRAME_WINDOW_MS;
  const wss = new WebSocketServer({ port: 0, host: opts.host ?? "0.0.0.0" });
  const sockets = new Set<WebSocket>();
  const hits = new WeakMap<WebSocket, number[]>(); // per-socket frame timestamps

  const broadcast = (from: WebSocket | null, payload: string) => {
    for (const s of sockets) {
      if (s === from) continue;
      if (s.readyState === WS_OPEN) {
        try { s.send(payload); } catch { /* a failing socket must not block the rest */ }
      }
    }
  };

  // Sliding-window admit: true if this socket is under its frame budget.
  const admit = (ws: WebSocket): boolean => {
    const now = Date.now();
    const arr = hits.get(ws) ?? [];
    const cutoff = now - frameWindowMs;
    while (arr.length && arr[0]! < cutoff) arr.shift();
    if (arr.length >= frameLimit) { hits.set(ws, arr); return false; }
    arr.push(now);
    hits.set(ws, arr);
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
      if (!admit(ws)) return; // rate-limited: drop, keep the socket
      let parsed: unknown;
      try { parsed = JSON.parse(str); } catch { return; }
      if (!ClientFrameSchema.safeParse(parsed).success) return;
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
