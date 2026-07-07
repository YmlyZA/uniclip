import { describe, expect, it } from "vitest";
import { parseSemver, isNewer, UpdateChecker } from "./version";

describe("parseSemver", () => {
  it("parses x.y.z with optional leading v and trailing metadata", () => {
    expect(parseSemver("v0.1.0")).toEqual([0, 1, 0]);
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("v0.2.0-rc.1")).toEqual([0, 2, 0]);
    expect(parseSemver("nope")).toBeNull();
  });
});

describe("isNewer", () => {
  it("is true only when latest > current", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("v0.1.1", "0.1.0")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
  });
  it("returns false (never throws) on unparseable input", () => {
    expect(isNewer("garbage", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "")).toBe(false);
  });
  it("compares two-digit components numerically, not lexically", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  });
});

describe("UpdateChecker", () => {
  it("reports an available update after a refresh finds a newer tag", async () => {
    const c = new UpdateChecker({
      current: "0.1.0", enabled: true, ttlMs: 1000,
      fetchLatest: async () => "v0.2.0", now: () => 1000,
    });
    await c.refresh();
    expect(c.snapshot()).toEqual({ latest: "v0.2.0", updateAvailable: true, checkedAt: 1000 });
  });
  it("reports no update when latest equals current", async () => {
    const c = new UpdateChecker({ current: "0.1.0", enabled: true, ttlMs: 1000, fetchLatest: async () => "v0.1.0", now: () => 1 });
    await c.refresh();
    expect(c.snapshot().updateAvailable).toBe(false);
  });
  it("never fetches when disabled", async () => {
    let called = 0;
    const c = new UpdateChecker({ current: "0.1.0", enabled: false, ttlMs: 1000, fetchLatest: async () => { called++; return "v9.9.9"; } });
    c.snapshot(); await c.refresh();
    expect(called).toBe(0);
    expect(c.snapshot()).toEqual({ latest: null, updateAvailable: false, checkedAt: null });
  });
  it("stays graceful when the fetch throws (no crash, no update)", async () => {
    const c = new UpdateChecker({ current: "0.1.0", enabled: true, ttlMs: 1000, fetchLatest: async () => { throw new Error("offline"); }, now: () => 5 });
    await c.refresh();
    expect(c.snapshot()).toEqual({ latest: null, updateAvailable: false, checkedAt: 5 });
  });
});
