import { describe, expect, it } from "vitest";
import { deriveKey } from "./key";
import { encrypt, decrypt, IV_BYTES } from "./envelope";

const key = await deriveKey({ secret: "abc123abc123abc123", salt: "qx7k2p" });

describe("envelope", () => {
  it("IV is 12 bytes", () => {
    expect(IV_BYTES).toBe(12);
  });

  it("round-trips plaintext", async () => {
    const aad = "qx7k2p:01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const env = await encrypt({ key, plaintext: "hello world", aad });
    expect(env.iv.byteLength).toBe(IV_BYTES);
    expect(env.ciphertext.byteLength).toBeGreaterThan(0);

    const back = await decrypt({ key, iv: env.iv, ciphertext: env.ciphertext, aad });
    expect(back).toBe("hello world");
  });

  it("fuzz: 100 random plaintexts round-trip", async () => {
    for (let i = 0; i < 100; i++) {
      const len = 1 + Math.floor(Math.random() * 2000);
      const text = Array.from({ length: len }, () =>
        String.fromCharCode(32 + Math.floor(Math.random() * 90)),
      ).join("");
      const aad = `r:m${i}`;
      const env = await encrypt({ key, plaintext: text, aad });
      const back = await decrypt({ key, iv: env.iv, ciphertext: env.ciphertext, aad });
      expect(back).toBe(text);
    }
  });

  it("uses a fresh random IV every call", async () => {
    const a = await encrypt({ key, plaintext: "same", aad: "r:m1" });
    const b = await encrypt({ key, plaintext: "same", aad: "r:m1" });
    expect(new Uint8Array(a.iv)).not.toEqual(new Uint8Array(b.iv));
  });

  it("rejects tampered ciphertext", async () => {
    const env = await encrypt({ key, plaintext: "secret", aad: "r:m1" });
    const tampered = new Uint8Array(env.ciphertext);
    tampered[0]! ^= 0x01;
    await expect(
      decrypt({ key, iv: env.iv, ciphertext: tampered.buffer, aad: "r:m1" }),
    ).rejects.toThrow();
  });

  it("rejects mismatched AAD", async () => {
    const env = await encrypt({ key, plaintext: "secret", aad: "roomA:m1" });
    await expect(
      decrypt({ key, iv: env.iv, ciphertext: env.ciphertext, aad: "roomB:m1" }),
    ).rejects.toThrow();
  });

  it("rejects with wrong key", async () => {
    const other = await deriveKey({ secret: "different456different", salt: "qx7k2p" });
    const env = await encrypt({ key, plaintext: "secret", aad: "r:m1" });
    await expect(
      decrypt({ key: other, iv: env.iv, ciphertext: env.ciphertext, aad: "r:m1" }),
    ).rejects.toThrow();
  });
});
