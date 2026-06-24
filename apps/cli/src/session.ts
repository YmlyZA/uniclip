import { UniclipClient } from "@uniclip/client-core";
import { generateModeARoom } from "@uniclip/room-code";
import { disabledPeer } from "./disabled-peer";
import { weriftPeer } from "./werift-peer";

// Room URL (http/https origin) → the ws(s) base UniclipClient connects to.
export function relayBaseFromUrl(roomUrl: string): string {
  const u = new URL(roomUrl);
  const ws = u.protocol === "https:" ? "wss:" : "ws:";
  return `${ws}//${u.host}`;
}

// Mint a Mode-A room on the relay and form its share URL (secret client-side).
export async function createRoom(
  relayBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ roomUrl: string }> {
  const base = relayBase.replace(/\/$/, "");
  const res = await fetchImpl(`${base}/api/room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "A" }),
  });
  if (!res.ok) throw new Error(`room creation failed: ${res.status}`);
  const { roomId } = (await res.json()) as { roomId: string };
  const { secret } = generateModeARoom();
  return { roomUrl: `${base}/r/${roomId}#${secret}` };
}

// The WebRTC factory for a session: real werift by default, the never-opening
// stub when the user forces relay-only.
export function peerFactory(relayOnly: boolean): (config: RTCConfiguration) => RTCPeerConnection {
  return relayOnly ? disabledPeer : weriftPeer;
}

// Build a UniclipClient. P2P uses werift unless relayOnly forces the relay.
export function makeClient(opts: { roomUrl: string; deviceName?: string; relayOnly?: boolean }): UniclipClient {
  return new UniclipClient({
    roomUrl: opts.roomUrl,
    relayBase: relayBaseFromUrl(opts.roomUrl),
    createConnection: peerFactory(opts.relayOnly ?? false),
    ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
  });
}
