import { ulid } from "ulid";
import { DATACHANNEL_LABEL } from "./constants";

export type PeerRole = "initiator" | "responder";

export interface PeerSignal {
  type: "sdp" | "ice";
  from: string;
  description?: { type: "offer" | "answer"; sdp: string };
  candidate?: string;
}

export interface PeerLinkOptions {
  role: PeerRole;
  iceServers: RTCIceServer[];
  signal: (s: PeerSignal) => void;
  onOpen: () => void;
  onClose: () => void;
  onMessage: (data: string) => void;
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

// One RTCPeerConnection + one ordered/reliable RTCDataChannel, driven by the
// "perfect negotiation" pattern. The connection is injectable so the logic is
// unit-testable in Node (which has no RTCPeerConnection). Politeness is
// determined by role: responder (newcomer) is polite, initiator (incumbent) is impolite.
export class PeerLink {
  readonly from = ulid();
  private readonly opts: PeerLinkOptions;
  private readonly make: (config: RTCConfiguration) => RTCPeerConnection;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private closed = false;

  constructor(opts: PeerLinkOptions) {
    this.opts = opts;
    this.make = opts.createConnection ?? ((c) => new RTCPeerConnection(c));
  }

  isOpen(): boolean {
    return this.channel?.readyState === "open";
  }

  start(): void {
    const pc = this.make({ iceServers: this.opts.iceServers });
    this.pc = pc;
    pc.onicecandidate = ({ candidate }) =>
      this.opts.signal({
        type: "ice",
        from: this.from,
        candidate: candidate ? JSON.stringify(candidate.toJSON()) : "",
      });
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "disconnected" || s === "closed") this.fireClose();
    };
    if (this.opts.role === "initiator") {
      pc.onnegotiationneeded = () => void this.makeOffer();
      this.wireChannel(pc.createDataChannel(DATACHANNEL_LABEL, { ordered: true }));
    } else {
      pc.ondatachannel = (ev) => this.wireChannel(ev.channel);
    }
  }

  private async makeOffer(): Promise<void> {
    if (!this.pc) return;
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.opts.signal({
        type: "sdp",
        from: this.from,
        description: { type: "offer", sdp: this.pc.localDescription?.sdp ?? offer.sdp ?? "" },
      });
    } catch {
      /* renegotiation will be retried on the next negotiationneeded */
    } finally {
      this.makingOffer = false;
    }
  }

  async handleSignal(s: PeerSignal): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (s.type === "sdp" && s.description) {
        // Responder is polite (yields on glare); initiator is impolite (ignores
        // colliding offers). Since the relay serializes socket joins, both peers
        // receive distinct roles (one via hello, one via peer-joined), so no tiebreak is needed.
        // `from` is per-connection identity for future use; it is not used for politeness.
        const polite = this.opts.role === "responder";
        const collision =
          s.description.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
        this.ignoreOffer = !polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription({ type: s.description.type, sdp: s.description.sdp });
        if (s.description.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.opts.signal({
            type: "sdp",
            from: this.from,
            description: { type: "answer", sdp: pc.localDescription?.sdp ?? answer.sdp ?? "" },
          });
        }
      } else if (s.type === "ice" && s.candidate !== undefined) {
        if (s.candidate === "") return; // end-of-candidates marker
        await pc.addIceCandidate(JSON.parse(s.candidate) as RTCIceCandidateInit);
      }
    } catch {
      // A failed addIceCandidate after an ignored offer is expected; swallow.
    }
  }

  private wireChannel(ch: RTCDataChannel): void {
    this.channel = ch;
    ch.onopen = () => this.opts.onOpen();
    ch.onclose = () => this.fireClose();
    ch.onmessage = (ev: MessageEvent) => this.opts.onMessage(ev.data as string);
  }

  send(data: string): boolean {
    if (this.channel?.readyState !== "open") return false;
    this.channel.send(data);
    return true;
  }

  private fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.opts.onClose();
  }

  close(): void {
    try {
      this.channel?.close();
    } catch { /* already gone */ }
    try {
      this.pc?.close();
    } catch { /* already gone */ }
    this.fireClose();
  }
}
