import { describe, expect, it } from "vitest";
import { Backoff } from "./backoff";

describe("Backoff", () => {
  it("starts at base, doubles, caps at max", () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 30_000, jitter: 0 });
    expect(b.next()).toBe(1000);
    expect(b.next()).toBe(2000);
    expect(b.next()).toBe(4000);
    expect(b.next()).toBe(8000);
    expect(b.next()).toBe(16000);
    expect(b.next()).toBe(30000);
    expect(b.next()).toBe(30000);
  });

  it("reset() returns to base", () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 30_000, jitter: 0 });
    b.next();
    b.next();
    b.reset();
    expect(b.next()).toBe(1000);
  });

  it("applies jitter within bounds", () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 30_000, jitter: 0.2 });
    for (let i = 0; i < 20; i++) {
      const v = b.next();
      // base 1000 with 20% jitter → between 800 and 1200 on first call
      if (i === 0) {
        expect(v).toBeGreaterThanOrEqual(800);
        expect(v).toBeLessThanOrEqual(1200);
      }
      b.reset();
    }
  });
});
