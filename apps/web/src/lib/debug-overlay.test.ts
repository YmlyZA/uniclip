import { describe, expect, it } from "vitest";
import { pushDiag, diagToText, candidateCounts, debugEnabled, type DiagRow } from "./debug-overlay";

const row = (p: Partial<DiagRow>): DiagRow => ({ phase: "ws", level: "info", detail: "x", t: 0, ...p });

describe("pushDiag", () => {
  it("appends and caps the ring, dropping oldest", () => {
    let buf: DiagRow[] = [];
    for (let i = 0; i < 205; i++) buf = pushDiag(buf, row({ detail: String(i) }), 200);
    expect(buf.length).toBe(200);
    expect(buf[0]!.detail).toBe("5"); // 0..4 dropped
    expect(buf[199]!.detail).toBe("204");
  });
});

describe("diagToText", () => {
  it("serializes rows to one line each with relative seconds", () => {
    const txt = diagToText([row({ t: 1500, phase: "dc", detail: "open" })]);
    expect(txt).toContain("1.50s");
    expect(txt).toContain("dc");
    expect(txt).toContain("open");
  });
});

describe("candidateCounts", () => {
  it("counts host/srflx/relay from ice-candidate detail", () => {
    const rows = [
      row({ phase: "ice-candidate", detail: "host udp" }),
      row({ phase: "ice-candidate", detail: "srflx udp" }),
      row({ phase: "ice-candidate", detail: "host tcp" }),
    ];
    expect(candidateCounts(rows)).toEqual({ host: 2, srflx: 1, relay: 0 });
  });
});

describe("debugEnabled", () => {
  it("is true when ?debug is present", () => {
    expect(debugEnabled("?debug")).toBe(true);
    expect(debugEnabled("?foo=1&debug")).toBe(true);
    expect(debugEnabled("?foo=1")).toBe(false);
    expect(debugEnabled("")).toBe(false);
  });
});
