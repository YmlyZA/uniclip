# Composer Upgrade + Durable Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make synced deletes survive an offline peer (tombstone replay on join), and turn the send composer into a single-line field with an expand-to-modal editor and a 32 KB size cap.

**Architecture:** The relay keeps a bounded per-room tombstone set of deleted msgIds (mirror of the backfill ring); it replays them as `delete` frames on join and clears them on empty. The web composer collapses to one line, gains an Expand button that opens a full-editor modal sharing the same text state, and blocks sends over `MAX_TEXT_BYTES` (aligned to the 64 KB frame limit). No protocol/crypto change.

**Tech Stack:** Bun + Hono (relay), Svelte 5 + Tailwind 4 (web), Vitest, Playwright. Relay tests run under `bun --bun vitest`.

**Spec:** `docs/superpowers/specs/2026-06-16-uniclip-composer-and-durable-delete-design.md`

**Order:** relay tombstones (Tasks 1–2) → composer size helper (Task 3) → composer UI (Task 4) → e2e + verify (Task 5).

---

## Task 1: relay — per-room tombstone set

**Files:**
- Modify: `apps/relay/src/rooms.ts`
- Modify: `apps/relay/src/rooms.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/relay/src/rooms.test.ts`, change the import line to add `TOMBSTONE_CAP`:

```ts
import { RoomStore, RECENT_CAP, TOMBSTONE_CAP } from "./rooms";
```

Add inside `describe("RoomStore", ...)`:

```ts
  it("addTombstone records deleted msgIds (deduped)", () => {
    const s = new RoomStore();
    const r = s.create("A");
    s.addTombstone(r.id, "m1");
    s.addTombstone(r.id, "m1"); // dedup
    s.addTombstone(r.id, "m2");
    expect(s.get(r.id)!.tombstones).toEqual(["m1", "m2"]);
  });

  it("tombstones are bounded to TOMBSTONE_CAP (oldest evicted)", () => {
    const s = new RoomStore();
    const r = s.create("A");
    for (let i = 0; i < TOMBSTONE_CAP + 5; i++) s.addTombstone(r.id, `m${i}`);
    expect(s.get(r.id)!.tombstones).toHaveLength(TOMBSTONE_CAP);
  });
```

- [ ] **Step 2: Run them to confirm failure**

Run: `pnpm --filter @uniclip/relay test rooms`
Expected: FAIL — `TOMBSTONE_CAP` is not exported; `s.addTombstone` is not a function; `room.tombstones` is undefined.

- [ ] **Step 3: Add the tombstone field, cap, and method**

In `apps/relay/src/rooms.ts`:

Add the cap constant right after `export const RECENT_CAP = 50;`:

```ts
// How many deleted msgIds a room remembers, so a peer offline at delete-time can
// reconcile on (re)join. msgId-only — carries no plaintext.
export const TOMBSTONE_CAP = 200;
```

Add `tombstones` to the `Room` interface (after `backfillEnabled: boolean;`):

```ts
  // Deleted msgIds, replayed to (re)joiners so they drop locally-held items they
  // missed the live delete for. Bounded; cleared when the room empties.
  tombstones: string[];
```

In `create()`, add `tombstones: [],` to the room literal (next to `recent: [],`).

In `get()`'s rehydrate branch, add `tombstones: [],` to the rehydrated room literal (next to `recent: [],`).

Add this method directly after `removeRecent` (before `get(id)`):

```ts
  // Record a deleted msgId for tombstone replay. Bounded FIFO; deduped.
  addTombstone(id: string, msgId: string): void {
    const r = this.rooms.get(id);
    if (!r) return;
    if (r.tombstones.includes(msgId)) return;
    r.tombstones.push(msgId);
    if (r.tombstones.length > TOMBSTONE_CAP) {
      r.tombstones.splice(0, r.tombstones.length - TOMBSTONE_CAP);
    }
  }
```

- [ ] **Step 4: Run the rooms suite**

