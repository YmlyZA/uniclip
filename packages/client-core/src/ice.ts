import { ICE_SERVERS } from "@uniclip/protocol";

// Fetch ICE servers (self-hosted STUN/TURN when the relay is configured for it)
// before constructing a UniclipClient. Fail-safe: any error yields the built-in
// default so a connection is always attempted. NEVER used by the --lan path.
export async function fetchIceServers(
  relayBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RTCIceServer[]> {
  try {
    const base = relayBase.replace(/\/$/, "");
    const res = await fetchImpl(`${base}/api/ice`);
    if (!res.ok) return ICE_SERVERS as RTCIceServer[];
    const body = (await res.json()) as { iceServers?: RTCIceServer[] };
    return Array.isArray(body.iceServers) && body.iceServers.length > 0
      ? body.iceServers
      : (ICE_SERVERS as RTCIceServer[]);
  } catch {
    return ICE_SERVERS as RTCIceServer[];
  }
}
