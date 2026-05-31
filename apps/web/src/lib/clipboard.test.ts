import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardWatcher, readClipboardText, writeClipboardText } from "./clipboard";

let readSpy: ReturnType<typeof vi.fn>;
let writeSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  readSpy = vi.fn().mockResolvedValue("hello");
  writeSpy = vi.fn().mockResolvedValue(undefined);
  // navigator is a read-only global in recent Node; use stubGlobal (defineProperty)
  // rather than Object.assign, which throws on the getter-only property.
  vi.stubGlobal("navigator", {
    clipboard: { readText: readSpy, writeText: writeSpy },
    permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
  });
  vi.stubGlobal("document", { visibilityState: "visible" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readClipboardText / writeClipboardText", () => {
  it("reads text via navigator.clipboard", async () => {
    expect(await readClipboardText()).toBe("hello");
  });

  it("writes text via navigator.clipboard", async () => {
    await writeClipboardText("yo");
    expect(writeSpy).toHaveBeenCalledWith("yo");
  });
});

describe("ClipboardWatcher", () => {
  it("emits 'change' when poll detects new text", async () => {
    readSpy.mockResolvedValueOnce("a").mockResolvedValueOnce("b").mockResolvedValueOnce("b");
    const changes: string[] = [];
    const w = new ClipboardWatcher({ intervalMs: 100 });
    w.on((text) => changes.push(text));
    await w.start();
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(150);
    expect(changes).toEqual(["a", "b"]);
    w.stop();
  });

  it("ignores duplicates", async () => {
    readSpy.mockResolvedValue("same");
    const changes: string[] = [];
    const w = new ClipboardWatcher({ intervalMs: 50 });
    w.on((t) => changes.push(t));
    await w.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(changes).toEqual(["same"]);
    w.stop();
  });
});
