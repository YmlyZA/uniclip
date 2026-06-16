# Uniclip — Ephemeral Rooms + Offline Send Queue — Design Spec

**Date:** 2026-06-16
**Status:** Approved (pending spec review)
**Scope:** A Phase-1 "trust & resilience" round. Two independent features. (A) **Ephemeral rooms**: a per-room mode where no device persists history and items auto-expire on-screen — for syncing passwords / 2FA codes. (B) **Offline send queue**: text typed while disconnected is queued and flushed on reconnect instead of being dropped. A is mostly web + one relay-metadata boolean; B is mostly client-core. One combined spec.

## 1. Goals and non-goals

### Goals
1. **Ephemeral rooms**: a creation-time, room-wide flag. In an ephemeral room nothing is written to `localStorage` on any device, relay backfill is forced off, and items auto-expire from the on-screen list 60s after delivery (per-device, no coordination).
2. **Offline send queue**: `UniclipClient.send` never drops text when the socket is closed. Queued frames flush in order on reconnect. Queued items show a per-item "pending" state until delivered.

### Non-goals / preserved invariants
- **No crypto change.** Frames are encrypted exactly as today (`${routingId}:${msgId}` AAD). Ephemeral and the queue are persistence/transport concerns, not encryption concerns.
- **Persistence stays metadata-only.** The relay gains one boolean column (`ephemeral`) — still no frames, keys, or content. The zero-knowledge boundary is untouched.
- **Per-item ephemeral and per-device toggles are out of scope.** Ephemeral is per-room, set at creation, like backfill.
- **The queue is in-memory only.** Unsent plaintext is never written to disk (that would defeat the sensitive-data stance). Closing the tab while offline loses queued items — a documented, accepted limitation.
- No accounts/identity. No protocol versioning work in this round (additive `hello` field only).

## 2. Feature A — Ephemeral rooms

### Model
A new per-room boolean `ephemeral`, set at creation, stored as relay metadata exactly like `backfillEnabled`, and echoed to every joiner in the `hello` frame. Two invariants follow:
- **`ephemeral ⇒ backfill off`**: `backfillEnabled = mode === "A" && backfill && !ephemeral`. An ephemeral room buffers nothing in relay memory either.
- **No at-rest persistence on any device**: items live only in the in-memory `items` list; nothing is written to `localStorage`.

Items **auto-expire 60s after delivery**, per-device and local. Every peer runs the same client with the same TTL constant and items arrive at ~the same time, so they vanish in sync **without sending any delete frames** — no coordination, no metadata leak. The TTL is a baked-in client constant (`EPHEMERAL_TTL_MS = 60_000`), not stored per-room.

Ephemeral is available for **both** Mode A and Mode B (it is orthogonal to who can decrypt — it governs device persistence + display lifetime). Mode A + ephemeral is the maximum-privacy combination.

### Relay (`apps/relay`) — metadata only
- `room-db.ts`: add an `ephemeral` column (boolean, integer 0/1 like `backfill_enabled`). Still metadata; no content. Included in `insert`/`get` row mapping.
- `rooms.ts`: add `ephemeral: boolean` to `Room`. `create(mode, backfill, ephemeral)` (extend the positional signature) stores `ephemeral` and computes `backfillEnabled = mode === "A" && backfill && !ephemeral`. `get()` rehydrates `ephemeral` from the DB row alongside the other fields (rehydrated rooms keep `recent: []`, `tombstones: []`).
- `app.ts`: `CreateRoomBody` Zod schema gains `ephemeral: z.boolean().optional()`; the handler calls `deps.store.create(parsed.data.mode, parsed.data.backfill ?? true, parsed.data.ephemeral ?? false)`.

### Protocol (`packages/protocol`)
- `HelloFrameSchema`: add `ephemeral: z.boolean().optional().default(false)`. Optional-with-default (not hard-required) for rolling-deploy compatibility: a new client talking to an old relay (whose hello lacks the field) still parses, defaulting to non-ephemeral, instead of rejecting the hello outright. The relay always sets it in real traffic.

