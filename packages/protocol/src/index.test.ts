import { describe, expect, it } from "vitest";
import {
  ClipboardFrameSchema,
  ClientFrameSchema,
  DeleteFrameSchema,
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
        backfill: true,
      }),
    ).toBeDefined();
  });
  it("accepts hello with an ephemeral flag", () => {
    const f = ServerFrameSchema.parse({
      type: "hello",
      roomId: "qx7k2p",
      peerCount: 1,
      serverTime: 1717000000000,
      backfill: true,
      ephemeral: true,
    });
    expect(f).toMatchObject({ type: "hello", ephemeral: true });
  });
  it("defaults ephemeral to false when the field is absent (rolling-deploy compat)", () => {
    const f = ServerFrameSchema.parse({
      type: "hello",
      roomId: "qx7k2p",
      peerCount: 1,
      serverTime: 1717000000000,
      backfill: false,
    });
    expect(f).toMatchObject({ type: "hello", ephemeral: false });
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

describe("DeleteFrameSchema", () => {
  const valid = { type: "delete" as const, msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" };

  it("accepts a valid delete frame", () => {
    expect(DeleteFrameSchema.parse(valid)).toEqual(valid);
  });
  it("rejects extra fields", () => {
    expect(() => DeleteFrameSchema.parse({ ...valid, extra: 1 })).toThrow();
  });
  it("rejects a malformed msgId", () => {
    expect(() => DeleteFrameSchema.parse({ ...valid, msgId: "short" })).toThrow();
  });
});

describe("ClientFrameSchema", () => {
  it("accepts a clip frame", () => {
    expect(
      ClientFrameSchema.parse({
        type: "clip",
        msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        iv: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAA",
        ts: 1717000000000,
      }),
    ).toBeDefined();
  });
  it("accepts a delete frame", () => {
    expect(
      ClientFrameSchema.parse({ type: "delete", msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    ).toBeDefined();
  });
  it("rejects an unknown frame type", () => {
    expect(() => ClientFrameSchema.parse({ type: "nope", msgId: "x" })).toThrow();
  });
});
