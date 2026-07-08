// The relay runs behind exactly one trusted proxy (Caddy), which appends the
// real client IP as the LAST X-Forwarded-For hop. The first hop is
// client-supplied and spoofable, so key rate limits on the last hop instead.
//
// If the relay is ever exposed directly (no proxy, no XFF header) this falls
// back to "unknown" — all such direct clients share one rate-limit bucket,
// same as today's behavior; that's only reachable if the relay is deployed
// without its intended proxy in front of it.
export function clientIp(xff: string | undefined): string {
  const hops = xff
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
  return hops.length ? hops[hops.length - 1]! : "unknown";
}