### `ws-handlers.ts`
- The hello build (currently sets `backfill: room.backfillEnabled`) also sets `ephemeral: room.ephemeral`.

### Client-core (`packages/client-core`)
- The `room` event payload changes from `{ backfill: boolean }` to `{ backfill: boolean; ephemeral: boolean }`. Update `ClientEvent`, `EventHandlers`, the `emit` switch, and the `hello` case in `handleFrame` to pass both fields.

### Web (`apps/web`)
- `lib/persist.ts`: extract an `ItemStore` interface (`load(): Promise<Item[]>`, `add(item): Promise<void>`, `remove(id): Promise<void>`, `clear(): void`). `PersistedItems` implements it unchanged. Add a new **`EphemeralStore`** implementing `ItemStore` as a Null Object: `load()` resolves `[]`, `add`/`remove` resolve without touching `localStorage`, `clear()` is a no-op.
- `lib/ephemeral.ts` (new): export `EPHEMERAL_TTL_MS = 60_000` and a small `ExpiryScheduler` class (`schedule(msgId)`, `cancel(msgId)`, `clear()`) that owns the per-item timers and invokes an `onExpire(msgId)` callback. Keeping the timer logic here (separate from storage) makes the TTL behavior unit-testable with fake timers, without mounting `room.svelte`.
- `routes/landing.svelte`: add an `ephemeral` toggle (a `$state` boolean) shown for both modes. When `ephemeral` is on, disable the backfill toggle (it is forced off server-side). The POST body includes `ephemeral`.
- `routes/room.svelte`:
  - Receive `ephemeral` from the `room` event into a `$state`.
  - Construct the store by the flag: `ephemeral ? new EphemeralStore() : new PersistedItems({...})`, typed as `ItemStore`. All existing `persist.load/add/remove/clear` calls stay unchanged.
  - Maintain `expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()`. A helper `scheduleExpiry(msgId)` (used only when `ephemeral`) sets a 60s timer that removes the item from `items` (no delete frame, no persist) and deletes its map entry. Clear all timers in `onDestroy`.
  - A header badge "Ephemeral · not saved" (in `header.svelte`) shown when `ephemeral`.

## 3. Feature B — Offline send queue

### Client-core (`UniclipClient`)
- Add `private queue: string[] = []` (serialized frame JSON) and a `MAX_QUEUE = 100` constant.
- `send(text)`: build the frame as today — `msgId = ulid()`, `ts = Date.now()` (**ts is frozen at composition time**), encrypt, serialize. If `this.ws?.readyState === WebSocket.OPEN`, send immediately. Otherwise push the serialized frame onto `queue`; if `queue.length > MAX_QUEUE`, drop the oldest and emit `error{ code: "QUEUE_FULL", message }` once per overflow. **Return `{ msgId, ts, queued: boolean }`** where `queued` is true iff the frame was enqueued. `send` no longer throws on disconnect (it still throws `"no key"` if the key is missing — a programming error, not a connectivity state).
- Flush: in `handleFrame`'s `hello` case (after emitting `connected`/`peer`/`room`), call `flushQueue()`. Flushing on `hello` (not raw `onopen`) guarantees the relay has set up the room. `flushQueue()` sends each queued frame string in order, emits `sent(msgId)` per frame (parse the msgId from the frame), and clears the queue. If the socket is not OPEN mid-flush, stop and leave the remainder queued for the next `hello`.
- Add a `sent` event: `ClientEvent` gains `{ kind: "sent"; msgId: string }`; `EventHandlers` gains `sent: (msgId: string) => void`; wire the `emit` switch.

### Web (`apps/web`)
- `lib/persist.ts` `Item`: add `pending?: boolean`.
- `routes/room.svelte`:
  - `sendText` and the `ClipboardWatcher` handler read `{ msgId, ts, queued }` from `client.send(text)` and call `addItem(text, ts, msgId, true, queued)`. `addItem` sets `pending: queued` on the item.
  - Listen `c.on("sent", (msgId) => { items = items.map(i => i.id === msgId ? { ...i, pending: false } : i); /* see §4 */ })` to clear the pending flag when the queued frame is actually delivered.
