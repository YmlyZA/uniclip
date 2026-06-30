// Pure logic for the debug overlay (tested in node). The .svelte shell renders
// these; keeping logic here matches the codebase's lib-tested pattern.
export interface DiagRow {
  phase: string;
  level: string;
  detail: string;
  t: number; // ms since session start
}

export function pushDiag(buf: DiagRow[], row: DiagRow, cap = 200): DiagRow[] {
  const next = buf.length >= cap ? buf.slice(buf.length - cap + 1) : buf.slice();
  next.push(row);
  return next;
}

export function diagToText(rows: DiagRow[]): string {
  return rows
    .map((r) => `[${(r.t / 1000).toFixed(2)}s] ${r.level === "info" ? "" : r.level.toUpperCase() + " "}${r.phase} ${r.detail}`)
    .join("\n");
}

export function candidateCounts(rows: DiagRow[]): { host: number; srflx: number; relay: number } {
  const c = { host: 0, srflx: 0, relay: 0 };
  for (const r of rows) {
    if (r.phase !== "ice-candidate") continue;
    if (r.detail.startsWith("host")) c.host++;
    else if (r.detail.startsWith("srflx")) c.srflx++;
    else if (r.detail.startsWith("relay")) c.relay++;
  }
  return c;
}

export function debugEnabled(search: string): boolean {
  const q = search.startsWith("?") ? search.slice(1) : search;
  return q.split("&").some((p) => p === "debug" || p.startsWith("debug="));
}
