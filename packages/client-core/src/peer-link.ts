import { ulid } from "ulid";
import { DATACHANNEL_LABEL } from "./constants";
import { parseCandidate, type DiagEvent } from "./diag";

export interface PeerSignal {
  type: "sdp" | "ice" | "rtc-hello";
  from: string;
  description?: { type: "offer" | "answer"; sdp: string };
  candidate?: string;
}

export interface PeerLinkOptions {
  iceServers: RTCIceServer[];
  signal: (s: PeerSignal) => void;
  onOpen: () => void;
  onClose: () => void;
  onMessage: (data: string) => void;
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  onDiag?: (e: DiagEvent) => void;
}

// One RTCPeerConnection + one ordered/reliable RTCDataChannel, driven by the
// "perfect negotiation" pattern. The connection is injectable so the logic is
// unit-testable in Node (which has no RTCPeerConnection). Role is decided by an
// identity handshake: each peer announces its random per-connection `from` via
// an `rtc-hello`; the larger `from` is the sole initiator (creates the channel
// and offers). This is deterministic across any join/reconnect ordering.
export class PeerLink {
  readonly from = ulid();
  private readonly opts: PeerLinkOptions;
  private readonly make: (config: RTCConfiguration) => RTCPeerConnection;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private peerFrom: string | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private closed = false;

  constructor(opts: PeerLinkOptions) {
    this.opts = opts;
    this.make = opts.createConnection ?? ((c) => new RTCPeerConnection(c));
  }

  private diag(phase: DiagEvent["phase"], level: DiagEvent["level"], detail: string, data?: Record<string, string | number>): void {
    this.opts.onDiag?.({ kind: "diag", phase, level, detail, ...(data ? { data } : {}) });
  }

  isOpen(): boolean {
    return this.channel?.readyState === "open";
  }

  start(): void {
    const pc = this.make({ iceServers: this.opts.iceServers });
    this.pc = pc;
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        const sdpStr = (candidate.toJSON() as { candidate?: string }).candidate ?? "";
        const { typ, protocol } = parseCandidate(sdpStr);
        if (typ) this.diag("ice-candidate", "info", `${typ} ${protocol ?? ""}`.trim(), { typ, ...(protocol ? { protocol } : {}) });
      }
      this.opts.signal({
        type: "ice",
        from: this.from,
        candidate: candidate ? JSON.stringify(candidate.toJSON()) : "",
      });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this.diag("pc-state", s === "failed" ? "error" : "info", s, { state: s });
      if (s === "failed" || s === "disconnected" || s === "closed") this.fireClose();
    };
    // Either peer may turn out to be the responder, so always be ready to
    // receive the channel. The channel is created only by the initiator, once
    // both `from` ids are known (see handleSignal "rtc-hello").
    pc.ondatachannel = (ev) => this.wireChannel(ev.channel);
    // Announce identity; the larger `from` becomes the sole initiator.
    this.opts.signal({ type: "rtc-hello", from: this.from });
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
    if (s.type === "rtc-hello") {
      if (this.peerFrom !== null) return; // resolve role once
      this.peerFrom = s.from;
      if (this.from > s.from) {
        // Larger `from` = sole initiator: create the channel and offer.
        pc.onnegotiationneeded = () => void this.makeOffer();
        this.wireChannel(pc.createDataChannel(DATACHANNEL_LABEL, { ordered: true }));
      }
      // Smaller `from` = responder: wait for ondatachannel + the inbound offer.
      // Equal `from` (astronomically unlikely between two random ULIDs) means
      // neither side initiates — by design this degrades to relay (lossless),
      // exactly like pairing with a peer that never announces.
      return;
    }
    try {
      if (s.type === "sdp" && s.description) {
        // Exactly one peer offers, so glare should not occur; keep an
        // identity-based backstop — the smaller `from` is polite (yields).
        const polite = this.peerFrom !== null ? this.from < this.peerFrom : true;
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
    ch.onopen = () => { this.diag("dc", "info", "open", { event: "open" }); this.opts.onOpen(); };
    ch.onclose = () => { this.diag("dc", "warn", "close", { event: "close" }); this.fireClose(); };
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
