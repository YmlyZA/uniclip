# Items Polish (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the in-room items list richer — URL-aware "smart clips" (clickable links + Open/QR actions), search/filter, a local pin that survives the cap, and copy-all / download export.

**Architecture:** Entirely client-side in `apps/web`. Three pure libs (`clip-content`, `export`, plus a `persist` pin tweak) underpin a redesigned `item-row.svelte` (links + action row) and `room.svelte`/`items-list.svelte` wiring (search, export, pin). No protocol, relay, or crypto changes; pin is a private local label persisted in the existing encrypted localStorage log.

**Tech Stack:** TypeScript, Svelte 5 (runes) + Tailwind 4, Vitest (Node), Playwright.

## Global Constraints

- **TDD always:** failing test → red → minimal impl → green → commit. (`CLAUDE.md`.)
- **Web-only:** changes confined to `apps/web`. NO protocol/relay/crypto change; no new wire frames; pin is never transmitted.
- **apps/web tests run in plain Node vitest** (no DOM/jsdom) — stub browser globals with `vi.stubGlobal` (`navigator`, `document`, `localStorage`, `URL`, `crypto` are getter-only; never `Object.assign`).
- **Link safety:** only `http`/`https` URLs are linkified; `<a>` uses `target="_blank"` + `rel="noopener noreferrer"`. Never linkify `javascript:`/`data:` etc.
- **Pin semantics:** `Item.pinned` IS persisted (unlike `pending`, which is never persisted). Eviction drops oldest **unpinned** first; pinned are a soft over-cap.
- **Tailwind v4 Safari rule:** any new modal/scrim uses a scoped `.scrim` with plain `rgba(...)` + BOTH `-webkit-backdrop-filter` and `backdrop-filter` (mirror `composer-modal.svelte`), never `bg-black/NN`.
- **Spec:** `docs/superpowers/specs/2026-06-24-uniclip-items-polish-design.md`.
- **Commit style:** small, scoped; end messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Branch: `feat/items-polish`.

---

## File Structure

- `apps/web/src/lib/clip-content.ts` (new) — `clipSegments`, `firstUrl`, `matchesQuery`.
- `apps/web/src/lib/export.ts` (new) — `historyText`, `downloadTextFile`.
- `apps/web/src/lib/persist.ts` (modify) — `Item.pinned`, pin-aware eviction, `setPinned`.
- `apps/web/src/components/item-row.svelte` (redesign) — links + action row (Copy/Pin/Open/QR/Delete).
- `apps/web/src/components/qr-popover.svelte` (new) — per-URL QR modal.
- `apps/web/src/components/items-list.svelte` (modify) — query filter, no-matches state.
- `apps/web/src/routes/room.svelte` (modify) — search input, export buttons, pin handler.
- `e2e/tests/items-polish.spec.ts` (new).

---

## Task 1: `clip-content.ts` — URL segmentation + search match

**Files:**
- Create: `apps/web/src/lib/clip-content.ts`
- Test: `apps/web/src/lib/clip-content.test.ts`

**Interfaces:**
- Produces: `type Segment = { type: "text" | "url"; value: string }`; `clipSegments(text): Segment[]`; `firstUrl(text): string | null`; `matchesQuery(text, query): boolean`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/clip-content.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clipSegments, firstUrl, matchesQuery } from "./clip-content";

describe("clipSegments", () => {
  it("splits text around an http(s) URL", () => {
    expect(clipSegments("see https://a.com/x now")).toEqual([
      { type: "text", value: "see " },
      { type: "url", value: "https://a.com/x" },
      { type: "text", value: " now" },
    ]);
  });
  it("returns a single text segment when there is no URL", () => {
    expect(clipSegments("no url here")).toEqual([{ type: "text", value: "no url here" }]);
  });
  it("excludes trailing sentence punctuation from the URL", () => {
    expect(clipSegments("go to https://a.com.")).toEqual([
      { type: "text", value: "go to " },
      { type: "url", value: "https://a.com" },
      { type: "text", value: "." },
    ]);
  });
  it("does NOT linkify javascript:/data: schemes", () => {
    expect(clipSegments("javascript:alert(1)")).toEqual([{ type: "text", value: "javascript:alert(1)" }]);
  });
});

