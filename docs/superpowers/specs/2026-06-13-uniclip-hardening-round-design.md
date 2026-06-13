# Uniclip v0.1.x — Hardening Round Design Spec

**Date:** 2026-06-13
**Status:** Approved (pending spec review)
**Scope:** Foundation cleanup before the UI redesign. Three groups: client-core
boundary refactor (A), SQLite room-metadata persistence (B1), and tech-debt
cleanup (B2/B3). The UI redesign is explicitly a **separate** spec → plan →
implementation cycle that follows this one.

## 1. Goal and non-goals

### Goal

Tighten the foundation so the upcoming UI redesign builds on clean boundaries:

1. Collapse the duplicated key-derivation and local-item logic by closing two
   gaps in the `client-core` package boundary, which also eliminates the
   reconnect-duplicate edge case.
2. Make room URLs survive a relay restart / redeploy, without persisting
   anything the relay must never retain (frames, keys, sockets, backfill ring).
3. Clear the tech debt surfaced this session (Hono deprecation, modal a11y).

### Non-goals

- UI redesign (separate spec, follows this one).
- Any v0.2 architectural work: binary/image frames, PAKE for Mode B, clock-skew
  ordering, multi-region. Explicitly out of scope.
- Changing the wire protocol's crypto envelope or AAD domain separation.
- Persisting clipboard history server-side in any form.

---

## 2. Section 1 — `client-core` boundary refactor (A1 + A2 + A3)

### Root cause

The web layer re-derives the room key and mints fresh local ULIDs because
`client-core` does not expose two things `persist` needs: the derived key's
derivation logic, and the frame-level identity (`msgId`) of each clip. Closing
those two gaps removes the duplication (A1), the local-item triplication (A2),
and the reconnect-duplicate edge (A3) together.

### 2a. Single source for key derivation (A1)

- `client-core` exports `deriveRoomKey(room: ParsedRoom): Promise<CryptoKey>`,
  encapsulating the Mode-A / Mode-B branch currently duplicated in
  `client.ts:74-78` and `apps/web/src/routes/room.svelte:36-39`.
  - Mode A: `deriveKey({ secret: room.secret, salt: room.routingId })`
  - Mode B: `deriveKey({ secret: room.routingId, salt: MODE_B_SALT })`
- `UniclipClient.connect()` calls `deriveRoomKey(this.room)` internally.
- `room.svelte` imports `deriveRoomKey` from `@uniclip/client-core` to build the
  `PersistedItems` key.
- **Home:** `client-core` (already depends on both `crypto` and `room-code`).
  Keeps `room-code` free of a crypto dependency and `crypto` free of mode
  knowledge.
- **Invariant preserved:** the Mode→derivation mapping now has exactly one
  definition. It must still match the relay's Mode-B derivation (per CLAUDE.md);
  a single source makes that invariant harder to break, not easier.

### 2b. Frame-level identity through persist (A3)

- `clip` event carries the frame's `msgId`:
  `clip: (text: string, ts: number, msgId: string) => void`. The `ClientEvent`
  clip variant gains a `msgId` field.
- `UniclipClient.send(text)` changes from `Promise<void>` to
  `Promise<{ msgId: string; ts: number }>`, returning the identity it minted so
  the caller can optimistically add a local item with the **same** identity the
  relay and peers will see. (`frame.ts` is already set to that same
  `Date.now()`, so `{ msgId, ts }` is identical across sender, relay, and
  receiver.)
- `apps/web/src/lib/persist.ts`: `Item.id` becomes the `msgId`.
  `PersistedItems.add(item)` dedups by `id` — if an item with that `id` already
  exists, it is a no-op (skip insert, skip save).
- **Effect:** on reconnect, backfill replays the device's own previously-sent
  frames; the fresh `ReplaySet` would re-emit them as `clip` events, but persist
  now dedups by `msgId`, so the list does not grow duplicates. Cross-device, the
  same logical clip shares `{ msgId, ts }` everywhere.

### 2c. Local-item helper (A2)

- `room.svelte` collapses the three near-identical "build Item → dedup → update
  `items` → persist" blocks (`c.on("clip")`, `watcher.on`, `sendNow`) into one
  `addItem(text, ts, msgId)` helper.
  - Received path passes the `clip` event's `(text, ts, msgId)`.
  - Send paths pass the value returned by `send()` plus the text.

### Tests (TDD, write failing first)

- `client-core`: `deriveRoomKey` produces a key that round-trips encrypt/decrypt
  for both modes; `send()` resolves to `{ msgId, ts }` matching the frame it puts
  on the wire; `clip` handler receives `msgId`.
