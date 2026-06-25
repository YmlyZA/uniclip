import { UniclipClient } from "@uniclip/client-core";
import { generateModeARoom } from "@uniclip/room-code";
import { startLanRelay } from "./lan-relay";
import { bonjourDiscovery, type Discovery } from "./mdns";
import { formatLanToken, parseLanToken } from "./lan-token";
import { weriftPeer } from "./werift-peer";

function deviceServiceName(deviceName?: string): string {
  return `uniclip ${(deviceName ?? "device").slice(0, 30)}`;
}

// Host: mint a Mode-A room locally, run the embedded relay, advertise it over
// mDNS, and point our own UniclipClient at it. No network beyond the LAN.
export async function startLanHost(
  opts: { deviceName?: string; discovery?: Discovery } = {},
): Promise<{ client: UniclipClient; roomUrl: string; token: string; dispose(): void }> {
  const discovery = opts.discovery ?? bonjourDiscovery();
  const { routingId, secret } = generateModeARoom();
  const relay = await startLanRelay({ routingId });
  const ad = discovery.advertise({ routingId, port: relay.port, name: deviceServiceName(opts.deviceName) });
  const roomUrl = `http://127.0.0.1:${relay.port}/r/${routingId}#${secret}`;
  const client = new UniclipClient({
    roomUrl, relayBase: `ws://127.0.0.1:${relay.port}`,
    iceServers: [], createConnection: weriftPeer,
    ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
  });
  return {
    client, roomUrl, token: formatLanToken({ routingId, secret }),
    dispose: () => { client.disconnect(); ad.stop(); relay.close(); },
  };
}

// Joiner: resolve the host on the LAN by routingId, then connect a UniclipClient.
export async function joinLan(
  token: string,
  opts: { deviceName?: string; discovery?: Discovery; timeoutMs?: number } = {},
): Promise<{ client: UniclipClient; roomUrl: string; dispose(): void }> {
  const parsed = parseLanToken(token);
  if (!parsed) throw new Error("invalid LAN token");
  const discovery = opts.discovery ?? bonjourDiscovery();
  const { host, port } = await discovery.discover(parsed.routingId, opts.timeoutMs ?? 5000);
  const roomUrl = `http://${host}:${port}/r/${parsed.routingId}#${parsed.secret}`;
  const client = new UniclipClient({
    roomUrl, relayBase: `ws://${host}:${port}`,
    iceServers: [], createConnection: weriftPeer,
    ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
  });
  // dispose only disconnects the client: bonjourDiscovery.discover() already
  // destroys its browse socket on resolve/timeout, so there is no mDNS handle
  // for the joiner to stop here (unlike the host's long-lived advertisement).
  return { client, roomUrl, dispose: () => client.disconnect() };
}
