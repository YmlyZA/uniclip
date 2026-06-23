# Uniclip — WebRTC Reconnect Hardening (deterministic P2P role via `from`) — Design Spec

**Date:** 2026-06-23
**Status:** Approved (pending spec review)
**Scope:** Replace the join-order role assignment in the WebRTC fast path with an **identity-based handshake**, so P2P deterministically (re)forms regardless of join/reconnect ordering. Closes the §10 limitation of the P1 spec (`2026-06-22-uniclip-webrtc-fast-path-design.md`): a simultaneous double-reconnect could leave both peers as `responder` (so neither creates the data channel) and stuck on the relay until the next presence change.

## 1. Goal and non-goals

### Goal
Make the choice of which peer creates the data channel a function of **stable per-connection identity** (`from`), not transient presence events. Exactly one peer (the larger `from`) becomes the initiator and offers; the connection self-heals on any reconnect, single- or double-, in any order.

### Non-goals / preserved invariants
- No change to crypto, the transport seam (`sendFrame`), the relay-fallback path, the `transport` badge, or the file engine.
- No change to the security model: signaling stays content-free, opaque to the relay, never buffered/persisted, and **WS-only in both directions** (the new frame is gated by the same `via` guard as `sdp`/`ice`).
- Not adding presence/device identity, multi-peer mesh, or TURN. `from` is a per-`PeerLink` random ULID with no cross-session meaning — it exists only to break the initiator tie within one handshake.

## 2. Protocol (`packages/protocol`)

Add one `.strict()` frame; it carries only the announcing peer's `from` (no content):

- `RtcHelloSchema` `{ type: "rtc-hello", from: z.string().max(64) }`

Added to **both** `ClientFrameSchema` and `ServerFrameSchema` (relayed verbatim). `PROTOCOL_VERSION` stays `1`: an un-upgraded relay rejects it at `safeParse` and never forwards it, so peers simply never exchange identity and fall back to relayed content — the same graceful degradation as `sdp`/`ice` against an old relay.

## 3. Relay (`apps/relay`)

The relay stays dumb fan-out and gains no state. `rtc-hello` is forwarded by the existing `broadcast` and is never buffered/tombstoned/persisted (it falls outside the `clip`/`delete` branch, exactly like `sdp`/`ice`). The only change is rate-limit routing: bill `rtc-hello` to the existing `signalLimiter` alongside `sdp`/`ice`:

```ts
const limiter =
  t === "sdp" || t === "ice" || t === "rtc-hello" ? signalLimiter
  : t.startsWith("file-") ? chunkLimiter
  : frameLimiter;
```

## 4. client-core — `PeerLink` (`packages/client-core/src/peer-link.ts`)

### 4.1 Remove the `role` constructor param; resolve role from identity
- `PeerSignal` gains a third variant: `type: "sdp" | "ice" | "rtc-hello"`. `rtc-hello` uses only `from` (no `description`/`candidate`).
- `PeerLinkOptions` **drops `role`**. (The `PeerRole` type may be removed; it has no other consumer.)
- New private field `peerFrom: string | null = null` (and an idempotence guard so role resolves once).

**`start()`** now does NOT branch on role and does NOT create a channel or set `onnegotiationneeded`. It:
1. creates the `RTCPeerConnection`, wires `onicecandidate` and `onconnectionstatechange` (unchanged),
2. wires `pc.ondatachannel = (ev) => this.wireChannel(ev.channel)` **always** (a peer that turns out to be the responder receives the channel here),
3. sends its own identity: `this.opts.signal({ type: "rtc-hello", from: this.from })`.

**`handleSignal`** gains a `rtc-hello` case handled *before* the `sdp`/`ice` logic:
```ts
if (s.type === "rtc-hello") {
  if (this.peerFrom !== null) return;      // resolve once
  this.peerFrom = s.from;
  if (this.from > s.from) {                // larger `from` = sole initiator
    this.pc!.onnegotiationneeded = () => void this.makeOffer();
    this.wireChannel(this.pc!.createDataChannel(DATACHANNEL_LABEL, { ordered: true }));
  }
  return;                                  // responder waits for ondatachannel + offer
}
```
Because exactly one peer offers, glare cannot occur in normal operation. The existing offer/answer/ICE handling is unchanged except politeness is now identity-based as a defensive backstop: `const polite = this.peerFrom !== null ? this.from < this.peerFrom : true` (smaller `from` yields). `peerFrom` is always set before any `sdp` arrives, because the initiator sends `rtc-hello` before it offers.

