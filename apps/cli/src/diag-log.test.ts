import { describe, expect, it } from "vitest";
import { formatDiagLine, attachDiagLog } from "./diag-log";
import type { DiagEvent } from "@uniclip/client-core";

const ev = (e: Partial<DiagEvent>): DiagEvent => ({ kind: "diag", phase: "ws", level: "info", detail: "x", ...e } as DiagEvent);

describe("formatDiagLine", () => {
  it("prefixes a relative timestamp, phase, and detail", () => {
    const line = formatDiagLine(12483, ev({ phase: "pc-state", detail: "connecting -> connected" }));
    expect(line).toContain("12.48s");
    expect(line).toContain("pc-state");
    expect(line).toContain("connecting -> connected");
  });
  it("marks warn and error levels", () => {
    expect(formatDiagLine(0, ev({ level: "warn", detail: "w" }))).toMatch(/!/);
    expect(formatDiagLine(0, ev({ level: "error", detail: "e" }))).toMatch(/✗|x/i);
  });
});

describe("attachDiagLog", () => {
  function fakeClient() {
    let cb: ((e: DiagEvent) => void) | undefined;
    return { on: (_k: string, f: (e: DiagEvent) => void) => (cb = f), emit: (e: DiagEvent) => cb?.(e) };
  }
  it("writes each diag event as a line to the writer", () => {
    const c = fakeClient();
    const out: string[] = [];
    attachDiagLog(c as any, { now: () => 1000, write: (s) => out.push(s) });
    c.emit(ev({ phase: "dc", detail: "open" }));
    expect(out.join("")).toContain("dc");
    expect(out.join("")).toContain("open");
  });
  it("warns when the relay never opens within the timeout", () => {
    const c = fakeClient();
    const out: string[] = [];
    const timers: Array<() => void> = [];
    attachDiagLog(c as any, { now: () => 0, write: (s) => out.push(s), setTimer: (fn) => { timers.push(fn); return 0; }, clearTimer: () => {} });
    c.emit(ev({ phase: "ws", detail: "connecting", data: { event: "connecting" } }));
    timers.forEach((fn) => fn()); // fire the 3s timer without an intervening "open"
    expect(out.join("")).toMatch(/relay unreachable/i);
  });
  it("does NOT warn relay-unreachable when open arrives first", () => {
    const c = fakeClient();
    const out: string[] = [];
    let cleared = false;
    attachDiagLog(c as any, { now: () => 0, write: (s) => out.push(s), setTimer: () => 1, clearTimer: () => { cleared = true; } });
    c.emit(ev({ phase: "ws", detail: "connecting", data: { event: "connecting" } }));
    c.emit(ev({ phase: "ws", detail: "open", data: { event: "open" } }));
    expect(cleared).toBe(true);
  });
});
