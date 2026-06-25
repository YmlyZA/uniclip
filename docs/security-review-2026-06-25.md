# Security review — 2026-06-25 (post-v0.3, focus on the LAN surface)

Read-only pass over the trust boundaries against the documented invariants, with extra scrutiny on the new zero-internet code (`apps/cli`'s `lan-relay.ts`, `mdns.ts`, `lan-session.ts`, `lan-token.ts`). Scope: confidentiality (the zero-knowledge claim) and availability (DoS). Severity reflects realistic impact given the trusted-room, E2EE model.

## Summary

The **crypto core holds** — no confidentiality findings. The actionable work is **one Medium** (the embedded LAN relay has no resource limits) plus a few **Low / documentation** items on the inherently-unauthenticated LAN discovery layer. Nothing here breaks the zero-knowledge boundary: even a fully hijacked LAN relay sees only ciphertext, because the secret never leaves the QR.

| # | Severity | Area | One-liner |
|---|----------|------|-----------|
| 1 | **Medium** | `lan-relay.ts` | No connection cap / rate limit / frame budget → LAN DoS & memory exhaustion |
| 2 | Low | `mdns.ts` | Unauthenticated mDNS → spoofable routingId→host binding (degrades to DoS, not disclosure) |
| 3 | Low | `mdns.ts` | Device name broadcast in cleartext mDNS instance name (metadata leak) |
| 4 | Info | `lan-relay.ts` | Plain `ws://` transport — acceptable: the app-layer envelope is the security boundary |
| 5 | Info ✓ | crypto core | Invariants verified (IV, AAD, KDF, non-extractable keys, presence validation) |
| 6 | Low | `app.ts` | Public relay IP limit trusts `x-forwarded-for` (deploy-config concern, pre-existing) |

---

## Finding 1 — Embedded LAN relay has no resource limits (Medium)

**Evidence:** `apps/cli/src/lan-relay.ts` binds `0.0.0.0` (`:15`) and, per connection, fans every valid `ClientFrameSchema` frame to all other sockets (`:18-25, :35-42`) with **no** connection cap, per-socket rate limit, or per-IP limit. Contrast the public relay (`apps/relay/src/ws-handlers.ts`), which runs three `SlidingWindowLimiter` buckets (frame/chunk/signal) keyed per socket, plus a per-IP limiter.

**Impact:** `uniclip --lan` is explicitly for shared/untrusted networks (a café). Any device on the LAN that learns the `routingId` (broadcast in cleartext via mDNS) can:
- open unbounded sockets → the `sockets` Set grows without bound → host memory exhaustion;
- flood valid frames → each is amplified to every other peer → CPU/bandwidth DoS on the host and all legitimate peers.

It is a **denial-of-service / resource-exhaustion** vector, not a confidentiality break (frames stay opaque; the attacker cannot decrypt). Bounded to the LAN, but real for the tool's intended setting.

**Fix (the primary hardening task):**
- **Connection cap** — reject (close) new sockets beyond a small `MAX_LAN_PEERS` (the CLI use is host + a handful of joiners; e.g. 8). Prevents unbounded socket/Set growth.
- **Per-socket frame rate limit** — a sliding-window limiter per connection (mirror the relay's `SlidingWindowLimiter`; ~20 lines of pure TS, reusable or reimplemented in `apps/cli`); on breach, drop the frame or close the socket.
- **Keep** the existing `MAX_FRAME_BYTES` enforcement (`:37`) — already correct.
- Optional: idle-timeout sockets that never complete a handshake.

## Finding 2 — Unauthenticated mDNS rendezvous is spoofable (Low)

**Evidence:** `mdns.ts:32-39` — `discover()` resolves to the **first** advertised `_uniclip._tcp` service whose TXT `rid` matches the token's routingId. mDNS has no authentication.

**Impact:** A malicious LAN peer that sniffs the routingId off the air can advertise the same `rid` pointing at its own `host:port`, hijacking the joiner's connection to an attacker-controlled relay. **Crucially, this does not break confidentiality:** the secret never leaves the QR, so the attacker-as-relay (like the legitimate relay) only ever sees ciphertext + routingId + traffic metadata. The real host and joiner still derive the same key and E2EE each other even if their frames pass through a hostile relay. The residual harms are **availability** (the attacker can drop frames / refuse to forward WebRTC signaling, forcing or denying connectivity) and confirming the room exists (already public via mDNS).

**Fix:** This is inherent to unauthenticated mDNS and matches the spec's trusted-LAN threat model — **primarily document it** as an accepted limitation, emphasizing that E2EE neutralizes the disclosure risk. Optional robustness: if the first resolved host fails to connect, keep browsing other services with the same `rid` rather than giving up (handles both a stale advert and a non-forwarding impostor).

## Finding 3 — Device name leaks in the mDNS advert (Low)

**Evidence:** `lan-session.ts:8-9, :20` — the mDNS instance name is `uniclip <deviceName>`, broadcast in cleartext. Anyone on the LAN learns "`<deviceName>` is hosting a uniclip room." The **secret is not leaked** (TXT carries `rid` only — verified).

**Fix:** Either drop the device name from the advertised instance name (use a neutral/random label; the routingId already disambiguates), or document the leak. Low.

## Finding 4 — Plain `ws://` on the LAN relay (Informational, no action)

The embedded relay is unencrypted transport. This is acceptable: the **app-layer AES-GCM envelope is the security boundary**, not the transport. A LAN observer sees exactly the opaque ciphertext the relay sees; there is no incremental exposure, and signaling (SDP/ICE for a LAN P2P) is non-sensitive. Adding TLS would mean self-signed certs with no trust anchor — net negative. No change.

## Finding 5 — Crypto core verified (Informational, positive)

Confirmed against source:
- **AES-256-GCM**, fresh **random 96-bit IV per message** (`envelope.ts:19,60` via `crypto.getRandomValues`). At clipboard message volumes the GCM random-IV birthday bound is irrelevant.
- **AAD domain separation** is disjoint across contexts: `${routingId}:${msgId}` (clips), `presence:${routingId}` (presence, `presence.ts:42`), `persist:${roomId}` (at-rest) — a stored or presence blob can't be replayed as a live clip.
- **PBKDF2-SHA256, 200k iterations**, keys **non-extractable by default** (`key.ts:38`) — resists key exfiltration via XSS/extension.
- **Presence is validated after decrypt** (`presence.ts:62-73`): wrong-key/tampered frames are dropped; name length-capped; self-echo ignored.
- **Signaling stays WS-only** (`client.ts` `via !== "ws"` guards) — a P2P peer cannot inject SDP/ICE/presence.
- `ReplaySet` dedups by msgId. No issues.

## Finding 6 — Public relay IP limit trusts `x-forwarded-for` (Low, pre-existing, deploy-config)

`app.ts:42` derives the rate-limit key from `x-forwarded-for`, defaulting to `"unknown"`. Behind the provided Caddy/`deploy/` config this is set correctly, but a misconfigured deploy (no trusted proxy) either buckets all clients together or lets an attacker spoof the header to evade the `/api/room` limit. **Fix:** document that the relay must run behind a proxy that sets a trustworthy client IP (the `deploy/` Caddyfile already does).

---

## Recommended hardening (Arc A, workstream 2)

1. **Finding 1 (build):** add a connection cap + per-socket sliding-window frame limiter to `lan-relay.ts` (the one concrete code task; TDD it). ← primary
2. **Finding 3 (build, small):** neutral mDNS instance name.
3. **Findings 2 & 6 (docs):** add accepted-limitation notes to the spec/CLAUDE.md (mDNS is unauthenticated but E2EE-safe; relay needs a trusted-IP proxy). Optional: Finding 2's "keep browsing on connect failure" robustness tweak.

No confidentiality fixes are required — the zero-knowledge boundary is intact on every path reviewed.
