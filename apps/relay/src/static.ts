import { resolve, normalize } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export function staticHandler(root: string) {
  const rootResolved = resolve(root);
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) {
      return null;
    }
    const safePath = normalize(url.pathname).replace(/^\/+/, "");
    const candidates = [
      resolve(rootResolved, safePath),
      resolve(rootResolved, "index.html"),
    ];
    for (const candidate of candidates) {
      if (!candidate.startsWith(rootResolved)) continue; // path traversal guard
      const file = Bun.file(candidate);
      if (await file.exists()) {
        const ext = candidate.slice(candidate.lastIndexOf("."));
        return new Response(file, {
          headers: { "content-type": TYPES[ext] ?? "application/octet-stream" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  };
}
