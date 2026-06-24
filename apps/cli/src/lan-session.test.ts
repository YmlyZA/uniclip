import { afterEach, describe, expect, it } from "vitest";
import { startLanHost, joinLan } from "./lan-session";
import type { Discovery } from "./mdns";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

// A fake Discovery that records the advertised service and serves it back to
// discover() — no multicast, fully deterministic.
function fakeDiscovery() {
  let ad: { routingId: string; port: number } | null = null;
  const d: Discovery = {
    advertise: (o) => { ad = { routingId: o.routingId, port: o.port }; return { stop: () => { ad = null; } }; },
    discover: async (rid) => {
      if (!ad || ad.routingId !== rid) throw new Error("not found");
      return { host: "127.0.0.1", port: ad.port };
    },
  };
  return d;
}

describe("lan-session", () => {
  it("host mints a Mode-A room, runs a relay, advertises it, and yields a matching token", async () => {
    const discovery = fakeDiscovery();
    const host = await startLanHost({ discovery });
    disposers.push(host.dispose);
    // token round-trips to the same room the host is serving
    expect(host.token.startsWith("uniclip+lan://")).toBe(true);
    expect(host.roomUrl).toContain("/r/");
    // a joiner using the same fake discovery resolves to the host's relay and builds a client
    const joiner = await joinLan(host.token, { discovery });
    disposers.push(joiner.dispose);
    expect(joiner.roomUrl).toContain("#"); // carries the secret
  });

  it("joinLan rejects when discovery finds nothing", async () => {
    const discovery = fakeDiscovery(); // nothing advertised
    await expect(joinLan("uniclip+lan://missing#sekretsekretsekret", { discovery, timeoutMs: 200 })).rejects.toThrow();
  });
});
