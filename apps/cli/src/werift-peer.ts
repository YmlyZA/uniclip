import { RTCPeerConnection as WeriftPC } from "werift";

// werift may deliver a data-channel message as a Buffer; PeerLink expects a
// string. Coerce every inbound message to UTF-8.
function asString(d: string | Buffer | ArrayBuffer): string {
  if (typeof d === "string") return d;
  return Buffer.from(d as Buffer).toString("utf8");
}

// DOM RTCIceServer.urls may be string | string[]; werift wants a single string,
// so expand each multi-URL entry into multiple single-URL werift entries.
function toWeriftIceServers(config: RTCConfiguration): { urls: string; username?: string; credential?: string }[] {
  return (config.iceServers ?? []).flatMap((s) => {
    const urlList = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urlList.map((url) => ({
      urls: url,
      ...(s.username ? { username: s.username } : {}),
      ...(typeof s.credential === "string" ? { credential: s.credential } : {}),
    }));
  });
}

// Wraps a werift data channel as the DOM RTCDataChannel surface PeerLink uses.
class ChannelAdapter {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(private readonly dc: any) {
    dc.stateChanged.subscribe((s: string) => {
      if (s === "open") this.onopen?.();
      else if (s === "closed") this.onclose?.();
    });
    dc.onMessage.subscribe((d: string | Buffer) => this.onmessage?.({ data: asString(d) }));
  }
  get readyState(): string { return this.dc.readyState; }
  send(data: string): void { this.dc.send(data); }
  close(): void { this.dc.close(); }
}

// Wraps a werift RTCPeerConnection as the DOM RTCPeerConnection surface PeerLink
// uses. Bridges werift's rx Event subjects to the DOM onX callbacks PeerLink
// assigns. The subjects (not werift's own onX fields) are the canonical, always-
// fired channel, so this works regardless of werift's DOM-callback behavior.
class PeerAdapter {
  onicecandidate: ((ev: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  ondatachannel: ((ev: { channel: ChannelAdapter }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private readonly pc: any;

  constructor(make: (cfg: any) => any, config: RTCConfiguration) {
    this.pc = make({ iceServers: toWeriftIceServers(config) });
    this.pc.onIceCandidate.subscribe((c: { toJSON(): unknown } | undefined) =>
      this.onicecandidate?.({ candidate: c ?? null }),
    );
    this.pc.onDataChannel.subscribe((dc: any) =>
      this.ondatachannel?.({ channel: new ChannelAdapter(dc) }),
    );
    this.pc.onNegotiationneeded.subscribe(() => this.onnegotiationneeded?.());
    this.pc.connectionStateChange.subscribe(() => this.onconnectionstatechange?.());
  }

  get connectionState(): string { return this.pc.connectionState; }
  get signalingState(): string { return this.pc.signalingState; }
  get localDescription(): { type: string; sdp: string } | null { return this.pc.localDescription ?? null; }

  createDataChannel(label: string, opts?: { ordered?: boolean }): ChannelAdapter {
    return new ChannelAdapter(this.pc.createDataChannel(label, opts));
  }
  createOffer(): Promise<{ type: string; sdp: string }> { return this.pc.createOffer(); }
  createAnswer(): Promise<{ type: string; sdp: string }> { return this.pc.createAnswer(); }
  setLocalDescription(d?: { type: "offer" | "answer"; sdp: string }): Promise<unknown> { return this.pc.setLocalDescription(d); }
  setRemoteDescription(d: { type: "offer" | "answer"; sdp: string }): Promise<unknown> { return this.pc.setRemoteDescription(d); }
  addIceCandidate(c: RTCIceCandidateInit): Promise<void> { return this.pc.addIceCandidate(c); }
  close(): void { void this.pc.close(); }
}

// Test hook: inject the werift constructor. Production code uses `weriftPeer`.
export function weriftPeerWith(
  make: (cfg: any) => any,
  config: RTCConfiguration,
): RTCPeerConnection {
  return new PeerAdapter(make, config) as unknown as RTCPeerConnection;
}

// A real Node WebRTC connection backed by werift, shaped as a DOM
// RTCPeerConnection so client-core's PeerLink drives it unchanged.
export const weriftPeer = (config: RTCConfiguration): RTCPeerConnection =>
  weriftPeerWith((cfg) => new WeriftPC(cfg), config);
