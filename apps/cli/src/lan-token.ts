// Pairing token for an offline LAN room: uniclip+lan://<routingId>#<secret>.
// routingId identifies the room (also advertised in mDNS TXT); the secret is
// the Mode-A key material and rides ONLY here (in the fragment) — never on the
// wire, never in mDNS. Mirrors the /r/<id>#<secret> URL contract.
const SCHEME = "uniclip+lan://";

export function formatLanToken(room: { routingId: string; secret: string }): string {
  return `${SCHEME}${room.routingId}#${room.secret}`;
}

export function parseLanToken(s: string): { routingId: string; secret: string } | null {
  if (!s.startsWith(SCHEME)) return null;
  const rest = s.slice(SCHEME.length);
  const hash = rest.indexOf("#");
  if (hash < 0) return null;
  const routingId = rest.slice(0, hash);
  const secret = rest.slice(hash + 1);
  if (!routingId || !secret) return null;
  return { routingId, secret };
}
