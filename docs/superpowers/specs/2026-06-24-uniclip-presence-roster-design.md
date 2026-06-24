# Uniclip — Presence Roster (named connected devices) — Design Spec

**Date:** 2026-06-24
**Status:** Approved (pending spec review)
**Scope:** A live, named roster of the devices connected to a room. Each device self-names; names propagate **peer-to-peer, encrypted** (the relay stays blind in Mode A); the roster reconciles against the relay's `peerCount` with a TTL backstop. This is sub-project **P2 (Pairing & presence)** of the WebRTC program — QR pairing already ships in `share-modal.svelte`, so P2 here is **device naming + the connected-device list** only.

## 1. Goals and non-goals

### Goals
1. Each device has a human name (user-editable, sensible UA-derived default) and shows a live list of the **other** connected devices by name.
2. Names never reach the relay in cleartext (Mode A): presence frames are encrypted with the room key, fanned out by the relay, and **never buffered/persisted**.
3. The roster is self-correcting: it converges to the relay's authoritative `peerCount`, and a departed device disappears within a couple of seconds (fast prune on `peer-left`), with a TTL backstop for missed announces.

### Non-goals / preserved invariants
- **No QR/pairing work** — already shipped (`share-modal.svelte` + `lib/qr.ts`).
- **No per-peer transport in the roster** (Direct/Relayed is a single 2-peer badge; a per-peer mesh view is out of scope).
- **No cross-session device identity / fingerprinting** — the device `id` is a random per-tab ULID (sessionStorage), not a stable tracker.
- **No new persisted server state.** Presence is ephemeral control traffic, like WebRTC signaling.
- Mode-A zero-knowledge preserved: only `routingId` + opaque frames reach the relay. Mode B may decrypt names (same caveat as content), and is already labelled "less secure".
- AAD domain separation preserved (new `presence:` domain, §4).

## 2. Identity & naming

- **Device id** — a random ULID generated once per tab and stored in `sessionStorage` (`uniclip.deviceId`). Stable across reconnects within the tab; a new tab/session gets a new id. Not persisted to localStorage (avoids a durable fingerprint).
- **Device name** — user-editable string (≤ 40 chars), stored in `localStorage` (`uniclip.deviceName`), shared across rooms on this origin. Default from a `defaultDeviceName()` helper that derives a friendly `"<Browser> · <OS>"` label from `navigator.userAgent`/`userAgentData` (e.g. "Chrome · macOS", "Safari · iPhone"), falling back to "This device" when unknown.
- Editing the name re-announces immediately (§5).

## 3. Protocol (`packages/protocol`)

Add one `.strict()` frame carrying an opaque encrypted blob (never content, never names in clear):

- `PresenceFrameSchema` `{ type: "presence", iv: Base64, ciphertext: Base64 }`

Added to **both** `ClientFrameSchema` and `ServerFrameSchema` (relayed verbatim). The plaintext under `ciphertext` is `JSON.stringify({ id: string, name: string })`. No `msgId`/`ts` — presence is not deduped by msgId or backfilled; it is keyed by the decrypted `id`.

## 4. Crypto / AAD (`packages/crypto` usage; no new crypto primitives)

Reuse the existing string `encrypt`/`decrypt` envelope with a **new AAD domain**:

- Presence AAD = `presence:${routingId}`.

This is disjoint from wire clips (`${routingId}:${msgId}`), file chunks (`${routingId}:${fileId}:...`), and at-rest persistence (`persist:${roomId}`), so a presence blob can never be accepted as any other frame (AES-GCM auth fails on AAD mismatch). The room `CryptoKey` is the existing non-extractable key from `deriveRoomKey`.

## 5. client-core — `PresenceManager` (`packages/client-core/src/presence.ts`, new)

An injectable manager mirroring `FileTransferManager`/`PeerLink`.

**Constructor options:**
```ts
interface PresenceManagerOptions {
  routingId: string;
  selfId: string;                 // the per-tab device id
  getKey: () => CryptoKey | null; // room key (null until derived)
  getName: () => string;          // current local device name
  send: (frame: { type: "presence"; iv: string; ciphertext: string }) => void; // writes to the WS
  emit: (roster: Device[]) => void; // notify UI of roster changes
  now?: () => number;             // injectable clock for tests
  ttlMs?: number;                 // default 20_000
  heartbeatMs?: number;           // default 8_000
  pruneDelayMs?: number;          // default 2_000 (fast prune after peer-left)
}
type Device = { id: string; name: string; self: boolean };
```

**State:** `roster: Map<id, { name: string; lastSeen: number }>`.

