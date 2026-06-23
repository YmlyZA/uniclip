# Uniclip — WebRTC Fast Path (Phase 3 v0.3, sub-project 1 / "P1") — Design Spec

**Date:** 2026-06-22
**Status:** Approved (pending spec review)
**Scope:** Add a peer-to-peer WebRTC `RTCDataChannel` that carries the **existing** encrypted frames, with the relay demoted to **signaling + presence + content fallback**. Content flows P2P (LAN-direct when peers share a network) when the channel is open, and silently falls back to today's relay fan-out otherwise. No new UI beyond a transport indicator. The crypto envelope, file engine, and frame shapes are unchanged — only the *transport under them* changes.

## 0. Program context (why this is "P1")

This is the keystone sub-project of a four-part architectural pivot: demote the relay from a content fan-out to a discovery/signaling server (the "Tailscale model"), with the real data path peer-to-peer. The user's product philosophy is **portable, zero-install, use-and-discard** — not multi-device/HA (otherwise native apps would be the answer). The full decomposition, each with its own spec→plan→build cycle:

- **P1 — WebRTC fast path (this spec).** Data channel + signaling over the relay WS; hybrid fallback. Delivers LAN-direct transfer and the Phase-1 "no-cloud data path" (handshake-only internet).
- **P2 — Pairing & presence.** QR pairing, device self-naming, "who's connected" list (derived from the signaling room the relay already tracks).
- **P3 — Durability polish.** Richer local encrypted history + P2P backlog exchange on connect (the hybrid already gives store-and-forward via the relay-backfill fallback).
- **P4 — CLI + true zero-internet.** mDNS discovery + local signaling, reusing `protocol`/`crypto`. The Phase-2 offline goal (works with no WAN at all).

**Chosen durability model:** *Hybrid — P2P fast, relay fallback.* Keep today's relay fan-out (which already has Mode-A backfill = store-and-forward) and bolt WebRTC on as the fast path. This makes P1 **purely additive and low-risk**: nothing about today's behavior is removed; a peer that never establishes P2P behaves exactly as it does today.

## 1. Goals and non-goals

