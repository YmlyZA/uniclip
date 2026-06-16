import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { RoomDb } from "./room-db";

describe("RoomDb", () => {
  it("inserts and reads back a room record", () => {
    const d = new RoomDb(new Database(":memory:"));
    d.insert({ id: "qx7k2p", mode: "A", expiresAt: 100, backfillEnabled: true, createdAt: 0, ephemeral: false });
    expect(d.get("qx7k2p")).toEqual({
      id: "qx7k2p",
      mode: "A",
      expiresAt: 100,
      backfillEnabled: true,
      createdAt: 0,
      ephemeral: false,
    });
  });

  it("returns undefined for an unknown id", () => {
    const d = new RoomDb(new Database(":memory:"));
    expect(d.get("nope12")).toBeUndefined();
  });

  it("delete removes a record", () => {
    const d = new RoomDb(new Database(":memory:"));
    d.insert({ id: "a", mode: "B", expiresAt: 100, backfillEnabled: false, createdAt: 0, ephemeral: false });
    d.delete("a");
    expect(d.get("a")).toBeUndefined();
  });

  it("deleteExpired removes rows at or before the cutoff", () => {
    const d = new RoomDb(new Database(":memory:"));
    d.insert({ id: "old", mode: "A", expiresAt: 50, backfillEnabled: true, createdAt: 0, ephemeral: false });
    d.insert({ id: "new", mode: "A", expiresAt: 150, backfillEnabled: true, createdAt: 0, ephemeral: false });
    d.deleteExpired(100);
    expect(d.get("old")).toBeUndefined();
    expect(d.get("new")).toBeDefined();
  });

  it("accepts a string path (\":memory:\") and round-trips", () => {
    const d = new RoomDb(":memory:");
    d.insert({ id: "strpth", mode: "A", expiresAt: 100, backfillEnabled: true, createdAt: 1_000_000, ephemeral: false });
    expect(d.get("strpth")?.createdAt).toBe(1_000_000);
  });

  it("count() counts only unexpired rooms", () => {
    const d = new RoomDb(new Database(":memory:"));
    d.insert({ id: "live", mode: "A", expiresAt: 200, backfillEnabled: true, createdAt: 0, ephemeral: false });
    d.insert({ id: "dead", mode: "A", expiresAt: 50, backfillEnabled: true, createdAt: 0, ephemeral: false });
    expect(d.count(100)).toBe(1);
  });
});

describe("RoomDb ephemeral", () => {
  it("round-trips the ephemeral flag", () => {
    const db = new RoomDb(new Database(":memory:"));
    db.insert({ id: "qx7k2p", mode: "A", expiresAt: Date.now() + 1000, backfillEnabled: false, createdAt: Date.now(), ephemeral: true });
    expect(db.get("qx7k2p")?.ephemeral).toBe(true);
  });

  it("defaults ephemeral to false for rows created before the column existed", () => {
    const raw = new Database(":memory:");
    // Simulate a pre-ephemeral schema + row.
    raw.run(`CREATE TABLE rooms (id TEXT PRIMARY KEY, mode TEXT NOT NULL, expires_at INTEGER NOT NULL, backfill_enabled INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    raw.run(`INSERT INTO rooms VALUES ('old123', 'A', ${Date.now() + 1000}, 1, ${Date.now()})`);
    const db = new RoomDb(raw); // constructor must migrate the existing table
    expect(db.get("old123")?.ephemeral).toBe(false);
  });
});
