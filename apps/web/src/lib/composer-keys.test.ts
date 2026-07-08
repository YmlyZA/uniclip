import { describe, expect, it } from "vitest";
import { isSendKey } from "./composer-keys";

describe("isSendKey", () => {
  it("is true for plain Enter", () => {
    expect(isSendKey({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
  });

  it("is false while an IME composition is in progress (CJK Enter-to-commit)", () => {
    expect(isSendKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });

  it("is false for Shift+Enter (newline)", () => {
    expect(isSendKey({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
  });

  it("is false for non-Enter keys", () => {
    expect(isSendKey({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
  });
});
