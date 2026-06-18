# Uniclip — Binary Transfer UI (Phase 2 v0.2, sub-project 2) — Design Spec

**Date:** 2026-06-18
**Status:** Approved (pending spec review)
**Scope:** The web UI for binary file/image transfer, consuming the already-shipped transfer **engine** (sub-project 1). **`apps/web` only** — no protocol/relay/crypto changes (the one possible exception is lowering the `MAX_FILE_BYTES` protocol constant if Spike C shows iOS can't hold a 100 MB Blob).
**Background:** engine spec `docs/superpowers/specs/2026-06-17-uniclip-binary-transfer-engine-design.md`; research `docs/superpowers/research/2026-06-17-uniclip-phase2-binary-research.md`.

## 1. Goals and non-goals

### Goals
1. Send files/images via an **attach button** (composer), **paste an image**, and **drag-and-drop**.
2. Receive: small images (engine-`inline`) render as a **thumbnail** automatically; larger files + non-images show an **inline offer card** (Accept/Decline) in the timeline, then progress, then a **Download** card.
3. Show send/receive **progress** and allow **cancel**.
4. Keep the existing text-clip experience untouched; present files/images in the **same timeline** as clips.

### Non-goals / preserved invariants
- **No engine/protocol/relay/crypto changes** (other than possibly lowering `MAX_FILE_BYTES`). The UI only consumes `client.sendFile/acceptFile/declineFile/cancelFile` and the `file-*` events.
- **File/image transfers are never persisted** (download-and-forget; Blobs can't go to localStorage; binary is live-only). They live only in session memory and vanish on reload. Text clips persist exactly as today.
- No resume/retry, no transfer history, no WebRTC. (Engine non-goals carry over.)

## 2. Engine surface consumed (already exists)
- Methods: `client.sendFile({ name, mime, bytes: Uint8Array }): Promise<void>`, `acceptFile(fileId)`, `declineFile(fileId)`, `cancelFile(fileId)`.
- Events: `file-offer({fileId,name,mime,size,chunkCount,hash,inline})`, `file-progress({fileId,dir:"send"|"recv",sent,total})`, `file-received({fileId,blob,name,mime})`, `file-error({fileId,code,message})`, `file-cancel({fileId,reason})`.
- Behavior to rely on: an `inline` offer is **auto-accepted by the engine** (the UI must NOT show an Accept card for it); the engine never emits an explicit "send complete" — the UI infers a send is done when `file-progress(send)` reaches `sent === total`.

## 3. Transfer state model — `apps/web/src/lib/transfers.ts` (new, pure)
The transfer state machine is extracted into a pure, Svelte-free module so it is unit-testable.

```ts
export interface TransferItem {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  dir: "send" | "recv";
  state: "offering" | "transferring" | "done" | "error" | "cancelled";
  sent: number;   // chunks sent/received so far
  total: number;  // chunkCount
  blob?: Blob;    // set on file-received (recv, done)
  errorMsg?: string;
  ts: number;     // for timeline sorting
  mine: boolean;  // true for dir==="send"
}
```

Pure reducers (each takes `(list, payload, now)` and returns a NEW list — `room.svelte` holds the array and calls these):
- `addOutgoing(list, {fileId,name,mime,size,total}, now)` → appends a `dir:"send", state:"transferring"` item (`sent:0`).
- `applyOffer(list, offer, now)` → appends a `dir:"recv"` item; `state` is `"transferring"` if `offer.inline` (engine auto-accepts) else `"offering"` (`total: offer.chunkCount`).
- `applyProgress(list, {fileId,dir,sent,total})` → sets `sent`/`total`; if `sent >= total` and `dir==="send"`, sets `state:"done"`.
- `applyReceived(list, {fileId,blob})` → sets `state:"done"`, attaches `blob`.
- `applyError(list, {fileId,message})` → `state:"error"`, `errorMsg`.
- `applyCancel(list, {fileId})` → `state:"cancelled"`.
- `markTransferring(list, fileId)` → flips an `offering` item to `transferring` (used when the local user accepts a non-inline offer).
All keep the list bounded (e.g. last 50, same cap idea as clips) and are timestamp-stable.

> `mine`/`dir`: a `dir:"send"` item is the local user's; `dir:"recv"` is incoming. Used for left/right alignment like clip `mine`.

## 4. File send helper — `apps/web/src/lib/file-send.ts` (new, pure-ish)
- `MAX_FILE_BYTES` is imported from `@uniclip/protocol`.
- `readFileBytes(file: File): Promise<Uint8Array>` — `new Uint8Array(await file.arrayBuffer())`.
- `tooLarge(file: File | Blob): boolean` — `file.size > MAX_FILE_BYTES`.
- The send path: `if (tooLarge(file)) { toast("Too large (max <N> MB)"); return; }` else read bytes → `client.sendFile({ name: file.name, mime: file.type || "application/octet-stream", bytes })` and `addOutgoing(...)`.

## 5. Components

### `composer.svelte` (modify)
- New optional prop `onSendFile?: (file: File) => void`.
- Add an **attach button** (paperclip icon) in the button row immediately to the left of the Expand button, that triggers a hidden `<input type="file" />`; on `change`, call `onSendFile(file)` for the first selected file and reset the input's value (so re-picking the same file fires `change` again).
- Text send path is unchanged.

### `room.svelte` (modify)
- Hold `let transfers = $state<TransferItem[]>([])`; a `$derived` `timeline` merges persisted `items` (clips) + `transfers`, sorted by `ts` ascending (newest-last, matching the current list order), capped.
- Pass `timeline` to `ItemsList` (which renders clips and transfers).
- Wire engine events to the `transfers.ts` reducers:
  - `c.on("file-offer", (o) => { transfers = applyOffer(transfers, o, Date.now()); })`
  - `c.on("file-progress", (p) => { transfers = applyProgress(transfers, p); })`
  - `c.on("file-received", (r) => { transfers = applyReceived(transfers, r); })`
  - `c.on("file-error", (e) => { transfers = applyError(transfers, e); toast(`Transfer failed: ${e.code}`, "warn"); })`
  - `c.on("file-cancel", (c2) => { transfers = applyCancel(transfers, c2); })`
- `sendFile(file)`: size-check → read bytes → `client.sendFile(...)` → `transfers = addOutgoing(...)`.
- `onAccept(fileId)` → `client.acceptFile(fileId); transfers = markTransferring(transfers, fileId)`. `onDecline(fileId)` → `client.declineFile(fileId)`; remove the item. `onCancelTransfer(fileId)` → `client.cancelFile(fileId)`; (engine emits `file-cancel` → `applyCancel`).
- A window **paste** handler: on `paste`, if `e.clipboardData` has an image item, `sendFile(file)` from it (and `preventDefault`).
- A **drag-and-drop** overlay (`DropOverlay`) on the room container: `dragover`/`dragenter` show the overlay; `drop` sends each dropped file via `sendFile`; `dragleave`/`drop` hide it.
- Pass `onSendFile={sendFile}` to both the desktop and mobile `<Composer>`.

### `items-list.svelte` (modify)
- Accept a `timeline` of mixed entries; for each, render `ItemRow` (text clip) or `TransferRow` (transfer) based on a discriminant (e.g. clips have `text`, transfers have `fileId`/`state`). Keep the empty state.

### `transfer-row.svelte` (new)
Renders a `TransferItem` by `state`, aligned by `dir` (send = right, like `mine`):
- `offering` (recv only): file icon + name + human size + **Accept** / **Decline** buttons.
- `transferring`: name + a **progress bar** (`sent/total`) + **Cancel** (×). For `dir:"send"` shows "Sending…", `recv` "Receiving…".
- `done`:
  - image mime → **thumbnail** (`<img>` with an object URL from the Blob) + **Download** + best-effort **Copy image** (via `navigator.clipboard.write([new ClipboardItem({[mime]: blob})])`, wrapped in try/catch — silently hidden/no-op where unsupported).
  - non-image → file card (icon + name + size) + **Download** (an `<a download>` with an object URL).
  - Object URLs are created lazily and revoked on destroy (`URL.revokeObjectURL`) to avoid leaks.
- `error` / `cancelled`: a muted single line ("Transfer failed" / "Cancelled").

### `drop-overlay.svelte` (new)
A full-room dashed-border overlay with a "Drop to send" prompt, shown while a drag is active over the room.

## 6. Size cap & messaging
- The UI rejects a file `> MAX_FILE_BYTES` before sending: a toast `"Too large to send (max <N> MB)."` where `<N>` derives from `MAX_FILE_BYTES`. (Distinct from the text composer's 32 KB cap, which still applies to text.)
- If the engine ever emits `file-error{code:"TOO_LARGE"}` (it pre-checks too), `applyError` + toast handle it.

## 7. Error handling
| Situation | UI behavior |
|---|---|
| Picked/dropped/pasted file > cap | toast, nothing sent |
| `file-error` (AUTH_FAILED / HASH_MISMATCH / TOO_LARGE / STALLED / NO_KEY / DISCONNECTED) | mark item `error`, toast `Transfer failed: <code>` |
| `file-cancel` (peer or self) | mark item `cancelled` |
| Decline | remove the offer item; engine sends `file-decline` |
| Reload / leave mid-transfer | transfers are session-only → gone (engine aborts on disconnect) |

## 8. Spike C (run FIRST in the plan, before finalizing the cap)
On the constrained target (iOS Safari): can the page hold a ~100 MB `Blob` in memory, create an object URL, and trigger a download? Can it read a pasted image? If 100 MB is unsafe, **lower `MAX_FILE_BYTES`** in `@uniclip/protocol` (a one-line change; relay/engine already read it) and note it. The spike is throwaway; capture the chosen cap in the plan.

## 9. Testing
- **web unit (`lib/transfers.test.ts`):** the reducers — outgoing add; offer (inline → transferring, non-inline → offering); progress sets sent/total and marks send done at `sent===total`; received attaches blob + done; error/cancel transitions; list cap.
- **web unit (`lib/file-send.test.ts`):** `tooLarge` boundary at `MAX_FILE_BYTES`; `readFileBytes` round-trips a small `Blob`/`File` to the right bytes.
- **e2e (`e2e/tests/file-transfer.spec.ts`):** A attaches a small PNG (via the attach `<input type=file>` using Playwright `setInputFiles`) → B sees it inline (auto-accept) with a Download control; A attaches a larger non-image file → B sees an **offer card** → clicks **Accept** → progress → a **Download** button appears; A picks an oversize file → a toast and no transfer. (Paste and drag-drop are exercised by unit tests, not e2e — they are unreliable to drive in Playwright; the attach-button path is the e2e backbone.)

## 10. Files
- Create: `apps/web/src/lib/transfers.ts` (+ `.test.ts`), `apps/web/src/lib/file-send.ts` (+ `.test.ts`), `apps/web/src/components/transfer-row.svelte`, `apps/web/src/components/drop-overlay.svelte`, `e2e/tests/file-transfer.spec.ts`.
- Modify: `apps/web/src/components/composer.svelte` (attach button + `onSendFile`), `apps/web/src/components/items-list.svelte` (mixed timeline dispatch), `apps/web/src/routes/room.svelte` (transfers state, event wiring, sendFile, paste, drag-drop, accept/decline/cancel handlers).
- Possibly modify: `packages/protocol/src/index.ts` (`MAX_FILE_BYTES`) only if Spike C requires a lower cap.

## 11. Out of scope (deferred)
Transfer history/persistence; resume/retry/re-request; multiple-files-per-pick batching beyond looping; an explicit engine "send complete" event (the UI infers from progress); WebRTC; per-receiver progress in 3+ device rooms (the engine is best-effort; the UI shows one aggregate bar driven by the events it receives).
