import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import type { RTCIceServer } from "../src/turn";

describe("GET /api/ice", () => {
  it("returns the default STUN when TURN is not configured", async () => {
    const app = buildApp({ roomCount: () => 0 });
    const res = await app.request("/api/ice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { iceServers: RTCIceServer[] };
    expect(body.iceServers.some((s) => String(s.urls).startsWith("stun:"))).toBe(true);
    expect(body.iceServers.every((s) => s.credential === undefined)).toBe(true);
  });

  it("returns self-hosted STUN+TURN with creds when configured", async () => {
    const app = buildApp({
      roomCount: () => 0,
      turn: { urls: ["stun:t.example:3478", "turn:t.example:3478"], secret: "k", ttlSeconds: 3600 },
    });
    const res = await app.request("/api/ice");
    const body = (await res.json()) as { iceServers: RTCIceServer[] };
    const turn = body.iceServers.find((s) => String(s.urls).startsWith("turn:"))!;
    expect(turn.credential).toBeDefined();
  });
});
