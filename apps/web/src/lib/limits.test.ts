import { describe, expect, it } from "vitest";
import { MAX_TEXT_BYTES, textByteLength, withinLimit } from "./limits";

describe("text size limits", () => {
  it("MAX_TEXT_BYTES is 32 KiB", () => {
    expect(MAX_TEXT_BYTES).toBe(32 * 1024);
  });
  it("textByteLength counts UTF-8 bytes, not chars", () => {
    expect(textByteLength("abc")).toBe(3);
    expect(textByteLength("é")).toBe(2);
    expect(textByteLength("😀")).toBe(4);
  });
  it("withinLimit is true at the cap, false over it", () => {
    expect(withinLimit("x".repeat(MAX_TEXT_BYTES))).toBe(true);
    expect(withinLimit("x".repeat(MAX_TEXT_BYTES + 1))).toBe(false);
  });
});
