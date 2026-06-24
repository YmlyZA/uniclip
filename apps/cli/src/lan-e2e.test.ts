import { expect, it } from "vitest";
import { UniclipClient } from "@uniclip/client-core";
import { generateModeARoom } from "@uniclip/room-code";
import { startLanRelay } from "./lan-relay";
import { weriftPeer } from "./werift-peer";

// Embedded relay + two real UniclipClients + werift, connected by known port
// (no mDNS). Proves a clip syncs P2P over the LAN path end-to-end in pure Node.
it("two UniclipClients sync a clip P2P through the embedded LAN relay", async () => {
  const { routingId, secret } = generateModeARoom();
  const relay = await startLanRelay({ routingId, host: "127.0.0.1" });
  const base = `ws://127.0.0.1:${relay.port}`;
  const roomUrl = `http://127.0.0.1:${relay.port}/r/${routingId}#${secret}`;
  const mk = () => new UniclipClient({ roomUrl, relayBase: base, iceServers: [], createConnection: weriftPeer });
  const a = mk(), b = mk();
  try {
    const got: string[] = [];
    let aP2P = false, bP2P = false;
    a.on("transport", (t) => { if (t === "p2p") aP2P = true; });
    b.on("transport", (t) => { if (t === "p2p") bP2P = true; });
    b.on("clip", (text) => got.push(text));

    await a.connect();
    await b.connect();

    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("P2P did not establish")), 18000);
      const i = setInterval(() => { if (aP2P && bP2P) { clearInterval(i); clearTimeout(t); res(); } }, 50);
    });

    await a.send("hello over the LAN");
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("clip not received")), 5000);
      const i = setInterval(() => { if (got.length) { clearInterval(i); clearTimeout(t); res(); } }, 50);
    });

    expect(got[0]).toBe("hello over the LAN");
  } finally {
    a.disconnect();
    b.disconnect();
    relay.close();
  }
}, 25000);
