export type TransferRow = { fileId: string; dir: "send" | "recv"; name: string; sent: number; total: number };

// Add a row, or replace the existing one with the same fileId. Pure (returns a
// new array) so it slots into React state.
export function upsertTransfer(rows: TransferRow[], row: TransferRow): TransferRow[] {
  const i = rows.findIndex((r) => r.fileId === row.fileId);
  if (i < 0) return [...rows, row];
  const next = rows.slice();
  next[i] = row;
  return next;
}

export function removeTransfer(rows: TransferRow[], fileId: string): TransferRow[] {
  return rows.filter((r) => r.fileId !== fileId);
}
