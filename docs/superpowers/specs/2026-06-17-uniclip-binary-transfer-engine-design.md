# Uniclip — Binary Transfer Engine (Phase 2 v0.2, sub-project 1) — Design Spec

**Date:** 2026-06-17
**Status:** Approved (pending spec review)
**Scope:** The encrypted file-transfer **engine** — bytes crypto, wire frames, relay routing/flow-control, and a `client-core` transfer module — with **no UI**. Provable entirely by unit/integration tests. The web UI is sub-project 2 (separate spec).
**Background:** `docs/superpowers/research/2026-06-17-uniclip-phase2-binary-research.md` (framing + Spike A chunked-AEAD validation + Spike B relay-limit/backpressure findings).

## 1. Goals and non-goals

### Goals
1. Transfer images and arbitrary files between devices in a room, end-to-end encrypted, with the relay remaining **zero-knowledge** (forwards opaque ciphertext) and **metadata-only** (persists no binary).
2. A reusable `client-core` `FileTransfer` engine (sender + receiver) driven by new `UniclipClient` events, testable without any UI.
3. Correct, adversarially-validated chunked AEAD (Spike A) and credit/ack flow control that bounds relay memory (Spike B).
4. **Broadcast** semantics consistent with text clips: a file goes to every device in the room; delivery is **best-effort per receiver** (a backpressured/slow receiver fails alone, without corrupting others). Because the relay is authless, `file-ack` frames carry no sender identity — the sender paces to the *fastest* acker and the relay's per-socket backpressure gate (not per-receiver pacing) is what bounds memory for slow receivers.

### Non-goals / preserved invariants
- **No UI** — file picker, paste, offer card, progress, inline rendering, download are sub-project 2.
- **No persisted binary** — download-and-forget; nothing enters the backfill ring, tombstones, or `RoomDb`. Live-only (both peers connected).
- **No WebRTC** (relay-relayed only; P2P is v0.3), **no resume/retry or chunk re-request**, **no offline/backfill delivery of files**.
- Mode-A zero-knowledge preserved: only `routingId` + opaque frames cross the wire. Mode B allowed (relay can decrypt, same caveat as text).
- AAD domain separation preserved and extended (see §5).

## 2. Constants (tunable defaults)
Defined in `packages/protocol` (shared) unless noted:
- `CHUNK_BYTES = 32 * 1024` — raw plaintext per chunk. base64(ciphertext+tag)+JSON ≈ 44 KB, safely under `MAX_FRAME_BYTES` (64 KB).
- `INLINE_IMAGE_MAX = 256 * 1024` — at/below this, an image offer is flagged `inline` (receiver may auto-accept).
- `MAX_FILE_BYTES = 100 * 1024 * 1024` — sender rejects larger files before offering. (Receiver holds the assembled Blob in memory; Spike C may lower this for iOS in sub-project 2.)
- `CREDIT_WINDOW = 32` — max unacked chunks in flight (~1 MB).
- `ACK_INTERVAL = 16` — receiver sends a `file-ack` every 16 received chunks (and on completion).
- `STALL_TIMEOUT_MS = 30_000` — an accepter silent this long is dropped from the transfer.
- Relay: `CHUNK_RATE = (2000, 10_000)` — a separate `SlidingWindowLimiter` budget for `file-*` frames (the existing `(20, 10_000)` limiter governs only `clip`/`delete`). `BUFFERED_AMOUNT_MAX = 8 * 1024 * 1024` — per-socket fan-out backpressure threshold.

## 3. Protocol (`packages/protocol`)
Add `PROTOCOL_VERSION = 1` and `protocolVersion: z.number().int()` to `HelloFrameSchema` (optional-with-default `1` for rolling-deploy compat, mirroring the `ephemeral` precedent). New `.strict()` schemas, with `fileId` an ULID (reuse `ULID_REGEX`), `iv`/`ciphertext` the existing `Base64`:

