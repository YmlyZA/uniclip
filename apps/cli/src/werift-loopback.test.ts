import { expect, it } from "vitest";
import { RTCPeerConnection } from "werift";
import { PeerLink, type PeerSignal } from "@uniclip/client-core/src/peer-link";
import { type DiagEvent } from "@uniclip/client-core/src/diag";
import { weriftPeer } from "./werift-peer";

// Proves werift completes a real handshake on loopback in this sandbox and
// pins the API the adapter (Task 2) bridges. No relay, no browser — pure Node.
it("two raw werift peers connect on loopback and exchange a datachannel message", async () => {
  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });
  a.onIceCandidate.subscribe((c) => c && void b.addIceCandidate(JSON.parse(JSON.stringify(c.toJSON())) as RTCIceCandidateInit));
  b.onIceCandidate.subscribe((c) => c && void a.addIceCandidate(JSON.parse(JSON.stringify(c.toJSON())) as RTCIceCandidateInit));

  const got = new Promise<string>((resolve) => {
    b.onDataChannel.subscribe((dc) => dc.onMessage.subscribe((d) => resolve(String(d))));
  });

  const dc = a.createDataChannel("uniclip", { ordered: true });
  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(a.localDescription!);
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(b.localDescription!);

  await new Promise<void>((res) => dc.stateChanged.subscribe((s) => s === "open" && res()));
  dc.send("hello-p2p");
  expect(await got).toBe("hello-p2p");
  await a.close();
  await b.close();
}, 20000);

it("PeerLink diag trace emits ice-candidate, pc-state, and dc-open for a real werift handshake", async () => {
  const collectedDiag: DiagEvent[] = [];
  let pa!: PeerLink, pb!: PeerLink;
  let aOpen = false, bOpen = false;

  // Deliver async so we never re-enter handleSignal synchronously.
  const send = (to: () => PeerLink) => (s: PeerSignal) =>
    void Promise.resolve().then(() => to().handleSignal(s));

  pa = new PeerLink({
    iceServers: [], createConnection: weriftPeer,
    signal: send(() => pb),
    onOpen: () => (aOpen = true), onClose: () => {}, onMessage: () => {},
    onDiag: (e) => collectedDiag.push(e),
  });
  pb = new PeerLink({
    iceServers: [], createConnection: weriftPeer,
    signal: send(() => pa),
    onOpen: () => (bOpen = true), onClose: () => {}, onMessage: () => {},
  });

  pa.start();
  pb.start();

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("channel did not open in time")), 15000);
    const check = setInterval(() => {
      if (aOpen && bOpen) { clearInterval(check); clearTimeout(t); resolve(); }
    }, 50);
  });

  // diag vocabulary is correct against a real WebRTC handshake:
  const phases = collectedDiag.map((e) => e.phase);
  expect(phases).toContain("ice-candidate");
  expect(phases).toContain("pc-state");
  expect(phases.indexOf("dc")).toBeGreaterThan(-1);
  // dc open arrives after at least one pc-state:
  expect(phases.indexOf("dc")).toBeGreaterThan(phases.indexOf("pc-state"));

  pa.close();
  pb.close();
}, 20000);
