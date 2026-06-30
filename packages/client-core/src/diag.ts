// Diagnostic events: metadata-only visibility into the transport state machine.
// Emitted (opt-in consumers) so real-hardware failures are attributable.
// NEVER carry secret / plaintext / ciphertext / key / full SDP — metadata only.
export type DiagPhase =
  | "ws"            // websocket connect / open / close
  | "signal"        // sdp/ice/rtc-hello sent or received (WS-only) — type + direction
  | "ice-candidate" // a gathered local ICE candidate: typ + protocol
  | "pc-state"      // RTCPeerConnection connectionState transition
  | "dc"            // datachannel open / close
  | "transport"     // p2p <-> relay switch
  | "decrypt-fail"; // receive-side decrypt failed (msgId only)

export interface DiagEvent {
  kind: "diag";
  phase: DiagPhase;
  level: "info" | "warn" | "error";
  detail: string; // one human-readable line (for logs/overlay display)
  data?: Record<string, string | number>; // structured fields consumers match on
}

// Extract `typ` (host|srflx|relay|prflx) and transport protocol from an ICE
// candidate SDP string. Field 2 (0-indexed) is the protocol; `typ <x>` names
// the type. Returns {} when the string isn't a recognizable candidate.
export function parseCandidate(sdp: string): { typ?: string; protocol?: string } {
  if (!sdp.startsWith("candidate:")) return {};
  const out: { typ?: string; protocol?: string } = {};
  const parts = sdp.split(/\s+/);
  if (parts[2]) out.protocol = parts[2].toLowerCase();
  const m = / typ (\w+)/.exec(sdp);
  if (m?.[1]) out.typ = m[1];
  return out;
}
