import { describe, expect, it } from "vitest";
import {
  ClipboardFrameSchema,
  ServerFrameSchema,
  ULID_REGEX,
  MAX_FRAME_BYTES,
} from "./index";

describe("ULID_REGEX", () => {
  it("accepts a valid ULID", () => {
    expect(ULID_REGEX.test("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });
  it("rejects wrong length", () => {
    expect(ULID_REGEX.test("01ARZ3NDEKTSV4RRFFQ69G5")).toBe(false);
  });
  it("rejects forbidden Crockford letters", () => {
    expect(ULID_REGEX.test("01ARZ3NDEKTSV4RRFFQ69G5FAU")).toBe(false); // U not allowed
  });
});

describe("ClipboardFrameSchema", () => {
  const valid = {
    type: "clip" as const,
    msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAA",
    ts: 1717000000000,
  };

  it("accepts a valid frame", () => {
    expect(ClipboardFrameSchema.parse(valid)).toEqual(valid);
  });
  it("rejects extra fields", () => {
    expect(() => ClipboardFrameSchema.parse({ ...valid, extra: 1 })).toThrow();
  });
  it("rejects wrong type tag", () => {
    expect(() => ClipboardFrameSchema.parse({ ...valid, type: "nope" })).toThrow();
  });
  it("rejects malformed msgId", () => {
    expect(() => ClipboardFrameSchema.parse({ ...valid, msgId: "short" })).toThrow();
  });
});

describe("ServerFrameSchema", () => {
  it("accepts hello", () => {
    expect(
      ServerFrameSchema.parse({
        type: "hello",
        roomId: "qx7k2p",
        peerCount: 1,
        serverTime: 1717000000000,
      }),
    ).toBeDefined();
  });
  it("accepts error", () => {
    expect(
      ServerFrameSchema.parse({
        type: "error",
        code: "ROOM_EXPIRED",
        message: "gone",
      }),
    ).toBeDefined();
  });
  it("rejects unknown error code", () => {
    expect(() =>
      ServerFrameSchema.parse({
        type: "error",
        code: "WAT",
        message: "x",
      }),
    ).toThrow();
  });
});

describe("MAX_FRAME_BYTES", () => {
  it("is 64 KiB", () => {
    expect(MAX_FRAME_BYTES).toBe(64 * 1024);
  });
});
