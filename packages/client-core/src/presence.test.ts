import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { deriveKey } from "@uniclip/crypto";
import { PresenceManager, type Device, type PresenceManagerOptions } from "./presence";

// client-core tests run in Node; ensure WebCrypto is present.
if (!globalThis.crypto) vi.stubGlobal("crypto", webcrypto);

async function key() {
  return deriveKey({ secret: "presence-test-secret", salt: "salt", extractable: false });
}

function mk(over: Partial<PresenceManagerOptions> = {}) {
  const sent: { iv: string; ciphertext: string }[] = [];
  const rosters: Device[][] = [];
  let cryptoKey: CryptoKey | null = null;
  let name = "Laptop";
  let t = 1_000;
  const mgr = new PresenceManager({
    routingId: "room1",
    selfId: "SELF",
    getKey: () => cryptoKey,
    getName: () => name,
    send: (f) => sent.push({ iv: f.iv, ciphertext: f.ciphertext }),
    emit: (r) => rosters.push(r),
    now: () => t,
    ttlMs: 20_000,
    heartbeatMs: 8_000,
    pruneDelayMs: 2_000,
    ...over,
  });
  return {
    mgr, sent, rosters,
    setKey: (k: CryptoKey | null) => (cryptoKey = k),
    setName: (n: string) => (name = n),
    setNow: (n: number) => (t = n),
  };
}

afterEach(() => vi.useRealTimers());

it("announce encrypts {id,name} and sends a presence frame", async () => {
  const h = mk();
  h.setKey(await key());
  await h.mgr.announce();
  expect(h.sent).toHaveLength(1);
  expect(typeof h.sent[0]!.iv).toBe("string");
  expect(typeof h.sent[0]!.ciphertext).toBe("string");
});

it("announce is a no-op with no key", async () => {
  const h = mk();
  await h.mgr.announce();
  expect(h.sent).toHaveLength(0);
});

it("handlePresence upserts a peer (decrypted) and emits; ignores own id and bad blobs", async () => {
  const k = await key();
  // Build a real peer frame by using a second manager with a different self id.
  const peer = mk({ selfId: "PEER" });
  peer.setKey(k);
  peer.setName("Phone");
  await peer.mgr.announce();
  const frame = { type: "presence" as const, ...peer.sent[0]! };

  const me = mk({ selfId: "SELF" });
  me.setKey(k);
  await me.mgr.handlePresence(frame);
  const roster = me.rosters.at(-1)!;
  expect(roster.some((d) => d.id === "PEER" && d.name === "Phone" && !d.self)).toBe(true);

  // Own id ignored
  const mine = mk({ selfId: "PEER" }); // same id as the frame's author
  mine.setKey(k);
  await mine.mgr.handlePresence(frame);
  expect(mine.rosters).toHaveLength(0);

  // Undecryptable blob dropped
  const other = mk({ selfId: "SELF" });
  other.setKey(await deriveKey({ secret: "different", salt: "salt", extractable: false }));
  await other.mgr.handlePresence(frame);
  expect(other.rosters).toHaveLength(0);
});

it("TTL eviction removes a stale peer on tick()", async () => {
  const k = await key();
  const peer = mk({ selfId: "PEER" }); peer.setKey(k); peer.setName("Phone");
  await peer.mgr.announce();
  const frame = { type: "presence" as const, ...peer.sent[0]! };

  const me = mk(); me.setKey(k); me.setNow(1_000);
  await me.mgr.handlePresence(frame);              // lastSeen = 1_000
  expect(me.mgr.roster().some((d) => d.id === "PEER")).toBe(true);
  me.setNow(1_000 + 20_001);                       // past ttl
  me.mgr.tick();
  expect(me.mgr.roster().some((d) => d.id === "PEER")).toBe(false);
});

it("fast prune on peer-left drops a non-refreshed peer within pruneDelayMs", async () => {
  vi.useFakeTimers();
  const k = await key();
  const peer = mk({ selfId: "GONE" }); peer.setKey(k); peer.setName("Old");
  await peer.mgr.announce();
  const frame = { type: "presence" as const, ...peer.sent[0]! };

  const me = mk(); me.setKey(k); me.setNow(1_000);
  await me.mgr.handlePresence(frame);              // GONE lastSeen = 1_000
  me.setNow(5_000);
  me.mgr.onPeerChange(true);                       // peer-left at now=5_000; schedules prune
  await vi.advanceTimersByTimeAsync(2_000);
  expect(me.mgr.roster().some((d) => d.id === "GONE")).toBe(false);
});

it("roster() lists self first", () => {
  const h = mk();
  const r = h.mgr.roster();
  expect(r[0]).toEqual({ id: "SELF", name: "Laptop", self: true });
});
