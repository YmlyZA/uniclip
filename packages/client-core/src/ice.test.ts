import { describe, expect, it } from "vitest";
import { fetchIceServers } from "./ice";
import { ICE_SERVERS } from "@uniclip/protocol";

const ok = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("fetchIceServers", () => {
  it("returns the server's iceServers on success", async () => {
    const servers = [{ urls: "turn:x:3478", username: "1", credential: "c" }];
    const out = await fetchIceServers("https://relay.test", ok({ iceServers: servers }));
    expect(out).toEqual(servers);
  });

  it("falls back to the default on network error", async () => {
    const boom = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await fetchIceServers("https://relay.test", boom)).toEqual(ICE_SERVERS);
  });

  it("falls back to the default on non-200 or malformed body", async () => {
    const bad = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchIceServers("https://relay.test", bad)).toEqual(ICE_SERVERS);
    const malformed = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchIceServers("https://relay.test", malformed)).toEqual(ICE_SERVERS);
  });
});
