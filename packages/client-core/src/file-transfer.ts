import { type ClientFrame, type ServerFrame, ACK_INTERVAL } from "@uniclip/protocol";
import { decryptBytes, sha256Hex, fromBase64 } from "@uniclip/crypto";

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
      // file-accept / file-ack are sender-side (added in Task 5).
      default: return;
    }
  }

  abortAll(reason: string): void {
    for (const [fileId] of this.incoming) this.fail(fileId, "DISCONNECTED", reason);
    for (const [fileId] of this.outgoing) this.fail(fileId, "DISCONNECTED", reason);
  }

  private onOffer(f: Extract<ServerFrame, { type: "file-offer" }>): void {
    if (this.incoming.has(f.fileId)) return;
    const offer = { fileId: f.fileId, name: f.name, mime: f.mime, size: f.size, chunkCount: f.chunkCount, hash: f.hash, inline: f.inline };
    this.incoming.set(f.fileId, { offer, accepted: false, buf: new Array(f.chunkCount), received: 0, upTo: -1 });
    this.deps.emit({ kind: "file-offer", ...offer });
    if (f.inline) this.acceptFile(f.fileId);
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
}