- `FileOfferSchema` `{ type:"file-offer", fileId, name: z.string().max(255), mime: z.string().max(255), size: z.number().int().nonnegative(), chunkCount: z.number().int().positive(), hash: z.string().regex(/^[0-9a-f]{64}$/), inline: z.boolean() }`
- `FileAcceptSchema` `{ type:"file-accept", fileId }`
- `FileDeclineSchema` `{ type:"file-decline", fileId }`
- `FileChunkSchema` `{ type:"file-chunk", fileId, index: z.number().int().nonnegative(), isFinal: z.boolean(), iv: Base64, ciphertext: Base64 }`
- `FileAckSchema` `{ type:"file-ack", fileId, upTo: z.number().int().nonnegative() }` — highest contiguous chunk index received.
- `FileCompleteSchema` `{ type:"file-complete", fileId }`
- `FileCancelSchema` `{ type:"file-cancel", fileId, reason: z.string().max(120) }`

All seven are added to **both** `ClientFrameSchema` and `ServerFrameSchema` discriminated unions (they are relayed verbatim, so the server forwards the same shape it receives).

## 4. Relay (`apps/relay`)
The relay stays **dumb fan-out** — it gains no transfer/content state.
- **Routing** (`ws-handlers.ts` `onMessage`): a `file-*` frame is broadcast to the room exactly like a `clip` (fan-out to all sockets except the sender). It is **never** passed to `pushRecent`/`addTombstone` and never touches `RoomDb`. (Only `clip` populates `recent`; `delete` still drives `removeRecent`/`addTombstone`; `file-*` does neither.)
- **Rate budget** (Spike B1): add `chunkLimiter = new SlidingWindowLimiter(2000, 10_000)`. In `onMessage`, frames whose `type` starts with `file-` are checked against `chunkLimiter`; `clip`/`delete` keep the existing `frameLimiter`. Both keyed per-socket as today. Exceeding `chunkLimiter` closes the socket with `RATE_LIMIT` (4429), same as the clip path.
- **Backpressure** (Spike B2): the `broadcast` helper, before `s.send(payload)`, checks `(s as ServerWebSocket).getBufferedAmount?.()`; if it exceeds `BUFFERED_AMOUNT_MAX`, skip that socket for this frame (do not buffer further). This is a memory backstop — under correct sender pacing it should rarely trigger. Skipping is silent at the relay; the affected receiver detects the gap via the manifest hash and fails locally.
- The relay does not parse manifests, track `fileId`s, or enforce a concurrency cap — concurrency is keyed by `fileId` in the engine (§5), so multiple transfers coexist, bounded by flow control + backpressure.

## 5. Crypto (`packages/crypto`)
Add a bytes envelope alongside the string one (`envelope.ts`), exported from `index.ts`:
- `encryptBytes({ key: CryptoKey, data: Uint8Array, aad: string }): Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer }>` — AES-256-GCM, fresh 12-byte IV, `additionalData = TextEncoder.encode(aad)`.
- `decryptBytes({ key, iv: BufferSource, ciphertext: BufferSource, aad: string }): Promise<Uint8Array>`.
- `sha256Hex(data: Uint8Array): Promise<string>` — lowercase hex SHA-256.
- Helpers feeding WebCrypto return `Uint8Array<ArrayBuffer>` (TS 5.7 `BufferSource`).

**Chunked-AEAD scheme (Spike-A-proven):** per chunk, `aad = `${routingId}:${fileId}:${index}:${isFinal}``. The **receiver authenticates each position against its OWN expected `(index, isFinal = index === chunkCount-1)`** — never the frame's self-declared values. On completion it verifies `sha256Hex(assembled) === manifest.hash`. This rejects reorder, truncation (by lying about count), cross-file splice, tamper, and wrong-room replay.

## 6. Client-core (`packages/client-core`)
New module `file-transfer.ts`, wired into `UniclipClient`. Keyed by `fileId`; multiple concurrent transfers (send and/or receive) coexist.

