# Uniclip — CLI Node WebRTC (P4b-i, real P2P over the relay) — Design Spec

**Date:** 2026-06-25
**Status:** Approved (pending spec review)
**Scope:** Give `apps/cli` **real peer-to-peer data transport** by replacing the `disabledPeer` stub with a working Node WebRTC `createConnection` backed by **werift** (pure-TypeScript WebRTC). Content travels P2P / LAN-direct when two peers share a room, with automatic relay fallback. **Signaling and discovery still ride the existing relay WS** — running with no relay at all (mDNS + local signaling) is the separate **P4b-ii — zero-internet** spec. No change to `client-core`, `protocol`, `relay`, or `crypto`; this is additive in `apps/cli` only.

This is the first half of the decomposed **P4b**. P4b-i de-risks the WebRTC-library choice and lands working P2P on a small, testable surface; P4b-ii then builds zero-internet discovery/signaling on top of it.

## 1. Goals and non-goals

### Goals
1. When two CLI peers are in a room, their clip/delete frames travel **peer-to-peer** over a real `RTCDataChannel` (LAN-direct where possible, STUN-assisted otherwise), exactly as the web app already does.
2. Back `PeerLink`'s injectable `createConnection` with **werift** via a thin adapter that presents the DOM `RTCPeerConnection` shape `PeerLink` consumes.
3. Keep automatic, silent **relay fallback**: if the P2P connection never opens or later fails, content rides the relay WS (the existing `sendFrame` floor).
4. Surface the existing `transport: p2p|relay` event in the CLI header as a **Direct / Relayed** indicator (in P4a it could never flip to `p2p`).
5. Provide a `--relay-only` escape hatch that forces relay transport (for locked-down networks / debugging).

