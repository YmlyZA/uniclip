import { expect, it } from "vitest";
import { PeerLink, type PeerSignal } from "@uniclip/client-core/src/peer-link";
import { weriftPeer } from "./werift-peer";

// Two PeerLinks, each backed by a real werift connection. Their signal()
// callbacks hand PeerSignals to each other (an in-memory stand-in for the relay
// WS). Asserts the channel opens and a clip frame crosses P2P — no relay buffer,
// no browser. This is the gate: if this fails, the adapter is wrong, not the wiring.
it("two PeerLinks over werift open a channel and exchange a clip frame", async () => {
  let a!: PeerLink, b!: PeerLink;
  const received: string[] = [];
  let aOpen = false, bOpen = false;

  // Deliver async so we never re-enter handleSignal synchronously.
  const send = (to: () => PeerLink) => (s: PeerSignal) =>
    void Promise.resolve().then(() => to().handleSignal(s));

  a = new PeerLink({
    iceServers: [], createConnection: weriftPeer,
    signal: send(() => b),
    onOpen: () => (aOpen = true), onClose: () => {}, onMessage: () => {},
  });
  b = new PeerLink({
    iceServers: [], createConnection: weriftPeer,
    signal: send(() => a),
    onOpen: () => (bOpen = true),
    onClose: () => {}, onMessage: (d) => received.push(d),
  });

  a.start();
  b.start();

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("channel did not open in time")), 15000);
    const check = setInterval(() => {
      if (aOpen && bOpen) { clearInterval(check); clearTimeout(t); resolve(); }
    }, 50);
  });

  const frame = JSON.stringify({ type: "clip", msgId: "x", iv: "i", ciphertext: "c", ts: 1 });
  // Send from whichever side ended up the initiator/responder — both channels are open.
  expect(a.send(frame)).toBe(true);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("frame not received")), 5000);
    const check = setInterval(() => {
      if (received.length > 0) { clearInterval(check); clearTimeout(t); resolve(); }
    }, 50);
  });

  expect(received[0]).toBe(frame);
  a.close();
  b.close();
}, 25000);
