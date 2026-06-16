import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EPHEMERAL_TTL_MS, ExpiryScheduler } from "./ephemeral";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ExpiryScheduler", () => {
  it("fires onExpire after EPHEMERAL_TTL_MS", () => {
    const expired: string[] = [];
    const s = new ExpiryScheduler(EPHEMERAL_TTL_MS, (id) => expired.push(id));
    s.schedule("a");
    vi.advanceTimersByTime(EPHEMERAL_TTL_MS - 1);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual(["a"]);
  });

  it("is idempotent per msgId (one timer per id)", () => {
    const expired: string[] = [];
    const s = new ExpiryScheduler(1000, (id) => expired.push(id));
    s.schedule("a");
    s.schedule("a");
    vi.advanceTimersByTime(1000);
    expect(expired).toEqual(["a"]);
  });

  it("cancel() and clear() stop pending timers", () => {
    const expired: string[] = [];
    const s = new ExpiryScheduler(1000, (id) => expired.push(id));
    s.schedule("a");
    s.schedule("b");
    s.cancel("a");
    s.clear();
    vi.advanceTimersByTime(2000);
    expect(expired).toEqual([]);
  });
});