### Non-goals / preserved invariants
- **No zero-internet** — discovery and signaling still use the relay; mDNS + embedded local relay is P4b-ii.
- **No `client-core` / `protocol` / `relay` / `crypto` change** — werift is Node-only and must not leak into `client-core` (the web app uses the platform's native `RTCPeerConnection`). All new code is in `apps/cli`.
- **No files** — text clips + delete only (the CLI is text-only; file transfer remains a deferred CLI feature, though it would now ride the same channel).
- **No protocol/crypto change** — the app-layer AES-256-GCM envelope sits on top of DTLS exactly as today; signaling (`sdp`/`ice`/`rtc-hello`) stays **WS-only** (the `via !== "ws"` guards in `client.ts` are unchanged). Content stays opaque on every path. Mode-A zero-knowledge is unaffected — only `routingId` reaches the relay; the secret never leaves the URL fragment.

## 2. Architecture & boundary

The slice is **additive in `apps/cli`**. `PeerLink` (`client-core/src/peer-link.ts`) already accepts `createConnection: (config: RTCConfiguration) => RTCPeerConnection`; P4a injected a never-opening stub because Node has no `RTCPeerConnection`. P4b-i injects a real one.

- **New — `apps/cli/src/werift-peer.ts`:** `weriftPeer(config: RTCConfiguration): RTCPeerConnection` — an adapter wrapping werift's `RTCPeerConnection` that presents the DOM shape `PeerLink` uses:
  - settable callbacks `onicecandidate`, `ondatachannel`, `onconnectionstatechange`, `onnegotiationneeded`;
  - `createDataChannel(label, {ordered})` returning a DOM-shaped channel;
  - `createOffer()`, `createAnswer()`, `setLocalDescription()`, `setRemoteDescription()`, `addIceCandidate()`;
  - properties `localDescription`, `signalingState`, `connectionState`; `close()`.
- **Kept — `apps/cli/src/disabled-peer.ts`:** unchanged; now the implementation behind `--relay-only` (not dead code).
- **`apps/cli/src/session.ts`:** `makeClient` selects the factory — default `weriftPeer`, or `disabledPeer` when `relayOnly` is set. New option `relayOnly?: boolean` threaded from the CLI flag.

werift is a normal runtime `dependency` of `apps/cli` (pure TS, no native binary — the zero-install fit), resolved at `npx` time. It stays **external** to the tsup bundle (only `@uniclip/*` is `noExternal`).

## 3. The adapter (`werift-peer.ts` — the only real complexity)

werift exposes an Rx-style event model (`.subscribe()` on subjects) rather than DOM `onX` assignment, and slightly different value shapes. The adapter bridges both, entirely inside `apps/cli`:

- **Events:** subscribe to werift subjects and re-dispatch to whatever DOM callback `PeerLink` has assigned:
  - `pc.onIceCandidate.subscribe(c => this.onicecandidate?.({ candidate: toDomCandidate(c) }))` — and emit the end-of-candidates signal (`{candidate: null}`) so `PeerLink` sends its `""` ICE marker.
  - `pc.onDataChannel.subscribe(ch => this.ondatachannel?.({ channel: wrapChannel(ch) }))`.
  - `pc.connectionStateChange.subscribe(s => { this.connectionState = s; this.onconnectionstatechange?.(); })`.
  - **`onnegotiationneeded`:** `PeerLink` relies on it to drive the initiator's first offer (`peer-link.ts:93`). If werift does not emit a DOM-equivalent `negotiationneeded`, the adapter fires `onnegotiationneeded` itself immediately after `createDataChannel` (the initiator creates exactly one channel up front), preserving `PeerLink`'s single-offer flow.
- **ICE candidates:** `PeerLink` serializes the outgoing candidate via `candidate.toJSON()` (`peer-link.ts:53`) and feeds the peer's parsed JSON to `addIceCandidate` (`peer-link.ts:123`). The adapter's `toDomCandidate` returns an object with a `toJSON()` producing `{ candidate, sdpMid, sdpMLineIndex }`; `addIceCandidate(init)` maps that JSON back to werift's candidate constructor.
- **SDP:** `createOffer`/`createAnswer` return `{ type, sdp }`; `setLocalDescription`/`setRemoteDescription` accept `{ type, sdp }`. werift's session-description objects already carry `type`/`sdp`, so mapping is shallow. `localDescription` returns `{ type, sdp }` or `null`.
- **DataChannel — `wrapChannel`:** present `.readyState` (`"connecting"|"open"|"closing"|"closed"`), `.send(data)`, `.close()`, and settable `.onopen`/`.onmessage`/`.onclose`. Bridge werift's channel via its open/close state subject and `.message.subscribe(data => this.onmessage?.({ data: asString(data) }))`. `PeerLink` reads `channel.readyState === "open"` (`peer-link.ts:138`) and `ev.data as string` (`peer-link.ts:134`); our frames are sent as JSON strings, but werift may surface a message as a `Buffer`/`Uint8Array`, so the adapter **coerces every inbound message to a UTF-8 string** before dispatch (`asString` decodes a `Buffer`, passes a `string` through).

The adapter never touches the relay, keys, or frames — it is pure transport plumbing under the existing AES-GCM envelope.

## 4. ICE / fallback

- Keep the default `ICE_SERVERS` (public Google STUN) already wired through `UniclipClient.iceServers`; the CLI passes no override. With internet present this gives normal STUN-assisted ICE; on a LAN the host candidates connect directly anyway.
- **Fallback is already implemented, no new logic:** `sendFrame` (`client.ts:332`) prefers the channel only when `peer.isOpen()`, else the WS. If the channel never opens, content simply rides the relay. If a live channel drops, werift's `connectionStateChange → failed/closed` → adapter `onconnectionstatechange` → `PeerLink.fireClose` → `onClose` → `setTransport("relay")` + abort transfers (`client.ts:361-364`). The CLI therefore degrades to exactly the P4a relay behavior.

## 5. UX (`cli.tsx`, `app.tsx`, `args.ts`)

- **Default:** P2P attempted automatically — no flag, no prompt. Relay fallback is silent and safe.
- **`--relay-only`:** parsed in `args.ts`; threads `relayOnly: true` into `makeClient`, which injects `disabledPeer`. Documented in the footer/usage.
- **Header indicator:** the `<App>` already subscribes to client events; add `transport` state and render **Direct** (p2p) / **Relayed** (relay) in `<Header>` beside the status. Starts "Relayed" and flips to "Direct" when the channel opens.

## 6. Security model

Unchanged from P4a. The AES-256-GCM envelope (AAD `${routingId}:${msgId}`) rides on top of WebRTC's DTLS, so content is doubly opaque and identical whether it travels P2P or via the relay. Signaling stays WS-only and is never buffered/persisted by the relay. werift introduces a new dependency but no new wire surface and no new server. STUN reveals only that *some* peer is using STUN (standard for any WebRTC app); the room secret and plaintext never leave the device.

## 7. Testing

- **Adapter unit tests (`werift-peer.test.ts`)** with a fake/minimal werift `pc`: subject→`onX` re-dispatch (ice/datachannel/connectionState), `onnegotiationneeded` synthesis after `createDataChannel`, candidate JSON round-trip (`toDomCandidate(...).toJSON()` ⇄ `addIceCandidate`), SDP shape mapping, and `wrapChannel` readyState/send/onmessage behavior.
- **Two-peer loopback integration test (`werift-loopback.test.ts`) — the high-value test:** construct two real werift `RTCPeerConnection`s in Node, drive two `PeerLink`s whose `signal` callbacks hand `PeerSignal`s to each other through an in-memory relay (no WS, no browser), and assert (a) both data channels reach `open` and (b) a JSON clip frame sent on one arrives on the other. This proves the adapter drives a genuine WebRTC handshake end-to-end in pure Node. Generous timeout (ICE/DTLS in werift takes a beat); skip-guarded if a CI sandbox blocks loopback UDP (logged, not silently passed).
- **`--relay-only`:** an `args.ts` test (flag parses) + a `session.ts` test (`relayOnly` selects `disabledPeer`), keeping the existing relay-path coverage valid.
- **No pty/e2e** — consistent with P4a; the loopback test covers the real transport.

## 8. Decomposition (for the plan)
1. **`werift-peer.ts` adapter** + `werift-peer.test.ts` unit tests (the core; werift added as a dep).
2. **Two-peer loopback integration test** (`werift-loopback.test.ts`) — proves the adapter against real werift.
3. **Wiring** — `args.ts` `--relay-only`, `session.ts` factory selection (`relayOnly` → `disabledPeer`), `cli.tsx` threading (+ tests).
4. **Header Direct/Relayed indicator** — `<App>` `transport` state + `<Header>` render (+ component test).

Order 1→4; (1)(2) are the transport core, (3)(4) the surfacing. (2) gates the design — if real werift can't complete a loopback handshake, the adapter is revisited before wiring.
