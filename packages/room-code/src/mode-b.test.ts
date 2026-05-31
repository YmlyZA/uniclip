import { describe, expect, it } from "vitest";
import {
  generateModeBCode,
  isValidModeBCode,
  MODE_B_CODE_LEN,
  MODE_B_ALPHABET,
  MODE_B_SALT,
} from "./mode-b";

describe("Mode B", () => {
  it("alphabet excludes look-alikes O and I", () => {
    expect(MODE_B_ALPHABET).not.toMatch(/[OI01]/);
  });

  it("alphabet is exactly 32 chars (A-Z minus O/I plus 2-9)", () => {
    expect(MODE_B_ALPHABET.length).toBe(32);
  });

  it("generates 6-char codes drawn from the alphabet", () => {
    expect(MODE_B_CODE_LEN).toBe(6);
    for (let i = 0; i < 50; i++) {
      const c = generateModeBCode();
      expect(c).toHaveLength(6);
      for (const ch of c) expect(MODE_B_ALPHABET).toContain(ch);
    }
  });

  it("validates correct codes", () => {
    const c = generateModeBCode();
    expect(isValidModeBCode(c)).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(isValidModeBCode("ABCDE")).toBe(false);
    expect(isValidModeBCode("ABCDEFG")).toBe(false);
  });

  it("rejects forbidden chars", () => {
    expect(isValidModeBCode("ABCDEO")).toBe(false);
    expect(isValidModeBCode("ABCDE0")).toBe(false);
    expect(isValidModeBCode("abcdef")).toBe(false);
  });

  it("salt is the documented constant", () => {
    expect(MODE_B_SALT).toBe("uniclip-v1");
  });
});
