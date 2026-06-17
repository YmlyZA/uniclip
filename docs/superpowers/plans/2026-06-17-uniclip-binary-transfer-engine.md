# Binary Transfer Engine Implementation Plan (Phase 2 v0.2, sub-project 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the encrypted file-transfer **engine** — bytes crypto, six `file-*` wire frames, relay routing/flow-control, and a `client-core` `FileTransferManager` (sender + receiver) — with **no UI**, fully covered by unit/integration tests.

**Architecture:** Files are split into `CHUNK_BYTES` pieces, each AES-256-GCM-sealed with `AAD = routingId:fileId:index:isFinal` (Spike-A scheme). The relay broadcasts `file-*` frames verbatim (never persisting them), governs them with a separate rate budget, and gates fan-out on per-socket `bufferedAmount`. A `client-core` `FileTransferManager` drives the offer → accept → chunk → complete flow with credit/ack flow control paced to the fastest acker; download-and-forget, live-only.

**Tech Stack:** TypeScript monorepo (pnpm + Turborepo). Zod (protocol), WebCrypto AES-GCM + SHA-256 (crypto), Bun + Hono (relay; tests under `bun --bun vitest`), Node vitest (crypto/client-core). `ulid` for ids.

---

## File Structure
- `packages/crypto/src/envelope.ts` — add `encryptBytes`/`decryptBytes`/`sha256Hex`; `index.ts` re-exports them.
- `packages/protocol/src/index.ts` — `PROTOCOL_VERSION`, transfer constants, six `file-*` schemas, `hello.protocolVersion`, union membership.
- `apps/relay/src/ws-handlers.ts` — `file-*` routing (broadcast, no persist), `chunkLimiter`, `bufferedAmount` gate in `broadcast`.
- `packages/client-core/src/file-transfer.ts` (new) — `FileTransferManager` + `FileClientEvent` types.
- `packages/client-core/src/client.ts` — wire the manager: events, `handleFrame` routing, `sendFile`/`acceptFile`/`declineFile`/`cancelFile`, abort-on-close.

---

## Task 1: Crypto — bytes envelope + SHA-256

**Files:**
- Modify: `packages/crypto/src/envelope.ts`
- Modify: `packages/crypto/src/index.ts` (already `export * from "./envelope"` — verify, no change likely needed)
- Test: `packages/crypto/src/bytes-envelope.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `packages/crypto/src/bytes-envelope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encryptBytes, decryptBytes, sha256Hex } from "./envelope";

const enc = new TextEncoder();
const RID = "qx7k2p";
const FID = "01HFILE0000000000000000000";

async function genKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function chunkAad(routingId: string, fileId: string, index: number, isFinal: boolean): string {
  return `${routingId}:${fileId}:${index}:${isFinal}`;
}

