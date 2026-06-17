# Phase 2 Research — Binary (images / files / media) over uniclip

**Date:** 2026-06-17
**Status:** Research framing + Spike A complete. Not yet a spec.
**Context:** v0.1 is text-only, end-to-end encrypted, relay-is-zero-knowledge. Phase 2 adds image/file/media transfer without breaking that.

## Locked v0.2 decisions (from framing)
- **Transport:** relay-relayed chunks (reuse the WebSocket); WebRTC P2P deferred to v0.3 if relay bandwidth becomes the bottleneck.
- **Scope:** images **and** arbitrary files.
- **At-rest:** download-and-forget (no persisted binary history in v0.2; localStorage is out — base64-MB + ~5 MB cap).
- **Buffering:** live-only — binary never enters the backfill ring; both peers must be connected (surfaced in UI).
- **UX:** one transfer path for everything — offer → accept → chunks → complete; images additionally get an inline thumbnail + download; non-images show a file card.

## Hard constraints in the current codebase (grounded)
- **Crypto is text-only.** `encrypt({plaintext: string})` / `decrypt(): string` use `TextEncoder`/`TextDecoder` (`packages/crypto/src/envelope.ts`). Binary needs a **bytes path** (`encryptBytes(key, Uint8Array, aad) → bytes`, `decryptBytes → Uint8Array`). The `toBase64`/`fromBase64` helpers already accept `ArrayBuffer`/`Uint8Array`.
- **64 KB frame cap.** `MAX_FRAME_BYTES = 64*1024`; the relay closes the socket above it. → must chunk; a JSON+base64 frame is ~1.33× its payload, so a ~24–32 KB raw chunk fits one frame safely.
- **Relay is pure in-memory fan-out.** `broadcast()` forwards JSON strings; the only retained content is the Mode-A backfill ring (`RECENT_CAP=50`), memory-only, cleared on empty. Binary must NOT enter it.
- **Protocol = Zod discriminated union on `type`.** New `file-*` variants + a `protocolVersion` in `hello` for graceful old-client rejection.
- **AAD domain separation.** `${routingId}:${msgId}` (wire), `persist:${roomId}` (at-rest). Binary chunks add a new dimension (see Spike A).
- **Persistence is metadata-only** (`RoomDb`). No content column, ever.

## Spike A — chunked AEAD (DONE, validated)

### Validated scheme
- A file gets a random `fileId`. Plaintext is split into fixed-size chunks; the last is flagged `isFinal`.
- Each chunk: **AES-256-GCM, fresh 12-byte IV, AAD = `${routingId}:${fileId}:${index}:${isFinal}`**.
- A **manifest** carries `{ fileId, name, mime, size, chunkCount, sha-256(plaintext) }`.
- **Receiver authority rule (the crux):** the receiver decrypts the chunk at position `i` using its OWN expected `(index = i, isFinal = i === chunkCount-1)` in the AAD — it never trusts a frame's self-declared index/final. On completion it verifies the reassembled SHA-256 against the manifest.

### Why each property holds (proven by 7 adversarial tests)
| Attack | Defeated by | Test result |
|---|---|---|
| Reorder chunks | AAD binds `index`; ciphertext for index 2 fails to auth when decrypted as index 0 | REJECTED ✓ |
| Truncation hidden by lowering claimed `chunkCount` | the new "last" chunk was sealed with `isFinal=false`; receiver decrypts it expecting `isFinal=true` → auth fail | REJECTED ✓ |
| Cross-file splice | AAD binds `fileId` | REJECTED ✓ |
| Single-bit tamper | GCM tag | REJECTED ✓ |
| Wrong-room replay | AAD binds `routingId` (domain separation) | REJECTED ✓ |
| Honest multi-chunk + single-chunk | — | ROUND-TRIPS ✓ |

The spike test was a throwaway (`packages/crypto/src/chunked-aead.spike.test.ts`, removed after validation). The scheme above is what the v0.2 spec should encode.

