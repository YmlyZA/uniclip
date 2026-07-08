import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";
import { RoomStore } from "./rooms";
import { attachWebSocket } from "./ws-handlers";
import { SlidingWindowLimiter } from "./rate-limit";

// Regression for the relay's `signalLimiter` being created and returned by
// `attachWebSocket` but never swept by server.ts's periodic sweep interval:
// entries are keyed by a per-socket crypto.randomUUID() that's never reused,
// so a never-swept limiter grows without bound on a long-running relay. The
// sweep wiring itself lives in server.ts, which boots a real Bun.serve on
// import and isn't reachable at this unit level — this test locks the
// invariant one layer down: attachWebSocket must keep exposing a real,
// sweepable signalLimiter for server.ts to wire up.
describe("attachWebSocket signalLimiter sweep wiring", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns a signalLimiter that is a real, sweepable SlidingWindowLimiter", () => {
    const store = new RoomStore();
    const app = buildApp({ roomCount: () => store.count, store });
    const { signalLimiter } = attachWebSocket(app, store);

    expect(signalLimiter).toBeInstanceOf(SlidingWindowLimiter);
    expect(typeof signalLimiter.sweep).toBe("function");
  });

  it("reclaims a signalLimiter entry's Map slot once its window has fully elapsed", () => {
    const store = new RoomStore();
    const app = buildApp({ roomCount: () => store.count, store });
    const { signalLimiter } = attachWebSocket(app, store);
    // A never-reused per-socket key (crypto.randomUUID() in ws-handlers.ts):
    // once its socket closes, nothing ever calls allow() for it again, so
    // only sweep() — not allow()'s own inline pruning — can reclaim it.
    const hits = (signalLimiter as unknown as { hits: Map<string, number[]> }).hits;

    signalLimiter.allow("dead-socket-key");
    expect(hits.has("dead-socket-key")).toBe(true);

    vi.advanceTimersByTime(10_001); // past signalLimiter's 10s window
    signalLimiter.sweep();

    expect(hits.has("dead-socket-key")).toBe(false);
  });
});
