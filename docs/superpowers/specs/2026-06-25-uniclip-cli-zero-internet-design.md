# Uniclip — CLI Zero-Internet (P4b-ii, mDNS + embedded local relay) — Design Spec

**Date:** 2026-06-25
**Status:** Approved (pending spec review)
**Scope:** Let two `uniclip` CLIs **pair and sync with no internet at all** on the same LAN. A host (`uniclip --lan`) mints a Mode-A room locally, runs an **embedded WebSocket fan-out** (the relay's protocol, ~60 lines of Node `ws`), advertises it over **mDNS**, and shows a QR pairing token; a joiner (`uniclip <token>`) discovers the host via mDNS and connects. Content rides **werift P2P over LAN host ICE candidates** (no STUN, no relay), with the embedded relay as the signaling rendezvous + content fallback. **CLI↔CLI only.** Builds directly on **P4b-i** (the merged werift adapter). No change to `client-core`, `protocol`, `crypto`, `room-code`, or `apps/relay`; all new code is in `apps/cli`.

This is the second half of the decomposed **P4b** — the genuinely offline goal. P4b-i made the data path real; P4b-ii replaces the *bootstrap* (discovery + signaling) so no public relay is ever contacted.

## 1. Goals and non-goals

### Goals
1. `uniclip --lan` starts a host with **zero network calls to any external service**: mint room locally → embedded relay → mDNS advertise → render TUI + show QR pairing token.
2. `uniclip <lan-token>` (scanned/pasted) discovers the host on the LAN via mDNS, connects, and syncs **text** end-to-end-encrypted, identical Mode-A zero-knowledge.
3. Content travels **peer-to-peer** over werift using LAN host candidates (`iceServers: []`, no STUN); the embedded relay is signaling + fallback, exactly mirroring the public-relay topology.
4. Reuse `UniclipClient` **unchanged**: the host points it at `ws://127.0.0.1:<port>`, the joiner at the mDNS-resolved `ws://<host>:<port>` — both via the existing `roomUrl`/`relayBase` options.

### Non-goals / preserved invariants
- **CLI↔CLI only.** A browser cannot run an mDNS responder or a local server, and LAN-HTTP is not a secure context for the Web Clipboard API — so CLI↔browser offline is out of scope (the web app stays relay-bound).
- **No change to `client-core`, `protocol`, `crypto`, `room-code`, or `apps/relay`.** All new code is in `apps/cli`. We do **not** import `apps/relay` (Bun + Hono + `bun:sqlite` + rate-limiting + metrics — Node-incompatible and far heavier than needed); the embedded relay is a minimal Node `ws` fan-out reusing the shared `@uniclip/protocol` schemas.
- **No persistence, no backfill, no tombstones.** Offline rooms are live-only: the embedded relay advertises `backfill:false`, `ephemeral:true`, and holds nothing when sockets hit zero. (History lives only while a device is connected — consistent with the use-and-discard ethos.)
- **No protocol/crypto change.** The app-layer AES-256-GCM envelope rides on top of DTLS as today; signaling (`sdp`/`ice`/`rtc-hello`/`presence`) stays WS-only via the existing `via !== "ws"` guards. Mode A stays zero-knowledge — see §6.
- **No files** — text clips + delete only (the CLI is text-only).

## 2. Architecture & boundary

**The host is simultaneously a relay and a participant.** This is what keeps `client-core` untouched: the host runs the embedded relay, then points its own `UniclipClient` at `ws://127.0.0.1:<port>` exactly as it would point at a public relay. The joiner points its `UniclipClient` at the mDNS-resolved host. Both are ordinary `UniclipClient`s; only the host additionally hosts the relay and advertises it.

New files, all under `apps/cli/src/`:
- **`lan-relay.ts`** — `startLanRelay({ routingId }): Promise<{ port: number; close(): void }>`. A single-room Node `ws` `WebSocketServer` bound to `0.0.0.0` on an ephemeral port. Mirrors the relay's WS semantics (see §4). Validates inbound frames with `ClientFrameSchema`; fans opaque frames to the *other* sockets.
- **`mdns.ts`** — a `Discovery` interface (so wiring is testable with a fake) backed by **`bonjour-service`** (pure-JS, no native deps): `advertise({ routingId, port, name }): Advertisement` and `discover(routingId, timeoutMs): Promise<{ host: string; port: number }>`. TXT record carries **routingId only** — never the secret.
- **`lan-token.ts`** — `formatLanToken({ routingId, secret }): string` and `parseLanToken(s): { routingId, secret } | null` for the `uniclip+lan://<routingId>#<secret>` pairing token.
- **`lan-session.ts`** — `startLanHost(deviceName?)` and `joinLan(token, deviceName?)`, each returning `{ client: UniclipClient, roomUrl, qr? , dispose() }` for the TUI (parallels P4a's `session.ts`; kept separate so the relay-connected path stays simple).

Modified (`apps/cli`): `args.ts` (`--lan` flag + LAN-token detection on the positional arg), `cli.tsx` (route to host/join/relay-connected), and a small TUI note that this is a LAN room. `package.json` gains `ws` and `bonjour-service`.

## 3. Host flow (`uniclip --lan`)
1. **Mint locally** — `generateModeARoom()` → `{ routingId, secret }`. No network.
2. **Embedded relay** — `startLanRelay({ routingId })` → ephemeral `port`, bound to `0.0.0.0`.
3. **mDNS advertise** — publish `_uniclip._tcp` on `port`, TXT `{ rid: routingId }`, instance name derived from the device name (cosmetic).
4. **Self-connect + render** — build `new UniclipClient({ roomUrl: "http://127.0.0.1:${port}/r/${routingId}#${secret}", relayBase: "ws://127.0.0.1:${port}", iceServers: [], createConnection: weriftPeer, deviceName? })`, render the TUI, and show a **QR of `formatLanToken(...)`** plus the token text. On quit, dispose the client, stop mDNS, and close the relay.

## 4. Embedded relay semantics (`lan-relay.ts`)
Mirrors `apps/relay/src/ws-handlers.ts` for one room, minus everything offline doesn't need:
- **connect** (any path `/ws/<id>`; the server hosts exactly one room): add socket → send `{ type:"hello", roomId: routingId, peerCount: <size>, backfill:false, ephemeral:true }` → broadcast `{ type:"peer-joined", peerCount }` to the others.
- **message**: `JSON.parse` → `ClientFrameSchema.safeParse`; on success broadcast the **raw** frame to every *other* socket (clip/delete/sdp/ice/rtc-hello/presence alike — all opaque). Enforce `MAX_FRAME_BYTES`; drop invalid frames. No buffering, no tombstones.
- **close**: remove socket → broadcast `{ type:"peer-left", peerCount }`. When size hits 0, nothing to clear (no state held).
- No rate limiting, CORS, metrics, or SQLite — a trusted single-LAN-room server. (The public relay keeps all of those; this is a deliberately minimal sibling, not a replacement.)

## 5. Joiner flow (`uniclip <token>`)
`parseLanToken` recognizes the `uniclip+lan://` form (a normal `https://…/r/…#…` argument still routes to the relay-connected P4a/P4b-i path). Then:
1. `discover(routingId, 5000)` — browse `_uniclip._tcp`, match the service whose TXT `rid` equals the token's routingId, resolve to `{ host, port }`.
2. Build `new UniclipClient({ roomUrl: "http://${host}:${port}/r/${routingId}#${secret}", relayBase: "ws://${host}:${port}", iceServers: [], createConnection: weriftPeer, deviceName? })`, render the same TUI.
3. On no match within the timeout → a friendly error: "Couldn't find that room on this network — make sure both devices are on the same Wi-Fi/LAN." Exit non-zero.

`roomUrl` is parsed by the existing `parseRoomUrl` (`/r/<routingId>#<secret>` → Mode A), so the key derivation and AAD are byte-identical to every other path; the synthesized `http://host:port` origin only supplies `relayBase`.

## 6. Security model
Identical Mode-A zero-knowledge to the public relay:
- The **secret is QR-only** — generated client-side, embedded solely in the pairing token's fragment, never sent in any frame, never in the mDNS TXT record, never to the embedded relay.
- The embedded relay sees only `routingId` + opaque ciphertext (and opaque signaling) — it cannot decrypt, exactly like the public relay in Mode A.
- The mDNS TXT advertises `routingId` (a non-secret room id, like a public room URL). Anyone on the LAN who learns the routingId could *connect* to the room, but without the secret cannot decrypt anything, and the app-layer AES-GCM envelope still wraps the P2P (DTLS) path.
- Live-only: no plaintext, ciphertext, frames, or keys are persisted anywhere; all state dies with the process.
- AAD domain separation is unchanged (`${routingId}:${msgId}` for clips, `presence:${routingId}`, etc.) since `client-core` is untouched.

## 7. Testing
- **`lan-token`** — `formatLanToken`/`parseLanToken` round-trip; rejects malformed tokens and a normal `https` room URL (so the joiner routes correctly); secret survives only in the fragment.
- **`lan-relay`** — drive a real server on `127.0.0.1` with `ws` clients: first connect receives `hello {peerCount:1, backfill:false, ephemeral:true}`; second connect triggers `peer-joined {peerCount:2}` to the first; a `clip` from one is delivered to the *other* only (not echoed to sender); an oversize/invalid frame is dropped; close triggers `peer-left`.
- **End-to-end gate** (the P4b-i analog, the task that gates the design): start a real `lan-relay` + **two real `UniclipClient`s** with `weriftPeer` and `iceServers: []`, connected by the known port (bypassing mDNS), and assert a clip sent on one arrives decrypted on the other and `transport` flips to `p2p`. Pure Node, no multicast — proves the embedded relay + signaling + werift LAN path end-to-end.
- **`mdns`** — unit-test the `Discovery`-consumer wiring (host/join) with a **fake** Discovery; plus **one** real-multicast advertise→discover integration test on the loopback/LAN interface, **skip-guarded** (multicast is frequently blocked in CI sandboxes — do not gate merge on it; `log`/annotate when skipped).
- No pty/TUI e2e (consistent with P4a/P4b-i); the gate test covers the transport.

## 8. Decomposition (for the plan)
1. **`lan-token.ts`** — format/parse (+ tests). Pure, no deps.
2. **`lan-relay.ts`** — embedded Node `ws` fan-out (+ tests driven by `ws` clients). Adds `ws` dep.
3. **End-to-end gate** — `lan-relay` + two `UniclipClient`s + `weriftPeer` sync a clip P2P (no mDNS). Gates the design.
4. **`mdns.ts`** — `Discovery` interface + `bonjour-service` impl; fake-backed wiring unit tests + one skip-guarded real-multicast test. Adds `bonjour-service` dep.
5. **`lan-session.ts` + wiring** — `startLanHost`/`joinLan`, `args.ts` `--lan` + token detection, `cli.tsx` routing, TUI/QR for the LAN room.

Order 1→5; (1)(2) are infra, (3) proves the transport before any discovery, (4) adds discovery, (5) wires the UX. (3) gates (4)/(5): if the embedded relay + werift LAN path doesn't sync, fix it before building discovery.
