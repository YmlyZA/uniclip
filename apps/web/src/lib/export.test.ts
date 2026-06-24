import { afterEach, describe, expect, it, vi } from "vitest";
import { historyText, downloadTextFile } from "./export";

afterEach(() => vi.unstubAllGlobals());

describe("historyText", () => {
  it("joins item texts with a blank line", () => {
    expect(historyText([{ text: "a" }, { text: "b" }])).toBe("a\n\nb");
    expect(historyText([])).toBe("");
  });
});

describe("downloadTextFile", () => {
  it("is a no-op when document is undefined", () => {
    vi.stubGlobal("document", undefined);
    expect(() => downloadTextFile("x.txt", "hi")).not.toThrow();
  });
  it("creates an anchor with the download name and revokes the object URL", () => {
    const anchor: any = { click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    });
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: revoke });
    downloadTextFile("uniclip-history.txt", "hello");
    expect(anchor.download).toBe("uniclip-history.txt");
    expect(anchor.href).toBe("blob:x");
    expect(anchor.click).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });
});
