# Uniclip — CLI File Transfer (Arc B) — Design Spec

**Date:** 2026-06-25
**Status:** Approved (pending spec review)
**Scope:** Surface `client-core`'s existing file transfer in the Ink terminal client — send a file (key → path prompt), accept/decline incoming offers, show progress, and save received files to disk. The transfer engine (`FileTransferManager`: chunking, per-chunk AES-GCM, credit-window flow control, acks, stall detection, hash verification) already exists and is unchanged; this is **thin glue + terminal UX in `apps/cli`**, with one Node-specific security concern (writing peer-named files to disk). No change to `client-core`, `protocol`, or `crypto`.

This is **Arc B** of the post-v0.3 program (Arc A = validate + harden, merged). It brings the CLI past text-only, toward web parity.

## 1. Goals and non-goals

### Goals
1. **Send:** press `f` to open a path input; type/paste a file path (with `~`/relative expansion); on Enter, read it and call `client.sendFile({ name, mime, bytes })`.
2. **Receive:** on a (non-inline) `file-offer`, show name + size and an **accept/decline** prompt; on accept, the engine streams; on `file-received`, save to disk.
3. **Save safely:** write the **sanitized basename** of the peer-offered name to the current working directory, collision-suffixed. Inline images (auto-accepted by the engine) save the same way.
4. **Progress:** render an active-transfers area driven by `file-progress`, with `file-error`/`file-cancel` surfaced as transient notes.

### Non-goals / preserved invariants
- **No change to `client-core`, `protocol`, or `crypto`** — the transfer engine is reused as-is via `UniclipClient`'s `sendFile`/`acceptFile`/`declineFile`/`cancelFile` + `file-*` events. New code is in `apps/cli` (plus one limiter tweak in the CLI's own `lan-relay.ts` — see §6).
- **No new wire frames or crypto** — per-chunk AES-GCM with the existing AAD `${routingId}:${fileId}:${index}:${isFinal}`; hash verified on reassembly before any disk write.
- **No directories / archives / multi-file picking** — one file per send action (you can send another after); the engine already supports concurrent transfers, which the UI lists.
- **Size cap is the engine's** — `MAX_FILE_BYTES` (100 MB); the CLI does not add its own.

## 2. Architecture & boundary

`UniclipClient` already exposes the full surface (`client.ts`): `sendFile({name,mime,bytes:Uint8Array}) → Promise<{fileId,chunkCount}|null>`, `acceptFile(id)`, `declineFile(id)`, `cancelFile(id)`, and emits `file-offer` / `file-progress {dir:"send"|"recv", sent, total}` / `file-received {blob, name, mime}` / `file-error {code, message}` / `file-cancel {reason}`. Files ride the transport seam (`sendFrame` prefers the open P2P channel, else the WS), so they travel P2P when available.

New files, all under `apps/cli/src/`:
- **`file-io.ts`** — the Node-fs glue and the security-critical unit:
  - `readForSend(path: string): Promise<{ name: string; mime: string; bytes: Uint8Array }>` — expand a leading `~`, `fs.readFile`, `name = path.basename`, `mime = mimeForName(name)`.
  - `safeFilename(name: string): string` — reduce a peer-controlled name to a safe basename: `path.basename(name)`, reject/replace `..` and path separators, fall back to `"file"` if empty/hidden-only.
  - `uniquePath(dir: string, name: string): string` — if `name` exists in `dir`, suffix ` (1)`, ` (2)`, … before the extension.
  - `saveBlob(dir: string, name: string, blob: Blob): Promise<string>` — `Buffer.from(await blob.arrayBuffer())` → `fs.writeFile(uniquePath(dir, safeFilename(name)))`; returns the final path.
- **`mime.ts`** — `mimeForName(name): string`, a small extension→MIME map (covers common images/text/pdf/zip/etc.); `application/octet-stream` default. No dependency. Drives the engine's `image/*` inline detection and gives the receiver a content-type hint.
- **`components/Transfers.tsx`** — renders the active-transfer list (direction arrow, name, percent).
- **`file-transfers.ts`** — a small non-React state holder (`Map<fileId, {dir, name, sent, total}>` + add/update/remove) so `app.tsx` doesn't balloon; `<App>` keeps it in React state and feeds `<Transfers>`.

Modified: `apps/cli/src/app.tsx` (subscribe to `file-*`; add the send-path prompt + the incoming-offer prompt; save on `file-received`), and `apps/cli/src/lan-relay.ts` (§6).

