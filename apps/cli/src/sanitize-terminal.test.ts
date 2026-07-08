import { describe, expect, it } from "vitest";
import { stripTerminal } from "./sanitize-terminal";

describe("stripTerminal", () => {
  it("removes an OSC-52 clipboard-set sequence, preserving surrounding text", () => {
    const input = "before\x1b]52;c;aGVsbG8=\x07malicious";
    const out = stripTerminal(input);
    expect(out).not.toContain("\x1b]52");
    expect(out).not.toContain("\x07");
    expect(out).toContain("before");
    expect(out).toContain("malicious");
  });

  it("removes CSI sequences, preserving surrounding text", () => {
    expect(stripTerminal("\x1b[2J")).toBe("");
    expect(stripTerminal("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("removes a malformed/truncated OSC missing its terminator", () => {
    const out = stripTerminal("\x1b]52;c;abc");
    expect(out).not.toContain("\x1b");
    // The introducer is gone, so it can no longer start a real OSC sequence.
  });

  it("removes lone control chars", () => {
    expect(stripTerminal("\x07")).toBe("");
    expect(stripTerminal("\x00")).toBe("");
    expect(stripTerminal("\x1b")).toBe("");
    expect(stripTerminal("\x9b")).toBe(""); // C1 CSI introducer
  });

  it("preserves normal text exactly: ASCII, multibyte unicode, and the UI's ❯ arrow", () => {
    expect(stripTerminal("hello world")).toBe("hello world");
    expect(stripTerminal("こんにちは 世界 🎉")).toBe("こんにちは 世界 🎉");
    expect(stripTerminal("❯ selected")).toBe("❯ selected");
  });
});
