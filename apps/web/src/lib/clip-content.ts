export type Segment = { type: "text" | "url"; value: string };

// Sentence punctuation commonly stuck to the end of a pasted URL; not part of it.
const TRAILING = /[.,;:!?)\]}'"]+$/;

function splitTrailing(raw: string): { url: string; trailing: string } {
  const m = TRAILING.exec(raw);
  if (!m) return { url: raw, trailing: "" };
  return { url: raw.slice(0, m.index), trailing: raw.slice(m.index) };
}

// Only http(s) is linkified — this excludes javascript:/data:/etc. by construction.
export function clipSegments(text: string): Segment[] {
  const segs: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s]+/g)) {
    const start = m.index ?? 0;
    const { url, trailing } = splitTrailing(m[0]);
    if (start > last) segs.push({ type: "text", value: text.slice(last, start) });
    segs.push({ type: "url", value: url });
    if (trailing) segs.push({ type: "text", value: trailing });
    last = start + m[0].length;
  }
  if (last < text.length) segs.push({ type: "text", value: text.slice(last) });
  if (segs.length === 0) segs.push({ type: "text", value: text });
  return segs;
}

export function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? splitTrailing(m[0]).url : null;
}

export function matchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || text.toLowerCase().includes(q);
}
