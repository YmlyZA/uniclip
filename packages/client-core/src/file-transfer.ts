import { z } from "zod";
import { ulid } from "ulid";
import {
  type ClientFrame,
  type ServerFrame,
  ACK_INTERVAL,
  CHUNK_BYTES,
  INLINE_IMAGE_MAX,
  MAX_FILE_BYTES,
  CREDIT_WINDOW,
  STALL_TIMEOUT_MS,
} from "@uniclip/protocol";
import { encrypt, decrypt, encryptBytes, decryptBytes, sha256Hex, toBase64, fromBase64 } from "@uniclip/crypto";

// The file-offer metadata is now encrypted on the wire (only {iv,ciphertext}
// reaches the relay), so the wire schema no longer validates these fields.
// Re-validate the DECRYPTED metadata here with the same constraints the old
// plaintext FileOfferSchema enforced — a room member could otherwise send
// malformed but correctly-encrypted metadata. Drop on any failure.
const OfferMetaSchema = z
  .object({
    name: z.string().max(255),
    mime: z.string().max(255),
    size: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive(),
    hash: z.string().regex(/^[0-9a-f]{64}$/), // match protocol's Sha256Hex
    inline: z.boolean(),
  })
  .strict();

export type FileClientEvent =
  | { kind: "file-offer"; fileId: string; name: string; mime: string; size: number; chunkCount: number; hash: string; inline: boolean }
  | { kind: "file-progress"; fileId: string; dir: "send" | "recv"; sent: number; total: number }
  | { kind: "file-received"; fileId: string; blob: Blob; name: string; mime: string }
  | { kind: "file-error"; fileId: string; code: string; message: string }
  | { kind: "file-cancel"; fileId: string; reason: string };

export interface FileTransferDeps {
  routingId: string;
  getKey: () => CryptoKey | null;
  /** Send a frame; returns false if the socket is not open. */
  send: (frame: ClientFrame) => boolean;
  emit: (evt: FileClientEvent) => void;
}

interface Incoming {
  offer: { fileId: string; name: string; mime: string; size: number; chunkCount: number; hash: string; inline: boolean };
  accepted: boolean;
  buf: (Uint8Array | undefined)[];
  received: number;
  upTo: number; // highest contiguous index received (-1 = none)
}

interface Outgoing {
  fileId: string;
  bytes: Uint8Array;
  name: string;
  mime: string;
  chunkCount: number;
  nextChunk: number;
  ackedUpTo: number;
  started: boolean;
  pumping: boolean;
  stall: ReturnType<typeof setTimeout> | null;
}

export class FileTransferManager {
  private readonly incoming = new Map<string, Incoming>();
  private readonly outgoing = new Map<string, Outgoing>();

  constructor(private readonly deps: FileTransferDeps) {}

  acceptFile(fileId: string): void {
    const t = this.incoming.get(fileId);
    if (!t || t.accepted) return;
    t.accepted = true;
    this.deps.send({ type: "file-accept", fileId });
  }

  declineFile(fileId: string): void {
    if (!this.incoming.delete(fileId)) return;
    this.deps.send({ type: "file-decline", fileId });
  }

