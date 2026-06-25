import { describe, expect, it } from "vitest";
import { pickAddress } from "./mdns";

describe("pickAddress", () => {
  it("prefers an IPv4 from addresses", () => {
    expect(pickAddress({ addresses: ["fe80::1", "192.168.1.5"], host: "host.local", referer: { address: "10.0.0.9" } } as any)).toBe("192.168.1.5");
  });
  it("falls back to referer.address, then host", () => {
    expect(pickAddress({ addresses: ["fe80::1"], host: "host.local", referer: { address: "10.0.0.9" } } as any)).toBe("10.0.0.9");
    expect(pickAddress({ addresses: [], host: "host.local" } as any)).toBe("host.local");
  });
});

// Real multicast advertise→discover. Skipped where the sandbox blocks mDNS
// (common in CI). Not a merge gate — see plan Global Constraints.
describe.skipIf(process.env.CI === "true")("bonjourDiscovery (real multicast)", () => {
  it("advertises a service and discovers it by routingId", async () => {
    const { bonjourDiscovery } = await import("./mdns");
    const d = bonjourDiscovery();
    const rid = "e2e" + Math.floor(performance.now()); // unique per run
    const ad = d.advertise({ routingId: rid, port: 51999, name: "uniclip-test" });
    try {
      const found = await d.discover(rid, 8000);
      expect(found.port).toBe(51999);
    } finally {
      ad.stop();
    }
  }, 12000);
});
