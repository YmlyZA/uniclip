import { afterEach, describe, expect, it, vi } from "vitest";
import { readClipboardImage, filenameForImageType } from "./clipboard";

function fakeItem(types: string[], blobs: Record<string, Blob>) {
  return {
    types,
    getType: vi.fn(async (t: string) => {
      const b = blobs[t];
      if (!b) throw new Error("no such type");
      return b;
    }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("readClipboardImage", () => {
  it("returns a File when the clipboard holds an image", async () => {
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    vi.stubGlobal("navigator", {
      clipboard: { read: vi.fn().mockResolvedValue([fakeItem(["image/png"], { "image/png": png })]) },
    });
    const f = await readClipboardImage();
    expect(f).toBeInstanceOf(File);
    expect(f?.type).toBe("image/png");
    expect(f?.name).toBe("clipboard-image.png");
    expect(f?.size).toBe(3);
  });

  it("returns null when the clipboard holds only text", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { read: vi.fn().mockResolvedValue([fakeItem(["text/plain"], {})]) },
    });
    expect(await readClipboardImage()).toBeNull();
  });

  it("returns null when read() rejects (permission denied / unsupported)", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { read: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    expect(await readClipboardImage()).toBeNull();
  });

  it("returns null when the async Clipboard read API is unavailable", async () => {
    vi.stubGlobal("navigator", { clipboard: {} });
    expect(await readClipboardImage()).toBeNull();
  });

  it("skips an image item whose getType is refused and uses a usable sibling", async () => {
    const png = new Blob([new Uint8Array([7, 7])], { type: "image/png" });
    const refusing = {
      types: ["image/svg+xml"],
      getType: vi.fn().mockRejectedValue(new Error("refused")),
    };
    vi.stubGlobal("navigator", {
      clipboard: {
        read: vi.fn().mockResolvedValue([refusing, fakeItem(["image/png"], { "image/png": png })]),
      },
    });
    const f = await readClipboardImage();
    expect(f?.type).toBe("image/png");
    expect(f?.name).toBe("clipboard-image.png");
  });

  it("prefers an image item over a sibling text item", async () => {
    const jpg = new Blob([new Uint8Array([9])], { type: "image/jpeg" });
    vi.stubGlobal("navigator", {
      clipboard: {
        read: vi.fn().mockResolvedValue([
          fakeItem(["text/plain"], {}),
          fakeItem(["image/jpeg"], { "image/jpeg": jpg }),
        ]),
      },
    });
    const f = await readClipboardImage();
    expect(f?.type).toBe("image/jpeg");
    expect(f?.name).toBe("clipboard-image.jpeg");
  });
});

describe("filenameForImageType", () => {
  it("derives an extension from the mime subtype", () => {
    expect(filenameForImageType("image/png")).toBe("clipboard-image.png");
    expect(filenameForImageType("image/jpeg")).toBe("clipboard-image.jpeg");
  });
  it("strips a structured suffix (svg+xml → svg) and falls back to png", () => {
    expect(filenameForImageType("image/svg+xml")).toBe("clipboard-image.svg");
    expect(filenameForImageType("nonsense")).toBe("clipboard-image.png");
  });
});