- The item-card component renders a pending appearance (dimmed + a small clock glyph) while `item.pending` is true.

### In-memory only (accepted limitation)
The queue is not persisted. Closing the tab while offline loses queued items. This is intentional: persisting unsent plaintext to disk would contradict the ephemeral/sensitive goal and the at-rest threat model.

## 4. The one cross-feature intersection: queued item in an ephemeral room

A queued item must **not** begin its 60s TTL until it is actually delivered, or a long offline window would expire it before it ever sends. Rule: **the TTL timer starts at delivery, not at add.**
- **Received clip** (`clip` event) → `scheduleExpiry(msgId)` at add.
- **Immediate own send** (`queued === false`) → `scheduleExpiry(msgId)` at add.
- **Queued own send** (`queued === true`) → do NOT schedule at add; schedule in the `sent` handler (alongside clearing `pending`), only when `ephemeral`.

## 5. Error handling and edge cases
- **Queue overflow**: drop oldest frame, emit `QUEUE_FULL` once.
- **Reconnect during flush**: queued frames carry fresh msgIds, so no `ReplaySet` dedup conflict. A socket drop mid-flush leaves the unsent remainder queued for the next `hello`.
- **Ephemeral expiry of an already-removed item**: the `items` filter is idempotent — a harmless no-op. Always `delete` the timer-map entry on fire.
- **`onDestroy`**: clear every timer in `expiryTimers` so a navigation away cannot fire a stale expiry.
- **Backfill in an ephemeral room**: forced off at create time, so a joiner receives no `recent` clips; only live items arrive and each gets a delivery-time TTL.

## 6. Testing
- **protocol unit**: `HelloFrameSchema` parses a frame including `ephemeral`; rejects a hello missing it (strict).
- **relay unit/integration**: `create(mode, backfill, ephemeral:true)` stores `ephemeral` and forces `backfillEnabled:false`; `get()` after a Map miss rehydrates `ephemeral` from the DB; the hello frame carries `ephemeral`.
- **client-core unit**: `send` while the socket is closed enqueues and returns `queued:true` without throwing; on a simulated `hello` the queue flushes in order and emits `sent` per msgId; the queue is bounded to `MAX_QUEUE` (oldest dropped, `QUEUE_FULL` emitted); `ts` equals composition time, not flush time; the `room` event delivers `{ backfill, ephemeral }`.
- **web unit**: `EphemeralStore` satisfies `ItemStore` and never writes `localStorage` (spy on `setItem`); `ExpiryScheduler` fires `onExpire(msgId)` after `EPHEMERAL_TTL_MS`, is idempotent per msgId, and `cancel`/`clear` reap pending timers (Vitest fake timers). The "queued item's TTL starts on `sent`, not at add" rule is enforced in `room.svelte` wiring (only `scheduleExpiry` for non-queued items at add; schedule in the `sent` handler for queued ones) and is exercised end-to-end by the e2e queue test.
- **e2e**:
  - **Ephemeral no-persist** (fast, no 60s wait): A creates an ephemeral room and sends a clip; B sees it; **reload B → the list is empty** (nothing was persisted). Assert the room header shows the ephemeral badge.
  - **Offline queue**: with A connected, block/drop A's socket (e.g. route abort or relay restart); type and send → the item shows the pending state; restore connectivity → the item loses pending and B receives the clip.
- TTL expiry timing (the 60s removal) is covered by the web unit test with fake timers — **not** by a 60s real-time e2e wait.

## 7. Out of scope
- Per-item or per-device ephemeral; configurable TTL or a per-item countdown ring (header badge is the only ephemeral UI in v1).
- Persisting the send queue across reloads; delivery receipts beyond the local `sent` event.
- Protocol versioning, file transfer, raising `MAX_FRAME_BYTES`. All future considerations.
