# CLI File Transfer (Arc B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface `client-core`'s existing file transfer in the Ink CLI — send a file via a path prompt, accept/decline incoming offers, show progress, and save received files safely to the cwd.

**Architecture:** Additive in `apps/cli`. `UniclipClient` already exposes `sendFile`/`acceptFile`/`declineFile`/`cancelFile` + `file-*` events (the chunking, AES-GCM, flow control, hashing all live in `client-core`'s `FileTransferManager`, unchanged). The CLI adds Node-fs glue (read/sanitize/save), a transfers UI, and the two prompts. One limiter tweak in the CLI's own `lan-relay.ts` keeps the Arc A hardening from throttling files on a relay fallback.

**Tech Stack:** TypeScript, Node ≥ 22 (`node:fs/promises`, `node:path`, `node:os`, global `Blob`/`Buffer`), Ink/React, `ink-text-input`, vitest (plain Node).

## Global Constraints

- **No change to `client-core`, `protocol`, or `crypto`.** All new code is in `apps/cli/src/` (plus the CLI-owned `lan-relay.ts`). Reuse the engine via `UniclipClient`.
- **The peer-offered filename is untrusted** — it must be sanitized to a bare basename before any disk write (path-traversal sink). Received files write ONLY into `process.cwd()`.
- **Consent gate:** no disk write for a non-inline file until the user accepts. Inline images (`image/*` ≤ `INLINE_IMAGE_MAX` = 2 MB) are auto-accepted by the engine and saved the same way.
- **Size cap is the engine's** (`MAX_FILE_BYTES` = 100 MB); the CLI adds none.
- Repo uses `exactOptionalPropertyTypes: true`; `pnpm typecheck` must pass. CLI tests run under plain Node vitest, colocated as `*.test.ts(x)` in `apps/cli/src/`.
- **`UniclipClient` file API (consume exactly):** `sendFile({ name: string; mime: string; bytes: Uint8Array }): Promise<{ fileId: string; chunkCount: number } | null>`; `acceptFile(id)`, `declineFile(id)`, `cancelFile(id)`. Events: `file-offer {fileId,name,mime,size,chunkCount,hash,inline}`, `file-progress {fileId,dir:"send"|"recv",sent,total}`, `file-received {fileId,blob:Blob,name,mime}`, `file-error {fileId,code,message}`, `file-cancel {fileId,reason}`.

---

### Task 1: `file-io.ts` + `mime.ts` — read / sanitize / save (the security unit)

**Files:**
- Create: `apps/cli/src/mime.ts`, `apps/cli/src/mime.test.ts`
- Create: `apps/cli/src/file-io.ts`, `apps/cli/src/file-io.test.ts`

**Interfaces:**
- Produces: `mimeForName(name): string`; `readForSend(path): Promise<{name,mime,bytes:Uint8Array}>`; `safeFilename(name): string`; `uniquePath(dir,name): string`; `saveBlob(dir,name,blob): Promise<string>`.

- [ ] **Step 1: Write the failing `mime` test**

Create `apps/cli/src/mime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mimeForName } from "./mime";

describe("mimeForName", () => {
  it("maps known extensions (case-insensitive)", () => {
    expect(mimeForName("a.png")).toBe("image/png");
    expect(mimeForName("a.JPG")).toBe("image/jpeg");
    expect(mimeForName("notes.txt")).toBe("text/plain");
    expect(mimeForName("doc.pdf")).toBe("application/pdf");
  });
  it("defaults unknown / extensionless to octet-stream", () => {
    expect(mimeForName("blob")).toBe("application/octet-stream");
    expect(mimeForName("a.zzz")).toBe("application/octet-stream");
  });
});
```

- [ ] **Step 2: Implement `mime.ts`**

```ts
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
```

- [ ] **Step 3: Run mime test → PASS.** `cd apps/cli && pnpm exec vitest run src/mime.test.ts`

- [ ] **Step 4: Write the failing `file-io` test**

Create `apps/cli/src/file-io.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readForSend, safeFilename, uniquePath, saveBlob } from "./file-io";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "uniclip-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("safeFilename", () => {
  it("reduces traversal / absolute / separator names to a bare basename", () => {
    expect(safeFilename("../../.ssh/authorized_keys")).toBe("authorized_keys");
    expect(safeFilename("/etc/passwd")).toBe("passwd");
    expect(safeFilename("a\\b\\evil.txt")).toBe("evil.txt");
    expect(safeFilename("plain.png")).toBe("plain.png");
  });
  it("falls back to 'file' for empty / dot-only names", () => {
    expect(safeFilename("..")).toBe("file");
    expect(safeFilename("/")).toBe("file");
    expect(safeFilename("")).toBe("file");
  });
});

describe("uniquePath", () => {
  it("suffixes a colliding name before the extension", () => {
    const d = tmp();
    expect(uniquePath(d, "a.txt")).toBe(join(d, "a.txt"));
    writeFileSync(join(d, "a.txt"), "x");
    expect(uniquePath(d, "a.txt")).toBe(join(d, "a (1).txt"));
    writeFileSync(join(d, "a (1).txt"), "x");
    expect(uniquePath(d, "a.txt")).toBe(join(d, "a (2).txt"));
  });
});

describe("readForSend", () => {
  it("reads a file into name + mime + bytes", async () => {
    const d = tmp();
    writeFileSync(join(d, "hello.txt"), "hi there");
    const f = await readForSend(join(d, "hello.txt"));
    expect(f.name).toBe("hello.txt");
    expect(f.mime).toBe("text/plain");
    expect(Buffer.from(f.bytes).toString("utf8")).toBe("hi there");
  });
  it("rejects a missing file", async () => {
    await expect(readForSend(join(tmp(), "nope.txt"))).rejects.toBeTruthy();
  });
});

describe("saveBlob", () => {
  it("writes a Blob under a sanitized, collision-safe name and returns the path", async () => {
    const d = tmp();
    const p1 = await saveBlob(d, "../evil.bin", new Blob([new Uint8Array([1, 2, 3])]));
    expect(p1).toBe(join(d, "evil.bin"));
    expect([...readFileSync(p1)]).toEqual([1, 2, 3]);
    const p2 = await saveBlob(d, "evil.bin", new Blob([new Uint8Array([9])]));
    expect(p2).toBe(join(d, "evil (1).bin")); // collision-suffixed
    expect(existsSync(p2)).toBe(true);
  });
});
```

- [ ] **Step 5: Run to verify it fails.** `cd apps/cli && pnpm exec vitest run src/file-io.test.ts` → FAIL (module missing).

- [ ] **Step 6: Implement `file-io.ts`**

```ts
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
// component for either separator, strip control chars, reject dot-only/empty.
// Guarantees no directory traversal can escape the save dir.
export function safeFilename(name: string): string {
  const tail = (name.split(/[/\\]/).pop() ?? "").replace(/[\x00-\x1f]/g, "").trim();
  if (!tail || /^\.+$/.test(tail)) return "file";
  return tail;
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
```

- [ ] **Step 7: Run file-io test → PASS; typecheck.** `cd apps/cli && pnpm exec vitest run src/file-io.test.ts && pnpm typecheck`

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/mime.ts apps/cli/src/mime.test.ts apps/cli/src/file-io.ts apps/cli/src/file-io.test.ts
git commit -m "feat(cli): file-io read/sanitize/save + mime map (Arc B task 1)"
```

---

### Task 2: `lan-relay.ts` — per-category frame budget (file-* headroom)

The Arc A hardening capped every socket at one budget (500/10 s). File chunks normally ride P2P, but on a relay fallback a large transfer would exceed that and stall. Split the budget: a **raw inbound ceiling** (`fileLimit`, default 2000/10 s — also what `file-*` is effectively allowed) plus a **stricter non-file cap** (`frameLimit`, default 500/10 s) for clips/signaling. This preserves the junk-flood and amplification backstops while letting files survive a fallback.

**Files:**
- Modify: `apps/cli/src/lan-relay.ts`
- Modify: `apps/cli/src/lan-relay.test.ts`

- [ ] **Step 1: Write the failing test** — add to `apps/cli/src/lan-relay.test.ts`:

```ts
it("gives file-* frames a higher budget than clip/other frames", async () => {
  relay = await startLanRelay({ routingId: RID, host: "127.0.0.1", frameLimit: 3, fileLimit: 6, frameWindowMs: 10_000 });
  const a = client(relay.port); await a.ready;
  const b = client(relay.port); await b.ready;
  await a.waitFor(() => a.frames.some((f) => f.type === "peer-joined"));
  // 8 clips → capped at the lower budget (3)
  for (let i = 0; i < 8; i++) a.send({ type: "clip", msgId: ulid(i), iv: "i", ciphertext: "c", ts: i });
  // 8 file-acks → allowed up to the higher budget (6)
  for (let i = 0; i < 8; i++) a.send({ type: "file-ack", fileId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", upTo: i });
  await b.waitFor(() => b.frames.filter((f) => f.type === "file-ack").length >= 6);
  await new Promise((r) => setTimeout(r, 300));
  expect(b.frames.filter((f) => f.type === "clip").length).toBe(3);
  expect(b.frames.filter((f) => f.type === "file-ack").length).toBe(6);
  a.ws.close(); b.ws.close();
});
```

> Note: `file-ack {type,fileId,upTo}` is a minimal valid `ClientFrameSchema` file-* frame. If it does not validate, substitute the smallest file-* frame that does (the test asserts counts, not frame semantics).

- [ ] **Step 2: Run to verify it fails.** `cd apps/cli && pnpm exec vitest run src/lan-relay.test.ts` → the new test FAILS (file-acks capped at 3, not 6), and the options type rejects `fileLimit`.

- [ ] **Step 3: Implement the split** in `apps/cli/src/lan-relay.ts`. Replace the limiter constants + the single `admit` + the message handler's admit call:

Change the comment block + constants:

```ts
const DEFAULT_MAX_PEERS = 8;
const DEFAULT_FRAME_LIMIT = 500;   // non-file frames (clips/signaling/presence) per window, per socket
const DEFAULT_FILE_LIMIT = 2000;   // raw-inbound ceiling; file-* ride this higher budget (mirrors the public relay's chunkLimiter)
const DEFAULT_FRAME_WINDOW_MS = 10_000;
```

Add `fileLimit` to the options and read it:

```ts
export function startLanRelay(opts: {
  routingId: string;
  host?: string;
  maxPeers?: number;
  frameLimit?: number;
  fileLimit?: number;
  frameWindowMs?: number;
}): Promise<LanRelay> {
  const maxPeers = opts.maxPeers ?? DEFAULT_MAX_PEERS;
  const frameLimit = opts.frameLimit ?? DEFAULT_FRAME_LIMIT;
  const fileLimit = opts.fileLimit ?? DEFAULT_FILE_LIMIT;
  const frameWindowMs = opts.frameWindowMs ?? DEFAULT_FRAME_WINDOW_MS;
  const wss = new WebSocketServer({ port: 0, host: opts.host ?? "0.0.0.0" });
  const sockets = new Set<WebSocket>();
  const rawHits = new WeakMap<WebSocket, number[]>();  // ALL inbound (junk + files) — ceiling
  const typeHits = new WeakMap<WebSocket, number[]>(); // non-file valid frames — stricter cap
```

Replace the `admit` helper with a generic one + update the message handler:

```ts
  // Generic per-socket sliding window against `map` with `limit`.
  const admit = (map: WeakMap<WebSocket, number[]>, ws: WebSocket, limit: number): boolean => {
    const now = Date.now();
    const arr = map.get(ws) ?? [];
    const cutoff = now - frameWindowMs;
    while (arr.length && arr[0]! < cutoff) arr.shift();
    if (arr.length >= limit) { map.set(ws, arr); return false; }
    arr.push(now);
    map.set(ws, arr);
    return true;
  };
```

Message handler:

```ts
    ws.on("message", (data) => {
      const str = data.toString("utf8");
      if (Buffer.byteLength(str, "utf8") > MAX_FRAME_BYTES) return;
      // Raw-inbound ceiling: bounds total work incl. junk floods; file-* never exceed this.
      if (!admit(rawHits, ws, fileLimit)) return;
      let parsed: unknown;
      try { parsed = JSON.parse(str); } catch { return; }
      const result = ClientFrameSchema.safeParse(parsed);
      if (!result.success) return;
      // Non-file frames (clips/signaling/presence/delete) get the stricter cap.
      const isFile = result.data.type.startsWith("file-");
      if (!isFile && !admit(typeHits, ws, frameLimit)) return;
      broadcast(ws, str);
    });
```

Update the top comment block to reflect the two-tier scheme (raw ceiling + stricter non-file cap; `file-*` ride the ceiling).

- [ ] **Step 4: Run to verify it passes** (incl. the existing rate-limit test). `cd apps/cli && pnpm exec vitest run src/lan-relay.test.ts` → all PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lan-relay.ts apps/cli/src/lan-relay.test.ts
git commit -m "harden(cli): per-category LAN relay budget — file-* headroom (Arc B task 2)"
```

---

### Task 3: `file-transfers.ts` + `components/Transfers.tsx` — progress state + render

**Files:**
- Create: `apps/cli/src/file-transfers.ts`, `apps/cli/src/file-transfers.test.ts`
- Create: `apps/cli/src/components/Transfers.tsx`
- Modify: `apps/cli/src/components/components.test.tsx` (add a Transfers render test)

**Interfaces:**
- Produces: `type TransferRow = { fileId: string; dir: "send" | "recv"; name: string; sent: number; total: number }`; `upsertTransfer(rows, row): TransferRow[]` (add or update by fileId); `removeTransfer(rows, fileId): TransferRow[]`; `<Transfers rows={TransferRow[]} />`.

- [ ] **Step 1: Write the failing `file-transfers` test**

Create `apps/cli/src/file-transfers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { upsertTransfer, removeTransfer, type TransferRow } from "./file-transfers";

describe("file-transfers state", () => {
  it("adds then updates a row by fileId (no duplicates)", () => {
    let rows: TransferRow[] = [];
    rows = upsertTransfer(rows, { fileId: "f1", dir: "send", name: "a.png", sent: 1, total: 10 });
    rows = upsertTransfer(rows, { fileId: "f1", dir: "send", name: "a.png", sent: 5, total: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sent).toBe(5);
  });
  it("removes a row by fileId", () => {
    let rows: TransferRow[] = [{ fileId: "f1", dir: "recv", name: "a", sent: 2, total: 4 }];
    rows = removeTransfer(rows, "f1");
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd apps/cli && pnpm exec vitest run src/file-transfers.test.ts`

- [ ] **Step 3: Implement `file-transfers.ts`**

```ts
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
```

- [ ] **Step 4: Implement `components/Transfers.tsx`**

```tsx
import { Box, Text } from "ink";
import type { TransferRow } from "../file-transfers";

const pct = (sent: number, total: number) => (total > 0 ? Math.floor((sent / total) * 100) : 0);

export function Transfers({ rows }: { rows: TransferRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      {rows.map((r) => (
        <Text key={r.fileId} dimColor>
          {r.dir === "send" ? "↑" : "↓"} {r.name} {pct(r.sent, r.total)}%
        </Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 5: Add a Transfers render test** to `apps/cli/src/components/components.test.tsx`:

```tsx
import { Transfers } from "./Transfers";

it("Transfers renders a row per active transfer with direction + percent", () => {
  const { lastFrame } = render(
    <Transfers rows={[{ fileId: "f1", dir: "send", name: "photo.png", sent: 5, total: 10 }]} />,
  );
  const f = lastFrame()!;
  expect(f).toContain("photo.png");
  expect(f).toContain("50%");
  expect(f).toMatch(/[↑]/);
});
```

- [ ] **Step 6: Run both → PASS; typecheck.** `cd apps/cli && pnpm exec vitest run src/file-transfers.test.ts src/components/components.test.tsx && pnpm typecheck`

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/file-transfers.ts apps/cli/src/file-transfers.test.ts apps/cli/src/components/Transfers.tsx apps/cli/src/components/components.test.tsx
git commit -m "feat(cli): file-transfers state + Transfers progress component (Arc B task 3)"
```

---

### Task 4: `app.tsx` — send prompt, offer prompt, save-on-received

Wire it together. The App gains: a `file-prompt` mode (path input via `ink-text-input`), an incoming-offer prompt (accept/decline), the transfers list, and saving on `file-received`.

**Files:**
- Modify: `apps/cli/src/app.tsx`
- Modify: `apps/cli/src/app.test.tsx`

**Interfaces:**
- Consumes: `readForSend`/`saveBlob` (T1), `upsertTransfer`/`removeTransfer`/`TransferRow` (T3), `<Transfers>` (T3), the client `file-*` events + `sendFile`/`acceptFile`/`declineFile` (Global Constraints).
- The `ClientLike` type extends with `sendFile`/`acceptFile`/`declineFile`.

- [ ] **Step 1: Write the failing `app` tests** — add to `apps/cli/src/app.test.tsx`. Extend `fakeClient` with the file methods, and import temp-dir helpers:

```tsx
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// extend fakeClient() with:  sendFile: vi.fn(async () => ({ fileId: "f1", chunkCount: 1 })),
//                            acceptFile: vi.fn(), declineFile: vi.fn(),

it("opens the send-file prompt on 'f' and calls sendFile with the typed path's bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniclip-app-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "x.txt"), "hello");
  const client = fakeClient();
  const { stdin, lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
  await tick();
  stdin.write("\x1B");                 // Esc → navigate mode
  await tick();
  stdin.write("f");                    // open the send-file prompt
  await tick();
  await vi.waitFor(() => expect(lastFrame()).toContain("Send file"));
  for (const ch of join(dir, "x.txt")) stdin.write(ch); // type the path
  await tick();
  stdin.write("\r");                   // submit
  await vi.waitFor(() => expect(client.sendFile).toHaveBeenCalled());
  const arg = client.sendFile.mock.calls[0][0];
  expect(arg.name).toBe("x.txt");
  expect(Buffer.from(arg.bytes).toString("utf8")).toBe("hello");
  rmSync(dir, { recursive: true, force: true });
});

it("shows an accept/decline prompt for a non-inline offer and accepts on 'a'", async () => {
  const client = fakeClient();
  const { stdin, lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
  await tick();
  client.emit("file-offer", { fileId: "f1", name: "doc.pdf", mime: "application/pdf", size: 2048, chunkCount: 1, hash: "h", inline: false });
  await vi.waitFor(() => expect(lastFrame()).toContain("doc.pdf"));
  expect(lastFrame()).toMatch(/accept/i);
  stdin.write("a");
  await vi.waitFor(() => expect(client.acceptFile).toHaveBeenCalledWith("f1"));
});

it("saves a received file into the cwd (sanitized) on file-received", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniclip-recv-"));
  const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
  const client = fakeClient();
  render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
  await tick();
  client.emit("file-received", { fileId: "f1", blob: new Blob([new Uint8Array([1, 2, 3])]), name: "../escape.bin", mime: "application/octet-stream" });
  await vi.waitFor(() => expect(readdirSync(dir)).toContain("escape.bin")); // traversal stripped
  spy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify they fail.** `cd apps/cli && pnpm exec vitest run src/app.test.tsx`

- [ ] **Step 3: Implement the wiring in `app.tsx`.** Apply these changes:

(a) Imports + `ClientLike`:

```tsx
import TextInput from "ink-text-input";
import { Transfers } from "./components/Transfers";
import { upsertTransfer, removeTransfer, type TransferRow } from "./file-transfers";
import { readForSend, saveBlob } from "./file-io";
```

Extend `ClientLike`:

```tsx
type ClientLike = {
  on: (k: string, cb: (...a: any[]) => void) => void;
  connect: () => Promise<void> | void;
  send: (t: string) => Promise<unknown> | unknown;
  sendFile: (f: { name: string; mime: string; bytes: Uint8Array }) => Promise<unknown>;
  acceptFile: (id: string) => void;
  declineFile: (id: string) => void;
  disconnect: () => void;
};
```

(b) New state:

```tsx
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [offer, setOffer] = useState<{ fileId: string; name: string; size: number } | null>(null);
  const [filePrompt, setFilePrompt] = useState(false);
  const [filePath, setFilePath] = useState("");
```

(c) In the mount `useEffect`, subscribe to the file events (after the existing `error` handler):

```tsx
    client.on("file-offer", (o: { fileId: string; name: string; size: number; inline: boolean }) => {
      if (o.inline) return; // engine auto-accepts inline images; we just save on receipt
      setOffer((cur) => cur ?? { fileId: o.fileId, name: o.name, size: o.size });
    });
    client.on("file-progress", (p: { fileId: string; dir: "send" | "recv"; sent: number; total: number }) =>
      setTransfers((rows) => upsertTransfer(rows, { fileId: p.fileId, dir: p.dir, name: nameFor(p.fileId), sent: p.sent, total: p.total })),
    );
    client.on("file-received", (r: { fileId: string; blob: Blob; name: string }) => {
      void saveBlob(process.cwd(), r.name, r.blob).then(
        (path) => { setTransfers((rows) => removeTransfer(rows, r.fileId)); setNote(`Saved ${path}`); },
        () => setNote("Could not save the received file"),
      );
    });
    client.on("file-error", (e: { fileId: string; message: string }) => {
      setTransfers((rows) => removeTransfer(rows, e.fileId));
      setNote(e.message);
    });
    client.on("file-cancel", (c: { fileId: string }) => setTransfers((rows) => removeTransfer(rows, c.fileId)));
```

Track names for progress rows (offers/sends): keep a ref of fileId→name. Add near the top of the component:

```tsx
  const names = useRef<Record<string, string>>({});
  const nameFor = (id: string) => names.current[id] ?? "file";
```

(import `useRef` from react). Record names in the offer handler (`names.current[o.fileId] = o.name`), the received handler, and after a successful send (below).

(d) `useInput` — handle the offer prompt FIRST (before the compose passthrough), then `f` in navigate mode. Insert at the start of the `useInput` body, after the Ctrl-C check:

```tsx
    if (offer) {
      if (inp === "a") { client.acceptFile(offer.fileId); setOffer(null); }
      else if (inp === "d") { client.declineFile(offer.fileId); setOffer(null); }
      return; // modal: swallow other keys while an offer is pending
    }
    if (filePrompt) return; // the path TextInput owns input; Esc handled by its own onSubmit/escape below
```

In navigate mode, add the `f` binding (e.g. before the `q` handler):

```tsx
    if (inp === "f") { setFilePrompt(true); return; }
```

(e) Send handler:

```tsx
  function submitFile() {
    const path = filePath.trim();
    setFilePrompt(false);
    setFilePath("");
    if (!path) return;
    void readForSend(path).then(
      (file) => { void client.sendFile(file); names.current[file.name] = file.name; setNote(`Sending ${file.name}…`); },
      (e: NodeJS.ErrnoException) => setNote(`Can't read ${path}: ${e.code ?? e.message}`),
    );
  }
```

> Note on the send-progress name: `sendFile` returns a `fileId` the progress events key on, but the path prompt doesn't know it synchronously. Acceptable for v1 — record the name by the path's basename and let the progress row fall back to `nameFor` (which returns "file" if the id isn't mapped). A tighter mapping (await `sendFile`'s `{fileId}` and record `names.current[fileId] = file.name`) is the cleaner version; do that:

```tsx
    void readForSend(path).then(
      async (file) => {
        const res = (await client.sendFile(file)) as { fileId: string } | null;
        if (res) names.current[res.fileId] = file.name;
        setNote(`Sending ${file.name}…`);
      },
      (e: NodeJS.ErrnoException) => setNote(`Can't read ${path}: ${e.code ?? e.message}`),
    );
```

(f) Render — add the offer prompt, the file-path prompt, and `<Transfers>`. Replace the composer/note region:

```tsx
      {offer ? (
        <Box paddingX={1}>
          <Text>Incoming file <Text bold>{offer.name}</Text> ({Math.ceil(offer.size / 1024)} KB) — [a]ccept / [d]ecline</Text>
        </Box>
      ) : filePrompt ? (
        <Box paddingX={1}>
          <Text>Send file: </Text>
          <TextInput value={filePath} onChange={setFilePath} onSubmit={submitFile} />
        </Box>
      ) : (
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={send}
          over={over}
          {...(!composing ? { focus: false } : {})}
        />
      )}
      <Transfers rows={transfers} />
      {note ? (
        <Box paddingX={1}><Text dimColor>{note}</Text></Box>
      ) : null}
      <Footer />
```

Also: when `filePrompt` is active, `Esc` should cancel it. Handle in `useInput` by replacing the `if (filePrompt) return;` line with:

```tsx
    if (filePrompt) {
      if (key.escape) { setFilePrompt(false); setFilePath(""); }
      return; // the TextInput captures the rest
    }
```

- [ ] **Step 4: Run app tests → PASS.** `cd apps/cli && pnpm exec vitest run src/app.test.tsx`

- [ ] **Step 5: Full CLI suite + typecheck.** `cd apps/cli && pnpm exec vitest run && pnpm typecheck` → all green.

- [ ] **Step 6: Update the Footer hint** (`components/Footer.tsx`) to mention `f send file` — keep it short; if the line gets long, abbreviate existing hints. (No test; verified by the suite still passing.)

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/app.tsx apps/cli/src/app.test.tsx apps/cli/src/components/Footer.tsx
git commit -m "feat(cli): file send/receive prompts + progress wired into the TUI (Arc B task 4)"
```

---

### Task 5 (optional): multi-chunk file e2e over the embedded relay + werift

**Files:**
- Create: `apps/cli/src/file-e2e.test.ts`

- [ ] **Step 1: Write the test** — mirror `lan-e2e.test.ts`, but after both peers reach `p2p`, send a multi-chunk file from A and assert B's `file-received` blob bytes match:

```ts
import { expect, it } from "vitest";
import { UniclipClient } from "@uniclip/client-core";
import { generateModeARoom } from "@uniclip/room-code";
import { startLanRelay } from "./lan-relay";
import { weriftPeer } from "./werift-peer";

it("sends a multi-chunk file P2P through the embedded LAN relay", async () => {
  const { routingId, secret } = generateModeARoom();
  const relay = await startLanRelay({ routingId, host: "127.0.0.1" });
  const base = `ws://127.0.0.1:${relay.port}`;
  const roomUrl = `http://127.0.0.1:${relay.port}/r/${routingId}#${secret}`;
  const mk = () => new UniclipClient({ roomUrl, relayBase: base, iceServers: [], createConnection: weriftPeer });
  const a = mk(), b = mk();
  let aP2P = false, bP2P = false;
  const received: { bytes: Uint8Array }[] = [];
  a.on("transport", (t) => { if (t === "p2p") aP2P = true; });
  b.on("transport", (t) => { if (t === "p2p") bP2P = true; });
  b.on("file-offer", (o) => b.acceptFile(o.fileId));
  b.on("file-received", async (r) => received.push({ bytes: new Uint8Array(await r.blob.arrayBuffer()) }));
  try {
    await a.connect(); await b.connect();
    await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error("no p2p")), 18000); const i = setInterval(() => { if (aP2P && bP2P) { clearInterval(i); clearTimeout(t); res(); } }, 50); });
    const bytes = new Uint8Array(80 * 1024).map((_, i) => i % 256); // > CHUNK_BYTES → multiple chunks
    await a.sendFile({ name: "blob.bin", mime: "application/octet-stream", bytes });
    await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error("no file")), 12000); const i = setInterval(() => { if (received.length) { clearInterval(i); clearTimeout(t); res(); } }, 50); });
    expect(received[0]!.bytes.length).toBe(bytes.length);
    expect([...received[0]!.bytes.slice(0, 5)]).toEqual([0, 1, 2, 3, 4]);
  } finally {
    a.disconnect(); b.disconnect(); relay.close();
  }
}, 30000);
```

- [ ] **Step 2: Run → PASS** (`cd apps/cli && pnpm exec vitest run src/file-e2e.test.ts`). If werift file throughput needs longer on CI, the test's own timeouts are generous; do not weaken assertions.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/file-e2e.test.ts
git commit -m "test(cli): multi-chunk file P2P over embedded relay e2e (Arc B task 5)"
```

