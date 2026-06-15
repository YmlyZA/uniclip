# Uniclip UI Follow-ups — Design Spec

**Date:** 2026-06-15
**Status:** Approved (pending spec review)
**Scope:** Three follow-up improvements from real-device use: (1) synced item delete, (2) a QR/Link toggle in the share modal, (3) an editable send composer replacing one-tap "Send clipboard now". Item 1 touches the protocol, relay, client-core, and web; items 2–3 are web-only. One combined spec.

## 1. Goals and non-goals

### Goals
1. **Synced delete** — deleting an item removes it from every device in the room (not just locally), matching the "live shared list" mental model.
2. **Share QR/Link toggle** — make the QR prominent and switchable with the link, for mobile (scan with another device's camera).
3. **Editable send composer** — replace the one-tap clipboard send with a multi-line, editable text field (best-effort pre-filled from the clipboard).

### Non-goals / preserved invariants
- **No identity / server-enforced permissions.** The relay is zero-knowledge and authless; it cannot tell who is who. "Anyone in the room can delete" is therefore the model — a client-side honor system, acceptable for trusted 2-person rooms. No accounts, no roles.
- **Zero-knowledge preserved.** Delete frames carry only the `msgId` (a ULID already sent in the clear with every clip) — no plaintext, no new info to the relay. Mode A stays zero-knowledge; AAD domain separation unchanged; backfill stays Mode-A-only.
- The auto-sync ("Sync this device") toggle is unchanged; only the *manual* send path becomes the composer.

## 2. Item 1 — Synced delete (anyone can delete)

### Protocol (`packages/protocol`)
- Add `DeleteFrameSchema`: `{ type: "delete", msgId: <ULID> }` (`.strict()`).
- `ClientFrameSchema` becomes a discriminated union of `ClipboardFrameSchema | DeleteFrameSchema`.
- Add `DeleteFrameSchema` to the `ServerFrameSchema` discriminated union (the relay forwards it to peers).

### Relay (`apps/relay`)
- WS `onMessage`: when a frame parses as `delete`, **broadcast it to the room's other sockets** (same fan-out as clip) **and remove that `msgId` from `room.recent`** (the backfill ring) so a late joiner never re-receives a deleted item. Delete frames are subject to the existing per-socket frame rate limit; they are NOT added to `recent` (live-only, like clips are once delivered).
- No change to room lifecycle, GC, or persistence.

### client-core (`packages/client-core`)
- Add `delete(msgId: string): void` — sends a `{ type: "delete", msgId }` frame (no-op if not connected).
- Add a `delete` event to `EventHandlers`: `delete: (msgId: string) => void`, emitted when a delete frame is received.
- The receive path validates the delete frame shape (already covered by `ServerFrameSchema`) and emits `delete`.

### web (`apps/web`)
- `PersistedItems.remove(id)` already exists.
- On user delete (the row trash button): remove from in-memory `items`, `persist.remove(id)`, **and** `client.delete(id)`.
- On `delete` event from a peer: remove from `items` + `persist.remove(id)` (idempotent if already gone).

### Limitation (documented, accepted)
A peer offline at delete-time won't receive the live delete and may still hold the item locally (deletes aren't backfilled). Matches the clip model.

## 3. Item 2 — Share modal QR/Link toggle

- The modal gains a segmented control: **QR** | **Link**.
  - **QR** (default): a large QR of the full share URL, sized for another device's camera.
  - **Link**: the URL in a mono field + a "Copy link" button (with copied feedback).
- The Mode-A/B security hint and the existing accessibility (Escape, focusable dialog, backdrop) are preserved.

## 4. Item 3 — Editable send composer

- Replace the manual **"Send clipboard now"** control with a composer:
  - A **multi-line textarea**, **best-effort pre-filled from the clipboard** when it mounts/focuses (works on desktop; may be empty on mobile, which can't read the clipboard without a gesture).
  - A **"Fill from clipboard"** button (clipboard icon) that reads the clipboard into the field on tap — the reliable path on mobile.
  - A **Send** action: **Enter sends, Shift+Enter inserts a newline**; sending clears the field; an empty field disables Send.
- Sent text flows through the existing `client.send(text)` → `addItem(..., mine: true)` path (no protocol change; still a `clip` frame).
- **Layout:** desktop — the composer sits in the left control panel where the send button was. Mobile — the bottom action bar holds the Sync toggle + a compact (auto-growing) composer + send. Exact sizing is an implementation/frontend-design detail.
- The auto-sync ("Sync this device") toggle is unchanged.

## 5. Testing

- **protocol:** `DeleteFrameSchema` accepts a valid delete, rejects extra fields / bad msgId; `ClientFrameSchema` accepts both clip and delete.
- **relay:** a delete frame is broadcast to other sockets and removes the msgId from `recent` (a subsequent late joiner does not receive the deleted item); sender does not receive its own delete echoed.
- **client-core:** `delete(msgId)` writes a delete frame; receiving a delete frame emits the `delete` event.
- **web:** `PersistedItems.remove` already tested; component wiring covered by e2e.
- **e2e:** a synced-delete flow — two browsers, A deletes an item, it disappears on B. (Plus the existing suites stay green.)

## 6. Out of scope
- Edit-in-place of existing items, multi-select delete, undo. Pin/star. Accounts/roles. Any v0.2 item. These can be future work.