### 4.2 Ordering safety
`UniclipClient` arms the `PeerLink` (calls `start()`) **synchronously** inside the `hello`/`peer-joined` handler, before the next inbound frame is processed, so `this.pc` always exists by the time the peer's `rtc-hello` is handled. (If a future change could deliver `rtc-hello` before `start()`, `handleSignal`'s `if (!pc) return` would drop it — acceptable: it degrades to relayed, never crashes. Noted, not handled, since the synchronous-arm invariant holds today.)

## 5. client-core — `UniclipClient` (`packages/client-core/src/client.ts`)

- `armPeer()` **drops its `role` parameter** and no longer passes `role` to `PeerLink`. The `PeerRole` import is removed.
- Presence handling collapses the role split:
  ```ts
  case "hello": … if (frame.peerCount >= 2) this.armPeer(); return;
  case "peer-joined": … if (frame.peerCount >= 2 && !this.peer) this.armPeer(); return;
  case "peer-left": … if (frame.peerCount < 2) this.teardownPeer(); return;
  ```
- `handleFrame`'s signaling case extends to `rtc-hello`, keeping the WS-only guard:
  ```ts
  case "sdp": case "ice": case "rtc-hello":
    if (via !== "ws") return;
    await this.peer?.handleSignal(frame as PeerSignal);
    return;
  ```
- On reconnect, `handleClose` → `teardownPeer()` (unchanged); the fresh `hello`/`peer-joined` re-arms, each `PeerLink` generates a new `from` and re-announces, and the larger-`from` peer initiates. Deterministic for every ordering — the §10 limitation is closed.

## 6. Data flow (the handshake)

1. `peerCount` reaches ≥ 2 → both peers `armPeer()` → each `PeerLink.start()` wires `ondatachannel`, sends `rtc-hello {from}` over the WS.
2. Each peer receives the other's `rtc-hello`, sets `peerFrom`, and resolves: larger `from` → create channel + offer; smaller `from` → wait.
3. Initiator's `onnegotiationneeded` → offer → responder answers → ICE → `datachannel.open` → `transport: "p2p"` (unchanged from here on).
4. Fallbacks unchanged: no `rtc-hello` exchange (old relay) or no channel open → stays `relay` (lossless). A reconnect re-runs the handshake from step 1.

## 7. Testing

- **`protocol`:** `rtc-hello` accepts `{ type, from }`; rejects missing/oversized `from` and extra keys (`.strict()`); appears in both unions.
- **`relay`:** extend `signaling.test.ts` — an `rtc-hello` fans out to the other peer, is not replayed to a late joiner, and is billed to `signalLimiter` (a burst that would trip the clip limiter does not close the socket).
- **`client-core` `peer-link.test.ts` (rewritten for the identity handshake, injected fake `RTCPeerConnection`):**
  - `start()` sends an `rtc-hello` and does NOT create a data channel or offer yet.
  - After receiving a peer `rtc-hello` with a **smaller** `from`, the link becomes initiator: creates the channel and offers.
  - After receiving a peer `rtc-hello` with a **larger** `from`, the link stays responder: no offer; it answers a subsequent inbound offer and opens on `ondatachannel`.
  - A second `rtc-hello` is ignored (resolve-once).
  - `close()` idempotence and ICE round-trip remain covered.
- **`client-core` `client.test.ts`:** `armPeer()` on `peerCount >= 2` emits an `rtc-hello` over the mock WS; an `rtc-hello` arriving over the **p2p** pipe is dropped (extends the existing `via`-guard test); a teardown + re-arm emits a fresh `rtc-hello` (reconnect path).
- **e2e:** the existing Direct/Relayed tests continue to pass unchanged (they already exercise the full handshake end-to-end in Chromium). The double-reconnect race is not deterministically reproducible in Playwright, so it stays unit-covered.

## 8. Migration / compatibility
- **Mixed-version peers:** a new client paired with an old client (no `rtc-hello`) never completes identity exchange → both stay `relay` (lossless). This is acceptable and matches the old-relay degradation; both peers should be the same build in practice (same SPA).
- No persisted data, no schema migration, no security-boundary change.
