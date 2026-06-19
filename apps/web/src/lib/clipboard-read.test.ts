import { afterEach, describe, expect, it, vi } from "vitest";
import { readClipboard } from "./clipboard";

function imgItem(type: string, blob: Blob) {
  return { types: [type], getType: vi.fn(async () => blob) };
}
function textItem(text: string) {
  return { types: ["text/plain"], getType: vi.fn(async () => new Blob([text], { type: "text/plain" })) };
}

afterEach(() => vi.unstubAllGlobals());

describe("readClipboard (single read() handles image + text)", () => {
  it("returns the image when the clipboard holds one", async () => {
    const png = new Blob([new Uint8Array([1, 2])], { type: "image/png" });
    vi.stubGlobal("navigator", {
      clipboard: { read: vi.fn().mockResolvedValue([imgItem("image/png", png)]) },
    });
    const r = await readClipboard();
    expect(r.image).toBeInstanceOf(File);
    expect(r.image?.type).toBe("image/png");
    expect(r.text).toBe("");
    expect(r.denied).toBe(false);
  });

  it("returns text from the same read when there is no image (no second clipboard call)", async () => {
    const readSpy = vi.fn().mockResolvedValue([textItem("hello world")]);
    const readTextSpy = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { read: readSpy, readText: readTextSpy } });
    const r = await readClipboard();
    expect(r.image).toBeNull();
    expect(r.text).toBe("hello world");
    expect(r.denied).toBe(false);
    expect(readTextSpy).not.toHaveBeenCalled(); // single round-trip, Safari-friendly
  });

  it("reports denied=false for an empty-but-accessible clipboard", async () => {
    vi.stubGlobal("navigator", { clipboard: { read: vi.fn().mockResolvedValue([]) } });
    const r = await readClipboard();
    expect(r).toEqual({ image: null, text: "", denied: false });
  });

  it("falls back to readText() when read() is unavailable", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: vi.fn().mockResolvedValue("fallback") } });
    const r = await readClipboard();
    expect(r.image).toBeNull();
    expect(r.text).toBe("fallback");
    expect(r.denied).toBe(false);
  });

  it("returns empty (no throw) when every clipboard access fails", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        read: vi.fn().mockRejectedValue(new Error("denied")),
        readText: vi.fn().mockRejectedValue(new Error("denied")),
      },
    });
    const r = await readClipboard();
    expect(r).toEqual({ image: null, text: "", denied: true });
  });
});