  async handle(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case "file-offer": return this.onOffer(frame);
      case "file-chunk": return this.onChunk(frame);
      case "file-complete": return this.onComplete(frame.fileId);
      case "file-cancel": return this.onCancel(frame.fileId, frame.reason);
      case "file-accept": return this.onAccept(frame.fileId);
      case "file-ack": return this.onAck(frame.fileId, frame.upTo);
      case "file-decline": return; // another peer declined; best-effort, ignore
      default: return;
    }
  }

  abortAll(reason: string): void {
    for (const [fileId] of this.incoming) this.fail(fileId, "DISCONNECTED", reason);
    for (const [fileId] of this.outgoing) this.fail(fileId, "DISCONNECTED", reason);
  }

  private async onOffer(f: Extract<ServerFrame, { type: "file-offer" }>): Promise<void> {
    if (this.incoming.has(f.fileId)) return;
    const key = this.deps.getKey();
    if (!key) return;
    let json: string;
    try {
      json = await decrypt({
        key,
        iv: fromBase64(f.iv),
        ciphertext: fromBase64(f.ciphertext),
        aad: `file-offer:${this.deps.routingId}:${f.fileId}`,
      });
    } catch {
      return; // wrong key / tampered → drop
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    const res = OfferMetaSchema.safeParse(parsed);
    if (!res.success) return; // malformed-but-authenticated metadata → drop
    const meta = res.data;
    const offer = { fileId: f.fileId, name: meta.name, mime: meta.mime, size: meta.size, chunkCount: meta.chunkCount, hash: meta.hash, inline: meta.inline };
    this.incoming.set(f.fileId, { offer, accepted: false, buf: new Array(meta.chunkCount), received: 0, upTo: -1 });
    this.deps.emit({ kind: "file-offer", ...offer });
    if (meta.inline) this.acceptFile(f.fileId);
  }

  private async onChunk(f: Extract<ServerFrame, { type: "file-chunk" }>): Promise<void> {
    const t = this.incoming.get(f.fileId);
    if (!t || !t.accepted) return;
    const key = this.deps.getKey();
    if (!key) return;
    const i = f.index;
    if (i < 0 || i >= t.offer.chunkCount || t.buf[i]) return;
    try {
      const expectFinal = i === t.offer.chunkCount - 1;
      t.buf[i] = await decryptBytes({
        key,
        iv: fromBase64(f.iv),
        ciphertext: fromBase64(f.ciphertext),
        aad: `${this.deps.routingId}:${f.fileId}:${i}:${expectFinal}`,
      });
      t.received++;
    } catch {
      this.fail(f.fileId, "AUTH_FAILED", "chunk failed to decrypt");
      this.deps.send({ type: "file-cancel", fileId: f.fileId, reason: "auth_failed" });
      return;
    }
    while (t.buf[t.upTo + 1]) t.upTo++;
    if (t.received % ACK_INTERVAL === 0 || t.received === t.offer.chunkCount) {
      this.deps.send({ type: "file-ack", fileId: f.fileId, upTo: t.upTo });
    }
    this.deps.emit({ kind: "file-progress", fileId: f.fileId, dir: "recv", sent: t.received, total: t.offer.chunkCount });
    if (t.received === t.offer.chunkCount) await this.assemble(f.fileId);
  }

  private async assemble(fileId: string): Promise<void> {
    const t = this.incoming.get(fileId);
    if (!t) return;
    const total = t.buf.reduce((n, c) => n + (c?.length ?? 0), 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of t.buf) { if (c) { out.set(c, off); off += c.length; } }
    if ((await sha256Hex(out as Uint8Array<ArrayBuffer>)) !== t.offer.hash) {
      this.fail(fileId, "HASH_MISMATCH", "reassembled file failed its hash");
      return;
    }
    const blob = new Blob([out], { type: t.offer.mime });
    this.incoming.delete(fileId);
    this.deps.emit({ kind: "file-received", fileId, blob, name: t.offer.name, mime: t.offer.mime });
  }

  private onComplete(fileId: string): void {
    void fileId; // receiver completes from the final chunk; safety net only
  }

  private onCancel(fileId: string, reason: string): void {
    const t = this.outgoing.get(fileId);
    if (t?.stall) clearTimeout(t.stall);
    const had = this.incoming.delete(fileId) || this.outgoing.delete(fileId);
    if (had) this.deps.emit({ kind: "file-cancel", fileId, reason });
  }

  private fail(fileId: string, code: string, message: string): void {
    const t = this.outgoing.get(fileId);
    if (t?.stall) clearTimeout(t.stall);
    this.incoming.delete(fileId);
    this.outgoing.delete(fileId);
    this.deps.emit({ kind: "file-error", fileId, code, message });
  }

  // ── Sender API ───────────────────────────────────────────────────────────
  async sendFile(file: { name: string; mime: string; bytes: Uint8Array }): Promise<{ fileId: string; chunkCount: number } | null> {
    if (file.bytes.length > MAX_FILE_BYTES) {
      this.deps.emit({ kind: "file-error", fileId: "", code: "TOO_LARGE", message: "file exceeds the size limit" });
      return null;
    }
    const key = this.deps.getKey();
    if (!key) {
      this.deps.emit({ kind: "file-error", fileId: "", code: "NO_KEY", message: "no room key" });
      return null;
    }
    const fileId = ulid();
    const chunkCount = Math.max(1, Math.ceil(file.bytes.length / CHUNK_BYTES));
    const hash = await sha256Hex(file.bytes as Uint8Array<ArrayBuffer>);
    const inline = file.mime.startsWith("image/") && file.bytes.length <= INLINE_IMAGE_MAX;
    this.outgoing.set(fileId, {
      fileId, bytes: file.bytes, name: file.name, mime: file.mime,
      chunkCount, nextChunk: 0, ackedUpTo: -1, started: false, pumping: false, stall: null,
    });
    const env = await encrypt({
      key,
      plaintext: JSON.stringify({ name: file.name, mime: file.mime, size: file.bytes.length, chunkCount, hash, inline }),
      aad: `file-offer:${this.deps.routingId}:${fileId}`,
    });
    const ok = this.deps.send({ type: "file-offer", fileId, iv: toBase64(env.iv), ciphertext: toBase64(env.ciphertext) });
    if (!ok) { this.fail(fileId, "DISCONNECTED", "not connected"); return null; }
    // The stall timer is NOT armed here: an offer can sit waiting to be accepted
    // (a non-inline file, or a peer that's slow to tap Accept) without that being
    // a "stall". The clock starts once streaming begins, in onAccept.
    return { fileId, chunkCount };
  }

  cancelFile(fileId: string): void {
    const t = this.outgoing.get(fileId);
    if (!t) return;
    if (t.stall) clearTimeout(t.stall);
    this.outgoing.delete(fileId);
    this.deps.send({ type: "file-cancel", fileId, reason: "sender_cancelled" });
    this.deps.emit({ kind: "file-cancel", fileId, reason: "sender_cancelled" });
  }

  private onAccept(fileId: string): Promise<void> {
    const t = this.outgoing.get(fileId);
    if (!t || t.started) return Promise.resolve(); // start on the FIRST accept
    t.started = true;
    this.armStall(fileId); // the stall clock starts when streaming begins
    return this.pump(fileId);
  }

  private onAck(fileId: string, upTo: number): Promise<void> {
    const t = this.outgoing.get(fileId);
    if (!t) return Promise.resolve();
    if (upTo > t.ackedUpTo) t.ackedUpTo = upTo; // pace to the fastest acker
    this.armStall(fileId); // progress resets the stall clock
    return this.pump(fileId);
  }

  private armStall(fileId: string): void {
    const t = this.outgoing.get(fileId);
    if (!t) return;
    if (t.stall) clearTimeout(t.stall);
    t.stall = setTimeout(() => {
      this.deps.send({ type: "file-cancel", fileId, reason: "stalled" });
      this.fail(fileId, "STALLED", "no acknowledgement within the stall timeout");
    }, STALL_TIMEOUT_MS);
  }

  private async pump(fileId: string): Promise<void> {
    const t = this.outgoing.get(fileId);
    if (!t || t.pumping || !t.started) return;
    const key = this.deps.getKey();
    if (!key) return;
    t.pumping = true;
    try {
      while (t.nextChunk < t.chunkCount && t.nextChunk - t.ackedUpTo - 1 < CREDIT_WINDOW) {
        const i = t.nextChunk;
        const isFinal = i === t.chunkCount - 1;
        const env = await encryptBytes({
          key,
          data: t.bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) as Uint8Array<ArrayBuffer>,
          aad: `${this.deps.routingId}:${fileId}:${i}:${isFinal}`,
        });
        if (!this.outgoing.has(fileId)) return; // cancelled/failed during the await
        const ok = this.deps.send({
          type: "file-chunk", fileId, index: i, isFinal,
          iv: toBase64(env.iv), ciphertext: toBase64(env.ciphertext),
        });
        if (!ok) { this.fail(fileId, "DISCONNECTED", "not connected"); return; }
        t.nextChunk++;
        this.deps.emit({ kind: "file-progress", fileId, dir: "send", sent: t.nextChunk, total: t.chunkCount });
      }
    } finally {
      t.pumping = false;
    }
    if (t.nextChunk >= t.chunkCount && t.ackedUpTo >= t.chunkCount - 1) {
      this.deps.send({ type: "file-complete", fileId });
      if (t.stall) clearTimeout(t.stall);
      this.outgoing.delete(fileId);
    }
  }
}
