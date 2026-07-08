import { beforeEach, describe, expect, it } from "vitest";
import { deriveKey } from "@uniclip/crypto";
import { PersistedItems, evictOldestUnpinned } from "./persist";

const store: Record<string, string> = {};
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    },
  });
});

describe("PersistedItems", () => {
  it("round-trips encrypted items", async () => {
    const key = await deriveKey({ secret: "abcdefghijklmnopqr", salt: "qx7k2p" });
    const p = new PersistedItems({ roomId: "qx7k2p", key, cap: 50 });
    await p.add({ id: "1", text: "hello", ts: 1 });
    await p.add({ id: "2", text: "world", ts: 2 });
    const loaded = await p.load();
    expect(loaded.map((i) => i.text)).toEqual(["hello", "world"]);
  });

  it("respects cap (drops oldest)", async () => {
    const key = await deriveKey({ secret: "abcdefghijklmnopqr", salt: "qx7k2p" });
    const p = new PersistedItems({ roomId: "qx7k2p", key, cap: 3 });
    for (let i = 0; i < 5; i++) {
      await p.add({ id: String(i), text: `t${i}`, ts: i });
    }
    const loaded = await p.load();
    expect(loaded.map((i) => i.text)).toEqual(["t2", "t3", "t4"]);
  });

  it("clear() removes the key", async () => {
    const key = await deriveKey({ secret: "abcdefghijklmnopqr", salt: "qx7k2p" });
    const p = new PersistedItems({ roomId: "qx7k2p", key, cap: 3 });
    await p.add({ id: "1", text: "x", ts: 1 });
    p.clear();
    expect(await p.load()).toEqual([]);
  });

  it("dedups by id (duplicate frame is a no-op)", async () => {
    const key = await deriveKey({ secret: "abcdefghijklmnopqr", salt: "qx7k2p" });
    const p = new PersistedItems({ roomId: "qx7k2p", key, cap: 50 });
    await p.add({ id: "m1", text: "hello", ts: 1 });
    await p.add({ id: "m1", text: "hello", ts: 1 }); // replayed on reconnect
    const loaded = await p.load();
    expect(loaded).toHaveLength(1);
  });

  it("EphemeralStore never touches localStorage", async () => {
    const { EphemeralStore } = await import("./persist");
    let writes = 0;
    const real = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = (...a: [string, string]) => { writes++; return real(...a); };
    const s = new EphemeralStore();
    await s.add({ id: "1", text: "secret", ts: 1 });
    await s.remove("1");
    s.clear();
    expect(await s.load()).toEqual([]);
    expect(writes).toBe(0);
  });
});

describe("pin", () => {
  it("protects a pinned item from cap eviction (oldest unpinned drops first)", async () => {
    const key = await deriveKey({ secret: "pin-secret-pin-secret", salt: "room1" });
    const store = new PersistedItems({ roomId: "room1", key, cap: 2 });
    await store.add({ id: "a", text: "a", ts: 1 });
    await store.add({ id: "b", text: "b", ts: 2 });
    await store.setPinned("a", true);          // pin the oldest
    await store.add({ id: "c", text: "c", ts: 3 }); // over cap → evict oldest UNPINNED (b)
    const ids = (await store.load()).map((i) => i.id);
    expect(ids).toContain("a"); // pinned survived
    expect(ids).toContain("c");
    expect(ids).not.toContain("b");
  });
  it("setPinned persists and is idempotent", async () => {
    const key = await deriveKey({ secret: "pin-secret-pin-secret", salt: "room1" });
    const store = new PersistedItems({ roomId: "room2", key, cap: 50 });
    await store.add({ id: "x", text: "x", ts: 1 });
    await store.setPinned("x", true);
    expect((await store.load()).find((i) => i.id === "x")?.pinned).toBe(true);
    await store.setPinned("x", true); // no-op, no throw
    expect((await store.load()).find((i) => i.id === "x")?.pinned).toBe(true);
  });
});

describe("evictOldestUnpinned", () => {
  it("keeps a pinned item near the front and drops the oldest unpinned once over cap", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, pinned: i === 2 }));
    const withNew = [...items, { id: "new", pinned: false }]; // 51 items, one pinned near the front
    const result = evictOldestUnpinned(withNew, 50);
    expect(result).toHaveLength(50);
    expect(result.find((i) => i.id === "i2")).toBeTruthy(); // pinned item survived
    expect(result.find((i) => i.id === "i0")).toBeFalsy(); // oldest UNPINNED was dropped
    expect(result.find((i) => i.id === "new")).toBeTruthy(); // newest survived
  });

  it("keeps everything when every item is pinned, even over cap", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, pinned: true }));
    const result = evictOldestUnpinned(items, 3);
    expect(result).toHaveLength(5);
  });

  it("is a no-op under cap", () => {
    const items = [{ id: "a", pinned: false }];
    expect(evictOldestUnpinned(items, 50)).toEqual(items);
  });
});
