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

## Still-open spikes (recommended before/with the spec)
- **Spike B — relay under load:** N concurrent chunked transfers through the in-memory fan-out. Does it hold? Is per-room/socket transfer backpressure or a concurrent-transfer cap needed? (The relay currently has per-socket/IP frame-rate limits — a sustained chunk stream may trip them; the limit may need a separate budget for `file-chunk`.)
- **Spike C — browser limits on the constrained target (iOS Safari):** Blob reassembly memory ceiling for large files; `navigator.clipboard.read()` for pasting an image; download trigger reliability. (At-rest is download-and-forget, so OPFS is NOT needed for v0.2.)

## Proposed v0.2 protocol surface (sketch — to be finalized in the spec)
- `file-offer` `{ fileId, name, mime, size, chunkCount, hash }`
- `file-accept` `{ fileId }` / `file-decline` `{ fileId }`
- `file-chunk` `{ fileId, index, isFinal, iv, ciphertext }`
- `file-complete` `{ fileId }` (sender signals end; receiver also knows from `isFinal` + count)
- `file-cancel` `{ fileId }` (either side aborts)
- `hello` gains `protocolVersion`.
Rate-limit `file-chunk` on its own budget so a transfer doesn't trip the clip frame limiter.

## Invariants to preserve (do not break)
- Mode-A zero-knowledge: chunks are ciphertext the relay can't read; only `routingId` + opaque frames cross the wire.
- Relay holds no binary content (no backfill ring entry, no DB column).
- AAD domain separation extended cleanly (`fileId:index:isFinal` is disjoint from `msgId` and `persist:`).