describe("bytes envelope", () => {
  it("round-trips arbitrary bytes", async () => {
    const key = await genKey();
    const data = crypto.getRandomValues(new Uint8Array(40));
    const env = await encryptBytes({ key, data, aad: "x" });
    const out = await decryptBytes({ key, iv: env.iv, ciphertext: env.ciphertext, aad: "x" });
    expect(out).toEqual(data);
  });

  it("fails when the AAD differs", async () => {
    const key = await genKey();
    const data = crypto.getRandomValues(new Uint8Array(8));
    const env = await encryptBytes({ key, data, aad: "a" });
    await expect(decryptBytes({ key, iv: env.iv, ciphertext: env.ciphertext, aad: "b" })).rejects.toThrow();
  });

  it("sha256Hex matches a known vector", async () => {
    // SHA-256("abc")
    expect(await sha256Hex(enc.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

// The Spike-A chunked-AEAD properties, now permanent. Each chunk is sealed with
// AAD routingId:fileId:index:isFinal; the RECEIVER authenticates each position
// against its OWN expected (index, isFinal), never the frame's claim.
describe("chunked-AEAD properties (over encryptBytes/decryptBytes)", () => {
  const CHUNK = 16;
  async function seal(key: CryptoKey, routingId: string, fileId: string, data: Uint8Array) {
    const chunkCount = Math.max(1, Math.ceil(data.length / CHUNK));
    const frames: { iv: ArrayBuffer; ct: ArrayBuffer }[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const isFinal = i === chunkCount - 1;
      const env = await encryptBytes({
        key, data: data.subarray(i * CHUNK, (i + 1) * CHUNK),
        aad: chunkAad(routingId, fileId, i, isFinal),
      });
      frames.push({ iv: env.iv, ct: env.ciphertext });
    }
    return { frames, chunkCount };
  }
  async function open(key: CryptoKey, routingId: string, fileId: string, chunkCount: number, frames: { iv: ArrayBuffer; ct: ArrayBuffer }[]) {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const f = frames[i]!;
      parts.push(await decryptBytes({
        key, iv: f.iv, ciphertext: f.ct,
        aad: chunkAad(routingId, fileId, i, i === chunkCount - 1),
      }));
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  it("round-trips multi- and single-chunk", async () => {
    const key = await genKey();
    const big = crypto.getRandomValues(new Uint8Array(50));
    const r1 = await seal(key, RID, FID, big);
    expect(r1.chunkCount).toBeGreaterThan(1);
    expect(await open(key, RID, FID, r1.chunkCount, r1.frames)).toEqual(big);
    const small = enc.encode("hi");
    const r2 = await seal(key, RID, FID, small);
    expect(await open(key, RID, FID, r2.chunkCount, r2.frames)).toEqual(small);
  });

  it("rejects reorder, truncation-by-count, cross-file splice, tamper, wrong room", async () => {
    const key = await genKey();
    const data = crypto.getRandomValues(new Uint8Array(50));

    const reordered = await seal(key, RID, FID, data);
    [reordered.frames[0], reordered.frames[1]] = [reordered.frames[1]!, reordered.frames[0]!];
    await expect(open(key, RID, FID, reordered.chunkCount, reordered.frames)).rejects.toThrow();

    const trunc = await seal(key, RID, FID, data);
    await expect(open(key, RID, FID, trunc.chunkCount - 1, trunc.frames.slice(0, trunc.chunkCount - 1))).rejects.toThrow();

    const a = await seal(key, RID, FID, data);
    const b = await seal(key, RID, "01HOTHER000000000000000000", crypto.getRandomValues(new Uint8Array(50)));
    a.frames[1] = b.frames[1]!;
    await expect(open(key, RID, FID, a.chunkCount, a.frames)).rejects.toThrow();

    const tam = await seal(key, RID, FID, data);
    const bytes = new Uint8Array(tam.frames[1]!.ct);
    bytes[0] = bytes[0]! ^ 0x01;
    tam.frames[1]!.ct = bytes.buffer;
    await expect(open(key, RID, FID, tam.chunkCount, tam.frames)).rejects.toThrow();

    const wr = await seal(key, RID, FID, data);
    await expect(open(key, "other-room", FID, wr.chunkCount, wr.frames)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uniclip/crypto test bytes-envelope`
Expected: FAIL — `encryptBytes`/`decryptBytes`/`sha256Hex` are not exported.

- [ ] **Step 3: Implement**

In `packages/crypto/src/envelope.ts`, append (the `encoder`, `IV_BYTES`, and `Envelope` interface already exist at the top of this file — reuse them):

```ts
export interface EncryptBytesInput {
  key: CryptoKey;
  data: Uint8Array;
  /** Associated data — bound into the GCM auth tag. */
  aad: string;
}

export async function encryptBytes(input: EncryptBytesInput): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(input.aad) },
    input.key,
    input.data,
  );
  return { iv: iv.buffer, ciphertext };
}

export interface DecryptBytesInput {
  key: CryptoKey;
  iv: BufferSource;
  ciphertext: BufferSource;
  aad: string;
}

export async function decryptBytes(input: DecryptBytesInput): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: input.iv, additionalData: encoder.encode(input.aad) },
    input.key,
    input.ciphertext,
  );
  return new Uint8Array(plain);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let s = "";
  for (const b of h) s += b.toString(16).padStart(2, "0");
  return s;
}
```

`packages/crypto/src/index.ts` already does `export * from "./envelope"`, so no change is needed there. (Verify it still reads `export * from "./envelope";`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uniclip/crypto test bytes-envelope`
Expected: PASS (all cases green).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @uniclip/crypto typecheck
git add packages/crypto/src/envelope.ts packages/crypto/src/bytes-envelope.test.ts
git commit -m "feat(crypto): bytes AEAD envelope + sha256Hex for file transfer"
```

---

## Task 2: Protocol — `file-*` frames, constants, `protocolVersion`

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/protocol/src/index.test.ts`:

```ts
import {
  ClientFrameSchema,
  PROTOCOL_VERSION,
  CHUNK_BYTES,
  MAX_FILE_BYTES,
} from "./index";

describe("file-transfer frames", () => {
  const fileId = "01HFILE0000000000000000000"; // 26-char ULID shape

  it("accepts a file-offer", () => {
    expect(
      ClientFrameSchema.parse({
        type: "file-offer", fileId, name: "a.png", mime: "image/png",
        size: 1234, chunkCount: 1, hash: "a".repeat(64), inline: true,
      }),
    ).toBeDefined();
  });

  it("rejects a file-offer with a bad hash", () => {
    expect(() =>
      ClientFrameSchema.parse({
        type: "file-offer", fileId, name: "a.png", mime: "image/png",
        size: 1, chunkCount: 1, hash: "xyz", inline: false,
      }),
    ).toThrow();
  });

  it("accepts file-accept / file-chunk / file-ack / file-complete / file-cancel", () => {
    expect(ClientFrameSchema.parse({ type: "file-accept", fileId })).toBeDefined();
    expect(ClientFrameSchema.parse({ type: "file-chunk", fileId, index: 0, isFinal: true, iv: "AAAA", ciphertext: "QUFB" })).toBeDefined();
    expect(ClientFrameSchema.parse({ type: "file-ack", fileId, upTo: 0 })).toBeDefined();
    expect(ClientFrameSchema.parse({ type: "file-complete", fileId })).toBeDefined();
    expect(ClientFrameSchema.parse({ type: "file-cancel", fileId, reason: "user" })).toBeDefined();
  });

  it("exposes transfer constants", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(CHUNK_BYTES).toBe(32 * 1024);
    expect(MAX_FILE_BYTES).toBe(100 * 1024 * 1024);
  });
});
```

Also add, in the existing `describe("ServerFrameSchema", …)` block:

```ts
  it("defaults protocolVersion to 1 when absent", () => {
    const f = ServerFrameSchema.parse({
      type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false,
    });
    expect((f as { protocolVersion: number }).protocolVersion).toBe(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uniclip/protocol test`
Expected: FAIL — the `file-*` schemas, constants, and `protocolVersion` don't exist.

- [ ] **Step 3: Implement**

In `packages/protocol/src/index.ts`:

Add constants near the top (after `MAX_FRAME_BYTES`):

```ts
export const PROTOCOL_VERSION = 1;

// Binary transfer (Phase 2 v0.2). CHUNK_BYTES is sized so a base64+JSON frame
// stays under MAX_FRAME_BYTES; the rest are engine tunables.
export const CHUNK_BYTES = 32 * 1024;
export const INLINE_IMAGE_MAX = 256 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const CREDIT_WINDOW = 32;
export const ACK_INTERVAL = 16;
export const STALL_TIMEOUT_MS = 30_000;
```

Add `protocolVersion` to `HelloFrameSchema` (optional-with-default, like `ephemeral`):

```ts
    ephemeral: z.boolean().optional().default(false),
    // Wire protocol version; lets an old client reject newer frames gracefully.
    protocolVersion: z.number().int().optional().default(PROTOCOL_VERSION),
```

Add the six schemas (after `DeleteFrameSchema`):

```ts
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const FileOfferSchema = z
  .object({
    type: z.literal("file-offer"),
    fileId: z.string().regex(ULID_REGEX),
    name: z.string().max(255),
    mime: z.string().max(255),
    size: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive(),
    hash: Sha256Hex,
    inline: z.boolean(),
  })
  .strict();

export const FileAcceptSchema = z
  .object({ type: z.literal("file-accept"), fileId: z.string().regex(ULID_REGEX) })
  .strict();

export const FileDeclineSchema = z
  .object({ type: z.literal("file-decline"), fileId: z.string().regex(ULID_REGEX) })
  .strict();

export const FileChunkSchema = z
  .object({
    type: z.literal("file-chunk"),
    fileId: z.string().regex(ULID_REGEX),
    index: z.number().int().nonnegative(),
    isFinal: z.boolean(),
    iv: Base64,
    ciphertext: Base64,
  })
  .strict();

export const FileAckSchema = z
  .object({ type: z.literal("file-ack"), fileId: z.string().regex(ULID_REGEX), upTo: z.number().int().nonnegative() })
  .strict();

export const FileCompleteSchema = z
  .object({ type: z.literal("file-complete"), fileId: z.string().regex(ULID_REGEX) })
  .strict();

export const FileCancelSchema = z
  .object({ type: z.literal("file-cancel"), fileId: z.string().regex(ULID_REGEX), reason: z.string().max(120) })
  .strict();
```

Add all six to **both** unions. Replace the `ClientFrameSchema` and `ServerFrameSchema` definitions:

```ts
export const ServerFrameSchema = z.discriminatedUnion("type", [
  HelloFrameSchema,
  PeerJoinedFrameSchema,
  PeerLeftFrameSchema,
  ClipboardFrameSchema,
  DeleteFrameSchema,
  ErrorFrameSchema,
  FileOfferSchema,
  FileAcceptSchema,
  FileDeclineSchema,
  FileChunkSchema,
  FileAckSchema,
  FileCompleteSchema,
  FileCancelSchema,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion("type", [
  ClipboardFrameSchema,
  DeleteFrameSchema,
  FileOfferSchema,
  FileAcceptSchema,
  FileDeclineSchema,
  FileChunkSchema,
  FileAckSchema,
  FileCompleteSchema,
  FileCancelSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uniclip/protocol test`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @uniclip/protocol typecheck
git add packages/protocol/src/index.ts packages/protocol/src/index.test.ts
git commit -m "feat(protocol): file-* transfer frames, constants, protocolVersion"
```

> NOTE: after this task, `apps/relay/src/ws-handlers.ts` has expected transient TS errors — its `hello` send lacks `protocolVersion` (now required by the inferred `ServerFrame`), and its `else` persistence branch reads `result.data.msgId`, which the new `file-*` variants don't have. Both are fixed in Task 3. `packages/client-core/src/client.ts` is unaffected (its `handleFrame` switch tolerates new union members until Task 6 adds their cases). Relay tests run under vitest (no full tsc), so `pnpm --filter @uniclip/relay test` stays green; don't run the relay `typecheck` until Task 3.

---

## Task 3: Relay — route `file-*` (no persist), separate rate budget, backpressure gate

**Files:**
- Modify: `apps/relay/src/ws-handlers.ts`
- Test: `apps/relay/test/file-transfer.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `apps/relay/test/file-transfer.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";
import { attachWebSocket } from "../src/ws-handlers";
import { ulid } from "ulid";

let server: ReturnType<typeof Bun.serve> | null = null;
let baseHttp = "";
let baseWs = "";
let store: RoomStore;

beforeEach(() => {
  store = new RoomStore();
  const app = buildApp({ roomCount: () => store.count, store });
  const { websocket, fetch } = attachWebSocket(app, store);
  server = Bun.serve({ port: 0, fetch, websocket });
  baseHttp = `http://localhost:${server.port}`;
  baseWs = `ws://localhost:${server.port}`;
});
afterEach(() => { server?.stop(true); server = null; });

async function mintRoom(): Promise<string> {
  const res = await fetch(`${baseHttp}/api/room`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "A" }),
  });
  return ((await res.json()) as { roomId: string }).roomId;
}
function offer(fileId: string) {
  return { type: "file-offer", fileId, name: "f", mime: "image/png", size: 10, chunkCount: 1, hash: "a".repeat(64), inline: false };
}
function chunk(fileId: string, index: number) {
  return { type: "file-chunk", fileId, index, isFinal: true, iv: "AAAA", ciphertext: "QUFB" };
}

describe("relay file-* handling", () => {
  it("fans out a file-offer to peers but stores nothing", async () => {
    const id = await mintRoom();
    const a = new WebSocket(`${baseWs}/ws/${id}`);
    await new Promise((r) => (a.onopen = () => r(null)));
    const bMsgs: any[] = [];
    const b = new WebSocket(`${baseWs}/ws/${id}`);
    b.onmessage = (e) => bMsgs.push(JSON.parse(e.data as string));
    await new Promise((r) => (b.onopen = () => r(null)));
    await new Promise((r) => setTimeout(r, 20));

    const fileId = ulid();
    a.send(JSON.stringify(offer(fileId)));
    a.send(JSON.stringify(chunk(fileId, 0)));
    await new Promise((r) => setTimeout(r, 30));

    expect(bMsgs.some((m) => m.type === "file-offer" && m.fileId === fileId)).toBe(true);
    expect(bMsgs.some((m) => m.type === "file-chunk")).toBe(true);
    // Nothing was buffered for backfill (file-* never enters the ring).
    const room = store.get(id)!;
    expect(room.recent).toHaveLength(0);
    expect(room.tombstones).toHaveLength(0);
  });

  it("does NOT rate-limit a 42-chunk burst (file-* uses its own budget)", async () => {
    const id = await mintRoom();
    let closeCode = 0;
    const a = new WebSocket(`${baseWs}/ws/${id}`);
    a.onclose = (e) => (closeCode = e.code);
    await new Promise((r) => (a.onopen = () => r(null)));
    const fileId = ulid();
    a.send(JSON.stringify(offer(fileId)));
    for (let i = 0; i < 42; i++) a.send(JSON.stringify({ type: "file-chunk", fileId, index: i, isFinal: i === 41, iv: "AAAA", ciphertext: "QUFB" }));
    await new Promise((r) => setTimeout(r, 150));
    expect(closeCode).toBe(0); // socket stayed open
  });

  it("still rate-limits a clip burst on the clip budget", async () => {
    const id = await mintRoom();
    let closeCode = 0;
    const a = new WebSocket(`${baseWs}/ws/${id}`);
    a.onclose = (e) => (closeCode = e.code);
    await new Promise((r) => (a.onopen = () => r(null)));
    for (let i = 0; i < 25; i++) a.send(JSON.stringify({ type: "clip", msgId: ulid(), iv: "AAAA", ciphertext: "QUFB", ts: 0 }));
    await new Promise((r) => setTimeout(r, 150));
    expect(closeCode).toBe(4429); // RATE_LIMIT
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uniclip/relay test file-transfer`
Expected: FAIL — `file-*` frames currently hit the single `frameLimiter` and fall into the `delete` branch (which reads `result.data.msgId`, undefined for file frames). The 42-chunk burst would be rate-limited (closeCode 4429, not 0).

- [ ] **Step 3: Implement**

In `apps/relay/src/ws-handlers.ts`:

First, the `hello` send must carry `protocolVersion` (the schema's `.default()` makes it a required field of the inferred `ServerFrame`, just like `ephemeral`). Add `PROTOCOL_VERSION` to the `@uniclip/protocol` import, and add the field to the `send(raw, { type: "hello", … })` object:

```ts
import {
  CLOSE_CODES,
  ClientFrameSchema,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type ServerFrame,
} from "@uniclip/protocol";
```

```ts
          send(raw, {
            type: "hello",
            roomId,
            peerCount: room.sockets.size,
            serverTime: Date.now(),
            backfill: room.backfillEnabled,
            ephemeral: room.ephemeral,
            protocolVersion: PROTOCOL_VERSION,
          });
```

Add a module-scope backpressure constant near the top of the file (after the imports, beside the existing module-level helpers):

```ts
// Per-socket fan-out backpressure ceiling. A socket buffered beyond this is
// skipped for the current frame (memory backstop; see the engine spec §4).
const BUFFERED_AMOUNT_MAX = 8 * 1024 * 1024;
```

Add the chunk limiter beside `frameLimiter` (top of `attachWebSocket`):

```ts
  const frameLimiter = new SlidingWindowLimiter(20, 10_000);
  // file-* frames are bursty by nature; they get a far higher budget so a
  // transfer doesn't trip the clip/delete limiter. Flow control is the real
  // pace governor; this is only a DoS ceiling.
  const chunkLimiter = new SlidingWindowLimiter(2000, 10_000);
```

Replace the limiter check (the `if (!frameLimiter.allow(key)) { … }` block) so the limiter is chosen by frame type:

```ts
          const limiter = result.data.type.startsWith("file-") ? chunkLimiter : frameLimiter;
          if (!limiter.allow(key)) {
            metrics?.inc("uniclip_errors_total", 1, { code: "RATE_LIMIT" });
            raw.send(
              JSON.stringify({
                type: "error",
                code: "RATE_LIMIT",
                message: "too many frames",
              } satisfies ServerFrame),
            );
            raw.close(CLOSE_CODES.RATE_LIMIT, "RATE_LIMIT");
            return;
          }
```

Replace the post-broadcast persistence branch (`if (result.data.type === "clip") { … } else { … }`) with an explicit three-way split (`file-*` persists nothing):

```ts
          if (result.data.type === "clip") {
            // Buffer for late joiners (no-op unless Mode A + backfill enabled).
            store.pushRecent(room.id, result.data);
          } else if (result.data.type === "delete") {
            // Drop from the ring and remember the tombstone for late reconcile.
            store.removeRecent(room.id, result.data.msgId);
            store.addTombstone(room.id, result.data.msgId);
          }
          // file-* frames are forwarded only (already broadcast above) — never
          // buffered, tombstoned, or persisted. Binary stays out of the relay.
```

Add the backpressure gate to the `broadcast` helper (the loop that calls `s.send(payload)`). Replace the body of the `for (const s of sockets)` loop:

```ts
  for (const s of sockets) {
    if (s === exclude) continue;
    const sock = s as ServerWebSocket<unknown> & { getBufferedAmount?: () => number };
    // Memory backstop: skip a socket whose send buffer is already large. Under
    // correct sender pacing this never triggers; it only fires for a stuck
    // receiver, which then fails its transfer's hash check (others unaffected).
    if (sock.getBufferedAmount && sock.getBufferedAmount() > BUFFERED_AMOUNT_MAX) continue;
    try {
      sock.send(payload);
      onSent?.();
    } catch {
      // A failing socket must not block delivery to the rest of the room.
    }
  }
```

(`BUFFERED_AMOUNT_MAX` is the module-scope constant added at the top of this step, so the module-level `broadcast` function can see it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uniclip/relay test file-transfer`
Expected: PASS. Then run the full relay suite + typecheck (the union grew; this task closes the relay side):

Run: `pnpm --filter @uniclip/relay test && pnpm --filter @uniclip/relay typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/ws-handlers.ts apps/relay/test/file-transfer.test.ts
git commit -m "feat(relay): route file-* frames (no persist) with own rate budget + backpressure gate"
```

---

## Task 4: Client-core — `FileTransferManager` receiver + file events

**Files:**
- Create: `packages/client-core/src/file-transfer.ts`
- Test: `packages/client-core/src/file-transfer.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `packages/client-core/src/file-transfer.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ClientFrame, ServerFrame } from "@uniclip/protocol";
import { encryptBytes, sha256Hex, toBase64 } from "@uniclip/crypto";
import { FileTransferManager, type FileClientEvent } from "./file-transfer";

const RID = "qx7k2p";
async function genKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Build a manager whose sent frames are captured, plus its emitted events.
function makeManager(key: CryptoKey) {
  const sent: ClientFrame[] = [];
  const events: FileClientEvent[] = [];
  const mgr = new FileTransferManager({
    routingId: RID,
    getKey: () => key,
    send: (f) => { sent.push(f); return true; },
    emit: (e) => events.push(e),
  });
  return { mgr, sent, events };
}

// Seal a whole file into file-chunk frames the receiver will accept.
async function chunks(key: CryptoKey, fileId: string, data: Uint8Array, chunkBytes = 8): Promise<ServerFrame[]> {
  const count = Math.max(1, Math.ceil(data.length / chunkBytes));
  const out: ServerFrame[] = [];
  for (let i = 0; i < count; i++) {
    const isFinal = i === count - 1;
    const env = await encryptBytes({
      key, data: data.subarray(i * chunkBytes, (i + 1) * chunkBytes),
      aad: `${RID}:${fileId}:${i}:${isFinal}`,
    });
    out.push({ type: "file-chunk", fileId, index: i, isFinal, iv: toBase64(env.iv), ciphertext: toBase64(env.ciphertext) } as ServerFrame);
  }
  return out;
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());

describe("FileTransferManager receiver", () => {
  it("emits file-offer; on accept, reassembles + verifies hash, emits file-received", async () => {
    const key = await genKey();
    const { mgr, sent, events } = makeManager(key);
    const fileId = "01HFILE0000000000000000000";
    const data = new TextEncoder().encode("hello chunked world!");
    const hash = await sha256Hex(data);
    const cfs = await chunks(key, fileId, data);

    await mgr.handle({ type: "file-offer", fileId, name: "a.txt", mime: "text/plain", size: data.length, chunkCount: cfs.length, hash, inline: false } as ServerFrame);
    expect(events.some((e) => e.kind === "file-offer" && e.fileId === fileId)).toBe(true);

    mgr.acceptFile(fileId);
    expect(sent.some((f) => f.type === "file-accept" && f.fileId === fileId)).toBe(true);

    for (const c of cfs) await mgr.handle(c);

    const recv = events.find((e) => e.kind === "file-received") as Extract<FileClientEvent, { kind: "file-received" }>;
    expect(recv).toBeDefined();
    expect(new Uint8Array(await recv.blob.arrayBuffer())).toEqual(data);
  });

  it("auto-accepts an inline offer (sends file-accept without a consumer call)", async () => {
    const key = await genKey();
    const { mgr, sent } = makeManager(key);
    const fileId = "01HINLINE000000000000000AA";
    await mgr.handle({ type: "file-offer", fileId, name: "p.png", mime: "image/png", size: 4, chunkCount: 1, hash: "a".repeat(64), inline: true } as ServerFrame);
    expect(sent.some((f) => f.type === "file-accept" && f.fileId === fileId)).toBe(true);
  });

  it("emits AUTH_FAILED when a chunk is tampered", async () => {
    const key = await genKey();
    const { mgr, events } = makeManager(key);
    const fileId = "01HFILE0000000000000000000";
    const data = new TextEncoder().encode("xyz");
    const cfs = await chunks(key, fileId, data);
    (cfs[0] as { ciphertext: string }).ciphertext = toBase64(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    await mgr.handle({ type: "file-offer", fileId, name: "f", mime: "text/plain", size: 3, chunkCount: cfs.length, hash: await sha256Hex(data), inline: false } as ServerFrame);
    mgr.acceptFile(fileId);
    for (const c of cfs) await mgr.handle(c);
    expect(events.some((e) => e.kind === "file-error" && e.code === "AUTH_FAILED")).toBe(true);
  });

  it("emits HASH_MISMATCH when the manifest hash is wrong", async () => {
    const key = await genKey();
    const { mgr, events } = makeManager(key);
    const fileId = "01HFILE0000000000000000000";
    const data = new TextEncoder().encode("abc");
    const cfs = await chunks(key, fileId, data);
    await mgr.handle({ type: "file-offer", fileId, name: "f", mime: "text/plain", size: 3, chunkCount: cfs.length, hash: "b".repeat(64), inline: false } as ServerFrame);
    mgr.acceptFile(fileId);
    for (const c of cfs) await mgr.handle(c);
    expect(events.some((e) => e.kind === "file-error" && e.code === "HASH_MISMATCH")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uniclip/client-core test file-transfer`
Expected: FAIL — `./file-transfer` does not exist.

- [ ] **Step 3: Implement the receiver half**

Create `packages/client-core/src/file-transfer.ts`:

```ts
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
  ackedUpTo: number; // max upTo across acks (-1 = none)
  started: boolean;
  pumping: boolean;
  stall: ReturnType<typeof setTimeout> | null;
}

export class FileTransferManager {
  private readonly incoming = new Map<string, Incoming>();
  private readonly outgoing = new Map<string, Outgoing>();

  constructor(private readonly deps: FileTransferDeps) {}

  // ── Receiver consumer API ────────────────────────────────────────────────
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

  // ── Frame ingress (called by UniclipClient for file-* frames) ────────────
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
    if (f.inline) this.acceptFile(f.fileId); // small images flow without a tap
  }

  private async onChunk(f: Extract<ServerFrame, { type: "file-chunk" }>): Promise<void> {
    const t = this.incoming.get(f.fileId);
    if (!t || !t.accepted) return;
    const key = this.deps.getKey();
    if (!key) return;
    const i = f.index;
    if (i < 0 || i >= t.offer.chunkCount || t.buf[i]) return; // out of range / duplicate
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
    while (t.buf[t.upTo + 1]) t.upTo++; // advance highest contiguous index
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
    if ((await sha256Hex(out)) !== t.offer.hash) {
      this.fail(fileId, "HASH_MISMATCH", "reassembled file failed its hash");
      return;
    }
    const blob = new Blob([out], { type: t.offer.mime });
    this.incoming.delete(fileId);
    this.deps.emit({ kind: "file-received", fileId, blob, name: t.offer.name, mime: t.offer.mime });
  }

  private onComplete(fileId: string): void {
    // Receiver already completes from the final chunk; this is a no-op safety
    // net for a transfer that somehow saw `complete` before its last chunk.
    void fileId;
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
```

> The `Outgoing` interface is declared here but only its consumers `sendFile`/`pump` arrive in Task 5; the `outgoing` map field IS used in this task (`onCancel`, `fail`), so it is not an unused member. Sender-only imports (`ulid`, `encryptBytes`, `toBase64`, and the `CHUNK_BYTES`/`INLINE_IMAGE_MAX`/`MAX_FILE_BYTES`/`CREDIT_WINDOW`/`STALL_TIMEOUT_MS` constants) are deliberately NOT imported yet — Task 5 adds them with their first use, so this task has no unused imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uniclip/client-core test file-transfer`
Expected: PASS (4 receiver tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/file-transfer.ts packages/client-core/src/file-transfer.test.ts
git commit -m "feat(client-core): FileTransferManager receiver (offer/chunk/assemble/verify)"
```

---

## Task 5: Client-core — `FileTransferManager` sender + flow control

**Files:**
- Modify: `packages/client-core/src/file-transfer.ts`
- Test: `packages/client-core/src/file-transfer.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/client-core/src/file-transfer.test.ts`:

```ts
describe("FileTransferManager sender", () => {
  it("rejects an oversize file with TOO_LARGE and sends nothing", async () => {
    const key = await genKey();
    const { mgr, sent, events } = makeManager(key);
    // sendFile only reads `bytes.length` before the guard, so a stub with an
    // oversize length exercises it without allocating 100 MB.
    await mgr.sendFile({ name: "big.bin", mime: "application/octet-stream", bytes: { length: 100 * 1024 * 1024 + 1 } as unknown as Uint8Array });
    expect(events.some((e) => e.kind === "file-error" && e.code === "TOO_LARGE")).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("offers, then streams the single chunk once accepted, then completes on ack", async () => {
    const key = await genKey();
    const { mgr, sent } = makeManager(key);
    const data = new TextEncoder().encode("a".repeat(100)); // ≤ CHUNK_BYTES → exactly 1 chunk
    await mgr.sendFile({ name: "f.txt", mime: "text/plain", bytes: data });
    const offer = sent.find((f) => f.type === "file-offer");
    expect(offer).toBeDefined();
    const fileId = (offer as { fileId: string }).fileId;

    await mgr.handle({ type: "file-accept", fileId } as ServerFrame);
    // 100 bytes ≤ CHUNK_BYTES → exactly 1 chunk, then file-complete after the ack.
    expect(sent.some((f) => f.type === "file-chunk" && f.fileId === fileId)).toBe(true);
    await mgr.handle({ type: "file-ack", fileId, upTo: 0 } as ServerFrame);
    expect(sent.some((f) => f.type === "file-complete" && f.fileId === fileId)).toBe(true);
  });

  it("pauses at CREDIT_WINDOW unacked chunks and resumes on ack (pace to fastest)", async () => {
    const key = await genKey();
    const { mgr, sent } = makeManager(key);
    // Force many chunks: 40 chunks worth at the real CHUNK_BYTES.
    const data = crypto.getRandomValues(new Uint8Array(40 * 32 * 1024));
    await mgr.sendFile({ name: "f.bin", mime: "application/octet-stream", bytes: data });
    const fileId = (sent.find((f) => f.type === "file-offer") as { fileId: string }).fileId;
    await mgr.handle({ type: "file-accept", fileId } as ServerFrame);
    const after1 = sent.filter((f) => f.type === "file-chunk").length;
    expect(after1).toBe(32); // CREDIT_WINDOW, no acks yet
    await mgr.handle({ type: "file-ack", fileId, upTo: 15 } as ServerFrame); // fastest acker
    const after2 = sent.filter((f) => f.type === "file-chunk").length;
    expect(after2).toBeGreaterThan(after1); // window advanced
  });

  it("round-trips sender→receiver: assembled bytes equal the input", async () => {
    const key = await genKey();
    const a = makeManager(key); // sender
    const b = makeManager(key); // receiver
    // Pipe a→b and b→a.
    a.mgr["deps"].send = (f: ClientFrame) => { void b.mgr.handle(f as unknown as ServerFrame); return true; };
    b.mgr["deps"].send = (f: ClientFrame) => { void a.mgr.handle(f as unknown as ServerFrame); return true; };

    const data = crypto.getRandomValues(new Uint8Array(70 * 1024)); // ~3 chunks
    await a.mgr.sendFile({ name: "x.bin", mime: "application/octet-stream", bytes: data });
    // Let the async chunk pipeline settle.
    await new Promise((r) => setTimeout(r, 50));
    const recv = b.events.find((e) => e.kind === "file-received") as Extract<FileClientEvent, { kind: "file-received" }>;
    expect(recv).toBeDefined();
    expect(new Uint8Array(await recv.blob.arrayBuffer())).toEqual(data);
    expect(b.events.some((e) => e.kind === "file-error")).toBe(false);
  });

  it("aborts with STALLED when no ack advances within the timeout", async () => {
    vi.useFakeTimers();
    const key = await genKey();
    const { mgr, sent, events } = makeManager(key);
    const data = crypto.getRandomValues(new Uint8Array(40 * 32 * 1024));
    await mgr.sendFile({ name: "f.bin", mime: "application/octet-stream", bytes: data });
    const fileId = (sent.find((f) => f.type === "file-offer") as { fileId: string }).fileId;
    await mgr.handle({ type: "file-accept", fileId } as ServerFrame);
    await vi.advanceTimersByTimeAsync(30_000 + 10);
    expect(events.some((e) => e.kind === "file-error" && e.code === "STALLED")).toBe(true);
    vi.useRealTimers();
  });

  it("cancelFile sends a file-cancel and emits one", async () => {
    const key = await genKey();
    const { mgr, sent, events } = makeManager(key);
    const data = new TextEncoder().encode("z");
    await mgr.sendFile({ name: "f", mime: "text/plain", bytes: data });
    const fileId = (sent.find((f) => f.type === "file-offer") as { fileId: string }).fileId;
    mgr.cancelFile(fileId);
    expect(sent.some((f) => f.type === "file-cancel" && f.fileId === fileId)).toBe(true);
    expect(events.some((e) => e.kind === "file-cancel" && e.fileId === fileId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uniclip/client-core test file-transfer`
Expected: FAIL — `sendFile`, `cancelFile`, and the `file-accept`/`file-ack` handling don't exist.

- [ ] **Step 3: Implement the sender half**

First extend the imports at the top of `packages/client-core/src/file-transfer.ts` to add the sender-only symbols:

```ts
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
import { encryptBytes, decryptBytes, sha256Hex, toBase64, fromBase64 } from "@uniclip/crypto";
```

Then extend `handle`'s switch to cover the sender-side frames:

```ts
      case "file-offer": return this.onOffer(frame);
      case "file-chunk": return this.onChunk(frame);
      case "file-complete": return this.onComplete(frame.fileId);
      case "file-cancel": return this.onCancel(frame.fileId, frame.reason);
      case "file-accept": return this.onAccept(frame.fileId);
      case "file-ack": return this.onAck(frame.fileId, frame.upTo);
      case "file-decline": return; // best-effort: another peer declined; ignore
      default: return;
```

Add the sender methods to the class:

```ts
  // ── Sender API ───────────────────────────────────────────────────────────
  async sendFile(file: { name: string; mime: string; bytes: Uint8Array }): Promise<void> {
    if (file.bytes.length > MAX_FILE_BYTES) {
      this.deps.emit({ kind: "file-error", fileId: "", code: "TOO_LARGE", message: "file exceeds the size limit" });
      return;
    }
    const key = this.deps.getKey();
    if (!key) {
      this.deps.emit({ kind: "file-error", fileId: "", code: "NO_KEY", message: "no room key" });
      return;
    }
    const fileId = ulid();
    const chunkCount = Math.max(1, Math.ceil(file.bytes.length / CHUNK_BYTES));
    const hash = await sha256Hex(file.bytes);
    const inline = file.mime.startsWith("image/") && file.bytes.length <= INLINE_IMAGE_MAX;
    this.outgoing.set(fileId, {
      fileId, bytes: file.bytes, name: file.name, mime: file.mime,
      chunkCount, nextChunk: 0, ackedUpTo: -1, started: false, pumping: false, stall: null,
    });
    const ok = this.deps.send({
      type: "file-offer", fileId, name: file.name, mime: file.mime,
      size: file.bytes.length, chunkCount, hash, inline,
    });
    if (!ok) { this.fail(fileId, "DISCONNECTED", "not connected"); return; }
    this.armStall(fileId);
  }

  cancelFile(fileId: string): void {
    const t = this.outgoing.get(fileId);
    if (!t) return;
    if (t.stall) clearTimeout(t.stall);
    this.outgoing.delete(fileId);
    this.deps.send({ type: "file-cancel", fileId, reason: "sender_cancelled" });
    this.deps.emit({ kind: "file-cancel", fileId, reason: "sender_cancelled" });
  }

  private onAccept(fileId: string): void {
    const t = this.outgoing.get(fileId);
    if (!t || t.started) return; // start on the FIRST accept; later accepters join mid-stream
    t.started = true;
    void this.pump(fileId);
  }

  private onAck(fileId: string, upTo: number): void {
    const t = this.outgoing.get(fileId);
    if (!t) return;
    if (upTo > t.ackedUpTo) t.ackedUpTo = upTo; // pace to the fastest acker
    this.armStall(fileId); // progress resets the stall clock
    void this.pump(fileId);
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
          data: t.bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES),
          aad: `${this.deps.routingId}:${fileId}:${i}:${isFinal}`,
        });
        // The transfer may have been cancelled/failed during the await.
        if (!this.outgoing.has(fileId)) return;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uniclip/client-core test file-transfer`
Expected: PASS (receiver + sender + round-trip). Then:

Run: `pnpm --filter @uniclip/client-core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/file-transfer.ts packages/client-core/src/file-transfer.test.ts
git commit -m "feat(client-core): FileTransferManager sender + credit/ack flow control"
```

---

## Task 6: Client-core — wire `FileTransferManager` into `UniclipClient`

**Files:**
- Modify: `packages/client-core/src/client.ts`
- Test: `packages/client-core/src/client.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/client-core/src/client.test.ts` (the `MockWebSocket` harness already exists at the top):

```ts
  it("sendFile writes a file-offer frame through the socket", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    await client.sendFile({ name: "a.txt", mime: "text/plain", bytes: new TextEncoder().encode("hello") });
    expect(ws.sent.some((s) => JSON.parse(s).type === "file-offer")).toBe(true);
  });

  it("routes an incoming file-offer to a file-offer event", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    let offered = "";
    client.on("file-offer", (o: { fileId: string }) => (offered = o.fileId));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.emit({ type: "file-offer", fileId: "01HFILE0000000000000000000", name: "f", mime: "text/plain", size: 1, chunkCount: 1, hash: "a".repeat(64), inline: false });
    await waitFor(() => offered !== "");
    expect(offered).toBe("01HFILE0000000000000000000");
  });

  it("aborts in-progress transfers on disconnect", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const errs: string[] = [];
    client.on("file-error", (e: { code: string }) => errs.push(e.code));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    // Begin a receive (offer accepted) then disconnect.
    client.on("file-offer", (o: { fileId: string }) => client.acceptFile(o.fileId));
    ws.emit({ type: "file-offer", fileId: "01HFILE0000000000000000000", name: "f", mime: "text/plain", size: 1, chunkCount: 2, hash: "a".repeat(64), inline: false });
    await waitFor(() => ws.sent.some((s) => JSON.parse(s).type === "file-accept"));
    client.disconnect();
    expect(errs).toContain("DISCONNECTED");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uniclip/client-core test client`
Expected: FAIL — `client.sendFile`/`acceptFile` and the `file-*` events/routing don't exist.

- [ ] **Step 3: Implement the wiring**

In `packages/client-core/src/client.ts`:

Add the import:

```ts
import { FileTransferManager, type FileClientEvent } from "./file-transfer";
```

Extend the `ClientEvent` union (append the file events):

```ts
  | { kind: "sent"; msgId: string }
  | FileClientEvent;
```

Extend `EventHandlers`:

```ts
  sent: (msgId: string) => void;
  "file-offer": (o: { fileId: string; name: string; mime: string; size: number; chunkCount: number; hash: string; inline: boolean }) => void;
  "file-progress": (p: { fileId: string; dir: "send" | "recv"; sent: number; total: number }) => void;
  "file-received": (r: { fileId: string; blob: Blob; name: string; mime: string }) => void;
  "file-error": (e: { fileId: string; code: string; message: string }) => void;
  "file-cancel": (c: { fileId: string; reason: string }) => void;
```

Add the file-event cases to the `emit` switch (each forwards the whole event object minus `kind`):

```ts
        case "sent": (cb as EventHandlers["sent"])(evt.msgId); break;
        case "file-offer": (cb as EventHandlers["file-offer"])(evt); break;
        case "file-progress": (cb as EventHandlers["file-progress"])(evt); break;
        case "file-received": (cb as EventHandlers["file-received"])(evt); break;
        case "file-error": (cb as EventHandlers["file-error"])(evt); break;
        case "file-cancel": (cb as EventHandlers["file-cancel"])(evt); break;
```

Add a `transfers` field and construct it (after `private replay = new ReplaySet();`):

```ts
  private transfers = new FileTransferManager({
    routingId: this.room.routingId,
    getKey: () => this.key,
    send: (frame) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(frame));
        return true;
      }
      return false; // transfers are live-only; never queued
    },
    emit: (evt) => this.emit(evt),
  });
```

> `this.room` is assigned in the constructor before field initializers that reference `this.room` run? In TypeScript, class field initializers run in declaration order during construction, AFTER `super()` but the constructor body assigns `this.room`. To avoid a use-before-assign, initialize `transfers` in the constructor body instead. Replace the field with `private transfers!: FileTransferManager;` and, at the end of the constructor body (after `this.room = parsed;`), add the `this.transfers = new FileTransferManager({...})` assignment shown above.

Route `file-*` frames in `handleFrame`. In the `switch (frame.type)`, before the `default`/end, add:

```ts
      case "file-offer":
      case "file-accept":
      case "file-decline":
      case "file-chunk":
      case "file-ack":
      case "file-complete":
      case "file-cancel":
        await this.transfers.handle(frame);
        return;
```

Add the public delegators (near `send`/`delete`):

```ts
  async sendFile(file: { name: string; mime: string; bytes: Uint8Array }): Promise<void> {
    return this.transfers.sendFile(file);
  }
  acceptFile(fileId: string): void { this.transfers.acceptFile(fileId); }
  declineFile(fileId: string): void { this.transfers.declineFile(fileId); }
  cancelFile(fileId: string): void { this.transfers.cancelFile(fileId); }
```

Abort transfers on disconnect. In `disconnect()`, before `this.ws?.close()`:

```ts
  disconnect(): void {
    this.disposed = true;
    this.transfers.abortAll("disconnected");
    this.ws?.close();
    this.ws = null;
  }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @uniclip/client-core test && pnpm --filter @uniclip/client-core typecheck`
Expected: PASS (all client-core tests, including the existing ones).

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/client.ts packages/client-core/src/client.test.ts
git commit -m "feat(client-core): wire FileTransferManager into UniclipClient"
```

---

## Final verification

- [ ] **Run the whole unit suite + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS across all packages (`pnpm test` excludes e2e). There is no e2e for the engine — it has no UI; the engine is proven by the crypto/protocol/relay/client-core suites.

- [ ] **Hand off** via superpowers:finishing-a-development-branch.

---

## Notes for the implementer
- **Relay tests run under Bun** (`bun --bun vitest`); cast `res.json()` to a type. Don't reassign `raw.data` — only mutate `raw.data.roomId`.
- **`protocolVersion`/`ephemeral` are optional-with-default** in `HelloFrameSchema` so growing the schema doesn't break existing hello fixtures.
- **Packages are consumed as TS source** — no build before test. Ignore stale "cannot find module"/unused-symbol IDE warnings right after creating `file-transfer.ts`; trust the vitest/tsc exit codes.
- **`file-*` is never persisted** by the relay (Task 3) — the three-way `clip`/`delete`/`file-*` split in `onMessage` is the guard; do not let `file-*` fall into the `delete` branch (it has no `msgId`).
- **Transfers are live-only**: `FileTransferManager`'s `send` returns `false` when the socket is closed, and the engine fails the transfer (`DISCONNECTED`) rather than queueing — unlike clips/deletes, binary is never buffered.
- **The delivery-time / pace-to-fastest model** (spec §6): the sender advances its credit window on the *maximum* `upTo` across acks; a slow receiver is protected only by the relay's `bufferedAmount` gate, and fails its own hash if it falls too far behind.
