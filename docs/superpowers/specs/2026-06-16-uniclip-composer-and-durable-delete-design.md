# Uniclip — Composer Upgrade + Durable Synced Delete — Design Spec

**Date:** 2026-06-16
**Status:** Approved (pending spec review)
**Scope:** Two refinements from real-device use. (1) The send composer collapses to a single line with an expand-to-modal full editor and a size cap. (2) Synced deletes survive a peer being offline at delete-time (tombstone replay on join). Item 1 is web-only; item 2 is relay-only. One combined spec.

## 1. Goals and non-goals

### Goals
1. **Composer**: a compact single-line inline field; an expand button opens a modal to view/edit the full text; a size cap (~32KB plaintext) that blocks oversized sends with a clear message.
2. **Durable delete**: a peer that was offline (screen-locked, disconnected) when another peer deleted an item removes it on reconnect/refresh — not stuck forever.

### Non-goals / preserved invariants
- **No protocol/crypto change.** The size cap aligns to the existing `MAX_FRAME_BYTES` (64KB) frame limit; deletes reuse the existing `delete` frame. Zero-knowledge preserved (tombstones are msgIds only — already in the clear).
- File transfer for large content is **future work** (the size cap's message points at it); not built here.
- No accounts/identity; deletes remain authless (any peer can delete).

## 2. Item 1 — Composer: single line + expand modal + size cap

### Constraint
`MAX_FRAME_BYTES = 64 * 1024`. A frame is JSON-wrapping base64 ciphertext (~1.33× plaintext) plus overhead; the relay closes the socket (`TOO_LARGE`/4413) above the limit. So the realistic plaintext cap is ~40KB; we use **`MAX_TEXT_BYTES = 32 * 1024`** for safe margin. The web client currently enforces NO size check before send (a large paste silently disconnects) — this fixes that.

### Inline composer (collapsed, single line)
- The textarea renders as **a single line**: `rows=1`, `overflow-hidden`, no visible scrollbar, no auto-grow. Long/multiline text shows its first line clipped — the user just sees that text is present.
- Controls on the inline bar: **Fill from clipboard**, **Expand** (new), **Send**.
- Enter sends; Shift+Enter inserts a newline (text persists; switch to the modal to see it).

### Expand modal (full editor)
- The **Expand** button (e.g. a corners/maximize icon) opens a modal dialog containing a large multi-line textarea bound to the same `text` state.
- The modal textarea shows a **scrollbar only while scrolling** (overlay/thin scrollbar styling), not permanently.
- The modal has **Fill** and **Send**; closing it keeps `text` (shared state), so the inline field reflects edits.
- Accessibility mirrors the share modal: Escape closes, focusable dialog, backdrop click-to-close.

### Size cap behavior
- `byteLength(text, "utf8") > MAX_TEXT_BYTES` ⇒ **send is blocked**: a toast — "Too large to send (max 32 KB). File transfer is coming." — and the Send control is disabled while over.
- **No indicator in normal use.** Only when text exceeds ~75% of the cap, show a small unobtrusive `"<N> KB / 32 KB"` counter (turns to the danger color when over).
- The cap is enforced in one place (a shared helper) used by both the inline and modal send paths.

### Files
- Modify: `apps/web/src/components/composer.svelte` (single-line collapse, expand button, size-cap guard; owns the shared `text` state and renders the modal when expanded).
- Create: `apps/web/src/components/composer-modal.svelte` (the full-editor dialog; props: the bound text, `onSend`, `onFill`, `onClose`).
- Optionally extract the size-cap helper (e.g. `MAX_TEXT_BYTES` + `withinLimit(text)`) into `apps/web/src/lib/limits.ts` so the inline and modal paths share one definition.
- No change to `room.svelte`'s `sendText` (still receives the final text).

## 3. Item 2 — Durable synced delete (tombstone replay on join)

### Model
Mirror the backfill ring: each room keeps a bounded in-memory **tombstone set** of deleted msgIds. On join, the relay replays the tombstones (as `delete` frames) to the newcomer, so a device that missed a live delete (offline/locked) removes the stale item from its local persisted history. Cleared on empty, exactly like `recent`.

### Relay (`apps/relay`)
- `RoomStore`: add `tombstones: string[]` to `Room`; a `TOMBSTONE_CAP` (e.g. 200); a method `addTombstone(id, msgId)` (dedup, FIFO-bounded). On room create, `tombstones: []`.
- `ws-handlers` `onMessage` delete branch: after `broadcast` + `removeRecent`, also `store.addTombstone(room.id, result.data.msgId)`.
- `ws-handlers` `onOpen`: after replaying `recent` clips to the newcomer, replay each tombstone as a `delete` frame to that newcomer only: `for (const msgId of room.tombstones) send(raw, { type: "delete", msgId })`.
- `onClose` (room empties): clear `tombstones` alongside `recent` (`room.tombstones.length = 0`).
- **Mode-independent**: tombstone replay does NOT depend on `backfillEnabled` (msgIds carry no secret; the missed-delete bug exists in both modes). A newcomer that never had a given item receives a delete for it and `persist.remove` is a harmless no-op.

### Client / web
- No change required: the client already emits a `delete` event on a delete frame, and `room.svelte` removes the item from `items` + `persist`. The replayed tombstones simply arrive as delete frames after the peer has loaded its persisted history on connect.

### Ordering / correctness
- On join the relay sends: hello → backfill `recent` clips → tombstones. A deleted clip is already pruned from `recent`, so it is never re-sent; the tombstone targets items the peer holds in its OWN localStorage from a prior session.
- The peer's `room.svelte` awaits `persist.load()` before `connect()`, so persisted items exist before tombstone delete frames arrive — the removal lands correctly.

### Known limitation (documented, accepted)
If **every** device leaves the room (sockets → 0) between a delete and the offline device's return, the tombstone is cleared and that device keeps the item. Consistent with "history lives only while a device is connected." The reported scenario (the deleter stays connected while the other device is merely locked) is fixed.

## 4. Testing
- **relay unit/integration:** a delete adds a tombstone; a joiner receives the tombstone as a delete frame after `recent`; tombstones clear on empty; tombstone set is bounded to `TOMBSTONE_CAP`.
- **e2e:** A and B in a room; A sends a clip (both see it); B's page closes (offline); A deletes the clip; B reopens the room → the clip is gone (removed via tombstone replay on join).
- **web:** composer blocks a send over `MAX_TEXT_BYTES` (toast, disabled send); the expand modal shares text with the inline field; single-line collapse renders without a visible scrollbar.

## 5. Out of scope
- File transfer / binary frames (the cap message references it as future work).
- Raising `MAX_FRAME_BYTES`. Persisting tombstones to SQLite (durable-across-empty deletes). Edit-in-place, undo, multi-select. All future considerations.
