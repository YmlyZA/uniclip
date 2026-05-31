import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlidingWindowLimiter } from "./rate-limit";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SlidingWindowLimiter", () => {
  it("allows up to N actions in window", () => {
    const lim = new SlidingWindowLimiter(3, 10_000);
    expect(lim.allow("k")).toBe(true);
    expect(lim.allow("k")).toBe(true);
    expect(lim.allow("k")).toBe(true);
    expect(lim.allow("k")).toBe(false);
  });

  it("releases oldest action as window slides", () => {
    const lim = new SlidingWindowLimiter(2, 1_000);
    expect(lim.allow("k")).toBe(true);
    expect(lim.allow("k")).toBe(true);
    expect(lim.allow("k")).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(lim.allow("k")).toBe(true);
  });

  it("tracks keys independently", () => {
    const lim = new SlidingWindowLimiter(1, 10_000);
    expect(lim.allow("a")).toBe(true);
    expect(lim.allow("b")).toBe(true);
    expect(lim.allow("a")).toBe(false);
  });
});
