# Uniclip — Items Polish (smart clips + history utility) — Design Spec

**Date:** 2026-06-24
**Status:** Approved (pending spec review)
**Scope:** Make the in-room items list richer and more useful — **URL-aware "smart clips"** (clickable links + per-item Open/QR actions) and **history utilities** (search/filter, local pin that survives the cap, copy-all / download export). This is the **re-scoped P3** (durable cross-session history sync was declined as off-ethos for a use-and-discard tool). **Entirely client-side, web-only: no protocol, relay, or crypto changes.**

## 1. Goals and non-goals

### Goals
1. URLs in a clip render as clickable links; a clip containing a URL gains **Open** and **QR** per-item actions (QR reuses `lib/qr.ts`).
2. Filter the items list by a case-insensitive substring search.
3. **Pin** items so they survive the 50-item cap eviction; pin is a private per-device label (no sync).
4. Export the (visible) history: **Copy all** to the clipboard and **Download .txt**.
5. Preserve the existing click-anywhere-to-copy affordance on a clip.

### Non-goals / preserved invariants
- **No protocol/relay/crypto change.** No new wire frames; the relay is untouched; pin is local-only (persisted in the existing encrypted localStorage log, never sent).
- **No cross-session history sync / anti-entropy** (the declined durability option).
- **No new content types beyond URLs** (no code/hex/email detection — YAGNI).
- Zero-knowledge unaffected: pin/search/export/URL-render are pure client-side; nothing new reaches the relay. At-rest history keeps AAD `persist:${roomId}`.
- Ephemeral rooms: search/URL-render/export still work on the in-memory list; pin has no durable effect (the `EphemeralStore` persists nothing) — acceptable.

## 2. Components

### 2.1 `apps/web/src/lib/clip-content.ts` (new)
Pure helpers, fully unit-testable:
- `type Segment = { type: "text" | "url"; value: string }`
- `clipSegments(text: string): Segment[]` — splits `text` into alternating text/url segments using an http(s) URL regex. A clip with no URL returns a single `{type:"text"}` segment. Trailing punctuation (`. , ) ] }`) is excluded from a matched URL.
- `firstUrl(text: string): string | null` — the first URL, or null. Drives the Open/QR actions.
- `matchesQuery(text: string, query: string): boolean` — case-insensitive substring; empty query → true.

### 2.2 `apps/web/src/lib/export.ts` (new)
- `historyText(items: { text: string }[]): string` — visible items joined by a blank line (`\n\n`).
- `downloadTextFile(filename: string, content: string): void` — creates a `Blob`, an object URL, a transient `<a download>`, clicks it, and revokes the URL. Guarded for non-DOM (no-op if `document` is undefined).

### 2.3 `apps/web/src/lib/persist.ts` (modify)
- `Item` gains `pinned?: boolean`. Unlike `pending` (deliberately never persisted), `pinned` **is** persisted (it serializes with the item array, encrypted under the existing AAD).
- `ItemStore` gains `setPinned(id: string, pinned: boolean): Promise<void>`. `PersistedItems` updates the item and `save()`s; `EphemeralStore` is a no-op (matches its other methods).
- **Eviction respects pins.** In `add()`, replace `splice(0, len-cap)` with: drop the **oldest unpinned** items until `length <= cap`; if pinned items alone exceed `cap`, keep them all (the cap is a soft limit for unpinned). The `QuotaExceededError` fallback in `save()` likewise shifts the oldest **unpinned** item (falling back to the oldest item only if all are pinned, to guarantee progress).

