import { expect, it } from "vitest";
import { RTCPeerConnection } from "werift";

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