### Implications for the v0.2 `crypto` API
- Add `encryptBytes({ key, data: Uint8Array, aad: string }) → { iv, ciphertext }` and `decryptBytes({ key, iv, ciphertext, aad }) → Uint8Array` (mirror the existing string envelope; reuse `IV_BYTES`, base64 helpers).
- A `sha256(data) → hex` helper for the manifest hash.
- Keep helpers returning `Uint8Array<ArrayBuffer>` (TS 5.7 / WebCrypto `BufferSource`).

## Spike B — relay under chunked load (DONE)

Empirically confirmed against the real `Bun.serve` relay (throwaway test, removed). Two findings, both of which shape the v0.2 protocol:

### Finding B1 (CRITICAL) — the frame rate limiter kills a transfer
The per-socket `frameLimiter = SlidingWindowLimiter(20, 10_000)` (20 frames / 10 s) counts **every** valid frame. A ~1 MB file at ~24 KB/chunk ≈ 42 `file-chunk` frames sent back-to-back trips the limit at frame 21: the relay emits a `RATE_LIMIT` error and **closes the socket (4429)**. Measured: only 20 of 42 chunks fan out before the close. **Fire-and-forget chunking is impossible as-is.**
- **v0.2 requirement:** `file-chunk` frames must NOT share the clip limiter's budget. Options: a separate, transfer-sized limiter (e.g. a byte/sec budget per socket), or exempt `file-chunk` from the frame-count limiter and bound transfer rate via flow control (B2) instead. The clip/delete limiter stays as-is for control frames.

### Finding B2 (read-confirmed) — no backpressure handling
`broadcast()` calls `ws.send(payload)` and ignores the return value. Bun's `ServerWebSocket.send` returns `-1` under backpressure; ignoring it means a **slow receiver makes the relay buffer the sender's chunks in memory**, unbounded, for the duration of a large transfer.
- **v0.2 requirement:** flow control so the sender can't outrun the slowest receiver — a **credit/ack scheme** (receiver acks every K chunks; sender pauses until acked) and/or the relay gating on `ws.getBufferedAmount()` before forwarding. This also naturally bounds the rate, dovetailing with B1.

### Net effect on the design
The transfer protocol is **not** fire-and-forget. It needs flow control (acks/credits), which means the protocol sketch below gains a `file-ack` frame and the sender paces chunks. This is the single biggest delta Spike B surfaced.

## Still-open spike
- **Spike C — browser limits on the constrained target (iOS Safari):** Blob reassembly memory ceiling for large files; `navigator.clipboard.read()` for pasting an image; download trigger reliability. (At-rest is download-and-forget, so OPFS is NOT needed for v0.2.) Can be run during implementation rather than before the spec — it informs UI/size-cap details, not the protocol.

## Proposed v0.2 protocol surface (sketch — to be finalized in the spec)
- `file-offer` `{ fileId, name, mime, size, chunkCount, hash }`
- `file-accept` `{ fileId }` / `file-decline` `{ fileId }`
- `file-chunk` `{ fileId, index, isFinal, iv, ciphertext }`
- `file-ack` `{ fileId, upTo }` (receiver → sender flow control; sender pauses until acked — see Finding B2)
- `file-complete` `{ fileId }` (sender signals end; receiver also knows from `isFinal` + count)
- `file-cancel` `{ fileId }` (either side aborts)
- `hello` gains `protocolVersion`.
- **Rate limiting:** `file-chunk` gets its own budget, separate from the clip/delete frame limiter (Finding B1). The credit/ack flow control (B2) is the primary pace governor.

## Invariants to preserve (do not break)
- Mode-A zero-knowledge: chunks are ciphertext the relay can't read; only `routingId` + opaque frames cross the wire.
- Relay holds no binary content (no backfill ring entry, no DB column).
- AAD domain separation extended cleanly (`fileId:index:isFinal` is disjoint from `msgId` and `persist:`).
