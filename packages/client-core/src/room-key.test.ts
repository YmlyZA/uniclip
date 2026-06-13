import { describe, expect, it } from "vitest";
import { encrypt, decrypt } from "@uniclip/crypto";
import { parseRoomUrl } from "@uniclip/room-code";
import { deriveRoomKey } from "./room-key";

describe("deriveRoomKey", () => {
  it("derives a usable key for a Mode A room", async () => {
    const room = parseRoomUrl("https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr")!;
    const key = await deriveRoomKey(room);
    const env = await encrypt({ key, plaintext: "hi", aad: "qx7k2p:1" });
    const back = await decrypt({ key, iv: env.iv, ciphertext: env.ciphertext, aad: "qx7k2p:1" });
    expect(back).toBe("hi");
  });

  it("derives a usable key for a Mode B room", async () => {
    const room = parseRoomUrl("https://uniclip.app/r/ABC234")!;
    const key = await deriveRoomKey(room);
    const env = await encrypt({ key, plaintext: "yo", aad: "ABC234:1" });
    const back = await decrypt({ key, iv: env.iv, ciphertext: env.ciphertext, aad: "ABC234:1" });
    expect(back).toBe("yo");
  });
});
