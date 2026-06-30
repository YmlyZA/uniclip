import { expect, it } from "vitest";
import { parseCandidate } from "./diag";

it("parses typ and protocol from a host candidate string", () => {
  const sdp = "candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host";
  expect(parseCandidate(sdp)).toEqual({ typ: "host", protocol: "udp" });
});

it("parses a srflx (STUN) candidate", () => {
  const sdp = "candidate:2 1 udp 1686052607 203.0.113.5 9 typ srflx raddr 0.0.0.0 rport 0";
  expect(parseCandidate(sdp)).toEqual({ typ: "srflx", protocol: "udp" });
});

it("parses a relay (TURN) tcp candidate", () => {
  const sdp = "candidate:3 1 tcp 1518280447 198.51.100.2 443 typ relay";
  expect(parseCandidate(sdp)).toEqual({ typ: "relay", protocol: "tcp" });
});

it("returns empty object for an unparseable string", () => {
  expect(parseCandidate("garbage")).toEqual({});
});
