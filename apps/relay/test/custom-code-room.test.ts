import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";

function app() {
  const store = new RoomStore();
  return buildApp({ roomCount: () => store.count, store });
}
const post = (a: ReturnType<typeof app>, body: unknown) =>
  a.request("/api/room", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/room customCode", () => {
  it("creates a Mode-B room at the canonical custom code", async () => {
    const res = await post(app(), { mode: "B", customCode: " pizza-42 " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roomId: string };
    expect(body.roomId).toBe("PIZZA-42");
  });

  it("rejects an invalid custom code with 400", async () => {
    const res = await post(app(), { mode: "B", customCode: "ab" });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the code is already taken", async () => {
    const a = app();
    expect((await post(a, { mode: "B", customCode: "TWINS-9" })).status).toBe(200);
    const dup = await post(a, { mode: "B", customCode: "twins-9" });
    expect(dup.status).toBe(409);
    expect((await dup.json()) as { error: string }).toEqual({ error: "code_taken" });
  });

  it("ignores customCode for Mode A", async () => {
    const res = await post(app(), { mode: "A", customCode: "SHOULD-IGNORE" });
    const body = (await res.json()) as { roomId: string };
    expect(body.roomId).not.toBe("SHOULD-IGNORE");
  });
});
