import { describe, it, expect } from "vitest";
import { encryptBytes, decryptBytes, sha256Hex } from "./envelope";

const enc = new TextEncoder();
const RID = "qx7k2p";
const FID = "01HFILE0000000000000000000";

async function genKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function chunkAad(routingId: string, fileId: string, index: number, isFinal: boolean): string {
  return `${routingId}:${fileId}:${index}:${isFinal}`;
}

describe("bytes envelope", () => {
  it("round-trips arbitrary bytes", async () => {
    const key = await genKey();
    const data = crypto.getRandomValues(new Uint8Array(40));
    const env = await encryptBytes({ key, data, aad: "x" });
    const out = await decryptBytes({ key, iv: env.iv, ciphertext: env.ciphertext, aad: "x" });
    expect(out).toEqual(data);
  });

  it("fails when the AAD differs", async () => {
    const key = await genKey();
    const data = crypto.getRandomValues(new Uint8Array(8));
    const env = await encryptBytes({ key, data, aad: "a" });
    await expect(decryptBytes({ key, iv: env.iv, ciphertext: env.ciphertext, aad: "b" })).rejects.toThrow();
  });

  it("sha256Hex matches a known vector", async () => {
    // SHA-256("abc")
    expect(await sha256Hex(enc.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

// The Spike-A chunked-AEAD properties, now permanent. Each chunk is sealed with
// AAD routingId:fileId:index:isFinal; the RECEIVER authenticates each position
// against its OWN expected (index, isFinal), never the frame's claim.
describe("chunked-AEAD properties (over encryptBytes/decryptBytes)", () => {
  const CHUNK = 16;
  async function seal(key: CryptoKey, routingId: string, fileId: string, data: Uint8Array) {
    const chunkCount = Math.max(1, Math.ceil(data.length / CHUNK));
    const frames: { iv: ArrayBuffer; ct: ArrayBuffer }[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const isFinal = i === chunkCount - 1;
      const env = await encryptBytes({
        key, data: data.subarray(i * CHUNK, (i + 1) * CHUNK) as Uint8Array<ArrayBuffer>,
        aad: chunkAad(routingId, fileId, i, isFinal),
      });
      frames.push({ iv: env.iv, ct: env.ciphertext });
    }
    return { frames, chunkCount };
  }
  async function open(key: CryptoKey, routingId: string, fileId: string, chunkCount: number, frames: { iv: ArrayBuffer; ct: ArrayBuffer }[]) {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const f = frames[i]!;
      parts.push(await decryptBytes({
        key, iv: f.iv, ciphertext: f.ct,
        aad: chunkAad(routingId, fileId, i, i === chunkCount - 1),
      }));
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  it("round-trips multi- and single-chunk", async () => {
    const key = await genKey();
    const big = crypto.getRandomValues(new Uint8Array(50));
    const r1 = await seal(key, RID, FID, big);
    expect(r1.chunkCount).toBeGreaterThan(1);
    expect(await open(key, RID, FID, r1.chunkCount, r1.frames)).toEqual(big);
    const small = enc.encode("hi");
    const r2 = await seal(key, RID, FID, small);
    expect(await open(key, RID, FID, r2.chunkCount, r2.frames)).toEqual(small);
  });

  it("rejects reorder, truncation-by-count, cross-file splice, tamper, wrong room", async () => {
    const key = await genKey();
    const data = crypto.getRandomValues(new Uint8Array(50));

    const reordered = await seal(key, RID, FID, data);
    [reordered.frames[0], reordered.frames[1]] = [reordered.frames[1]!, reordered.frames[0]!];
    await expect(open(key, RID, FID, reordered.chunkCount, reordered.frames)).rejects.toThrow();

    const trunc = await seal(key, RID, FID, data);
    await expect(open(key, RID, FID, trunc.chunkCount - 1, trunc.frames.slice(0, trunc.chunkCount - 1))).rejects.toThrow();

    const a = await seal(key, RID, FID, data);
    const b = await seal(key, RID, "01HOTHER000000000000000000", crypto.getRandomValues(new Uint8Array(50)));
    a.frames[1] = b.frames[1]!;
    await expect(open(key, RID, FID, a.chunkCount, a.frames)).rejects.toThrow();

    const tam = await seal(key, RID, FID, data);
    const bytes = new Uint8Array(tam.frames[1]!.ct);
    bytes[0] = bytes[0]! ^ 0x01;
    tam.frames[1]!.ct = bytes.buffer;
    await expect(open(key, RID, FID, tam.chunkCount, tam.frames)).rejects.toThrow();

    const wr = await seal(key, RID, FID, data);
    await expect(open(key, "other-room", FID, wr.chunkCount, wr.frames)).rejects.toThrow();
  });
});