Run: `pnpm --filter @uniclip/relay test rooms`
Expected: PASS (new tombstone tests + all existing; the restart-rehydrate test still passes with `tombstones: []` on the rehydrated room).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @uniclip/relay typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/rooms.ts apps/relay/src/rooms.test.ts
git commit -m "feat(relay): per-room tombstone set for deleted msgIds (bounded, deduped)"
```

---

## Task 2: relay — record tombstones, replay on join, clear on empty

**Files:**
- Modify: `apps/relay/src/ws-handlers.ts` (onOpen, onClose, onMessage delete branch)
- Modify: `apps/relay/test/delete.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/relay/test/delete.test.ts`, add inside `describe("delete frame fan-out", ...)`:

```ts
  it("replays tombstones to a device that joins after the delete", async () => {
    const id = await mintRoom();
    const aMsgs: any[] = [];
    const a = await open(id, aMsgs);
    const clip = makeClip();
    a.send(JSON.stringify(clip));
    await wait(30);
    a.send(JSON.stringify({ type: "delete", msgId: clip.msgId }));
    await wait(30);

    // A new device joins AFTER the delete — it must receive the tombstone.
    const bMsgs: any[] = [];
    const b = await open(id, bMsgs);
    await wait(30);
    expect(bMsgs.filter((m) => m.type === "delete").map((m) => m.msgId)).toContain(clip.msgId);
    a.close();
    b.close();
  });

  it("clears tombstones once the room empties", async () => {
    const id = await mintRoom();
    const aMsgs: any[] = [];
    const a = await open(id, aMsgs);
    const clip = makeClip();
    a.send(JSON.stringify(clip));
    await wait(30);
    a.send(JSON.stringify({ type: "delete", msgId: clip.msgId }));
    await wait(30);
    a.close();
    await wait(40); // room empties → tombstones cleared

    const bMsgs: any[] = [];
    const b = await open(id, bMsgs);
    await wait(30);
    expect(bMsgs.filter((m) => m.type === "delete")).toHaveLength(0);
    b.close();
  });
```

- [ ] **Step 2: Run them to confirm failure**

Run: `pnpm --filter @uniclip/relay test delete`
Expected: FAIL — the relay doesn't record or replay tombstones yet (the joiner `b` receives no delete frame).

- [ ] **Step 3: Record a tombstone on delete**

In `apps/relay/src/ws-handlers.ts`, in the `onMessage` delete branch, add the `addTombstone` call. Replace:

```ts
          } else {
            // delete: drop it from the ring so a late joiner won't get it back.
            store.removeRecent(room.id, result.data.msgId);
          }
```

with:

```ts
          } else {
            // delete: drop it from the ring so a late joiner won't get it back,
            // and remember it so a peer offline now can reconcile on (re)join.
            store.removeRecent(room.id, result.data.msgId);
            store.addTombstone(room.id, result.data.msgId);
          }
```

- [ ] **Step 4: Replay tombstones on join**

In `onOpen`, right after the backfill `recent` replay block (the `if (room.backfillEnabled) { for (const frame of room.recent) send(raw, frame); }`), add:

```ts
          // Replay deletions to this newcomer too, so a device that was offline
          // when an item was deleted removes it on (re)join. Independent of
          // backfill — a tombstone is a msgId only, and `persist.remove` is a
          // no-op on a device that never had the item.
          for (const msgId of room.tombstones) send(raw, { type: "delete", msgId });
```

- [ ] **Step 5: Clear tombstones on empty**

In `onClose`, change the room-empty cleanup. Replace:

```ts
          if (room.sockets.size === 0) room.recent.length = 0;
```

with:

```ts
          if (room.sockets.size === 0) {
            room.recent.length = 0;
            room.tombstones.length = 0;
          }
```

- [ ] **Step 6: Run the delete suite**

Run: `pnpm --filter @uniclip/relay test delete`
Expected: PASS (the two new tests + the existing fan-out/prune tests).

- [ ] **Step 7: Full relay suite + typecheck**

Run: `pnpm --filter @uniclip/relay test && pnpm --filter @uniclip/relay typecheck`
Expected: PASS (no regressions; backfill/clip/ws/rooms all green).

- [ ] **Step 8: Commit**

```bash
git add apps/relay/src/ws-handlers.ts apps/relay/test/delete.test.ts
git commit -m "feat(relay): replay tombstones on join so offline peers reconcile deletes"
```

---

## Task 3: web — size-cap helper

**Files:**
- Create: `apps/web/src/lib/limits.ts`
- Create: `apps/web/src/lib/limits.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/limits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_TEXT_BYTES, textByteLength, withinLimit } from "./limits";

