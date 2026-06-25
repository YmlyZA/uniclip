import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { mimeForName } from "./mime";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Read a local file for sending: { name: basename, mime: guessed, bytes }.
// Throws (ENOENT/EISDIR/permission) — the caller surfaces it as a note.
export async function readForSend(path: string): Promise<{ name: string; mime: string; bytes: Uint8Array }> {
  const buf = await readFile(expandHome(path));
  const name = basename(expandHome(path));
  return { name, mime: mimeForName(name), bytes: new Uint8Array(buf) };
}

// Reduce a PEER-CONTROLLED name to a safe bare filename: take the last
// component for either separator, strip control chars, trim, then strip
// leading dots so a peer-named file can never be hidden (.npmrc -> npmrc).
// Guarantees no directory traversal can escape the save dir, and no hidden
// file can be planted in cwd.
export function safeFilename(name: string): string {
  const tail = (name.split(/[/\\]/).pop() ?? "").replace(/[\x00-\x1f]/g, "").trim().replace(/^\.+/, "");
  return tail || "file";
}

// If `name` exists in `dir`, suffix " (1)", " (2)", … before the extension.
export function uniquePath(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return join(dir, name);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let n = 1;
  while (existsSync(join(dir, `${stem} (${n})${ext}`))) n++;
  return join(dir, `${stem} (${n})${ext}`);
}

// Save a received Blob into `dir` under a sanitized, collision-safe name.
export async function saveBlob(dir: string, name: string, blob: Blob): Promise<string> {
  const target = uniquePath(dir, safeFilename(name));
  await writeFile(target, Buffer.from(await blob.arrayBuffer()));
  return target;
}
