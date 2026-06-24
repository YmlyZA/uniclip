import { describe, expect, it, vi } from "vitest";
import { relayBaseFromUrl, createRoom } from "./session";
import { disabledPeer } from "./disabled-peer";
import { MODE_A_SECRET_ALPHABET, MODE_A_SECRET_LEN } from "@uniclip/room-code";

// Build the regex character class from the real alphabet so the test stays
// correct even if the alphabet changes (e.g. it includes '-' and '_').
const escapedAlphabet = MODE_A_SECRET_ALPHABET.replace(/[-\\]]/g, "\\$&");
const secretPattern = new RegExp(
  `^http:\\/\\/localhost:3000\\/r\\/abc123#[${escapedAlphabet}]{${MODE_A_SECRET_LEN}}$`,
);

describe("relayBaseFromUrl", () => {
  it("maps https→wss and http→ws, preserving host/port", () => {
    expect(relayBaseFromUrl("https://uniclip.app/r/abc123#sekretsekretsekret")).toBe("wss://uniclip.app");
    expect(relayBaseFromUrl("http://localhost:3000/r/abc123#sekretsekretsekret")).toBe("ws://localhost:3000");
  });
});

describe("createRoom", () => {
  it("POSTs {mode:'A'} and forms /r/<roomId>#<secret>", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ roomId: "abc123" }) })) as unknown as typeof fetch;
    const { roomUrl } = await createRoom("http://localhost:3000", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/room",
      expect.objectContaining({ method: "POST" }),
    );
    expect(roomUrl).toMatch(secretPattern);
  });
  it("throws on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;
    await expect(createRoom("http://localhost:3000", fetchImpl)).rejects.toThrow(/429/);
  });
});

describe("disabledPeer", () => {
  it("returns a connection whose data channel never opens", () => {
    const pc = disabledPeer();
    const ch = pc.createDataChannel("uniclip");
    expect(ch.readyState).toBe("connecting"); // never 'open'
    expect(() => ch.send("x")).not.toThrow();
  });
});
