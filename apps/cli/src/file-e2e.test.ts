import { expect, it } from "vitest";
import { UniclipClient } from "@uniclip/client-core";
import { generateModeARoom } from "@uniclip/room-code";
import { startLanRelay } from "./lan-relay";
import { weriftPeer } from "./werift-peer";

it("sends a multi-chunk file P2P through the embedded LAN relay", async () => {
  const { routingId, secret } = generateModeARoom();
  const relay = await startLanRelay({ routingId, host: "127.0.0.1" });
  const base = `ws://127.0.0.1:${relay.port}`;
  const roomUrl = `http://127.0.0.1:${relay.port}/r/${routingId}#${secret}`;
  const mk = () => new UniclipClient({ roomUrl, relayBase: base, iceServers: [], createConnection: weriftPeer });
  const a = mk(), b = mk();
  let aP2P = false, bP2P = false;
  const received: { bytes: Uint8Array }[] = [];
  a.on("transport", (t) => { if (t === "p2p") aP2P = true; });
  b.on("transport", (t) => { if (t === "p2p") bP2P = true; });
  b.on("file-offer", (o) => b.acceptFile(o.fileId));
  b.on("file-received", async (r) => received.push({ bytes: new Uint8Array(await r.blob.arrayBuffer()) }));
  try {
    await a.connect(); await b.connect();
    await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error("no p2p")), 18000); const i = setInterval(() => { if (aP2P && bP2P) { clearInterval(i); clearTimeout(t); res(); } }, 50); });
    const bytes = new Uint8Array(80 * 1024).map((_, i) => i % 256); // > CHUNK_BYTES → multiple chunks
    await a.sendFile({ name: "blob.bin", mime: "application/octet-stream", bytes });
    await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error("no file")), 12000); const i = setInterval(() => { if (received.length) { clearInterval(i); clearTimeout(t); res(); } }, 50); });
    expect(received[0]!.bytes.length).toBe(bytes.length);
    expect(Buffer.from(received[0]!.bytes).equals(Buffer.from(bytes))).toBe(true); // full byte-for-byte match
  } finally {
    a.disconnect(); b.disconnect(); relay.close();
  }
}, 30000);
