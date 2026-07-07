import { describe, expect, it } from "vitest";
import {
  canonicalizeCode, isValidCustomCode, estimateCodeBits, strengthBand,
} from "./custom-code";

describe("canonicalizeCode", () => {
  it("trims and uppercases; is idempotent", () => {
    expect(canonicalizeCode("  tiger ")).toBe("TIGER");
    expect(canonicalizeCode("PIZZA-42")).toBe("PIZZA-42");
    const once = canonicalizeCode(" Cobalt-7 ");
    expect(canonicalizeCode(once)).toBe(once);
  });
});

describe("isValidCustomCode", () => {
  it("enforces charset and 4–64 length", () => {
    expect(isValidCustomCode("abc")).toBe(false);      // too short (3)
    expect(isValidCustomCode("abcd")).toBe(true);       // 4, canonicalized
    expect(isValidCustomCode("PIZZA-42")).toBe(true);
    expect(isValidCustomCode("A".repeat(64))).toBe(true);
    expect(isValidCustomCode("A".repeat(65))).toBe(false);
    expect(isValidCustomCode("----")).toBe(false);      // solely hyphens
    expect(isValidCustomCode("bad code")).toBe(false);  // space
    expect(isValidCustomCode("café")).toBe(false);      // non-charset
  });
});

describe("estimateCodeBits + strengthBand", () => {
  it("rates a short code very weak and a long mixed code ok", () => {
    expect(strengthBand(estimateCodeBits(canonicalizeCode("ab12")))).toBe("very-weak");
    expect(strengthBand(estimateCodeBits(canonicalizeCode("k7pm2qx9rtab")))).toBe("ok");
  });
  it("penalizes low variety", () => {
    expect(estimateCodeBits("AAAA")).toBeLessThan(estimateCodeBits("AB12"));
  });
});
