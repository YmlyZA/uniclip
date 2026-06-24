import { describe, expect, it, vi } from "vitest";

// A minimal fake of a werift RTCPeerConnection: each "Event" is an object with
// a .subscribe(cb) that records cb so the test can fire it. Mirrors werift's API.
function mkSubject<T>() {
  const cbs: ((v: T) => void)[] = [];
  return { subscribe: (cb: (v: T) => void) => cbs.push(cb), fire: (v: T) => cbs.forEach((c) => c(v)) };
}
function fakeChannel() {
  const stateChanged = mkSubject<string>();
  const onMessage = mkSubject<string | Buffer>();
  return { stateChanged, onMessage, readyState: "connecting", sent: [] as string[], send(d: string) { this.sent.push(d); }, close: vi.fn() };
}
function fakeWerift() {
  const onIceCandidate = mkSubject<{ toJSON(): unknown } | undefined>();
  const onDataChannel = mkSubject<ReturnType<typeof fakeChannel>>();
  const onNegotiationneeded = mkSubject<void>();
  const connectionStateChange = mkSubject<void>();
  const created: ReturnType<typeof fakeChannel>[] = [];
  return {
    onIceCandidate, onDataChannel, onNegotiationneeded, connectionStateChange, created,
    iceServers: undefined as unknown,
    connectionState: "new", signalingState: "stable", localDescription: { type: "offer", sdp: "SDP" },
    createDataChannel: vi.fn(function (this: any) { const c = fakeChannel(); created.push(c); return c; }),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "OFFER" })),
    createAnswer: vi.fn(async () => ({ type: "answer", sdp: "ANSWER" })),
    setLocalDescription: vi.fn(async () => {}), setRemoteDescription: vi.fn(async () => {}),
    addIceCandidate: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
}

// Inject the fake werift constructor into werift-peer via the module's test hook.
import { weriftPeerWith } from "./werift-peer";

describe("weriftPeer adapter", () => {
  it("re-dispatches werift ICE candidates to onicecandidate with a toJSON-able candidate", () => {
    const w = fakeWerift();
    const pc = weriftPeerWith(() => w as any, { iceServers: [] });
    const seen: unknown[] = [];
    pc.onicecandidate = (ev: any) => seen.push(ev.candidate);
    const cand = { toJSON: () => ({ candidate: "x" }) };
    w.onIceCandidate.fire(cand);
    w.onIceCandidate.fire(undefined); // end-of-candidates
    expect(seen).toEqual([cand, null]);
  });

  it("synthesizes onnegotiationneeded from werift's onNegotiationneeded", () => {
    const w = fakeWerift();
    const pc = weriftPeerWith(() => w as any, { iceServers: [] });
    const fn = vi.fn();
    pc.onnegotiationneeded = fn;
    w.onNegotiationneeded.fire();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("wraps an inbound data channel and coerces Buffer messages to strings", () => {
    const w = fakeWerift();
    const pc = weriftPeerWith(() => w as any, { iceServers: [] });
    let channel: any;
    pc.ondatachannel = (ev: any) => (channel = ev.channel);
    const dc = fakeChannel();
    w.onDataChannel.fire(dc);
    const msgs: string[] = [];
    channel.onmessage = (ev: { data: string }) => msgs.push(ev.data);
    dc.onMessage.fire(Buffer.from("héllo", "utf8"));
    dc.onMessage.fire("plain");
    expect(msgs).toEqual(["héllo", "plain"]);
  });

  it("maps channel open/close via stateChanged and forwards send/readyState", () => {
    const w = fakeWerift();
    const pc = weriftPeerWith(() => w as any, { iceServers: [] }) as any;
    const ch = pc.createDataChannel("uniclip", { ordered: true });
    const inner = w.created[0]!;
    let opened = false, closed = false;
    ch.onopen = () => (opened = true);
    ch.onclose = () => (closed = true);
    inner.stateChanged.fire("open");
    expect(opened).toBe(true);
    ch.send("frame");
    expect(inner.sent).toEqual(["frame"]);
    inner.stateChanged.fire("closed");
    expect(closed).toBe(true);
  });

  it("exposes connectionState/localDescription getters and fires onconnectionstatechange", () => {
    const w = fakeWerift();
    const pc = weriftPeerWith(() => w as any, { iceServers: [] }) as any;
    const fn = vi.fn();
    pc.onconnectionstatechange = fn;
    w.connectionState = "connected";
    w.connectionStateChange.fire();
    expect(fn).toHaveBeenCalledOnce();
    expect(pc.connectionState).toBe("connected");
    expect(pc.localDescription).toEqual({ type: "offer", sdp: "SDP" });
  });

  it("maps DOM iceServers (urls string|string[]) to werift's single-string urls, expanding arrays", () => {
    let captured: any;
    const make = (cfg: any) => { captured = cfg; return fakeWerift() as any; };
    weriftPeerWith(make, { iceServers: [{ urls: ["stun:a:1", "stun:b:2"] }, { urls: "stun:c:3" }] });
    expect(captured.iceServers).toEqual([{ urls: "stun:a:1" }, { urls: "stun:b:2" }, { urls: "stun:c:3" }]);
  });
});