### 2.4 `apps/web/src/components/item-row.svelte` (redesign)
- **Content area** renders `clipSegments(item.text)`: text segments as plain spans, url segments as `<a href target="_blank" rel="noopener">`. The content stays click-to-copy (the wrapper has the copy `onclick`); each `<a>` calls `e.stopPropagation()` so a link click opens instead of copying. (The wrapper becomes a non-`<button>` element with `role="button"` + keyboard handler, since an `<a>` cannot nest inside a `<button>`.)
- **Action row** (the existing hover-revealed area): **Copy** (existing), **Pin** (toggle; filled when `item.pinned`), **Open** + **QR** (only when `firstUrl(item.text)` is non-null), **Delete** (existing). New props: `onPin: (id, pinned) => void`, `pinned: boolean` (from `item.pinned`). A pin marker shows in the meta row when pinned.
- **QR action** opens a small `qr-popover.svelte` showing `renderQrSvg(url)` (mirrors `share-modal.svelte`'s QR tile + the Safari-safe scrim pattern). Closeable via Escape / backdrop / Done.

### 2.5 `apps/web/src/components/qr-popover.svelte` (new)
A minimal modal: props `{ url, onClose }`; renders the QR (via `renderQrSvg`) + the URL text; uses the scoped `.scrim` rgba + dual `-webkit-`/standard `backdrop-filter` pattern (per the Tailwind-4 Safari memo) — not `bg-black/NN`.

### 2.6 `apps/web/src/components/items-list.svelte` + `routes/room.svelte` (modify)
- **Search:** `room.svelte` owns a `query` `$state` and renders a search input + the export buttons in the items-area header (above the list). It passes `query` to `items-list.svelte`, which filters its merged timeline for display (`matchesQuery` on `item.text`; transfers filtered by `name`). An active query with no matches shows a "no matches" state (distinct from the empty-room `EmptyState`).
- **Export:** "Copy all" → `navigator.clipboard.writeText(historyText(visible))`; "Download .txt" → `downloadTextFile('uniclip-history.txt', historyText(visible))`. "Visible" = the current filtered text items (newest-first or chronological — chronological for a readable log).
- **Pin:** `item-row`'s `onPin` calls a `room.svelte` handler → `persist.setPinned(id, pinned)` and updates the reactive `items` (toggle the flag in place) so the marker + eviction protection take effect immediately.

## 3. Data flow
- Clip arrives/sent → `items` updated + `persist.add` (unchanged). Render: `items-list` filters by `query`, `item-row` segments each clip and renders links + actions.
- Pin: user toggles → `setPinned` persists + `items` flag flips → eviction now protects it.
- Export/search/QR/Open are read-only over the current `items`.

## 4. Security model
- **No change to the zero-knowledge boundary.** Pin is a private local label (persisted only in the device's encrypted localStorage log; never transmitted). Search, URL rendering, QR, and export are pure client-side over already-decrypted local items. The relay sees nothing new.
- **Link safety:** URL `<a>`s use `rel="noopener"` (and `noreferrer`) + `target="_blank"`; only `http`/`https` schemes are linkified (the regex excludes `javascript:`/`data:` etc.), preventing scheme-based injection from a peer-sent clip.
- At-rest AAD (`persist:${roomId}`) and the cap semantics are otherwise unchanged.

## 5. Testing
- **`clip-content.ts`:** `clipSegments` splits a mixed text/URL string into correct segments; a no-URL string is one text segment; trailing punctuation is excluded from the URL; `javascript:`/`data:` are NOT linkified; `firstUrl` returns the first http(s) URL or null; `matchesQuery` is case-insensitive and empty-query-true.
- **`export.ts`:** `historyText` joins items by blank lines; `downloadTextFile` is a no-op without `document` and (with a stubbed DOM) creates+revokes an object URL.
- **`persist.ts`:** a pinned item survives eviction when the cap is exceeded by unpinned items; `setPinned` toggles and persists; the Quota fallback drops an unpinned item before a pinned one.
- **web components / e2e:** a clip containing a URL renders a clickable link and an Open/QR action; clicking a link does not trigger copy (stopPropagation); search filters the list; pinning marks an item; "Copy all" writes the joined text. e2e (Playwright): send a clip with a URL, assert the link is present and `target=_blank`; pin an item and assert the marker; type in search and assert filtering.

## 6. Decomposition (for the plan)
1. **`clip-content.ts`** — segments / firstUrl / matchesQuery (+ test).
2. **`export.ts`** — historyText / downloadTextFile (+ test).
3. **`persist.ts`** — `pinned` + pin-aware eviction + `setPinned` (+ test).
4. **`item-row.svelte` redesign + `qr-popover.svelte`** — links, action row (Copy/Pin/Open/QR/Delete), preserve click-to-copy.
5. **`items-list.svelte` + `room.svelte`** — search input + filter, export buttons, pin wiring, no-matches state.
6. **e2e** — URL link + pin marker + search filter.

Each is independently testable; (1)(2)(3) are pure libs, (4)(5) the UI, (6) the integration. Order 1→6.
