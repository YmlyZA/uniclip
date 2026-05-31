import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomStore } from "./rooms";

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

  it("GC drops rooms with 0 sockets idle > 5 min", () => {
    const s = new RoomStore({ idleTimeoutMs: 5 * 60_000, maxAgeMs: 24 * 3600_000 });
    const r = s.create("A");
    expect(s.get(r.id)).toBeDefined();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    s.gc();
    expect(s.get(r.id)).toBeUndefined();
  });

  it("GC keeps rooms with at least one socket regardless of idle time", () => {
    const s = new RoomStore({ idleTimeoutMs: 5 * 60_000, maxAgeMs: 24 * 3600_000 });
    const r = s.create("A");
    s.get(r.id)!.sockets.add({} as never);
    vi.advanceTimersByTime(10 * 60_000);
    s.gc();
    expect(s.get(r.id)).toBeDefined();
  });

  it("GC drops rooms older than maxAge regardless of activity", () => {
    const s = new RoomStore({ idleTimeoutMs: 5 * 60_000, maxAgeMs: 1_000 });
    const r = s.create("A");
    s.get(r.id)!.sockets.add({} as never);
    vi.advanceTimersByTime(2_000);
    s.gc();
    expect(s.get(r.id)).toBeUndefined();
  });
});
