import { beforeEach, describe, expect, it } from "vitest";
import { deriveKey } from "@uniclip/crypto";
import { PersistedItems } from "./persist";

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
