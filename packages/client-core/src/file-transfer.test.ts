import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ClientFrame, ServerFrame } from "@uniclip/protocol";
import { encryptBytes, sha256Hex, toBase64 } from "@uniclip/crypto";
import { FileTransferManager, type FileClientEvent } from "./file-transfer";

const RID = "qx7k2p";
const FID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FID_INLINE = "01ARZ3NDEKTSV4RRFFQ69G5FB1";

async function genKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function makeManager(key: CryptoKey) {
  const sent: ClientFrame[] = [];
  const events: FileClientEvent[] = [];
  const mgr = new FileTransferManager({
    routingId: RID,
    getKey: () => key,
    send: (f) => { sent.push(f); return true; },
    emit: (e) => events.push(e),
  });
  return { mgr, sent, events };
}

// Seal a whole file into file-chunk frames the receiver will accept.
async function chunks(key: CryptoKey, fileId: string, data: Uint8Array, chunkBytes = 8): Promise<ServerFrame[]> {
  const count = Math.max(1, Math.ceil(data.length / chunkBytes));
  const out: ServerFrame[] = [];
  for (let i = 0; i < count; i++) {
    const isFinal = i === count - 1;
    const env = await encryptBytes({
      key,
      data: data.subarray(i * chunkBytes, (i + 1) * chunkBytes) as Uint8Array<ArrayBuffer>,
      aad: `${RID}:${fileId}:${i}:${isFinal}`,
    });
    out.push({ type: "file-chunk", fileId, index: i, isFinal, iv: toBase64(env.iv), ciphertext: toBase64(env.ciphertext) } as ServerFrame);
  }
  return out;
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());

describe("FileTransferManager receiver", () => {
  it("emits file-offer; on accept, reassembles + verifies hash, emits file-received", async () => {
    const key = await genKey();
    const { mgr, sent, events } = makeManager(key);
    const data = new TextEncoder().encode("hello chunked world!");
    const hash = await sha256Hex(data as Uint8Array<ArrayBuffer>);
    const cfs = await chunks(key, FID, data);

    await mgr.handle({ type: "file-offer", fileId: FID, name: "a.txt", mime: "text/plain", size: data.length, chunkCount: cfs.length, hash, inline: false } as ServerFrame);
    expect(events.some((e) => e.kind === "file-offer" && e.fileId === FID)).toBe(true);

    mgr.acceptFile(FID);
    expect(sent.some((f) => f.type === "file-accept" && f.fileId === FID)).toBe(true);

    for (const c of cfs) await mgr.handle(c);

    const recv = events.find((e) => e.kind === "file-received") as Extract<FileClientEvent, { kind: "file-received" }>;
    expect(recv).toBeDefined();
    expect(new Uint8Array(await recv.blob.arrayBuffer())).toEqual(data);
  });

  it("auto-accepts an inline offer (sends file-accept without a consumer call)", async () => {
    const key = await genKey();
    const { mgr, sent } = makeManager(key);
    await mgr.handle({ type: "file-offer", fileId: FID_INLINE, name: "p.png", mime: "image/png", size: 4, chunkCount: 1, hash: "a".repeat(64), inline: true } as ServerFrame);
    expect(sent.some((f) => f.type === "file-accept" && f.fileId === FID_INLINE)).toBe(true);
  });

  it("emits AUTH_FAILED when a chunk is tampered", async () => {
    const key = await genKey();
    const { mgr, events } = makeManager(key);
    const data = new TextEncoder().encode("xyz");
    const cfs = await chunks(key, FID, data);
    (cfs[0] as { ciphertext: string }).ciphertext = toBase64(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    await mgr.handle({ type: "file-offer", fileId: FID, name: "f", mime: "text/plain", size: 3, chunkCount: cfs.length, hash: await sha256Hex(data as Uint8Array<ArrayBuffer>), inline: false } as ServerFrame);
    mgr.acceptFile(FID);
    for (const c of cfs) await mgr.handle(c);
    expect(events.some((e) => e.kind === "file-error" && e.code === "AUTH_FAILED")).toBe(true);
  });

  it("emits HASH_MISMATCH when the manifest hash is wrong", async () => {
    const key = await genKey();
    const { mgr, events } = makeManager(key);
    const data = new TextEncoder().encode("abc");
    const cfs = await chunks(key, FID, data);
    await mgr.handle({ type: "file-offer", fileId: FID, name: "f", mime: "text/plain", size: 3, chunkCount: cfs.length, hash: "b".repeat(64), inline: false } as ServerFrame);
    mgr.acceptFile(FID);
    for (const c of cfs) await mgr.handle(c);
    expect(events.some((e) => e.kind === "file-error" && e.code === "HASH_MISMATCH")).toBe(true);
  });
});
