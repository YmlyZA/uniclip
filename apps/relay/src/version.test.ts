import { describe, expect, it } from "vitest";
import { parseSemver, isNewer } from "./version";

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
});