describe("firstUrl", () => {
  it("returns the first http(s) URL or null", () => {
    expect(firstUrl("a https://x.io b https://y.io")).toBe("https://x.io");
    expect(firstUrl("none here")).toBeNull();
  });
});

describe("matchesQuery", () => {
  it("is case-insensitive and true for an empty query", () => {
    expect(matchesQuery("Hello World", "world")).toBe(true);
    expect(matchesQuery("Hello", "zzz")).toBe(false);
    expect(matchesQuery("anything", "  ")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/web test clip-content`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `apps/web/src/lib/clip-content.ts`:

```ts
export type Segment = { type: "text" | "url"; value: string };

// Sentence punctuation commonly stuck to the end of a pasted URL; not part of it.
const TRAILING = /[.,;:!?)\]}'"]+$/;

function splitTrailing(raw: string): { url: string; trailing: string } {
  const m = TRAILING.exec(raw);
  if (!m) return { url: raw, trailing: "" };
  return { url: raw.slice(0, m.index), trailing: raw.slice(m.index) };
}

// Only http(s) is linkified — this excludes javascript:/data:/etc. by construction.
export function clipSegments(text: string): Segment[] {
  const segs: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s]+/g)) {
    const start = m.index ?? 0;
    const { url, trailing } = splitTrailing(m[0]);
    if (start > last) segs.push({ type: "text", value: text.slice(last, start) });
    segs.push({ type: "url", value: url });
    if (trailing) segs.push({ type: "text", value: trailing });
    last = start + m[0].length;
  }
  if (last < text.length) segs.push({ type: "text", value: text.slice(last) });
  if (segs.length === 0) segs.push({ type: "text", value: text });
  return segs;
}

export function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? splitTrailing(m[0]).url : null;
}

export function matchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || text.toLowerCase().includes(q);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/web test clip-content` → PASS. `pnpm --filter @uniclip/web typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/clip-content.ts apps/web/src/lib/clip-content.test.ts
git commit -m "feat(web): clip-content — URL segmentation + search match

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `export.ts` — copy-all text + download

**Files:**
- Create: `apps/web/src/lib/export.ts`
- Test: `apps/web/src/lib/export.test.ts`

**Interfaces:**
- Produces: `historyText(items: { text: string }[]): string`; `downloadTextFile(filename: string, content: string): void`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/export.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { historyText, downloadTextFile } from "./export";

afterEach(() => vi.unstubAllGlobals());

describe("historyText", () => {
  it("joins item texts with a blank line", () => {
    expect(historyText([{ text: "a" }, { text: "b" }])).toBe("a\n\nb");
    expect(historyText([])).toBe("");
  });
});