### New `UniclipClient` events (added to `ClientEvent`/`EventHandlers`)
- `file-offer` `(offer: { fileId, name, mime, size, chunkCount, hash, inline })`
- `file-progress` `(p: { fileId, dir: "send"|"recv", sent: number, total: number })` — `sent`/`total` in chunks.
- `file-received` `(r: { fileId, blob: Blob, name: string, mime: string })`
- `file-error` `(e: { fileId, code: string, message: string })`
- `file-cancel` `(c: { fileId, reason: string })`

### Sender API: `sendFile(file: { name, mime, bytes: Uint8Array })`
1. Reject if `bytes.length > MAX_FILE_BYTES` → `file-error{code:"TOO_LARGE"}`, no frame sent.
2. Mint `fileId = ulid()`; `chunkCount = max(1, ceil(bytes.length / CHUNK_BYTES))`; `hash = sha256Hex(bytes)`; `inline = mime.startsWith("image/") && bytes.length <= INLINE_IMAGE_MAX`.
3. Encrypt each chunk with `encryptBytes` as it is streamed (the plaintext is already in memory; ≤ MAX_FILE_BYTES).
4. Send `file-offer`. Begin streaming once the **first** `file-accept{fileId}` arrives. (The relay is authless: `file-accept`/`file-ack` frames carry no peer identity, so the sender cannot attribute them to specific devices. A device that accepts much later, after streaming has advanced, misses early chunks and fails its hash — acceptable best-effort for v0.2.)
5. **Flow control (pace to fastest acker):** maintain `nextChunk` and `ackedUpTo` (the **maximum** `upTo` across all `file-ack` frames received for this `fileId`). Stream while `nextChunk - ackedUpTo - 1 < CREDIT_WINDOW` and `nextChunk < chunkCount`; on each `file-ack`, raise `ackedUpTo` and resume. Emit `file-progress{dir:"send"}`. A slow receiver that lags beyond the window is not paced for individually — the relay's `BUFFERED_AMOUNT_MAX` gate (§4) drops chunks to its socket and that receiver fails its hash, leaving others unaffected.
6. **Stall handling:** if `ackedUpTo` does not advance for `STALL_TIMEOUT_MS`, abort with `file-error{code:"STALLED"}` + `file-cancel` (every receiver has gone silent).
7. After the final chunk, send `file-complete`. The send side considers itself done when `ackedUpTo === chunkCount-1` or it stalls/cancels.
8. `cancelFile(fileId)` → `file-cancel{reason:"sender_cancelled"}`, free buffers.

### Receiver
- On `file-offer`: emit the `file-offer` event. If `offer.inline`, the engine **auto-accepts** (sends `file-accept`) and starts receiving; otherwise it waits for the consumer to call `acceptFile(fileId)` / `declineFile(fileId)` (UI in sub-project 2; tests call these directly).
- On accept: allocate a chunk buffer of `chunkCount`. For each `file-chunk{fileId,index,isFinal,iv,ciphertext}`: `decryptBytes` with AAD using the receiver's **own expected** `(index, index===chunkCount-1)`. Store at `index`. Track the highest contiguous `upTo`; send `file-ack{upTo}` every `ACK_INTERVAL` chunks and when complete. Emit `file-progress{dir:"recv"}`.
- A chunk that fails to decrypt (AEAD reject) → abort that transfer with `file-error{code:"AUTH_FAILED"}` + `file-cancel`.
- On `file-complete` (or all chunks present): assemble `Blob` from the decrypted chunks; if `sha256Hex(assembled) !== offer.hash` → `file-error{code:"HASH_MISMATCH"}`, discard. Else emit `file-received{blob,...}`.
- On `file-cancel` for an in-progress receive: discard buffers, emit `file-cancel`.
- On disconnect (socket close): abort all in-progress transfers (live-only) with `file-error{code:"DISCONNECTED"}`.