---

## Final verification (after all tasks)

- [ ] **Build:** `cd apps/cli && pnpm build` → `dist/cli.js` with shebang.
- [ ] **Repo gates:** `pnpm typecheck && pnpm test` → all packages green (CLI suite incl. file-io, mime, file-transfers, the lan-relay split, the app file tests, and the optional e2e).
- [ ] **Update `CLAUDE.md`** — the `apps/cli` bullet says the CLI syncs **text**; update to note it now also does **file transfer** (send via `f`→path prompt; receive with an accept/decline prompt, saving the sanitized basename to cwd; inline images auto-save), reusing `client-core`'s `FileTransferManager` over the werift channel, and that the embedded `lan-relay` gives `file-*` frames a higher rate-limit budget. Commit:

```bash
git add CLAUDE.md
git commit -m "docs: CLI now does file transfer (Arc B)"
```

## Self-Review (completed during planning)

- **Spec coverage:** Goal 1 (send) → T1 `readForSend` + T4 prompt/`sendFile`; Goal 2 (receive accept/decline) → T4 offer prompt; Goal 3 (save safely) → T1 `safeFilename`/`saveBlob` + T4 wiring; Goal 4 (progress) → T3 + T4. §5 security (path-traversal) → T1 tests (`safeFilename`, `saveBlob` "../evil.bin"→"evil.bin") + T4 ("../escape.bin"→"escape.bin"). §6 relay interaction → T2. Decomposition matches spec §8.
- **Placeholder scan:** none. The only "optional" is T5 (e2e), explicitly marked.
- **Type consistency:** `TransferRow`, `upsertTransfer`/`removeTransfer`, `readForSend`/`saveBlob`/`safeFilename`, the extended `ClientLike`, and the `startLanRelay` options (`fileLimit` added) are consistent across T1–T5 and the app wiring. `file-progress.total` is in **chunks** (the engine's unit) — the percent is chunks-based, which is correct and monotonic.
