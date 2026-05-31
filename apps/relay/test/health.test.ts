import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

describe("GET /api/health", () => {
  it("returns ok with counts", async () => {
    const app = buildApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      rooms: number;
      uptime: number;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.rooms).toBe("number");
    expect(typeof body.uptime).toBe("number");
  });
});
