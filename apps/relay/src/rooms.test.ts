import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomStore, RECENT_CAP, TOMBSTONE_CAP } from "./rooms";
import { ulid } from "ulid";
import { Database } from "bun:sqlite";
import { CLOSE_CODES } from "@uniclip/protocol";

const frame = () => ({
  type: "clip" as const,
  msgId: ulid(),
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "QUFBQQ==",
  ts: 0,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("RoomStore", () => {
  it("creates a Mode A room", () => {
    const s = new RoomStore();
    const r = s.create("A");
    expect(r.mode).toBe("A");
    expect(r.id).toHaveLength(6);
    expect(s.get(r.id)).toBeDefined();
  });

  it("creates a Mode B room", () => {
    const s = new RoomStore();
    const r = s.create("B");
    expect(r.mode).toBe("B");
    expect(/^[A-Z2-9]{6}$/.test(r.id)).toBe(true);
  });

  it("count reflects size", () => {
    const s = new RoomStore();
    s.create("A");
    s.create("B");
    expect(s.count).toBe(2);
  });

  it("touch() updates lastActivityAt", () => {
    const s = new RoomStore();
    const r = s.create("A");
    const before = s.get(r.id)!.lastActivityAt;
    vi.advanceTimersByTime(5_000);
    s.touch(r.id);
    expect(s.get(r.id)!.lastActivityAt).toBeGreaterThan(before);
  });

  it("idle GC evicts from memory but the room rehydrates from the DB (survives to max-age)", () => {
    const s = new RoomStore({ idleTimeoutMs: 5 * 60_000, maxAgeMs: 24 * 3600_000 });
    const r = s.create("A");
    expect(s.count).toBe(1);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    const { aged, idle } = s.gc();
    expect(aged).toBe(0);
    expect(idle).toBe(1);
    expect(s.count).toBe(0); // evicted from the live Map
    const got = s.get(r.id);
    expect(got).toBeDefined(); // still reachable: rehydrated from the DB row
    expect(got!.sockets.size).toBe(0);
  });

  it("GC keeps rooms with at least one socket regardless of idle time", () => {
    const s = new RoomStore({ idleTimeoutMs: 5 * 60_000, maxAgeMs: 24 * 3600_000 });
    const r = s.create("A");
    s.get(r.id)!.sockets.add({} as never);
    vi.advanceTimersByTime(10 * 60_000);
    s.gc();
    expect(s.get(r.id)).toBeDefined();
  });

  it("max-age GC drops the room from both memory and the DB", () => {
    const db = new Database(":memory:");
    const s = new RoomStore({ db, idleTimeoutMs: 5 * 60_000, maxAgeMs: 1_000 });
    const r = s.create("A");
    s.get(r.id)!.sockets.add({} as never);
    vi.advanceTimersByTime(2_000);
    const { aged, idle } = s.gc();
    expect(aged).toBe(1);
    expect(idle).toBe(0);
    expect(s.get(r.id)).toBeUndefined(); // gone from Map AND DB (no rehydrate)
  });

  it("max-age GC closes still-open sockets with ROOM_EXPIRED (no in-band error frame) before deleting the room", () => {
    const db = new Database(":memory:");
    const s = new RoomStore({ db, idleTimeoutMs: 5 * 60_000, maxAgeMs: 1_000 });
    const r = s.create("A");
    const sock = { send: vi.fn(), close: vi.fn() };
    s.get(r.id)!.sockets.add(sock);
    vi.advanceTimersByTime(2_000);
    s.gc();

    // The close code is the authoritative signal — the client no longer needs
    // (and shouldn't get) a redundant in-band error frame.
    expect(sock.send).not.toHaveBeenCalled();
    expect(sock.close).toHaveBeenCalledWith(CLOSE_CODES.ROOM_EXPIRED, "ROOM_EXPIRED");

    expect(s.get(r.id)).toBeUndefined();
  });

  it("Mode A defaults to backfill enabled; explicit false disables it", () => {
    const s = new RoomStore();
    expect(s.create("A").backfillEnabled).toBe(true);
    expect(s.create("A", false).backfillEnabled).toBe(false);
  });

  it("Mode B never buffers even if backfill is requested", () => {
    const s = new RoomStore();
    const r = s.create("B", true);
    expect(r.backfillEnabled).toBe(false);
    s.pushRecent(r.id, frame());
    expect(s.get(r.id)!.recent).toHaveLength(0);
  });

  it("pushRecent buffers in order and caps at RECENT_CAP (oldest evicted)", () => {
    const s = new RoomStore();
    const r = s.create("A");
    for (let i = 0; i < RECENT_CAP + 5; i++) s.pushRecent(r.id, frame());
    const buf = s.get(r.id)!.recent;
    expect(buf).toHaveLength(RECENT_CAP);
  });

  it("get() rehydrates a room from the DB after the in-memory Map is gone (restart)", () => {
    const db = new Database(":memory:");
    const s1 = new RoomStore({ db });
    const r = s1.create("A");
    const s2 = new RoomStore({ db }); // fresh process over the same DB
    const got = s2.get(r.id);
    expect(got).toBeDefined();
    expect(got!.mode).toBe("A");
    expect(got!.sockets.size).toBe(0);
    expect(got!.recent).toHaveLength(0);
    expect(got!.backfillEnabled).toBe(true);
  });

  it("get() does not rehydrate an expired DB row and removes it", () => {
    const db = new Database(":memory:");
    const s1 = new RoomStore({ db, maxAgeMs: 1_000 });
    const r = s1.create("A");
    vi.advanceTimersByTime(2_000);
    const s2 = new RoomStore({ db, maxAgeMs: 1_000 });
    expect(s2.get(r.id)).toBeUndefined();
  });

  it("defaults to an isolated in-memory DB (no persistence across instances)", () => {
    const a = new RoomStore();
    const r = a.create("A");
    const b = new RoomStore();
    expect(b.get(r.id)).toBeUndefined();
  });

  it("removeRecent drops a clip from the backfill ring by msgId", () => {
    const s = new RoomStore();
    const r = s.create("A");
    const f1 = frame();
    const f2 = frame();
    s.pushRecent(r.id, f1);
    s.pushRecent(r.id, f2);
    s.removeRecent(r.id, f1.msgId);
    const buf = s.get(r.id)!.recent;
    expect(buf.map((f) => f.msgId)).toEqual([f2.msgId]);
  });

  it("addTombstone records deleted msgIds (deduped)", () => {
    const s = new RoomStore();
    const r = s.create("A");
    s.addTombstone(r.id, "m1");
    s.addTombstone(r.id, "m1"); // dedup
    s.addTombstone(r.id, "m2");
    expect(s.get(r.id)!.tombstones).toEqual(["m1", "m2"]);
  });

  it("tombstones are bounded to TOMBSTONE_CAP (oldest evicted)", () => {
    const s = new RoomStore();
    const r = s.create("A");
    for (let i = 0; i < TOMBSTONE_CAP + 5; i++) s.addTombstone(r.id, `m${i}`);
    expect(s.get(r.id)!.tombstones).toHaveLength(TOMBSTONE_CAP);
  });

  it("create with ephemeral stores it and forces backfill off", () => {
    const s = new RoomStore();
    const r = s.create("A", true, true); // backfill requested true, but ephemeral
    expect(r.ephemeral).toBe(true);
    expect(r.backfillEnabled).toBe(false);
  });

  it("non-ephemeral Mode-A room keeps backfill (regression)", () => {
    const s = new RoomStore();
    const r = s.create("A", true, false);
    expect(r.ephemeral).toBe(false);
    expect(r.backfillEnabled).toBe(true);
  });

  it("rehydrates ephemeral from the DB on a Map miss", () => {
    const db = new Database(":memory:");
    const s1 = new RoomStore({ db });
    const r = s1.create("A", false, true);
    const s2 = new RoomStore({ db }); // fresh cache, same DB → forces a rehydrate
    const got = s2.get(r.id);
    expect(got?.ephemeral).toBe(true);
  });

  it("gc() sweeps an expired DB row that was evicted from the Map while idle", () => {
    const db = new Database(":memory:");
    const s = new RoomStore({ db, idleTimeoutMs: 5 * 60_000, maxAgeMs: 10 * 60_000 });
    const r = s.create("A");
    vi.advanceTimersByTime(5 * 60_000 + 1); // idle but not aged
    s.gc();
    expect(s.count).toBe(0); // evicted from Map; DB row still present
    vi.advanceTimersByTime(10 * 60_000); // now past max-age, while evicted
    s.gc(); // deleteExpired sweep should remove the orphaned DB row
    expect(s.get(r.id)).toBeUndefined();
  });
});