**Public methods:**
- `announce(): Promise<void>` — encrypts `{ id: selfId, name: getName() }` with the presence AAD and calls `send(...)`. No-op if no key yet.
- `handlePresence(frame): Promise<void>` — decrypts; on success upserts `{ id, name, lastSeen: now }` (ignoring the frame if `id === selfId`); emits the roster. Decryption failure (wrong key / tampered) is dropped silently.
- `onPeerChange(left: boolean): void` — always `announce()` (covers a peer joining or this device's own join); when `left === true`, also schedule a fast prune after `pruneDelayMs` that drops entries not refreshed since the `peer-left` (i.e. `lastSeen < peerLeftAt`). The relay's `peerCount` is not used to forcibly trim the roster — the count display stays driven by `peerCount` directly in the UI; the roster is a best-effort named overlay that converges via announces + TTL.
- `onNameChange(): void` — `announce()`.
- `start()` / `stop()` — manage the heartbeat timer (re-`announce()` every `heartbeatMs`) and a sweep timer that evicts entries older than `ttlMs` and emits when the roster changes.
- `roster()` accessor returning `Device[]` including a synthetic `self` entry (`{ id: selfId, name: getName(), self: true }`) sorted self-first.

**Liveness model (reconcile-on-change + TTL):** announces fire on join, every peer-join/leave, name edit, and a slow heartbeat; entries evict on TTL; `peer-left` triggers a fast prune so a leaver clears in ~`pruneDelayMs`. No reliance on the relay for identity.

## 6. client-core — `UniclipClient` wiring (`packages/client-core/src/client.ts`)

- Construct a `PresenceManager` alongside `transfers`, injecting: `routingId`, a `selfId` (passed in via `UniclipClientOptions.deviceId`, defaulted by the web app from sessionStorage), `getKey: () => this.key`, `getName` (from an internal `this.deviceName`, settable), `send` = write the presence frame **to the WS** (`this.ws.send`, never `sendFrame` — presence must reach all peers via relay fan-out), `emit` = `this.emit({ kind: "presence", roster })`.
- New `ClientEvent`/handler: `presence: (roster: Device[]) => void`.
- New methods: `setDeviceName(name: string): void` (updates `this.deviceName`, calls `presence.onNameChange()`).
- `handleFrame`:
  - `case "presence":` — route to `presence.handlePresence(frame)`. Accept on the **WS** pipe; like signaling, drop it if it arrives over the P2P channel (`if (via !== "ws") return;`), so the `via` guard now also covers `presence`.
  - `case "hello":` after arming → `presence.start()` and `presence.onPeerChange(false)`.
  - `case "peer-joined":` → `presence.onPeerChange(false)`.
  - `case "peer-left":` → `presence.onPeerChange(true)`.
- `handleClose`/`disconnect` → `presence.stop()` and clear the roster (emit empty).

## 7. relay (`apps/relay/src/ws-handlers.ts`)

- Route `presence` to the `signalLimiter` bucket (low-rate control traffic, alongside `sdp`/`ice`/`rtc-hello`).
- `presence` is forwarded by the existing `broadcast` only; it matches neither the `clip` nor `delete` branch, so it is **never** `pushRecent`/`addTombstone`/`RoomDb`. Update the forward-only comment to include `presence`.
- No other relay change; the relay never decrypts or inspects the blob.

## 8. web (`apps/web`)

- `room.svelte`: read/generate the per-tab `deviceId` (sessionStorage) and pass it to `UniclipClient`; read the persisted `deviceName` (localStorage, default via `defaultDeviceName()`); subscribe to `client.on("presence", r => roster = r)`; expose a `setName` that persists to localStorage and calls `client.setDeviceName`.
- A new `roster-popover.svelte` (or fold into `header.svelte`): the existing peer indicator becomes a button showing the count and opening a popover that lists the roster — "This device" first with an inline-editable name input, then the others by name. Empty/single-device state shows a friendly "Only this device".
- **Fold-in:** fix `share-modal.svelte:36` scrim from `bg-black/55 … backdrop-blur-sm` to the Safari-safe scoped `rgba()` + `-webkit-backdrop-filter` pattern used by `composer-modal.svelte` (the last unfixed instance; see the project memo on TW4 color-mix/backdrop on Safari).

## 9. Security model

- **Names opaque to the relay (Mode A).** Presence ciphertext uses the room key + `presence:${routingId}` AAD; the relay forwards an opaque blob it cannot decrypt and never stores.
- **No durable identity.** `deviceId` is per-tab (sessionStorage), random; `deviceName` is user-chosen. Nothing ties a device across sessions or to the network identity.
- **AAD isolation** prevents cross-replay between presence, clips, files, and at-rest blobs.
- **DoS:** presence is rate-limited via `signalLimiter`; the heartbeat is slow (~8s) and bounded.
- **Mode B caveat:** the relay can derive the key and thus read names — consistent with Mode B already being labelled less secure; no new boundary is crossed.

## 10. Testing

- **protocol:** `presence` accepts `{type,iv,ciphertext}`; rejects extra keys / missing fields.
- **crypto/AAD:** a blob encrypted with `presence:${routingId}` fails to `decrypt` under a clip AAD and vice-versa (domain separation).
- **client-core `presence.test.ts`** (injected clock + fake key): `announce` encrypts `{id,name}` and calls `send`; `handlePresence` upserts a peer and emits, ignores own `id`, drops undecryptable blobs; TTL eviction removes a stale entry; fast prune on `peer-left` drops a non-refreshed entry within `pruneDelayMs`; `onNameChange` re-announces; `roster()` includes the self entry first.
- **client-core `client.test.ts`:** a `presence` frame over the WS reaches the manager and surfaces a `presence` roster event; a `presence` frame over the **p2p** pipe is dropped (extends the `via`-guard test); peer events drive announces.
- **relay:** a `presence` frame fans out to peers, is not replayed to a late joiner, and is billed to `signalLimiter` (a burst does not trip the clip limiter).
- **web:** unit-test `defaultDeviceName()` parsing; the roster popover renders self + peers (component or e2e). e2e: two browsers in a room each set a name and see the other's name in the roster.

## 11. Decomposition (for the plan)
1. **protocol** — `presence` frame.
2. **relay** — route `presence` to `signalLimiter`; forward-only.
3. **client-core** — `PresenceManager` + `UniclipClient` wiring + `presence` event + `via` guard + `defaultDeviceName()` (shared helper location: `client-core` or `apps/web`; default the helper in `apps/web` since it reads `navigator`).
4. **web** — `deviceId`/`deviceName` plumbing, roster popover, share-modal scrim fold-in.

Each is an independently testable task; (1)→(2)→(3)→(4) order.