- `apps/web`: `PersistedItems.add` with a duplicate `id` is a no-op (count
  unchanged, no second save); distinct `id`s still append.

---

## 3. Section 2 — SQLite room-metadata persistence (B1)

### Model

The SQLite DB is the **source of truth for room existence and metadata**; the
in-memory `Map` is a **live cache of occupied rooms**. The DB stores only
metadata — never frames, keys, sockets, or the backfill ring.

### Schema

New module `apps/relay/src/room-db.ts` using `bun:sqlite`:

```sql
CREATE TABLE IF NOT EXISTS rooms (
  id               TEXT    PRIMARY KEY,
  mode             TEXT    NOT NULL,      -- 'A' | 'B'
  expires_at       INTEGER NOT NULL,      -- epoch ms, max-age bound
  backfill_enabled INTEGER NOT NULL,      -- 0 | 1
  created_at       INTEGER NOT NULL
);
```

### `RoomStore` changes

- `create(mode, backfill)` → write the row to the DB **and** the Map.
- `get(id)`:
  1. Map hit → return.
  2. Map miss → query DB. If the row exists and is not expired, **rehydrate**
     into the Map (empty `sockets`, empty `recent`, `backfillEnabled` from the
     row) and return it. Otherwise return `null`.
- **Idle GC** → evict from the Map only; keep the DB row until `expires_at`.
- **Max-age / expiry GC** → delete from **both** the DB and the Map.
- **No startup preload** — rooms rehydrate lazily on `get()`. Cold rooms occupy
  no memory; no startup scan.

### Configuration

- DB path from `ROOM_DB_PATH`, **default `:memory:`** — i.e. current behavior
  (no cross-restart persistence) unless explicitly configured. Persistence is
  opt-in.
- Production: `ROOM_DB_PATH=/data/rooms.db` plus a mounted volume (documented in
  `deploy/`). Tests pass `:memory:`.
- `RoomStore` accepts an injected `Database` (or path) so tests stay isolated.

### Security boundary (unchanged)

The backfill ring stays memory-only and clears on empty. Persisting it would
mean writing replayable ciphertext to disk, breaking the model. Persistence
touches routing metadata **only**.

### Effect

After a relay restart or redeploy, room URLs stay valid (no `4404`). Devices
reconnect via the existing backoff and the room comes back live. History still
exists only while a device is connected, exactly as before.

### Tests (TDD, write failing first)

- `get()` rehydrates a room that is in the DB but not the Map (simulated restart:
  new `RoomStore` over the same `:memory:`/file DB, or a store whose Map was
  cleared).
- Expired rows are not rehydrated and are deleted by GC from both DB and Map.
- Idle GC evicts from the Map but leaves the DB row; a subsequent `get()`
  rehydrates it.
- Default `:memory:` store behaves exactly as today (no persistence across new
  instances).
- A rehydrated room has empty `sockets` and empty `recent`.

---

## 4. Section 3 — Tech-debt cleanup (B2 + B3)

### B2 — Hono `createBunWebSocket` deprecation

- `apps/relay/src/ws-handlers.ts` imports a deprecated `createBunWebSocket` from
  `hono/bun` (Hono ^4.6.9).
- Resolve by migrating to Hono's current Bun-WebSocket API, verified against
  Hono's current docs during implementation (may require a minor `hono` bump).
- Preserve the `raw.data.roomId` mutation invariant (never reassign `raw.data` —
  Hono's bun adapter owns it) and keep the relay's Bun-vitest suite green.

### B3 — `share-modal.svelte` accessibility

- Four a11y warnings on the overlay `div`. Fix by giving the interactive overlay
  a `tabindex` and a keyboard handler (Esc/Enter to close), or by converting to
  semantic `<dialog>` / `<button>` elements.
- Contained to one component; no behavior change beyond keyboard accessibility.

---

## 5. Implementation order (for the plan)

1. **B3 + B2** — isolated, low-risk; clear the deck first.
2. **Section 1 boundary refactor** — touches `client-core` + `apps/web`; TDD the
   `deriveRoomKey` helper, the `send()` return value, and persist dedup.
3. **Section 2 SQLite** — relay-only; TDD rehydrate, expiry double-delete, and
   the `:memory:` default.

All TDD (failing test → implement → green), small scoped commits
(`refactor(pkg):`, `feat(relay):`, `fix(web):`).

## 6. Out of scope / follow-up

- **UI redesign** — separate spec, immediately after this round.
- v0.2 items (binary frames, PAKE, multi-region, clock-skew ordering) remain
  deferred per the v0.1 design spec §13.