### Goals
1. When two peers in a room can reach each other, route all content frames (`clip`, `delete`, `file-*`) over a single `RTCDataChannel` instead of the relay — **LAN-direct** when they share a network, NAT-traversed (public STUN) when remote.
2. Demote the relay to **signaling** (forward opaque SDP/ICE), **presence** (unchanged hello/peer-joined/peer-left), and **content fallback** (today's fan-out) when P2P is unavailable.
3. Seamless, no-user-action fallback: if ICE never completes or the channel drops, content keeps flowing over the WS with no error and no message loss.
4. Preserve every security invariant: app-layer AES-256-GCM stays on top of WebRTC's DTLS, so content is opaque on **every** path (P2P, relay-fallback, any future TURN). The relay never sees keys or plaintext.
5. A `transport: "p2p" | "relay"` client event so the UI can show a **"Direct / LAN"** vs **"Relayed"** badge.

### Non-goals / preserved invariants
- **No TURN server.** When NAT traversal fails, the *fallback is the relay fan-out itself*, so we never pay for a media-TURN relay. STUN-only for discovery.
- **No N-peer mesh optimization.** The target is the 2-peer ad-hoc case (laptop ↔ phone). Signaling is broadcast-to-room; perfect negotiation handles the 2-peer case correctly. >2 peers degrade gracefully to relay (see §6).
- **No change to the crypto envelope, file-transfer engine, AAD scheme, or frame *payload* shapes** — only two new *signaling* frame types are added.
- **No persistence change.** Signaling frames are never buffered, tombstoned, or written to `RoomDb`. The relay gains no content state.
- **No CLI / true zero-internet** (that is P4). P1's offline reach is "no-cloud data path": LAN-direct P2P with handshake-only internet.
- Mode-A zero-knowledge preserved: only `routingId` + opaque frames (now including opaque SDP/ICE) cross the wire to the relay.

## 2. Constants (tunable defaults)

Defined in `packages/protocol` unless noted:
- `ICE_SERVERS` (client config default) — `[{ urls: "stun:stun.l.google.com:19302" }]`. **Public STUN for P1; self-hosted coturn is a later phase.** STUN reveals only the public IP needed to discover it (which any connected server already sees). Overridable via `UniclipClientOptions` so the deploy can point at a self-hosted STUN without code change.
- `DATACHANNEL_LABEL = "uniclip"` — single negotiated-in-band reliable, ordered data channel.
- `P2P_CONNECT_TIMEOUT_MS = 8_000` — if the data channel hasn't opened within this window of a peer being present, stay on the relay (no error). A later peer-join re-arms the attempt.
- Relay: `SIGNAL_RATE = (200, 10_000)` — a dedicated `SlidingWindowLimiter` budget for `sdp`/`ice` frames (ICE trickle is bursty but bounded; do not bill it against the `(20, 10_000)` clip limiter or the `(2000, 10_000)` file limiter).

## 3. Protocol (`packages/protocol`)

Two new `.strict()` signaling frames. They carry WebRTC negotiation blobs — **never content**. `from` is a per-connection random peer id (see §5) used for perfect-negotiation politeness; the relay does not assign or validate it.

- `SdpFrameSchema` `{ type:"sdp", from: z.string().max(64), description: z.object({ type: z.enum(["offer","answer"]), sdp: z.string().max(16*1024) }).strict() }` — a single-data-channel SDP is ~1–4 KB; the 16 KB cap leaves ample headroom under `MAX_FRAME_BYTES` after JSON wrapping.
- `IceFrameSchema` `{ type:"ice", from: z.string().max(64), candidate: z.string().max(4096) }` — a single serialized ICE candidate string (trickle). End-of-candidates is signaled by an empty `candidate: ""`.

Both are added to **both** `ClientFrameSchema` and `ServerFrameSchema` (relayed verbatim — the server forwards the same shape it receives). `PROTOCOL_VERSION` stays `1`: an old relay rejects unknown frames at `ClientFrameSchema.safeParse` and simply never forwards them, so a new client transparently falls back to relayed content against an un-upgraded relay (graceful — see §6).

The `description.sdp` and `candidate` size caps keep a signaling frame under `MAX_FRAME_BYTES` (64 KB) so the existing relay length guard is unaffected.

## 4. Relay (`apps/relay`)

The relay stays **dumb fan-out**; it gains no P2P/connection state.
- **Routing** (`ws-handlers.ts` `onMessage`): `sdp`/`ice` frames are broadcast to the room exactly like a `clip` (fan-out to all sockets except the sender) via the existing `broadcast` helper. They are **never** passed to `pushRecent`/`addTombstone`/`RoomDb`. Because the existing buffer code only matches `type === "clip"` / `type === "delete"`, signaling falls through to "forward only" with no change to that branch — only the schema union and the rate-limit routing change.
- **Rate budget:** add `signalLimiter = new SlidingWindowLimiter(200, 10_000)`. In `onMessage`, route by type: `sdp`/`ice` → `signalLimiter`; `file-*` → `chunkLimiter`; else → `frameLimiter`. Exceeding closes the socket with `RATE_LIMIT` (4429), same as today.
- **Broadcast targeting:** signaling is room-broadcast (no per-peer addressing on the relay). For 2 peers this is exactly right. For >2 peers, every peer receives every offer; perfect negotiation + `from`-based dedup means peers settle into one connection and the rest stay relayed (acceptable — mesh is a non-goal).
- The relay does not parse SDP, learn `fileId`s, or track connection state. **Privacy note:** SDP/ICE contain IP candidates, so the relay transiently observes peer candidate IPs during negotiation. The relay already sees each peer's socket IP, so this is not a new *relay* exposure; the new exposure is peer↔peer (see §7).

## 5. Client-core (`packages/client-core`)

### 5.1 Transport seam
Today every outbound frame goes through `this.ws.send(payload)` and `FileTransferManager` was constructed with an injected `send` callback (`client.ts:67`). P1 introduces a single chooser:

```
sendFrame(frame): boolean
  if peerLink.isOpen():  peerLink.send(JSON.stringify(frame)); return true
  if ws OPEN:            ws.send(JSON.stringify(frame));       return true
  return false           // caller decides: clip → enqueue; file-* → fail (live-only)
```

- `send()` (clip): try `sendFrame`; if false, enqueue exactly as today (offline queue is unchanged and remains WS-tied — queued clips flush on the next `hello`).
- `delete()`: same `sendFrame`-or-enqueue path as today.
- `FileTransferManager`'s injected `send` callback is repointed to `sendFrame` (one-line change), so an entire file transfer rides whichever pipe is live. File transfers remain **live-only** (never queued) on both pipes.

**Inbound:** both `ws.onmessage` and `peerLink.onmessage` call the *unchanged* `handleFrame`. `handleFrame` already validates with `ServerFrameSchema` and dedups clips via `ReplaySet` by `msgId`, so a frame that (rarely) arrives on both pipes during a transport switch is idempotent. `sdp`/`ice` frames are consumed by the `PeerLink` (routed in `handleFrame` before the content switch) and never surface as content events.

### 5.2 `peer-link.ts` (new module)
Wraps one `RTCPeerConnection` + one `RTCDataChannel`, implements **perfect negotiation**, and emits `open` / `close` / `message`.
- **Injectable factory:** the constructor takes a `createConnection: (config) => RTCPeerConnectionLike` (default: `(c) => new RTCPeerConnection(c)`). Node has no `RTCPeerConnection`, so unit tests inject a fake — the same dependency-injection pattern as `FileTransferManager`.
- **Signaling out:** the `PeerLink` is given a `signal(frame)` callback that serializes an `sdp`/`ice` frame onto the **WS transport** (always the WS — signaling cannot ride the channel it is establishing).
- **Politeness:** each `PeerLink` generates a random `from` id (ULID) at construction. On an SDP collision, the peer with the lexicographically **smaller** `from` is *polite* (rolls back and accepts the incoming offer); the other is *impolite* (ignores the incoming offer). No server-assigned identity needed.
- **Lifecycle:** a peer attempts negotiation when `peerCount >= 2`. The data channel is created by the impolite side and `negotiationneeded` drives the offer. `iceconnectionstate`/`connectionstate` transitions to `connected` → emit `open`; `failed`/`disconnected`/`closed` → emit `close`.
- **Trickle ICE:** `onicecandidate` → `signal({type:"ice", ...})`; an incoming `ice` frame → `addIceCandidate`. Empty candidate = end-of-candidates.

### 5.3 `UniclipClient` integration
- Owns one `PeerLink`. On `hello`/`peer-joined` with `peerCount >= 2`, arm the `PeerLink`; on `peer-left` to `< 2`, tear it down.
- New event `{ kind: "transport", value: "p2p" | "relay" }`, emitted on data-channel open (`p2p`) and on close/teardown/fallback (`relay`). Default is `relay` until a channel opens.
- `handleClose` (WS drop) and a new `PeerLink` close both abort live file transfers (`transfers.abortAll`) — extend today's WS-close logic to the channel-close case.
- `disconnect()` also closes the `PeerLink`.

## 6. Data flow and fallback

1. Client derives key, opens WS (`/ws/<routingId>`) → `hello` → status `connected`, peer count, room info, queue flush. **Identical to today.** Transport starts as `relay`.
2. If `peerCount >= 2`, both peers arm `PeerLink` and exchange `sdp`/`ice` over the WS. ICE discovers host/mDNS (LAN), srflx (STUN) candidates.
3. On `datachannel.open` → emit `transport: "p2p"`; `sendFrame` now prefers the channel. LAN-direct when both on the same network. **Inbound `sdp`/`ice` are accepted only from the WS pipe** (`handleFrame(raw, via)` drops signaling when `via === "p2p"`) — signaling can never ride the channel it establishes, in either direction.
4. **Fallback paths (all silent, no message loss):**
   - ICE never completes → transport simply stays at its default `relay` (no timer needed; there is no error to suppress, so no `P2P_CONNECT_TIMEOUT_MS` is wired — the default-`relay` state *is* the guarantee).
   - Channel/connection drops mid-session → `onconnectionstatechange`/channel `onclose` → emit `transport: "relay"`, content immediately rides the WS again. The peer is re-armed on the next presence transition (it is not auto-renegotiated in place).
   - Old relay (no `sdp`/`ice` support) → signaling frames are dropped by the relay's `safeParse`; ICE never completes → permanent `relay`. New client + old relay = today's behavior.
5. The WS is **never** closed while connected — it is signaling + presence + fallback for the whole session.

**Known limitation — reconnect role re-arming (RESOLVED by the reconnect-hardening follow-up — see `2026-06-23-uniclip-webrtc-reconnect-hardening-design.md`; this section describes the original P1 behavior).** Roles are assigned by join order: the incumbent receives `peer-joined` → `initiator` (creates the data channel); the newcomer receives its own `hello` with `peerCount >= 2` → `responder`. A **single-peer** WS reconnect self-heals: the stable peer sees `peer-left` then `peer-joined` (→ `initiator`), the reconnector sees `hello` (→ `responder`) — distinct roles, P2P re-forms. A **simultaneous double-reconnect** can race so that both still-present peers take the `hello` → `responder` branch; since only the `initiator` creates the channel, neither does, and the pair **stays `relay` (lossless — content keeps flowing over the WS)** until the next join/leave re-assigns roles. This degrades to the intended fallback, never loses or duplicates a message. The robust fix (revive the per-connection `from` id as a deterministic initiator tiebreak so P2P self-heals under any reconnect) is deferred — see §9.

## 7. Security model

- **Content opaque everywhere.** App-layer AES-256-GCM (existing envelope, existing `${routingId}:${msgId}` / `${routingId}:${fileId}:...` AAD) wraps every content frame *before* it enters either pipe. WebRTC's DTLS is a second, transport-level layer; we do not rely on it for confidentiality, and its keys are not derived from the room secret. A malicious relay (fallback path) or any future TURN sees only ciphertext.
- **Relay remains zero-knowledge and metadata-only.** It forwards opaque SDP/ICE and (on fallback) opaque ciphertext; it persists none of it. No content column, no key, no connection state. Mode-A secret stays in the URL fragment only.
- **New tradeoff — peer↔peer IP visibility.** P2P inherently exposes each peer's IP candidates to the other peer (and transiently to the relay via SDP). For the dominant "my laptop ↔ my phone" case this is a non-issue. For sharing a room with another person it reveals your IP to them. Mitigations: browsers emit mDNS `.local` candidates by default (private IPs hidden); the relay already saw your socket IP; this is consistent with the **trusted-room** model (any peer in the room is already trusted with plaintext). Documented as accepted; revisit if/when rooms become shareable with semi-trusted parties.
- **No new amplification/DoS surface beyond `signalLimiter`.** Signaling is rate-limited per socket like every other frame.

## 8. Testing

- **`protocol`:** `sdp`/`ice` accept valid shapes; reject oversize `sdp`/`candidate`, bad `description.type`, extra keys (`.strict()`).
- **`relay`:** `sdp`/`ice` fan out to other sockets; are **not** replayed to a newcomer (no buffering); are billed to `signalLimiter` (exceeding it closes the socket); `file-*` and `clip` limiters are unaffected.
- **`client-core` (injected fake `RTCPeerConnection`):**
  - `sendFrame` prefers an open channel, falls back to WS when closed, enqueues a clip when both are down.
  - Inbound content over the fake channel reaches `handleFrame` and emits the same events as the WS path; a duplicate over both pipes is deduped by `ReplaySet`.
  - Perfect-negotiation politeness: smaller-`from` peer rolls back on collision; larger-`from` peer does not.
  - `transport` event fires `p2p` on open, `relay` on close; file transfers abort on channel close.
  - `peer-left` to `< 2` tears down the `PeerLink`.
- **e2e (Playwright, two Chromium contexts):** a clip sent from A appears on B **and** the "Direct" badge appears (loopback ICE completes in Chromium). A relay-only regression run (ICE disabled via injected empty `ICE_SERVERS` + blocked candidates, or a test flag forcing `relay`) confirms content still flows and the badge reads "Relayed."

## 9. Open implementation details (decide in the plan, not here)
- Exact `RTCPeerConnectionLike` interface surface (minimal subset used) for the injectable seam.
- Whether the data channel is created with `{ ordered: true }` only, or also negotiated `id` for determinism.
- Renegotiation backoff after a mid-session channel drop (one immediate attempt vs. bounded retry).
- Web UI badge placement (header, near the existing sync/status indicators) — cosmetic, can ride the P2 pairing/presence work.

## 10. Deferred follow-ups (not in P1 as built)
- **Robust reconnect re-arming (`from` tiebreak). — DONE (2026-06-23).** Shipped as the reconnect-hardening follow-up (`2026-06-23-uniclip-webrtc-reconnect-hardening-design.md`): each peer announces its per-connection `from` via a new `rtc-hello` frame and the larger `from` is the sole initiator, so role assignment is deterministic and self-heals under any reconnect order. Replaced the join-order arming entirely.
- **Self-hosted STUN / explicit relay-as-TURN-equivalent semantics.** P1 uses public STUN; a later phase may self-host (spec §2).