## 3. Send flow
- A keybinding **`f`** (in navigate mode; the composer keeps its own focus) switches `<App>` into a *file-prompt* mode rendering an `ink-text-input` labelled "Send file:".
- On submit: `readForSend(path)`; on success `await client.sendFile(file)`; on a read error (ENOENT/EISDIR/permission) emit a transient note and stay. Oversize is caught by the engine (`file-error TOO_LARGE`).
- `Esc` cancels the prompt. The offer then waits for the peer to accept (the engine arms no stall clock until streaming begins).

## 4. Receive flow
- On `file-offer`: **inline** images (the engine auto-accepts `image/*` ≤ `INLINE_IMAGE_MAX`) stream immediately — the CLI just saves on `file-received`. **Non-inline** offers put `<App>` into an *offer-prompt* state showing `name` + human size and `[a]ccept / [d]ecline`.
  - `a` → `client.acceptFile(id)`; `d` → `client.declineFile(id)`. (If multiple offers arrive, they queue; one prompt at a time.)
- On `file-received {blob, name, mime}`: `const saved = await saveBlob(process.cwd(), name, blob)` → note "Saved <saved>". `saveBlob` applies `safeFilename` + `uniquePath` internally.

## 5. Security model
- **Path-traversal sink (the one genuinely new risk).** The offered `name` is peer-controlled. The web app hands it to the browser's download API, which sanitizes; a CLI writing it straight to `fs` is a traversal sink. `safeFilename` guarantees only a bare filename inside `process.cwd()` is ever written — `../../x`, `/etc/x`, and separator-bearing names collapse to their basename, and a name that sanitizes to empty/dot-only becomes `"file"`. Covered by direct unit tests.
- **Consent gate.** No disk write occurs for a non-inline file until the user accepts. Inline auto-accept is bounded by `INLINE_IMAGE_MAX` (2 MB) and `image/*` only.
- **E2EE unchanged.** Per-chunk AES-GCM (existing AAD); the engine verifies the SHA-256 hash on reassembly **before** emitting `file-received`, so a tampered transfer never reaches disk.
- **No new persistence beyond the explicit save** — received files go only where the user accepted them (cwd); nothing else is written.

## 6. LAN-relay limiter interaction
The Arc A hardening gave the embedded `lan-relay.ts` a single per-socket budget (500 frames / 10 s). File chunks normally ride the **P2P channel** and never touch the relay, but on a relay-*fallback* (P2P failed) a large transfer at the engine's credit-window pace would exceed 500/10 s, get dropped, and trip the 30 s stall timer — a silent failure. Fix: bucket the limiter by frame category, mirroring the public relay — `file-*` frames get a **higher budget (2000 / 10 s, matching the public relay's `chunkLimiter`)**; all other frames keep the 500/10 s cap. This keeps the DoS backstop for clip/signaling while letting a legitimate file transfer survive a relay fallback.

## 7. Testing
- **`file-io`** (the security unit): `safeFilename` strips directories and rejects `..`/separators/absolute paths and empty→`"file"`; `uniquePath` suffixes on collision; `readForSend` (temp file) returns name+mime+bytes and expands `~`; `saveBlob` round-trips a `Blob` to a temp dir and returns the final (possibly suffixed) path.
- **`mime`**: known extensions map; unknown → `application/octet-stream`; case-insensitive.
- **`app`** (ink-testing-library + injected fake client): `f` opens the prompt and a submitted path calls `sendFile`; a non-inline `file-offer` shows the accept/decline prompt; `a` calls `acceptFile`, `d` calls `declineFile`; a `file-received` event writes a sanitized file into a temp cwd; `file-progress` renders a transfer line.
- **`lan-relay`**: a `file-*` flood is admitted up to the higher budget while a `clip` flood still hits the 500/10 s cap (proves the per-category split).
- **(optional) e2e**: extend the embedded-relay LAN e2e to send a multi-chunk file between two real `UniclipClient`s over werift and assert the received bytes match (hash) — proves the engine + CLI save path end-to-end in pure Node.

## 8. Decomposition (for the plan)
1. **`file-io.ts` + `mime.ts`** — read / sanitize / unique / save + MIME map (+ tests). The security unit; no UI.
2. **`lan-relay.ts` per-category budget** — `file-*` higher bucket (+ test).
3. **`file-transfers.ts` + `components/Transfers.tsx`** — transfer state + progress rendering (+ component test).
4. **`app.tsx` wiring** — `f` send-prompt, offer accept/decline prompt, save-on-received, event subscriptions (+ injected-client tests).
5. **(optional) e2e** — multi-chunk file over the embedded relay + werift.

Order 1→5; (1)(2) are libs/infra, (3)(4) the UI, (5) the integration proof. (1) carries the security tests that gate the receive path.
