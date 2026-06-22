import { describe, expect, it, vi } from "vitest";
import { PeerLink, type PeerSignal } from "./peer-link";

class FakeChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = "closed"; this.onclose?.(); }
  open() { this.readyState = "open"; this.onopen?.(); }
  deliver(d: string) { this.onmessage?.({ data: d }); }
}
class FakePC {
  static last: FakePC;
  signalingState = "stable";
  connectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  onicecandidate: ((ev: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  ondatachannel: ((ev: { channel: FakeChannel }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  channels: FakeChannel[] = [];
  added: unknown[] = [];
  constructor() { FakePC.last = this; }
  createDataChannel() { const c = new FakeChannel(); this.channels.push(c); return c; }
  async createOffer() { return { type: "offer", sdp: "OFFER" }; }
  async createAnswer() { return { type: "answer", sdp: "ANSWER" }; }
  async setLocalDescription(d: { type: string; sdp: string }) { this.localDescription = d; this.signalingState = d.type === "offer" ? "have-local-offer" : "stable"; }
  async setRemoteDescription(d: { type: string; sdp: string }) { this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable"; }
  async addIceCandidate(c: unknown) { this.added.push(c); }
  close() { this.connectionState = "closed"; }
}
const mkPC = () => new FakePC() as unknown as RTCPeerConnection;

it("initiator creates a channel, offers, and opens on answer + channel.open", async () => {
  const out: PeerSignal[] = [];
  let opened = false;
  const link = new PeerLink({
    role: "initiator", iceServers: [],
    signal: (s) => out.push(s), onOpen: () => (opened = true),
    onClose: () => {}, onMessage: () => {}, createConnection: mkPC,
  });
  link.start();
  FakePC.last.onnegotiationneeded?.();
  await new Promise((r) => setTimeout(r, 0));
  expect(out.some((s) => s.type === "sdp" && s.description?.type === "offer")).toBe(true);
  await link.handleSignal({ type: "sdp", from: "peer", description: { type: "answer", sdp: "ANSWER" } });
  FakePC.last.channels[0]!.open();
  expect(opened).toBe(true);
  expect(link.isOpen()).toBe(true);
});

it("responder answers an incoming offer and surfaces channel messages", async () => {
  const out: PeerSignal[] = [];
  const got: string[] = [];
  const link = new PeerLink({
    role: "responder", iceServers: [],
    signal: (s) => out.push(s), onOpen: () => {},
    onClose: () => {}, onMessage: (d) => got.push(d), createConnection: mkPC,
  });
  link.start();
  await link.handleSignal({ type: "sdp", from: "peer", description: { type: "offer", sdp: "OFFER" } });
  expect(out.some((s) => s.type === "sdp" && s.description?.type === "answer")).toBe(true);
  const ch = new FakeChannel();
  FakePC.last.ondatachannel?.({ channel: ch });
  ch.open();
  ch.deliver("hi");
  expect(got).toEqual(["hi"]);
});

it("forwards local ICE candidates and applies remote ones", async () => {
  const out: PeerSignal[] = [];
  const link = new PeerLink({
    role: "initiator", iceServers: [], signal: (s) => out.push(s),
    onOpen: () => {}, onClose: () => {}, onMessage: () => {}, createConnection: mkPC,
  });
  link.start();
  FakePC.last.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "cand" }) } });
  expect(out.some((s) => s.type === "ice" && s.candidate === JSON.stringify({ candidate: "cand" }))).toBe(true);
  FakePC.last.onicecandidate?.({ candidate: null }); // end-of-candidates
  expect(out.some((s) => s.type === "ice" && s.candidate === "")).toBe(true);
  await link.handleSignal({ type: "ice", from: "peer", candidate: JSON.stringify({ candidate: "remote" }) });
  expect(FakePC.last.added).toContainEqual({ candidate: "remote" });
});

it("a polite responder ignores nothing; an impolite initiator ignores a glare offer", async () => {
  const link = new PeerLink({
    role: "initiator", iceServers: [], signal: () => {},
    onOpen: () => {}, onClose: () => {}, onMessage: () => {}, createConnection: mkPC,
  });
  link.start();
  FakePC.last.signalingState = "have-local-offer"; // we are mid-offer → collision
  const before = FakePC.last.signalingState;
  await link.handleSignal({ type: "sdp", from: "peer", description: { type: "offer", sdp: "OFFER" } });
  expect(FakePC.last.signalingState).toBe(before); // impolite: offer ignored, state untouched
});

it("close() closes the connection and reports not open", () => {
  let closed = false;
  const link = new PeerLink({
    role: "initiator", iceServers: [], signal: () => {},
    onOpen: () => {}, onClose: () => (closed = true), onMessage: () => {}, createConnection: mkPC,
  });
  link.start();
  link.close();
  expect(link.isOpen()).toBe(false);
  expect(FakePC.last.connectionState).toBe("closed");
  expect(closed).toBe(true);
});
