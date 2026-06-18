import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ClientFrame, ServerFrame } from "@uniclip/protocol";
import { encryptBytes, sha256Hex, toBase64 } from "@uniclip/crypto";
import { FileTransferManager, type FileClientEvent } from "./file-transfer";

const RID = "qx7k2p";
const FID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FID_INLINE = "01ARZ3NDEKTSV4RRFFQ69G5FB1";

/** Fill an arbitrary-length buffer with random bytes (Node's getRandomValues caps at 65536). */
function randBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) {
    crypto.getRandomValues(buf.subarray(off, Math.min(off + 65536, n)));
  }
  return buf;
}

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

describe("FileTransferManager sender", () => {
  it("rejects an oversize file with TOO_LARGE and sends nothing", async () => {
    const key = await genKey();
    const { mgr, sent, events } = makeManager(key);
    // sendFile only reads `bytes.length` before the guard, so a stub with an
    // oversize length exercises it without allocating 100 MB.
    await mgr.sendFile({ name: "big.bin", mime: "application/octet-stream", bytes: { length: 100 * 1024 * 1024 + 1 } as unknown as Uint8Array });
    expect(events.some((e) => e.kind === "file-error" && e.code === "TOO_LARGE")).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("offers, then streams the single chunk once accepted, then completes on ack", async () => {
    const key = await genKey();
    const { mgr, sent } = makeManager(key);
    const data = new TextEncoder().encode("a".repeat(100)); // ≤ CHUNK_BYTES → exactly 1 chunk
    await mgr.sendFile({ name: "f.txt", mime: "text/plain", bytes: data });
    const offer = sent.find((f) => f.type === "file-offer");
    expect(offer).toBeDefined();
    const fileId = (offer as { fileId: string }).fileId;

    await mgr.handle({ type: "file-accept", fileId } as ServerFrame);
    expect(sent.some((f) => f.type === "file-chunk" && f.fileId === fileId)).toBe(true);
    await mgr.handle({ type: "file-ack", fileId, upTo: 0 } as ServerFrame);
    expect(sent.some((f) => f.type === "file-complete" && f.fileId === fileId)).toBe(true);
  });

  it("pauses at CREDIT_WINDOW unacked chunks and resumes on ack (pace to fastest)", async () => {
    const key = await genKey();
    const { mgr, sent } = makeManager(key);
    const data = randBytes(40 * 32 * 1024); // exactly 40 chunks
    await mgr.sendFile({ name: "f.bin", mime: "application/octet-stream", bytes: data });
    const fileId = (sent.find((f) => f.type === "file-offer") as { fileId: string }).fileId;
    await mgr.handle({ type: "file-accept", fileId } as ServerFrame);
    const after1 = sent.filter((f) => f.type === "file-chunk").length;
    expect(after1).toBe(32); // CREDIT_WINDOW, no acks yet
    await mgr.handle({ type: "file-ack", fileId, upTo: 15 } as ServerFrame);
    const after2 = sent.filter((f) => f.type === "file-chunk").length;
    expect(after2).toBeGreaterThan(after1);
  });

  it("paces to the fastest acker: a lower subsequent ack does not shrink the window", async () => {
    const key = await genKey();
    const { mgr, sent } = makeManager(key);
    const data = randBytes(100 * 32 * 1024); // 100 chunks
    await mgr.sendFile({ name: "f.bin", mime: "application/octet-stream", bytes: data });
    const fileId = (sent.find((f) => f.type === "file-offer") as { fileId: string }).fileId;
    await mgr.handle({ type: "file-accept", fileId } as ServerFrame);
    expect(sent.filter((f) => f.type === "file-chunk").length).toBe(32); // CREDIT_WINDOW

    await mgr.handle({ type: "file-ack", fileId, upTo: 20 } as ServerFrame); // fast acker
    const afterHigh = sent.filter((f) => f.type === "file-chunk").length;
    expect(afterHigh).toBeGreaterThan(32);

    await mgr.handle({ type: "file-ack", fileId, upTo: 10 } as ServerFrame); // slower/stale ack
    const afterLow = sent.filter((f) => f.type === "file-chunk").length;
    expect(afterLow).toBe(afterHigh); // lower upTo ignored — window did not shrink or advance
  });

  it("round-trips sender→receiver: assembled bytes equal the input", async () => {
    const key = await genKey();
    const aEvents: FileClientEvent[] = [];
    const bEvents: FileClientEvent[] = [];
    let aMgr!: FileTransferManager;
    let bMgr!: FileTransferManager;
    aMgr = new FileTransferManager({
      routingId: RID, getKey: () => key,
      send: (f) => { void bMgr.handle(f as unknown as ServerFrame); return true; },
      emit: (e) => aEvents.push(e),
    });
    bMgr = new FileTransferManager({
      routingId: RID, getKey: () => key,
      send: (f) => { void aMgr.handle(f as unknown as ServerFrame); return true; },
      emit: (e) => bEvents.push(e),
    });

    // An image ≤ INLINE_IMAGE_MAX → inline offer → receiver auto-accepts.
    const data = randBytes(70 * 1024); // ~3 chunks
    await aMgr.sendFile({ name: "x.png", mime: "image/png", bytes: data });
    await new Promise((r) => setTimeout(r, 50)); // let the cross-manager async pipeline settle

    const recv = bEvents.find((e) => e.kind === "file-received") as Extract<FileClientEvent, { kind: "file-received" }>;
    expect(recv).toBeDefined();
    expect(new Uint8Array(await recv.blob.arrayBuffer())).toEqual(data);
    expect(bEvents.some((e) => e.kind === "file-error")).toBe(false);
  });

  it("aborts with STALLED when no ack advances within the timeout", async () => {
    vi.useFakeTimers();
    const key = await genKey();
    const { mgr, sent, events } = makeManager(key);
    const data = randBytes(40 * 32 * 1024);
    await mgr.sendFile({ name: "f.bin", mime: "application/octet-stream", bytes: data });
    const fileId = (sent.find((f) => f.type === "file-offer") as { fileId: string }).fileId;
    await mgr.handle({ type: "file-accept", fileId } as ServerFrame);
    await vi.advanceTimersByTimeAsync(30_000 + 10);
    expect(events.some((e) => e.kind === "file-error" && e.code === "STALLED")).toBe(true);
    vi.useRealTimers();
  });

  it("cancelFile sends a file-cancel and emits one", async () => {
    const key = await genKey();
    const { mgr, sent, events } = makeManager(key);
    const data = new TextEncoder().encode("z");
    await mgr.sendFile({ name: "f", mime: "text/plain", bytes: data });
    const fileId = (sent.find((f) => f.type === "file-offer") as { fileId: string }).fileId;
    mgr.cancelFile(fileId);
    expect(sent.some((f) => f.type === "file-cancel" && f.fileId === fileId)).toBe(true);
    expect(events.some((e) => e.kind === "file-cancel" && e.fileId === fileId)).toBe(true);
  });

  it("a peer file-cancel clears the sender stall timer (no spurious frames)", async () => {
    vi.useFakeTimers();
    const key = await genKey();
    const { mgr, sent, events } = makeManager(key);
    await mgr.sendFile({ name: "f.txt", mime: "text/plain", bytes: new TextEncoder().encode("hi") });
    const fileId = (sent.find((f) => f.type === "file-offer") as { fileId: string }).fileId;
    await mgr.handle({ type: "file-cancel", fileId, reason: "peer_cancelled" } as ServerFrame);
    const before = sent.length;
    await vi.advanceTimersByTimeAsync(30_000 + 10);
    expect(sent.length).toBe(before); // no spurious file-cancel sent
    expect(events.some((e) => e.kind === "file-error" && e.code === "STALLED")).toBe(false);
    vi.useRealTimers();
  });

  it("sendFile returns the minted {fileId, chunkCount}, and null when oversize", async () => {
    const key = await genKey();
    const { mgr } = makeManager(key);
    const res = await mgr.sendFile({ name: "f.txt", mime: "text/plain", bytes: new TextEncoder().encode("hi") });
    expect(res).not.toBeNull();
    expect(res!.fileId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(res!.chunkCount).toBe(1);
    const big = await mgr.sendFile({ name: "b", mime: "x", bytes: { length: 100 * 1024 * 1024 + 1 } as unknown as Uint8Array });
    expect(big).toBeNull();
  });
});