describe("text size limits", () => {
  it("MAX_TEXT_BYTES is 32 KiB", () => {
    expect(MAX_TEXT_BYTES).toBe(32 * 1024);
  });
  it("textByteLength counts UTF-8 bytes, not chars", () => {
    expect(textByteLength("abc")).toBe(3);
    expect(textByteLength("é")).toBe(2);
    expect(textByteLength("😀")).toBe(4);
  });
  it("withinLimit is true at the cap, false over it", () => {
    expect(withinLimit("x".repeat(MAX_TEXT_BYTES))).toBe(true);
    expect(withinLimit("x".repeat(MAX_TEXT_BYTES + 1))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm --filter @uniclip/web test limits`
Expected: FAIL — `Cannot find module './limits'`.

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/lib/limits.ts`:

```ts
// Plaintext send cap. Bounded by the protocol's 64 KiB frame limit
// (MAX_FRAME_BYTES): ciphertext is base64 (~1.33x) plus JSON overhead, so a
// frame stays under 64 KiB for plaintext up to ~40 KiB. 32 KiB leaves margin.
// Larger content is future file-transfer territory.
export const MAX_TEXT_BYTES = 32 * 1024;

export function textByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function withinLimit(text: string): boolean {
  return textByteLength(text) <= MAX_TEXT_BYTES;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @uniclip/web test limits`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/limits.ts apps/web/src/lib/limits.test.ts
git commit -m "feat(web): MAX_TEXT_BYTES + byte-length helpers for the send cap"
```

---

## Task 4: web — single-line composer + expand modal + size cap

**Files:**
- Create: `apps/web/src/components/composer-modal.svelte`
- Modify: `apps/web/src/components/composer.svelte`

- [ ] **Step 1: Create the modal editor**

Create `apps/web/src/components/composer-modal.svelte`:

```svelte
<script lang="ts">
  let {
    text = $bindable(""),
    over,
    bytes,
    onFill,
    onSend,
    onClose,
  }: {
    text: string;
    over: boolean;
    bytes: number;
    onFill: () => void;
    onSend: () => void;
    onClose: () => void;
  } = $props();

  let area = $state<HTMLTextAreaElement>();
  $effect(() => {
    area?.focus();
  });

  function onWindowKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
  function kb(n: number): string {
    return (n / 1024).toFixed(n < 10240 ? 1 : 0);
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-4 backdrop-blur-sm sm:items-center"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
  style="animation: item-arrive 0.18s ease-out"
>
  <div
    class="flex max-h-[80dvh] w-full max-w-xl flex-col overflow-hidden rounded-card border border-border bg-elevated shadow-[var(--shadow-card)]"
    role="dialog"
    aria-modal="true"
    aria-label="Compose message"
    tabindex="-1"
  >
    <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
      <h2 class="font-display text-base font-bold text-text">Compose</h2>
      <button
        type="button"
        onclick={onClose}
        class="grid h-8 w-8 place-items-center rounded-field text-muted transition hover:bg-surface-2 hover:text-text"
        aria-label="Close"
      >
        <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <textarea
      bind:this={area}
      bind:value={text}
      placeholder="Type or paste…"
      class="min-h-48 flex-1 resize-none bg-transparent p-5 font-mono text-sm leading-relaxed text-text placeholder:font-sans placeholder:text-faint focus:outline-none"
    ></textarea>

    <div class="flex items-center gap-3 border-t border-border p-3">
      <button
        type="button"
        onclick={onFill}
        class="rounded-field border border-border px-3 py-1.5 text-sm text-muted transition hover:border-border-strong hover:text-text"
      >
        Fill from clipboard
      </button>
      <span class="ml-auto text-[11px] {over ? 'text-danger' : 'text-faint'}">{kb(bytes)} KB / 32 KB</span>
      <button
        type="button"
        onclick={onSend}
        disabled={!text.trim() || over}
        class="rounded-field bg-accent px-4 py-1.5 text-sm font-bold text-accent-fg transition hover:bg-accent-bright disabled:opacity-40"
      >
        Send
      </button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Rewrite the inline composer**

Replace the entire contents of `apps/web/src/components/composer.svelte` with:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { readClipboardText } from "../lib/clipboard";
  import { toast } from "../lib/toast";
  import { MAX_TEXT_BYTES, textByteLength, withinLimit } from "../lib/limits";
  import ComposerModal from "./composer-modal.svelte";

  let { onSend }: { onSend: (text: string) => void } = $props();
  let text = $state("");
  let area = $state<HTMLTextAreaElement>();
  let expanded = $state(false);

  let bytes = $derived(textByteLength(text));
  let over = $derived(bytes > MAX_TEXT_BYTES);
  let showCount = $derived(bytes > MAX_TEXT_BYTES * 0.75);

  onMount(async () => {
    try {
      const t = await readClipboardText();
      if (t && !text) text = t;
    } catch {}
  });

  async function fill() {
    try {
      text = await readClipboardText();
      area?.focus();
    } catch {}
  }

  function send() {
    if (!text.trim()) return;
    if (!withinLimit(text)) {
      toast("Too large to send (max 32 KB). File transfer is coming.", "warn");
      return;
    }
    onSend(text);
    text = "";
    expanded = false;
    area?.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function kb(n: number): string {
    return (n / 1024).toFixed(n < 10240 ? 1 : 0);
  }
</script>

<div class="rounded-card border border-border bg-surface">
  <div class="flex items-center gap-2 p-2">
    <button
      type="button"
      onclick={fill}
      class="grid h-9 w-9 shrink-0 place-items-center rounded-field text-muted transition hover:bg-surface-2 hover:text-text"
      title="Fill from clipboard"
      aria-label="Fill from clipboard"
    >
      <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
        <rect x="8" y="3" width="8" height="4" rx="1" stroke="currentColor" stroke-width="1.7" />
        <path d="M9 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H15" stroke="currentColor" stroke-width="1.7" />
      </svg>
    </button>

    <textarea
      bind:this={area}
      bind:value={text}
      onkeydown={onKeydown}
      rows="1"
      placeholder="Type or paste — Enter to send"
      class="h-9 flex-1 resize-none overflow-hidden whitespace-nowrap bg-transparent py-1.5 font-mono text-sm text-text placeholder:font-sans placeholder:text-faint focus:outline-none"
    ></textarea>

    <button
      type="button"
      onclick={() => (expanded = true)}
      class="grid h-9 w-9 shrink-0 place-items-center rounded-field text-muted transition hover:bg-surface-2 hover:text-text"
      title="Expand editor"
      aria-label="Expand editor"
    >
      <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
        <path d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <button
      type="button"
      onclick={send}
      disabled={!text.trim() || over}
      class="grid h-9 w-9 shrink-0 place-items-center rounded-field bg-accent text-accent-fg transition hover:bg-accent-bright disabled:opacity-40"
      title="Send"
      aria-label="Send"
    >
      <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
        <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>

  {#if showCount}
    <div class="px-3 pb-1.5 text-right text-[11px] {over ? 'text-danger' : 'text-faint'}">
      {kb(bytes)} KB / 32 KB
    </div>
  {/if}
</div>

{#if expanded}
  <ComposerModal bind:text {over} {bytes} onFill={fill} onSend={send} onClose={() => (expanded = false)} />
{/if}
```

- [ ] **Step 3: Typecheck (svelte-check)**

Run: `pnpm --filter @uniclip/web typecheck`
Expected: PASS, 0 errors / 0 warnings (the two `svelte-ignore` lines suppress the backdrop a11y warnings, as in share-modal). If a different a11y code is reported on the modal backdrop, adjust the `svelte-ignore` codes to match and re-run.

- [ ] **Step 4: Run the web unit suite**

Run: `pnpm --filter @uniclip/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/composer.svelte apps/web/src/components/composer-modal.svelte
git commit -m "feat(web): single-line composer with expand modal + 32 KB send cap"
```

---

## Task 5: e2e + full verification + docs

**Files:**
- Create: `e2e/tests/durable-delete.spec.ts`
- Create: `e2e/tests/composer-cap.spec.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write the durable-delete e2e**

Create `e2e/tests/durable-delete.spec.ts`:

```ts
import { test, expect, chromium } from "@playwright/test";

// A peer that was offline (page closed) when another peer deleted an item must
// remove it on rejoin, via the relay's tombstone replay. The deleter stays
// connected, so the room never empties and the tombstone survives.
test("an offline peer removes a deleted item on rejoin", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();
  let pageB = await ctxB.newPage();

  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();

  await pageB.goto(roomUrl);
  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // A sends; B receives and persists it.
  await pageA.getByRole("textbox").fill("ephemeral");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageB.getByText("ephemeral")).toBeVisible({ timeout: 5_000 });

  // B goes offline — close the page but KEEP the context (localStorage persists).
  await pageB.close();

  // A deletes while B is offline.
  await pageA.getByRole("button", { name: /Delete item/i }).first().click();
  await expect(pageA.getByText("ephemeral")).toHaveCount(0, { timeout: 5_000 });

  // B reopens in the SAME context (same localStorage, still has the item) →
  // the relay replays the tombstone on join → B removes it.
  pageB = await ctxB.newPage();
  await pageB.goto(roomUrl);
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("ephemeral")).toHaveCount(0, { timeout: 5_000 });

  await browser.close();
});
```

- [ ] **Step 2: Write the composer-cap e2e**

Create `e2e/tests/composer-cap.spec.ts`:

```ts
import { test, expect, chromium } from "@playwright/test";

test("the composer blocks an over-size send", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();

  await page.goto("/");
  await page.getByRole("button", { name: /Zero-knowledge/i }).click();
  await page.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(page).toHaveURL(/\/r\/[a-z2-9]{6}#/);

  // Fill with > 32 KiB of text.
  await page.getByRole("textbox").fill("x".repeat(33_000));

  await expect(page.getByRole("button", { name: /^Send$/i })).toBeDisabled();
  await expect(page.getByText(/32 KB/)).toBeVisible();

  await browser.close();
});
```

- [ ] **Step 3: Run the full e2e suite**

Run: `pnpm test:e2e`
Expected: PASS — `two-browser`, `backfill`, `key-mismatch`, `synced-delete`, `durable-delete`, `composer-cap` all green. If a test flakes on cold-start, retry once. If a selector mismatches (e.g. the composer Send/Delete accessible names changed), read the component and fix the matcher to the actual name.

- [ ] **Step 4: Full typecheck + unit suites**

Run: `pnpm typecheck && pnpm test`
Expected: PASS across all packages.

- [ ] **Step 5: Update CLAUDE.md**

In `CLAUDE.md`:
- In the `apps/relay` bullet: note the per-room **tombstone set** (deleted msgIds) replayed on join so offline peers reconcile deletes; cleared on empty, alongside `recent`.
- In the `apps/web` bullet (or near the composer/clipboard description if present): note the send composer is single-line with an expand modal and a `MAX_TEXT_BYTES` (32 KB) cap aligned to the frame limit.

Keep edits concise and consistent with the surrounding style. Then commit everything:

```bash
git add e2e/tests/durable-delete.spec.ts e2e/tests/composer-cap.spec.ts CLAUDE.md
git commit -m "test(e2e): durable delete + composer cap; docs: tombstones + send cap"
```

---

## Notes for the implementer

- **Relay tests run under Bun** (`bun --bun vitest`); `delete.test.ts` uses real `Bun.serve` + `WebSocket`.
- **Tombstones are msgId-only** — never put plaintext or key-derived data in a tombstone; that would break the zero-knowledge boundary. They are mode-independent on purpose.
- **The durable-delete e2e must reuse the same browser context for B** (close the page, not the context) so localStorage survives — that is what makes B a device that *had* the item and missed the delete.
- **The composer modal shares `text`** with the inline field via `$bindable`; editing in either reflects in both. `send`/`fill` are the inline component's functions passed into the modal, so the size cap is enforced in exactly one place.
