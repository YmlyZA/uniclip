import { describe, expect, it } from "vitest";
import {
  ClipboardFrameSchema,
  ClientFrameSchema,
  DeleteFrameSchema,
  ServerFrameSchema,
  ULID_REGEX,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  CHUNK_BYTES,
  MAX_FILE_BYTES,
  SdpFrameSchema,
  IceFrameSchema,
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
  it("defaults protocolVersion to 1 when absent", () => {
    const f = ServerFrameSchema.parse({
      type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false,
    });
    expect((f as { protocolVersion: number }).protocolVersion).toBe(1);
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

describe("file-transfer frames", () => {
  const fileId = "01HF000000000000000000000A"; // 26-char valid ULID shape

  it("accepts a file-offer", () => {
    expect(
      ClientFrameSchema.parse({
        type: "file-offer", fileId, name: "a.png", mime: "image/png",
        size: 1234, chunkCount: 1, hash: "a".repeat(64), inline: true,
      }),
    ).toBeDefined();
  });

  it("rejects a file-offer with a bad hash", () => {
    expect(() =>
      ClientFrameSchema.parse({
        type: "file-offer", fileId, name: "a.png", mime: "image/png",
        size: 1, chunkCount: 1, hash: "xyz", inline: false,
      }),
    ).toThrow();
  });

  it("accepts file-accept / file-chunk / file-ack / file-complete / file-cancel", () => {
    expect(ClientFrameSchema.parse({ type: "file-accept", fileId })).toBeDefined();
    expect(ClientFrameSchema.parse({ type: "file-chunk", fileId, index: 0, isFinal: true, iv: "AAAA", ciphertext: "QUFB" })).toBeDefined();
    expect(ClientFrameSchema.parse({ type: "file-ack", fileId, upTo: 0 })).toBeDefined();
    expect(ClientFrameSchema.parse({ type: "file-complete", fileId })).toBeDefined();
    expect(ClientFrameSchema.parse({ type: "file-cancel", fileId, reason: "user" })).toBeDefined();
  });

  it("exposes transfer constants", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(CHUNK_BYTES).toBe(32 * 1024);
    expect(MAX_FILE_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe("signaling frames", () => {
  const from = "01HF000000000000000000000A";
  it("accepts a valid sdp offer", () => {
    expect(
      ClientFrameSchema.parse({
        type: "sdp", from,
        description: { type: "offer", sdp: "v=0\r\n..." },
      }),
    ).toBeDefined();
  });
  it("accepts an ice candidate and an end-of-candidates marker", () => {
    expect(ClientFrameSchema.parse({ type: "ice", from, candidate: '{"candidate":"x"}' })).toBeDefined();
    expect(ClientFrameSchema.parse({ type: "ice", from, candidate: "" })).toBeDefined();
  });
  it("rejects a bad sdp description type", () => {
    expect(() =>
      ClientFrameSchema.parse({ type: "sdp", from, description: { type: "nope", sdp: "x" } }),
    ).toThrow();
  });
  it("rejects an oversized sdp", () => {
    expect(() =>
      ClientFrameSchema.parse({ type: "sdp", from, description: { type: "offer", sdp: "x".repeat(16385) } }),
    ).toThrow();
  });
  it("forwards both shapes as server frames too", () => {
    expect(ServerFrameSchema.parse({ type: "ice", from, candidate: "" })).toBeDefined();
  });
});
