// Minimal extension→MIME map: drives the engine's image/* inline detection and
// gives the receiver a content-type hint. No dependency; octet-stream default.
const MAP: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  html: "text/html", css: "text/css", js: "text/javascript",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", mov: "video/quicktime",
};

export function mimeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MAP[ext] ?? "application/octet-stream";
}
