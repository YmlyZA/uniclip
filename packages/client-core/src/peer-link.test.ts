import { describe, expect, it } from "vitest";
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
const MIN_FROM = "00000000000000000000000000"; // < any real ULID
const MAX_FROM = "ZZZZZZZZZZZZZZZZZZZZZZZZZZ"; // > any real ULID
function mk(extra: Partial<Record<"onOpen" | "onClose" | "onMessage", () => void>> = {}) {
  const out: PeerSignal[] = [];
  const link = new PeerLink({
    iceServers: [], signal: (s) => out.push(s),
    onOpen: extra.onOpen ?? (() => {}), onClose: extra.onClose ?? (() => {}),
    onMessage: (extra.onMessage as ((d: string) => void)) ?? (() => {}),
    createConnection: mkPC,
  });
  return { link, out };
}

it("start() announces rtc-hello and creates no channel or offer yet", () => {
  const { link, out } = mk();
  link.start();
  expect(out).toEqual([{ type: "rtc-hello", from: link.from }]);
  expect(FakePC.last.channels.length).toBe(0);
});

it("becomes the initiator (creates channel + offers) when its from is larger", async () => {
  const { link, out } = mk();
  link.start();
  await link.handleSignal({ type: "rtc-hello", from: MIN_FROM }); // peer smaller → we initiate
  expect(FakePC.last.channels.length).toBe(1);
  FakePC.last.onnegotiationneeded?.();
  await new Promise((r) => setTimeout(r, 0));
  expect(out.some((s) => s.type === "sdp" && s.description?.type === "offer")).toBe(true);
});

it("stays responder when its from is smaller; answers an inbound offer and opens via ondatachannel", async () => {
  let opened = false;
  const { link, out } = mk({ onOpen: () => (opened = true) });
  link.start();
  await link.handleSignal({ type: "rtc-hello", from: MAX_FROM }); // peer larger → we wait
  expect(FakePC.last.channels.length).toBe(0);
  await link.handleSignal({ type: "sdp", from: MAX_FROM, description: { type: "offer", sdp: "OFFER" } });
  expect(out.some((s) => s.type === "sdp" && s.description?.type === "answer")).toBe(true);
  const ch = new FakeChannel();
  FakePC.last.ondatachannel?.({ channel: ch });
  ch.open();
  expect(opened).toBe(true);
});

it("resolves role once — a second rtc-hello is ignored", async () => {
  const { link } = mk();
  link.start();
  await link.handleSignal({ type: "rtc-hello", from: MIN_FROM }); // initiator: 1 channel
  await link.handleSignal({ type: "rtc-hello", from: MAX_FROM }); // ignored
  expect(FakePC.last.channels.length).toBe(1);
});

it("forwards local ICE candidates and applies remote ones", async () => {
  const { link, out } = mk();
  link.start();
  FakePC.last.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "cand" }) } });
  expect(out.some((s) => s.type === "ice" && s.candidate === JSON.stringify({ candidate: "cand" }))).toBe(true);
  await link.handleSignal({ type: "ice", from: MIN_FROM, candidate: JSON.stringify({ candidate: "remote" }) });
  expect(FakePC.last.added).toContainEqual({ candidate: "remote" });
});

it("close() closes the connection and reports not open", () => {
  let closed = false;
  const { link } = mk({ onClose: () => (closed = true) });
  link.start();
  link.close();
  expect(link.isOpen()).toBe(false);
  expect(FakePC.last.connectionState).toBe("closed");
  expect(closed).toBe(true);
});
