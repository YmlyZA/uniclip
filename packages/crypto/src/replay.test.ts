import { describe, expect, it } from "vitest";
import { ReplaySet } from "./replay";

describe("ReplaySet", () => {
  it("admits a new msgId", () => {
    const s = new ReplaySet(4);
    expect(s.admit("a")).toBe(true);
  });

  it("rejects a duplicate", () => {
    const s = new ReplaySet(4);
    s.admit("a");
    expect(s.admit("a")).toBe(false);
  });

  it("evicts oldest beyond capacity", () => {
    const s = new ReplaySet(3);
    s.admit("a");
    s.admit("b");
    s.admit("c");
    s.admit("d"); // evicts "a"
    expect(s.admit("a")).toBe(true); // accepted again because evicted
    expect(s.admit("d")).toBe(false); // still in set
  });

  it("defaults capacity to 256", () => {
    const s = new ReplaySet();
    expect(s.capacity).toBe(256);
  });
});
