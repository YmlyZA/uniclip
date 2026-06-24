import { expect, it } from "vitest";
import { PeerLink, type PeerSignal } from "@uniclip/client-core/src/peer-link";
import { weriftPeer } from "./werift-peer";

// Two PeerLinks, each backed by a real werift connection. Their signal()
// callbacks hand PeerSignals to each other (an in-memory stand-in for the relay
// WS). Asserts the channel opens and a clip frame crosses P2P — no relay buffer,
// no browser. This is the gate: if this fails, the adapter is wrong, not the wiring.
it("two PeerLinks over werift open a channel and exchange a clip frame", async () => {
  let a!: PeerLink, b!: PeerLink;
  const recvByB: string[] = [];
  const recvByA: string[] = [];
  let aOpen = false, bOpen = false;

  // Deliver async so we never re-enter handleSignal synchronously.
  const send = (to: () => PeerLink) => (s: PeerSignal) =>
    void Promise.resolve().then(() => to().handleSignal(s));

  a = new PeerLink({
    iceServers: [], createConnection: weriftPeer,
    signal: send(() => b),
    onOpen: () => (aOpen = true), onClose: () => {}, onMessage: (d) => recvByA.push(d),
  });
  b = new PeerLink({
    iceServers: [], createConnection: weriftPeer,
    signal: send(() => a),
    onOpen: () => (bOpen = true),
    onClose: () => {}, onMessage: (d) => recvByB.push(d),
  });

  a.start();
  b.start();

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("channel did not open in time")), 15000);
    const check = setInterval(() => {
      if (aOpen && bOpen) { clearInterval(check); clearTimeout(t); resolve(); }
    }, 50);
  });

  // A→B. The DataChannel is full-duplex, so direction is independent of which
  // side won the rtc-hello initiator role — sending from A always reaches B.
  const frameAB = JSON.stringify({ type: "clip", msgId: "ab", iv: "i", ciphertext: "c", ts: 1 });
  expect(a.send(frameAB)).toBe(true);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("A→B frame not received")), 5000);
    const check = setInterval(() => {
      if (recvByB.length > 0) { clearInterval(check); clearTimeout(t); resolve(); }
    }, 50);
  });
  expect(recvByB[0]).toBe(frameAB);

  // B→A, proving the channel carries both directions.
  const frameBA = JSON.stringify({ type: "clip", msgId: "ba", iv: "i", ciphertext: "c", ts: 2 });
  expect(b.send(frameBA)).toBe(true);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("B→A frame not received")), 5000);
    const check = setInterval(() => {
      if (recvByA.length > 0) { clearInterval(check); clearTimeout(t); resolve(); }
    }, 50);
  });
  expect(recvByA[0]).toBe(frameBA);

  a.close();
  b.close();
}, 25000);
