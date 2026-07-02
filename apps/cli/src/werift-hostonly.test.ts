import { describe, expect, it } from "vitest";
import { weriftPeer } from "./werift-peer";

// Regression lock for the werift patch (patches/werift@0.23.0.patch).
//
// Stock werift 0.23 falls back to a hardcoded public STUN (stun.l.google.com)
// whenever no STUN server is configured, so `iceServers: []` would gather a
// server-reflexive (srflx) candidate — phoning home and breaking `--lan`'s
// zero-internet guarantee. The patch makes "no STUN configured" mean host
// candidates only. This test drives a REAL werift connection through the
// production adapter and asserts host-only gathering:
//   - unpatched + online  → an srflx candidate appears        → fails
//   - unpatched + offline → ~5s STUN timeout stall exceeds the → fails
//                           3s bound (no end-of-candidates)
// so the invariant is guarded in both network states.
describe("werift host-only ICE (--lan zero-internet)", () => {
  it("gathers host candidates only (no srflx) when iceServers is empty", async () => {
    const pc = weriftPeer({ iceServers: [] }) as unknown as {
      onicecandidate: ((ev: { candidate: { toJSON(): { candidate?: string } } | null }) => void) | null;
      createDataChannel(label: string, opts?: { ordered?: boolean }): unknown;
      createOffer(): Promise<{ type: string; sdp: string }>;
      setLocalDescription(d: { type: "offer" | "answer"; sdp: string }): Promise<unknown>;
      close(): void;
    };
    const types = new Set<string>();
    const done = new Promise<void>((resolve) => {
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) { resolve(); return; } // end-of-candidates
        const sdp = ev.candidate.toJSON().candidate ?? "";
        const m = / typ (\w+)/.exec(sdp);
        if (m?.[1]) types.add(m[1]);
      };
    });
    pc.createDataChannel("probe", { ordered: true });
    await pc.setLocalDescription((await pc.createOffer()) as { type: "offer"; sdp: string });
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
    pc.close();

    expect(types.has("srflx")).toBe(false); // no phone-home to a public STUN
    expect(types.has("host")).toBe(true); // but real host candidates gathered
  });
});
