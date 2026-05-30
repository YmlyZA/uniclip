import { describe, expect, it } from "vitest";
import { deriveKey, KDF_ITERATIONS } from "./key";

describe("deriveKey (PBKDF2)", () => {
  it("uses 200 000 iterations", () => {
    expect(KDF_ITERATIONS).toBe(200_000);
  });

  it("derives a 256-bit AES-GCM key for Mode A", async () => {
    const key = await deriveKey({
      secret: "abc123abc123abc123",
      salt: "qx7k2p",
    });
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key.usages).toEqual(expect.arrayContaining(["encrypt", "decrypt"]));
  });

  it("is deterministic for the same input", async () => {
    const k1 = await deriveKey({ secret: "abc123abc123abc123", salt: "qx7k2p" });
    const k2 = await deriveKey({ secret: "abc123abc123abc123", salt: "qx7k2p" });
    // Same input → same raw bytes
    const raw1 = await crypto.subtle.exportKey("raw", k1);
    const raw2 = await crypto.subtle.exportKey("raw", k2);
    expect(new Uint8Array(raw1)).toEqual(new Uint8Array(raw2));
  });

  it("differs for different secret", async () => {
    const k1 = await deriveKey({ secret: "abc123abc123abc123", salt: "qx7k2p" });
    const k2 = await deriveKey({ secret: "xyz456xyz456xyz456", salt: "qx7k2p" });
    const r1 = new Uint8Array(await crypto.subtle.exportKey("raw", k1));
    const r2 = new Uint8Array(await crypto.subtle.exportKey("raw", k2));
    expect(r1).not.toEqual(r2);
  });

  it("differs for different salt", async () => {
    const k1 = await deriveKey({ secret: "abc123abc123abc123", salt: "qx7k2p" });
    const k2 = await deriveKey({ secret: "abc123abc123abc123", salt: "ab9d3z" });
    const r1 = new Uint8Array(await crypto.subtle.exportKey("raw", k1));
    const r2 = new Uint8Array(await crypto.subtle.exportKey("raw", k2));
    expect(r1).not.toEqual(r2);
  });
});