## 7. Error handling summary
| Situation | Behavior |
|---|---|
| File > `MAX_FILE_BYTES` | Sender rejects pre-offer (`TOO_LARGE`); no frames sent |
| Chunk fails AEAD | Receiver aborts that transfer (`AUTH_FAILED`) + cancels |
| Hash mismatch on assemble | Receiver discards (`HASH_MISMATCH`) |
| `ackedUpTo` frozen > `STALL_TIMEOUT_MS` | Sender aborts the transfer (`STALLED`) — every receiver has gone silent |
| Relay socket over `BUFFERED_AMOUNT_MAX` | Relay skips that socket for the frame; that receiver fails via hash, others unaffected |
| `file-*` burst > `CHUNK_RATE` | Relay closes that socket (`RATE_LIMIT`) — DoS ceiling only |
| Disconnect mid-transfer | All in-progress transfers abort (`DISCONNECTED`) |

## 8. Testing
- **crypto unit**: `encryptBytes`/`decryptBytes` round-trip arbitrary bytes; `sha256Hex` known vector; the **7 chunked-AEAD adversarial cases** ported from the spike (multi-chunk + single-chunk round-trip; reorder; truncation-by-count; cross-file splice; tamper; wrong-routingId) — implemented over `encryptBytes`/`decryptBytes`.
- **protocol unit**: each new frame schema accepts a valid frame and rejects a malformed one (bad `hash` regex, missing field, extra key under `.strict()`); `HelloFrameSchema` defaults `protocolVersion` to 1 when absent.
- **relay integration** (real `Bun.serve`): a 42-`file-chunk` burst is **not** closed (separate `chunkLimiter`), while a 21-`clip` burst still is; a `file-offer`/`file-chunk` is fanned out to peers but leaves `recent`/`tombstones` empty and writes nothing to `RoomDb`; a socket reporting a high `getBufferedAmount()` is skipped by `broadcast` (use a stub socket).
- **client-core unit** (`MockWebSocket`): sender↔receiver round-trip assembles bytes equal to the input and verifies the hash; sender stops at `CREDIT_WINDOW` unacked and resumes on `file-ack`; the sender advances credit on the **maximum** `upTo` across acks (pace-to-fastest — two interleaved ack streams with different `upTo` advance it by the higher); if no ack raises `ackedUpTo` for `STALL_TIMEOUT_MS` the transfer aborts with `STALLED` (fake timers); a tampered chunk yields `AUTH_FAILED`; a wrong-hash manifest yields `HASH_MISMATCH`; `cancelFile` emits `file-cancel`; an `inline` offer auto-accepts (a `file-accept` is sent without a consumer call).

## 9. Files
- Modify: `packages/protocol/src/index.ts` (frames, `PROTOCOL_VERSION`, hello field, constants), `packages/protocol/src/index.test.ts`.
- Modify: `packages/crypto/src/envelope.ts` (bytes envelope + `sha256Hex`), `packages/crypto/src/index.ts` (exports); add `packages/crypto/src/bytes-envelope.test.ts` (+ the AEAD cases).
- Modify: `apps/relay/src/ws-handlers.ts` (file-* routing, `chunkLimiter`, bufferedAmount gate), `apps/relay/src/rate-limit.ts` (no change expected; reuse `SlidingWindowLimiter`); add `apps/relay/test/file-transfer.test.ts`.
- Create: `packages/client-core/src/file-transfer.ts`; modify `packages/client-core/src/client.ts` (events + `sendFile`/`acceptFile`/`declineFile`/`cancelFile` + chunk routing in `handleFrame`); add `packages/client-core/src/file-transfer.test.ts`.

## 10. Out of scope (→ sub-project 2 or later)
All web UI; Spike C (iOS Blob/clipboard limits) which may lower `MAX_FILE_BYTES`; WebRTC; persisted history; resume/retry; offline file delivery.
