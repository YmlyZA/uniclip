import { describe, it, expect } from "vitest";
import { tooLarge, readFileBytes, chunkCountOf, MAX_FILE_BYTES, MAX_FILE_MB } from "./file-send";
import { CHUNK_BYTES } from "@uniclip/protocol";

describe("file-send helpers", () => {
  it("tooLarge: false at the cap, true just over", () => {
    expect(tooLarge({ size: MAX_FILE_BYTES })).toBe(false);
    expect(tooLarge({ size: MAX_FILE_BYTES + 1 })).toBe(true);
  });
  it("MAX_FILE_MB is the cap in whole MB", () => {
    expect(MAX_FILE_MB).toBe(Math.round(MAX_FILE_BYTES / (1024 * 1024)));
  });
  it("readFileBytes round-trips a Blob's bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(await readFileBytes(new Blob([bytes]))).toEqual(bytes);
  });
  it("chunkCountOf splits by CHUNK_BYTES (min 1)", () => {
    expect(chunkCountOf(0)).toBe(1);
    expect(chunkCountOf(CHUNK_BYTES)).toBe(1);
    expect(chunkCountOf(CHUNK_BYTES + 1)).toBe(2);
  });
});
