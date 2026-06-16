import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";

describe("POST /api/room", () => {
  it("creates a Mode A room", async () => {
    const store = new RoomStore();
    const app = buildApp({ roomCount: () => store.count, store });
    const res = await app.request("/api/room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "A" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roomId: string; expiresAt: string };
    expect(body.roomId).toHaveLength(6);
    expect(typeof body.expiresAt).toBe("string");
    expect(store.count).toBe(1);
  });

  it("creates a Mode B room (uppercase)", async () => {
    const store = new RoomStore();
    const app = buildApp({ roomCount: () => store.count, store });
    const res = await app.request("/api/room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "B" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roomId: string };
    expect(/^[A-Z2-9]{6}$/.test(body.roomId)).toBe(true);
  });

  it("rejects unknown mode", async () => {
    const store = new RoomStore();
    const app = buildApp({ roomCount: () => store.count, store });
    const res = await app.request("/api/room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "Z" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/room with ephemeral:true creates an ephemeral room", async () => {
    const store = new RoomStore();
    const app = buildApp({ roomCount: () => store.count, store });
    const res = await app.request("/api/room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "A", ephemeral: true }),
    });
    const body = (await res.json()) as { roomId: string };
    expect(store.get(body.roomId)?.ephemeral).toBe(true);
    expect(store.get(body.roomId)?.backfillEnabled).toBe(false);
  });
});
