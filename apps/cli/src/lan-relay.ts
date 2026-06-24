import { WebSocketServer, type WebSocket } from "ws";
import { ClientFrameSchema, MAX_FRAME_BYTES } from "@uniclip/protocol";

export interface LanRelay {
  port: number;
  close(): void;
}

// A minimal single-room WebSocket fan-out — the relay's wire protocol with
// everything offline doesn't need stripped out (no backfill, tombstones,
// persistence, rate limiting, or metrics). The host runs this and points its
// own UniclipClient at it; a LAN joiner connects too. Frames stay opaque: the
// relay validates shape and fans ciphertext + signaling to the OTHER sockets.
export function startLanRelay(opts: { routingId: string; host?: string }): Promise<LanRelay> {
  const wss = new WebSocketServer({ port: 0, host: opts.host ?? "0.0.0.0" });
  const sockets = new Set<WebSocket>();

  const broadcast = (from: WebSocket | null, payload: string) => {
    for (const s of sockets) {
      if (s === from) continue;
      if (s.readyState === 1 /* OPEN */) {
        try { s.send(payload); } catch { /* a failing socket must not block the rest */ }
      }
    }
  };

  wss.on("connection", (ws) => {
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
      if (!ClientFrameSchema.safeParse(parsed).success) return;
      broadcast(ws, str); // re-serialize from the validated shape would be equivalent; str is already validated
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
