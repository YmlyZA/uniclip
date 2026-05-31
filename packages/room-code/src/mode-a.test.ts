import { describe, expect, it } from "vitest";
import {
  generateModeARoom,
  parseRoomUrl,
  MODE_A_ROUTING_ID_LEN,
  MODE_A_SECRET_LEN,
  MODE_A_ROUTING_ALPHABET,
  MODE_A_SECRET_ALPHABET,
} from "./mode-a";

describe("Mode A — generate", () => {
  it("routingId is the documented length and alphabet", () => {
    expect(MODE_A_ROUTING_ID_LEN).toBe(6);
    const { routingId } = generateModeARoom();
    expect(routingId).toHaveLength(6);
    for (const c of routingId) {
      expect(MODE_A_ROUTING_ALPHABET).toContain(c);
    }
  });

  it("secret is the documented length and alphabet", () => {
    expect(MODE_A_SECRET_LEN).toBe(18);
    const { secret } = generateModeARoom();
    expect(secret).toHaveLength(18);
    for (const c of secret) {
      expect(MODE_A_SECRET_ALPHABET).toContain(c);
    }
  });

  it("two consecutive generations differ", () => {
    const a = generateModeARoom();
    const b = generateModeARoom();
    expect(a.routingId).not.toBe(b.routingId);
    expect(a.secret).not.toBe(b.secret);
  });
});

describe("Mode A — parseRoomUrl", () => {
  it("extracts routingId + secret from full URL", () => {
    const r = parseRoomUrl("https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr");
    expect(r).toEqual({
      mode: "A",
      routingId: "qx7k2p",
      secret: "abcdefghijklmnopqr",
    });
  });

  it("treats path-only URL as Mode B", () => {
    const r = parseRoomUrl("https://uniclip.app/r/QX7K2P");
    expect(r).toEqual({ mode: "B", routingId: "QX7K2P" });
  });

  it("rejects URLs without /r/", () => {
    expect(parseRoomUrl("https://uniclip.app/")).toBeNull();
  });

  it("rejects empty routing id", () => {
    expect(parseRoomUrl("https://uniclip.app/r/")).toBeNull();
  });
});