describe("downloadTextFile", () => {
  it("is a no-op when document is undefined", () => {
    vi.stubGlobal("document", undefined);
    expect(() => downloadTextFile("x.txt", "hi")).not.toThrow();
  });
  it("creates an anchor with the download name and revokes the object URL", () => {
    const anchor: any = { click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    });
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: revoke });
    downloadTextFile("uniclip-history.txt", "hello");
    expect(anchor.download).toBe("uniclip-history.txt");
    expect(anchor.href).toBe("blob:x");
    expect(anchor.click).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/web test export`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `apps/web/src/lib/export.ts`:

```ts
export function historyText(items: { text: string }[]): string {
  return items.map((i) => i.text).join("\n\n");
}

// Triggers a client-side .txt download. No-op outside a DOM (SSR / tests).
export function downloadTextFile(filename: string, content: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```

> Node 22 provides `Blob`; the test stubs `document` and `URL` (createObjectURL/revokeObjectURL are DOM-only). The "no-op" test relies on `typeof document === "undefined"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/web test export` → PASS. `pnpm --filter @uniclip/web typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/export.ts apps/web/src/lib/export.test.ts
git commit -m "feat(web): export — history text + .txt download

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `persist.ts` — pin support + pin-aware eviction

**Files:**
- Modify: `apps/web/src/lib/persist.ts`
- Test: `apps/web/src/lib/persist.test.ts`

**Interfaces:**
- Consumes: existing `Item`, `ItemStore`, `PersistedItems`, `EphemeralStore`.
- Produces: `Item.pinned?: boolean`; `ItemStore.setPinned(id: string, pinned: boolean): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/lib/persist.test.ts` (reuse its existing localStorage stub + `deriveKey` setup — match the harness already at the top of that file; if it lacks a key helper, mirror the existing tests' `deriveKey({ secret, salt })` call):

```ts
describe("pin", () => {
  it("protects a pinned item from cap eviction (oldest unpinned drops first)", async () => {
    const key = await deriveKey({ secret: "pin-secret-pin-secret", salt: "room1" });
    const store = new PersistedItems({ roomId: "room1", key, cap: 2 });
    await store.add({ id: "a", text: "a", ts: 1 });
    await store.add({ id: "b", text: "b", ts: 2 });
    await store.setPinned("a", true);          // pin the oldest
    await store.add({ id: "c", text: "c", ts: 3 }); // over cap → evict oldest UNPINNED (b)
    const ids = (await store.load()).map((i) => i.id);
    expect(ids).toContain("a"); // pinned survived
    expect(ids).toContain("c");
    expect(ids).not.toContain("b");
  });
  it("setPinned persists and is idempotent", async () => {
    const key = await deriveKey({ secret: "pin-secret-pin-secret", salt: "room1" });
    const store = new PersistedItems({ roomId: "room2", key, cap: 50 });
    await store.add({ id: "x", text: "x", ts: 1 });
    await store.setPinned("x", true);
    expect((await store.load()).find((i) => i.id === "x")?.pinned).toBe(true);
    await store.setPinned("x", true); // no-op, no throw
    expect((await store.load()).find((i) => i.id === "x")?.pinned).toBe(true);
  });
});
```

> If `persist.test.ts` runs each test against a fresh localStorage stub keyed by storage key, the distinct `roomId`s above keep the two tests isolated. Match whatever isolation the existing tests use (e.g. a `beforeEach` clearing the stub).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/web test persist`
Expected: FAIL — `setPinned` not defined; eviction not pin-aware.

- [ ] **Step 3: Implement**

In `apps/web/src/lib/persist.ts`:

(a) `Item` interface — add:
```ts
  /** True when the user pinned this item; pinned items survive cap eviction.
   *  Local-only: persisted at rest but never transmitted. */
  pinned?: boolean;
```

(b) `ItemStore` interface — add:
```ts
  setPinned(id: string, pinned: boolean): Promise<void>;
```

(c) `PersistedItems.add` — replace the eviction block with a call to a pin-aware helper:
```ts
  async add(item: Item): Promise<void> {
    if (!this.loaded) await this.load();
    if (this.items.some((i) => i.id === item.id)) return; // dedup by frame identity
    this.items.push(item);
    this.evict();
    await this.save();
  }

  // Drop oldest UNPINNED items until within cap. Pinned items are protected
  // (the cap is a soft limit on unpinned); if everything is pinned, keep all.
  private evict(): void {
    while (this.items.length > this.opts.cap) {
      const idx = this.items.findIndex((i) => !i.pinned);
      if (idx === -1) break;
      this.items.splice(idx, 1);
    }
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    if (!this.loaded) await this.load();
    const it = this.items.find((i) => i.id === id);
    if (!it || !!it.pinned === pinned) return;
    it.pinned = pinned;
    await this.save();
  }
```

(d) `PersistedItems.save` — the `QuotaExceededError` fallback drops the oldest **unpinned** first:
```ts
    } catch {
      // QuotaExceededError → drop the oldest unpinned item and retry once
      // (fall back to the absolute oldest only if every item is pinned, so we
      // always make progress).
      if (this.items.length > 1) {
        const idx = this.items.findIndex((i) => !i.pinned);
        this.items.splice(idx === -1 ? 0 : idx, 1);
        await this.save();
      }
    }
```

(e) `EphemeralStore` — add the no-op:
```ts
  async setPinned(_id: string, _pinned: boolean): Promise<void> {
    /* intentionally not persisted */
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/web test persist` → PASS. `pnpm --filter @uniclip/web typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/persist.ts apps/web/src/lib/persist.test.ts
git commit -m "feat(web): pin items — survive cap eviction; setPinned

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `item-row.svelte` redesign + `qr-popover.svelte`

**Files:**
- Modify: `apps/web/src/components/item-row.svelte`
- Create: `apps/web/src/components/qr-popover.svelte`
- Test: covered by Task 6 e2e (UI wiring; no unit test).

**Interfaces:**
- Consumes: `clipSegments`/`firstUrl` (Task 1); `renderQrSvg` from `../lib/qr`; `Item` (Task 3, with `pinned`).
- Produces: `item-row` props gain `onPin: (id: string, pinned: boolean) => void`; reads `item.pinned`.

- [ ] **Step 1: Create the QR popover**

Create `apps/web/src/components/qr-popover.svelte`:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { renderQrSvg } from "../lib/qr";
  let { url, onClose }: { url: string; onClose: () => void } = $props();
  let svg = $state("");
  onMount(async () => { svg = await renderQrSvg(url); });
  function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
</script>

<svelte:window onkeydown={onKey} />
<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="scrim fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="w-full max-w-xs rounded-card border border-border bg-elevated p-5 shadow-[var(--shadow-card)]" role="dialog" aria-modal="true" aria-label="QR code for link" tabindex="-1">
    <div class="mx-auto grid w-fit place-items-center rounded-card border border-border bg-white p-3 [&>svg]:h-48 [&>svg]:w-48">
      {@html svg}
    </div>
    <p class="mt-3 break-all text-center text-xs text-muted">{url}</p>
    <button type="button" onclick={onClose} class="mt-4 w-full rounded-field bg-accent px-4 py-2 text-sm font-bold text-accent-fg transition hover:bg-accent-bright">Done</button>
  </div>
</div>

<style>
  .scrim {
    background-color: rgba(8, 10, 14, 0.82);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
</style>
```

- [ ] **Step 2: Redesign `item-row.svelte`**

Replace `apps/web/src/components/item-row.svelte` with:

```svelte
<script lang="ts">
  import type { Item } from "../lib/persist";
  import { clipSegments, firstUrl } from "../lib/clip-content";
  import QrPopover from "./qr-popover.svelte";

  let {
    item,
    mine,
    onCopy,
    onDelete,
    onPin,
  }: {
    item: Item;
    mine: boolean;
    onCopy: (text: string) => void;
    onDelete: (id: string) => void;
    onPin: (id: string, pinned: boolean) => void;
  } = $props();

  const segments = $derived(clipSegments(item.text));
  const url = $derived(firstUrl(item.text));
  let copied = $state(false);
  let showQr = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function copy() {
    onCopy(item.text);
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1400);
  }
  function onContentKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copy(); }
  }
  function ago(ts: number): string {
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }
</script>

<div class="group/row flex items-stretch gap-1.5" style="animation: item-arrive 0.28s ease-out" class:flex-row-reverse={mine}>
  <div
    class="relative min-w-0 max-w-[88%] flex-1 overflow-hidden rounded-card border px-3.5 py-2.5 text-left transition
      {item.pending ? 'opacity-60' : ''}
      {mine ? 'border-accent/30 bg-accent-soft' : 'border-border bg-surface hover:border-border-strong'}"
  >
    <div class="flex items-center gap-2 text-[11px]">
      <span class="font-medium uppercase tracking-wide {mine ? 'text-accent' : 'text-faint'}">{mine ? "You" : "Peer"}</span>
      <span class="text-faint">· {ago(item.ts)} ago</span>
      {#if item.pinned}
        <span class="inline-flex items-center gap-1 text-accent" title="Pinned — kept past the history limit">
          <svg viewBox="0 0 24 24" fill="currentColor" class="h-3 w-3" aria-hidden="true"><path d="M9 3h6l-1 6 3 3v2h-5v5l-1 2-1-2v-5H5v-2l3-3z"/></svg>
        </span>
      {/if}
      {#if item.pending}
        <span class="inline-flex items-center gap-1 text-warn" title="Queued — will send when reconnected">
          <svg viewBox="0 0 24 24" fill="none" class="h-3 w-3" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4l2.5 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Queued
        </span>
      {/if}
    </div>

    <!-- Click anywhere on the content copies; links open instead (stopPropagation). -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      data-testid="clip"
      role="button"
      tabindex="0"
      title="Click to copy"
      onclick={copy}
      onkeydown={onContentKey}
      class="mt-1.5 cursor-pointer whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-text line-clamp-6"
    >
      {#each segments as seg}
        {#if seg.type === "url"}
          <a href={seg.value} target="_blank" rel="noopener noreferrer" onclick={(e) => e.stopPropagation()} class="text-accent underline underline-offset-2 hover:text-accent-bright">{seg.value}</a>
        {:else}{seg.value}{/if}
      {/each}
    </div>

    <!-- action row -->
    <div class="mt-2 flex items-center gap-1 text-faint">
      <button type="button" onclick={copy} title="Copy" aria-label="Copy" class="grid h-7 w-7 place-items-center rounded-field transition hover:bg-surface-2 hover:text-text">
        <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="1.6"/></svg>
      </button>
      <button type="button" onclick={() => onPin(item.id, !item.pinned)} title={item.pinned ? "Unpin" : "Pin"} aria-label={item.pinned ? "Unpin item" : "Pin item"} aria-pressed={!!item.pinned} class="grid h-7 w-7 place-items-center rounded-field transition hover:bg-surface-2 {item.pinned ? 'text-accent' : 'hover:text-text'}">
        <svg viewBox="0 0 24 24" fill={item.pinned ? "currentColor" : "none"} class="h-4 w-4" aria-hidden="true"><path d="M9 3h6l-1 6 3 3v2h-5v5l-1 2-1-2v-5H5v-2l3-3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
      </button>
      {#if url}
        <a href={url} target="_blank" rel="noopener noreferrer" title="Open link" aria-label="Open link" class="grid h-7 w-7 place-items-center rounded-field transition hover:bg-surface-2 hover:text-text">
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M11 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </a>
        <button type="button" onclick={() => (showQr = true)} title="Show QR" aria-label="Show QR code for link" class="grid h-7 w-7 place-items-center rounded-field transition hover:bg-surface-2 hover:text-text">
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="4" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="14" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.6"/><path d="M14 14h3v3M20 14v6M17 20h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      {/if}
      <button type="button" onclick={() => onDelete(item.id)} title="Delete from this device" aria-label="Delete item" class="ml-auto grid h-7 w-7 place-items-center rounded-field transition hover:bg-danger-soft hover:text-danger">
        <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M8 7l.8 12h6.4L16 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>

    {#if copied}
      <div class="pointer-events-none absolute inset-0 grid place-items-center rounded-card bg-accent-soft backdrop-blur-[1px]" style="animation: copied-pop 0.2s ease-out">
        <span class="flex items-center gap-1.5 text-sm font-semibold text-accent">
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true"><path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Copied
        </span>
      </div>
    {/if}
  </div>
</div>

{#if showQr && url}
  <QrPopover {url} onClose={() => (showQr = false)} />
{/if}
```

- [ ] **Step 3: Verify it compiles and renders**

Run: `pnpm --filter @uniclip/web typecheck` → svelte-check 0 errors / 0 warnings. (If svelte-check warns about the `role="button"` content div lacking a keyboard handler, the `onkeydown={onContentKey}` already satisfies it; ensure the `a11y_click_events_have_key_events` ignore is not needed — the keydown handler covers it.)
Run: `pnpm --filter @uniclip/web test` → existing suite still green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/item-row.svelte apps/web/src/components/qr-popover.svelte
git commit -m "feat(web): smart-clip item row — links, pin, open, per-URL QR

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `items-list.svelte` + `room.svelte` — search, export, pin wiring

**Files:**
- Modify: `apps/web/src/components/items-list.svelte`, `apps/web/src/routes/room.svelte`
- Test: covered by Task 6 e2e.

**Interfaces:**
- Consumes: `matchesQuery` (Task 1); `historyText`/`downloadTextFile` (Task 2); `persist.setPinned` (Task 3); `item-row`'s `onPin` (Task 4).

- [ ] **Step 1: Add the query filter + no-matches state to `items-list.svelte`**

In `apps/web/src/components/items-list.svelte`:
- Add `query = ""` and `onPin` to props:
```ts
  let {
    items, transfers = [], syncing, query = "", onCopy, onDelete, onPin = () => {},
    onAccept = () => {}, onDecline = () => {}, onCancelTransfer = () => {},
  }: {
    items: Item[]; transfers?: TransferItem[]; syncing: boolean; query?: string;
    onCopy: (text: string) => void; onDelete: (id: string) => void; onPin?: (id: string, pinned: boolean) => void;
    onAccept?: (id: string) => void; onDecline?: (id: string) => void; onCancelTransfer?: (id: string) => void;
  } = $props();
```
- Import `matchesQuery`: `import { matchesQuery } from "../lib/clip-content";`
- Filter the timeline by query (text items by `text`, transfers by `name`):
```ts
  const timeline = $derived<Entry[]>(
    [...items, ...transfers]
      .filter((e) => (isTransfer(e) ? matchesQuery(e.name, query) : matchesQuery(e.text, query)))
      .sort((a, b) => a.ts - b.ts),
  );
```
- Pass `{onPin}` to `<ItemRow>`: `<ItemRow item={entry} mine={!!entry.mine} {onCopy} {onDelete} {onPin} />`.
- Distinguish "no matches" from the empty room: when `timeline.length === 0`, render the existing `<EmptyState {syncing} />` only if `query.trim() === ""`, else a no-matches message:
```svelte
{#if timeline.length === 0}
  {#if query.trim() === ""}
    <EmptyState {syncing} />
  {:else}
    <p class="px-1 py-8 text-center text-sm text-muted">No items match "{query}".</p>
  {/if}
{:else}
  ...existing list...
{/if}
```

- [ ] **Step 2: Wire search + export + pin into `room.svelte`**

In `apps/web/src/routes/room.svelte`:
- Imports: `import { historyText, downloadTextFile } from "../lib/export";` and `import { matchesQuery } from "../lib/clip-content";`
- State: `let query = $state("");`
- Pin handler (updates persist + the reactive `items` so the marker/eviction apply now):
```ts
  async function pinItem(id: string, pinned: boolean) {
    await persist?.setPinned(id, pinned);
    items = items.map((i) => (i.id === id ? { ...i, pinned } : i));
  }
```
- Export handlers (operate on the currently-filtered text items, chronological):
```ts
  function visibleForExport() {
    return items.filter((i) => matchesQuery(i.text, query));
  }
  async function copyAll() {
    try { await navigator.clipboard.writeText(historyText(visibleForExport())); toast("History copied", "info", 1400); } catch {}
  }
  function downloadAll() {
    downloadTextFile("uniclip-history.txt", historyText(visibleForExport()));
  }
```
(Use the existing `toast` import if present; otherwise omit the toast.)
- In the items-area markup (just above `<ItemsList .../>` at ~line 395), add a search + export bar, and pass `query`/`onPin`:
```svelte
  <div class="mb-2.5 flex items-center gap-2">
    <input
      bind:value={query}
      type="search"
      placeholder="Search items"
      aria-label="Search items"
      class="h-9 min-w-0 flex-1 rounded-field border border-border bg-surface px-3 text-sm text-text placeholder:text-faint focus:border-border-strong focus:outline-none"
    />
    <button type="button" onclick={copyAll} title="Copy all" aria-label="Copy all items" class="grid h-9 w-9 shrink-0 place-items-center rounded-field border border-border text-muted transition hover:bg-surface-2 hover:text-text">
      <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="1.6"/></svg>
    </button>
    <button type="button" onclick={downloadAll} title="Download .txt" aria-label="Download history as text" class="grid h-9 w-9 shrink-0 place-items-center rounded-field border border-border text-muted transition hover:bg-surface-2 hover:text-text">
      <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true"><path d="M12 4v10m0 0l-4-4m4 4l4-4M5 18h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
  <ItemsList {items} {transfers} {query} syncing={watching} onCopy={copy} {onDelete} onPin={pinItem} onAccept={acceptTransfer} onDecline={declineTransfer} onCancelTransfer={cancelTransfer} />
```
(Replace the existing single `<ItemsList .../>` line with the bar + the updated `<ItemsList>` that adds `{query}` and `onPin={pinItem}`.)

- [ ] **Step 3: Verify**

Run: `pnpm --filter @uniclip/web typecheck` → svelte-check 0/0. `pnpm --filter @uniclip/web test` → existing suite green. Manually: search filters; pin shows the marker and the item persists across reload; Copy all / Download work.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/items-list.svelte apps/web/src/routes/room.svelte
git commit -m "feat(web): items search/filter, copy-all + download, pin wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: e2e — link, pin, search

**Files:**
- Create: `e2e/tests/items-polish.spec.ts`

- [ ] **Step 1: Write the test**

Create `e2e/tests/items-polish.spec.ts`, modeled on `two-browser.spec.ts` (single browser is enough — one page creates a room and sends to itself is not possible, so use the existing two-context send, OR send from A and assert on A's own list since sent items render locally). Sent items appear in the sender's own list, so one page suffices:

```ts
import { test, expect, chromium } from "@playwright/test";

test("smart clips: link renders, pin marks, search filters", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();

  await page.goto("/");
  await page.getByRole("button", { name: /Zero-knowledge/i }).click();
  await page.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(page).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  await expect(page.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // Send a clip containing a URL.
  await page.getByRole("textbox").first().fill("visit https://example.com/page now");
  await page.getByRole("button", { name: /^Send$/i }).click();

  // The URL renders as a real link.
  const link = page.getByRole("link", { name: "https://example.com/page" });
  await expect(link).toBeVisible({ timeout: 5_000 });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);

  // Pin it → pin button becomes pressed.
  const pin = page.getByRole("button", { name: /^Pin item$/i }).first();
  await pin.click();
  await expect(page.getByRole("button", { name: /^Unpin item$/i }).first()).toBeVisible();

  // Send a second, non-matching clip, then search.
  await page.getByRole("textbox").first().fill("totally different text");
  await page.getByRole("button", { name: /^Send$/i }).click();
  await page.getByRole("searchbox", { name: /Search items/i }).fill("example");
  await expect(page.getByText("totally different text")).toHaveCount(0);
  await expect(link).toBeVisible();

  await browser.close();
});
```

> Note: `getByRole("textbox").first()` targets the composer (the search input is `type="search"` → `searchbox` role, distinct). If the composer's accessible name differs, match the real one. Raise timeouts before weakening assertions.

- [ ] **Step 2: Run the e2e**

Run: `pnpm test:e2e`
Expected: the new test passes alongside the existing 12 (13 total).

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/items-polish.spec.ts
git commit -m "test(e2e): smart-clip link, pin marker, search filter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `pnpm typecheck` → clean (svelte-check 0/0).
- [ ] `pnpm test` → all unit suites green (web gains clip-content/export/persist-pin tests).
- [ ] `pnpm test:e2e` → 13/13.
- [ ] Update `CLAUDE.md` `apps/web` bullet to mention smart clips (clickable URLs + per-item Open/QR), search/filter, local pin, and export (fold into Task 5 commit or a final `docs:` commit).

## Spec coverage check (self-review)

- §2.1 (`clip-content`) → Task 1. §2.2 (`export`) → Task 2. §2.3 (`persist` pin) → Task 3. §2.4 (`item-row` redesign) → Task 4 Step 2. §2.5 (`qr-popover`) → Task 4 Step 1. §2.6 (search/export/pin wiring) → Task 5. §3 (data flow) → Tasks 4-5. §4 (security: pin local-only, `rel=noopener`, http(s)-only) → Tasks 1/3/4. §5 (testing) → Tasks 1-3 units + Task 6 e2e. Ephemeral note → `EphemeralStore.setPinned` no-op (Task 3e).
