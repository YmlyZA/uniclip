export interface TransferItem {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  dir: "send" | "recv";
  state: "offering" | "transferring" | "done" | "error" | "cancelled";
  sent: number; // chunks sent/received so far
  total: number; // chunkCount
  blob?: Blob; // set on file-received
  errorMsg?: string;
  ts: number; // for timeline sorting
  mine: boolean; // true for dir === "send"
}

const CAP = 50;
const cap = (l: TransferItem[]): TransferItem[] => (l.length > CAP ? l.slice(l.length - CAP) : l);
const patch = (l: TransferItem[], fileId: string, p: Partial<TransferItem>): TransferItem[] =>
  l.map((t) => (t.fileId === fileId ? { ...t, ...p } : t));

export function addOutgoing(
  l: TransferItem[],
  f: { fileId: string; name: string; mime: string; size: number; total: number },
  now: number,
): TransferItem[] {
  return cap([...l, { ...f, dir: "send", state: "transferring", sent: 0, ts: now, mine: true }]);
}

export function applyOffer(
  l: TransferItem[],
  o: { fileId: string; name: string; mime: string; size: number; chunkCount: number; inline: boolean },
  now: number,
): TransferItem[] {
  if (l.some((t) => t.fileId === o.fileId)) return l;
  return cap([
    ...l,
    {
      fileId: o.fileId, name: o.name, mime: o.mime, size: o.size,
      dir: "recv", state: o.inline ? "transferring" : "offering",
      sent: 0, total: o.chunkCount, ts: now, mine: false,
    },
  ]);
}

export function applyProgress(
  l: TransferItem[],
  p: { fileId: string; dir: "send" | "recv"; sent: number; total: number },
): TransferItem[] {
  return l.map((t) => {
    if (t.fileId !== p.fileId) return t;
    const done = p.dir === "send" && p.sent >= p.total;
    return { ...t, sent: p.sent, total: p.total, state: done ? "done" : t.state };
  });
}

export function applyReceived(l: TransferItem[], r: { fileId: string; blob: Blob }): TransferItem[] {
  return patch(l, r.fileId, { state: "done", blob: r.blob });
}

export function applyError(l: TransferItem[], e: { fileId: string; message: string }): TransferItem[] {
  if (!e.fileId) return l; // pre-flight error (TOO_LARGE/NO_KEY) — no item exists yet
  return patch(l, e.fileId, { state: "error", errorMsg: e.message });
}

export function applyCancel(l: TransferItem[], c: { fileId: string }): TransferItem[] {
  return patch(l, c.fileId, { state: "cancelled" });
}

export function markTransferring(l: TransferItem[], fileId: string): TransferItem[] {
  return patch(l, fileId, { state: "transferring" });
}

export function removeTransfer(l: TransferItem[], fileId: string): TransferItem[] {
  return l.filter((t) => t.fileId !== fileId);
}
