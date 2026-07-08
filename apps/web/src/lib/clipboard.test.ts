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
    // First value is consumed by start()'s permission probe; ticks see the rest.
    readSpy
      .mockResolvedValueOnce("probe")
      .mockResolvedValueOnce("a")
      .mockResolvedValueOnce("b")
      .mockResolvedValueOnce("b");
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

  it("start() probes clipboard readability and rejects on permission denial", async () => {
    readSpy.mockRejectedValueOnce(new Error("NotAllowedError"));
    const w = new ClipboardWatcher({ intervalMs: 100 });
    await expect(w.start()).rejects.toThrow();
  });

  it("start() resolves and arms the timer when the probe succeeds", async () => {
    readSpy.mockResolvedValueOnce("probe").mockResolvedValueOnce("x");
    const changes: string[] = [];
    const w = new ClipboardWatcher({ intervalMs: 100 });
    w.on((t) => changes.push(t));
    await expect(w.start()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(150);
    expect(changes).toEqual(["x"]);
    w.stop();
  });

  it("closes the double-start race: two concurrent start() calls before the probe resolves arm only one interval", async () => {
    // Both start() calls race the SAME pending probe promise (worst case: the
    // permission prompt resolves once and unblocks both awaiters together).
    let resolveProbe!: (v: string) => void;
    const probePromise = new Promise<string>((resolve) => {
      resolveProbe = resolve;
    });
    readSpy.mockImplementationOnce(() => probePromise);
    readSpy.mockImplementationOnce(() => probePromise);
    const w = new ClipboardWatcher({ intervalMs: 100 });
    const p1 = w.start();
    const p2 = w.start(); // second start() passes the `if (this.timer) return` guard too
    resolveProbe("probe");
    await p1;
    await p2;

    readSpy.mockResolvedValue("x"); // subsequent ticks
    await vi.advanceTimersByTimeAsync(100);
    // 2 probe calls + exactly 1 tick call if only one interval is armed.
    // A leaked second interval would double this to 2 tick calls (4 total).
    expect(readSpy.mock.calls.length).toBe(3);

    w.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(readSpy.mock.calls.length).toBe(3); // fully halted — no leaked interval survives stop()
  });

  it("stop() during a pending probe leaves no interval armed once the probe resolves", async () => {
    let resolveProbe!: (v: string) => void;
    const probePromise = new Promise<string>((resolve) => {
      resolveProbe = resolve;
    });
    readSpy.mockImplementationOnce(() => probePromise);
    const w = new ClipboardWatcher({ intervalMs: 100 });
    const changes: string[] = [];
    w.on((t) => changes.push(t));
    const started = w.start();
    w.stop(); // stop()/onDestroy races ahead of the pending start()
    resolveProbe("probe");
    await started;

    readSpy.mockResolvedValue("z");
    await vi.advanceTimersByTimeAsync(500);
    expect(changes).toEqual([]); // no interval was armed after the superseded start()
  });
});
