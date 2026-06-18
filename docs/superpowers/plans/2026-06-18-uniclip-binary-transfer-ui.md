# Binary Transfer UI Implementation Plan (Phase 2 v0.2, sub-project 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the web UI for binary file/image transfer — attach-button + paste + drag-drop sends, inline offer cards, inline image thumbnails, download-button file cards, progress + cancel — consuming the already-shipped transfer engine.

**Architecture:** A pure `lib/transfers.ts` state machine maps the engine's `file-*` events to `TransferItem`s held in a session-only array (never persisted — download-and-forget). `items-list` merges persisted clips + transfers into one timeline. The engine's `sendFile` is extended (minimally) to return its minted `{fileId, chunkCount}` so the optimistic send item can be correlated with progress events.

**Tech Stack:** Svelte 5 runes + Tailwind 4 (web), Vitest (web unit), Playwright (e2e). Consumes `@uniclip/client-core` + `@uniclip/protocol`.

---

## File Structure
- `packages/client-core/src/file-transfer.ts`, `client.ts` — `sendFile` returns `{fileId, chunkCount} | null` (Task 1).
- `apps/web/src/lib/file-send.ts` (new) — `MAX_FILE_BYTES`/`MAX_FILE_MB`, `tooLarge`, `chunkCountOf`, `readFileBytes`.
- `apps/web/src/lib/transfers.ts` (new) — `TransferItem` + pure reducers.
- `apps/web/src/components/composer.svelte` — attach button + optional `onSendFile`.
- `apps/web/src/components/transfer-row.svelte` (new) — render a `TransferItem`.
- `apps/web/src/components/drop-overlay.svelte` (new) — drag-drop overlay.
- `apps/web/src/components/items-list.svelte` — merge clips + transfers, dispatch rows.
- `apps/web/src/routes/room.svelte` — transfers state, event wiring, send/accept/decline/cancel, paste, drag-drop.
- `e2e/tests/file-transfer.spec.ts` (new).

> **Manual QA note (not a code task):** the iOS-Safari Blob/download/paste check ("Spike C" in the spec) needs a real device, which this pipeline can't run. The UI reads `MAX_FILE_BYTES` (currently 100 MB) for its cap. Before shipping, verify on an iPhone that receiving a near-cap file doesn't crash Safari (receiver peak memory ≈ 2–3× file size during assembly); if it does, lower `MAX_FILE_BYTES` in `packages/protocol/src/index.ts` (one line; relay/engine/UI all read it).

---

## Task 1: Engine — `sendFile` returns its minted `{fileId, chunkCount}`

**Files:**
- Modify: `packages/client-core/src/file-transfer.ts` (`FileTransferManager.sendFile`)
- Modify: `packages/client-core/src/client.ts` (`UniclipClient.sendFile` delegator)
- Test: `packages/client-core/src/file-transfer.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe("FileTransferManager sender", …)` block in `packages/client-core/src/file-transfer.test.ts`:

```ts
  it("sendFile returns the minted {fileId, chunkCount}, and null when oversize", async () => {
    const key = await genKey();
    const { mgr } = makeManager(key);
    const res = await mgr.sendFile({ name: "f.txt", mime: "text/plain", bytes: new TextEncoder().encode("hi") });
    expect(res).not.toBeNull();
    expect(res!.fileId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(res!.chunkCount).toBe(1);
    const big = await mgr.sendFile({ name: "b", mime: "x", bytes: { length: 100 * 1024 * 1024 + 1 } as unknown as Uint8Array });
    expect(big).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/client-core test file-transfer`
Expected: FAIL — `sendFile` currently returns `void`/`undefined`, so `res!.fileId` is undefined and `res` is not null on the oversize path.

- [ ] **Step 3: Implement**

In `packages/client-core/src/file-transfer.ts`, change `sendFile`'s signature and its return points:

```ts
  async sendFile(file: { name: string; mime: string; bytes: Uint8Array }): Promise<{ fileId: string; chunkCount: number } | null> {
    if (file.bytes.length > MAX_FILE_BYTES) {
      this.deps.emit({ kind: "file-error", fileId: "", code: "TOO_LARGE", message: "file exceeds the size limit" });
      return null;
    }
    const key = this.deps.getKey();
    if (!key) {
      this.deps.emit({ kind: "file-error", fileId: "", code: "NO_KEY", message: "no room key" });
      return null;
    }
    const fileId = ulid();
    const chunkCount = Math.max(1, Math.ceil(file.bytes.length / CHUNK_BYTES));
    const hash = await sha256Hex(file.bytes as Uint8Array<ArrayBuffer>);
    const inline = file.mime.startsWith("image/") && file.bytes.length <= INLINE_IMAGE_MAX;
    this.outgoing.set(fileId, {
      fileId, bytes: file.bytes, name: file.name, mime: file.mime,
      chunkCount, nextChunk: 0, ackedUpTo: -1, started: false, pumping: false, stall: null,
    });
    const ok = this.deps.send({
      type: "file-offer", fileId, name: file.name, mime: file.mime,
      size: file.bytes.length, chunkCount, hash, inline,
    });
    if (!ok) { this.fail(fileId, "DISCONNECTED", "not connected"); return null; }
    this.armStall(fileId);
    return { fileId, chunkCount };
  }
```

In `packages/client-core/src/client.ts`, update the delegator's return type:

```ts
  async sendFile(file: { name: string; mime: string; bytes: Uint8Array }): Promise<{ fileId: string; chunkCount: number } | null> {
    return this.transfers.sendFile(file);
  }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @uniclip/client-core test && pnpm --filter @uniclip/client-core typecheck`
Expected: PASS (the new test + all existing — existing callers ignore the return value).

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/file-transfer.ts packages/client-core/src/client.ts packages/client-core/src/file-transfer.test.ts
git commit -m "feat(client-core): sendFile returns minted {fileId, chunkCount} for UI correlation"
```

---

## Task 2: Web — `lib/file-send.ts` (size cap + file reading)

**Files:**
- Create: `apps/web/src/lib/file-send.ts`
- Test: `apps/web/src/lib/file-send.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/file-send.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { tooLarge, readFileBytes, chunkCountOf, MAX_FILE_BYTES, MAX_FILE_MB } from "./file-send";
import { CHUNK_BYTES } from "@uniclip/protocol";

describe("file-send helpers", () => {
  it("tooLarge: false at the cap, true just over", () => {
    expect(tooLarge({ size: MAX_FILE_BYTES })).toBe(false);
    expect(tooLarge({ size: MAX_FILE_BYTES + 1 })).toBe(true);
  });
  it("MAX_FILE_MB is the cap in whole MB", () => {
    expect(MAX_FILE_MB).toBe(Math.round(MAX_FILE_BYTES / (1024 * 1024)));
  });
  it("readFileBytes round-trips a Blob's bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(await readFileBytes(new Blob([bytes]))).toEqual(bytes);
  });
  it("chunkCountOf splits by CHUNK_BYTES (min 1)", () => {
    expect(chunkCountOf(0)).toBe(1);
    expect(chunkCountOf(CHUNK_BYTES)).toBe(1);
    expect(chunkCountOf(CHUNK_BYTES + 1)).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/web test file-send`
Expected: FAIL — `./file-send` does not exist.

- [ ] **Step 3: Implement**

Create `apps/web/src/lib/file-send.ts`:

```ts
import { MAX_FILE_BYTES, CHUNK_BYTES } from "@uniclip/protocol";

export { MAX_FILE_BYTES };

/** The cap as a whole number of MB, for user-facing messages. */
export const MAX_FILE_MB = Math.round(MAX_FILE_BYTES / (1024 * 1024));

export function tooLarge(file: { size: number }): boolean {
  return file.size > MAX_FILE_BYTES;
}

/** How many chunks the engine will split a file of this byte length into. */
export function chunkCountOf(byteLength: number): number {
  return Math.max(1, Math.ceil(byteLength / CHUNK_BYTES));
}

export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/web test file-send`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/file-send.ts apps/web/src/lib/file-send.test.ts
git commit -m "feat(web): file-send helpers (size cap, chunk count, read bytes)"
```

---

## Task 3: Web — `lib/transfers.ts` (pure transfer state machine)

**Files:**
- Create: `apps/web/src/lib/transfers.ts`
- Test: `apps/web/src/lib/transfers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/transfers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  addOutgoing, applyOffer, applyProgress, applyReceived, applyError,
  applyCancel, removeTransfer, markTransferring,
} from "./transfers";

describe("transfers reducers", () => {
  it("addOutgoing appends a send/transferring item", () => {
    const l = addOutgoing([], { fileId: "f1", name: "a", mime: "text/plain", size: 10, total: 1 }, 100);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ fileId: "f1", dir: "send", state: "transferring", sent: 0, total: 1, mine: true, ts: 100 });
  });

  it("applyOffer: inline → transferring, non-inline → offering; dedups by fileId", () => {
    let l = applyOffer([], { fileId: "f2", name: "p.png", mime: "image/png", size: 4, chunkCount: 1, inline: true }, 1);
    expect(l[0]).toMatchObject({ dir: "recv", state: "transferring", mine: false });
    l = applyOffer(l, { fileId: "f3", name: "b", mime: "x", size: 1, chunkCount: 2, inline: false }, 2);
    expect(l.find((t) => t.fileId === "f3")?.state).toBe("offering");
    expect(applyOffer(l, { fileId: "f3", name: "b", mime: "x", size: 1, chunkCount: 2, inline: false }, 3)).toHaveLength(2);
  });

  it("applyProgress updates sent/total and marks a SEND done at sent===total", () => {
    let l = addOutgoing([], { fileId: "f1", name: "a", mime: "x", size: 10, total: 3 }, 0);
    l = applyProgress(l, { fileId: "f1", dir: "send", sent: 2, total: 3 });
    expect(l[0]).toMatchObject({ sent: 2, state: "transferring" });
    l = applyProgress(l, { fileId: "f1", dir: "send", sent: 3, total: 3 });
    expect(l[0]?.state).toBe("done");
  });

  it("a recv progress reaching total does NOT mark done (waits for file-received)", () => {
    let l = applyOffer([], { fileId: "r1", name: "a", mime: "x", size: 1, chunkCount: 2, inline: true }, 0);
    l = applyProgress(l, { fileId: "r1", dir: "recv", sent: 2, total: 2 });
    expect(l[0]?.state).toBe("transferring");
  });

  it("applyReceived attaches the blob + marks done", () => {
    let l = applyOffer([], { fileId: "r1", name: "a", mime: "text/plain", size: 1, chunkCount: 1, inline: true }, 0);
    const blob = new Blob(["hi"]);
    l = applyReceived(l, { fileId: "r1", blob });
    expect(l[0]?.state).toBe("done");
    expect(l[0]?.blob).toBe(blob);
  });

  it("applyError marks error and ignores an empty fileId (pre-flight)", () => {
    let l = addOutgoing([], { fileId: "f1", name: "a", mime: "x", size: 1, total: 1 }, 0);
    expect(applyError(l, { fileId: "", message: "x" })).toEqual(l);
    l = applyError(l, { fileId: "f1", message: "boom" });
    expect(l[0]).toMatchObject({ state: "error", errorMsg: "boom" });
  });

  it("markTransferring flips offering→transferring; applyCancel→cancelled; removeTransfer drops", () => {
    let l = applyOffer([], { fileId: "r1", name: "a", mime: "x", size: 1, chunkCount: 2, inline: false }, 0);
    expect(l[0]?.state).toBe("offering");
    l = markTransferring(l, "r1");
    expect(l[0]?.state).toBe("transferring");
    l = applyCancel(l, { fileId: "r1" });
    expect(l[0]?.state).toBe("cancelled");
    expect(removeTransfer(l, "r1")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/web test transfers`
Expected: FAIL — `./transfers` does not exist.

- [ ] **Step 3: Implement**

Create `apps/web/src/lib/transfers.ts`:

```ts
export interface TransferItem {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  dir: "send" | "recv";
  state: "offering" | "transferring" | "done" | "error" | "cancelled";
  sent: number; // chunks sent/received so far
  total: number; // chunkCount
  blob?: Blob; // set on file-received
  errorMsg?: string;
  ts: number; // for timeline sorting
  mine: boolean; // true for dir === "send"
}

const CAP = 50;
const cap = (l: TransferItem[]): TransferItem[] => (l.length > CAP ? l.slice(l.length - CAP) : l);
const patch = (l: TransferItem[], fileId: string, p: Partial<TransferItem>): TransferItem[] =>
  l.map((t) => (t.fileId === fileId ? { ...t, ...p } : t));

export function addOutgoing(
  l: TransferItem[],
  f: { fileId: string; name: string; mime: string; size: number; total: number },
  now: number,
): TransferItem[] {
  return cap([...l, { ...f, dir: "send", state: "transferring", sent: 0, ts: now, mine: true }]);
}

export function applyOffer(
  l: TransferItem[],
  o: { fileId: string; name: string; mime: string; size: number; chunkCount: number; inline: boolean },
  now: number,
): TransferItem[] {
  if (l.some((t) => t.fileId === o.fileId)) return l;
  return cap([
    ...l,
    {
      fileId: o.fileId, name: o.name, mime: o.mime, size: o.size,
      dir: "recv", state: o.inline ? "transferring" : "offering",
      sent: 0, total: o.chunkCount, ts: now, mine: false,
    },
  ]);
}

export function applyProgress(
  l: TransferItem[],
  p: { fileId: string; dir: "send" | "recv"; sent: number; total: number },
): TransferItem[] {
  return l.map((t) => {
    if (t.fileId !== p.fileId) return t;
    const done = p.dir === "send" && p.sent >= p.total;
    return { ...t, sent: p.sent, total: p.total, state: done ? "done" : t.state };
  });
}

export function applyReceived(l: TransferItem[], r: { fileId: string; blob: Blob }): TransferItem[] {
  return patch(l, r.fileId, { state: "done", blob: r.blob });
}

export function applyError(l: TransferItem[], e: { fileId: string; message: string }): TransferItem[] {
  if (!e.fileId) return l; // pre-flight error (TOO_LARGE/NO_KEY) — no item exists yet
  return patch(l, e.fileId, { state: "error", errorMsg: e.message });
}

export function applyCancel(l: TransferItem[], c: { fileId: string }): TransferItem[] {
  return patch(l, c.fileId, { state: "cancelled" });
}

export function markTransferring(l: TransferItem[], fileId: string): TransferItem[] {
  return patch(l, fileId, { state: "transferring" });
}

export function removeTransfer(l: TransferItem[], fileId: string): TransferItem[] {
  return l.filter((t) => t.fileId !== fileId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/web test transfers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/transfers.ts apps/web/src/lib/transfers.test.ts
git commit -m "feat(web): pure transfer state reducers (lib/transfers)"
```

---

## Task 4: Web — composer attach button

**Files:**
- Modify: `apps/web/src/components/composer.svelte`

> No unit test (presentational); the attach path is covered by the Task 9 e2e. Verify via typecheck + build.

- [ ] **Step 1: Add the prop + a hidden file input + handlers**

In `apps/web/src/components/composer.svelte`, change the props line:

```ts
  let { onSend, onSendFile }: { onSend: (text: string) => void; onSendFile?: (file: File) => void } = $props();
```

Add near the other `let` state:

```ts
  let fileInput = $state<HTMLInputElement>();
  function pickFile() {
    fileInput?.click();
  }
  function onFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) onSendFile?.(file);
    input.value = ""; // allow re-picking the same file
  }
```

- [ ] **Step 2: Add the attach button to the button row**

In the markup, immediately BEFORE the Expand button (`<button … onclick={() => (expanded = true)} …>`), insert:

```svelte
    {#if onSendFile}
      <input bind:this={fileInput} type="file" class="hidden" onchange={onFileChange} />
      <button
        type="button"
        onclick={pickFile}
        class="grid h-9 w-9 shrink-0 place-items-center rounded-field text-muted transition hover:bg-surface-2 hover:text-text"
        title="Attach a file"
        aria-label="Attach a file"
      >
        <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
          <path d="M18 8.5l-7.8 7.8a2.5 2.5 0 0 1-3.5-3.5l8-8a4 4 0 0 1 5.7 5.7l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    {/if}
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web build`
Expected: PASS. (Existing `<Composer onSend={…} />` callers still compile — `onSendFile` is optional, the attach button just doesn't render there yet.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/composer.svelte
git commit -m "feat(web): composer attach button (optional onSendFile)"
```

---

## Task 5: Web — `transfer-row.svelte`

**Files:**
- Create: `apps/web/src/components/transfer-row.svelte`

> No unit test (presentational; the state machine it renders is unit-tested in `lib/transfers`). The Task 9 e2e exercises it. Verify via typecheck + build. Visual polish can be refined later with frontend-design; this is functional, on-system markup.

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/transfer-row.svelte`:

```svelte
<script lang="ts">
  import { onDestroy } from "svelte";
  import type { TransferItem } from "../lib/transfers";
  import { toast } from "../lib/toast";

  let {
    item,
    onAccept,
    onDecline,
    onCancel,
  }: {
    item: TransferItem;
    onAccept: (id: string) => void;
    onDecline: (id: string) => void;
    onCancel: (id: string) => void;
  } = $props();

  let objectUrl: string | undefined;
  $effect(() => {
    if (item.state === "done" && item.blob && !objectUrl) {
      objectUrl = URL.createObjectURL(item.blob);
    }
  });
  onDestroy(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  const isImage = $derived(item.mime.startsWith("image/"));
  const pct = $derived(item.total > 0 ? Math.min(100, Math.round((item.sent / item.total) * 100)) : 0);

  function human(n: number): string {
    return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  async function copyImage() {
    if (!item.blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ [item.blob.type]: item.blob })]);
      toast("Image copied", "info", 1200);
    } catch {
      toast("Copy image not supported here", "warn");
    }
  }
</script>

<div class="group/row flex items-stretch gap-1.5" style="animation: item-arrive 0.28s ease-out" class:flex-row-reverse={item.mine}>
  <div
    class="min-w-0 max-w-[88%] flex-1 overflow-hidden rounded-card border px-3.5 py-2.5 text-left
      {item.mine ? 'border-accent/30 bg-accent-soft' : 'border-border bg-surface'}"
  >
    <div class="flex items-center gap-2 text-[11px]">
      <span class="font-medium uppercase tracking-wide {item.mine ? 'text-accent' : 'text-faint'}">{item.mine ? "You" : "Peer"}</span>
      <span class="truncate text-muted">{item.name}</span>
      <span class="ml-auto shrink-0 text-faint">{human(item.size)}</span>
    </div>

    {#if item.state === "offering"}
      <div class="mt-2 flex items-center gap-2">
        <button type="button" onclick={() => onAccept(item.fileId)} class="rounded-field bg-accent px-3 py-1 text-xs font-bold text-accent-fg transition hover:bg-accent-bright">Accept</button>
        <button type="button" onclick={() => onDecline(item.fileId)} class="rounded-field border border-border px-3 py-1 text-xs font-medium text-muted transition hover:text-text">Decline</button>
      </div>
    {:else if item.state === "transferring"}
      <div class="mt-2 flex items-center gap-2">
        <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
          <div class="h-full rounded-full bg-accent transition-[width] duration-200" style="width: {pct}%"></div>
        </div>
        <span class="shrink-0 text-[11px] text-faint">{pct}%</span>
        <button type="button" onclick={() => onCancel(item.fileId)} class="shrink-0 text-faint transition hover:text-danger" title="Cancel" aria-label="Cancel transfer">
          <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
        </button>
      </div>
    {:else if item.state === "done"}
      {#if isImage && objectUrl}
        <img data-testid="transfer-thumb" src={objectUrl} alt={item.name} class="mt-2 max-h-48 rounded-field border border-border object-contain" />
      {/if}
      <div class="mt-2 flex items-center gap-2">
        {#if objectUrl}
          <a data-testid="transfer-download" href={objectUrl} download={item.name} class="rounded-field bg-accent px-3 py-1 text-xs font-bold text-accent-fg transition hover:bg-accent-bright">Download</a>
        {/if}
        {#if isImage && item.blob}
          <button type="button" onclick={copyImage} class="rounded-field border border-border px-3 py-1 text-xs font-medium text-muted transition hover:text-text">Copy image</button>
        {/if}
      </div>
    {:else if item.state === "error"}
      <div class="mt-1 text-xs text-danger">Transfer failed{item.errorMsg ? ` — ${item.errorMsg}` : ""}</div>
    {:else}
      <div class="mt-1 text-xs text-faint">Cancelled</div>
    {/if}
  </div>
</div>
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web build`
Expected: PASS. (Component is unused so far — just compiles.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/transfer-row.svelte
git commit -m "feat(web): transfer-row component (offer/progress/image/file states)"
```

---

## Task 6: Web — `drop-overlay.svelte`

**Files:**
- Create: `apps/web/src/components/drop-overlay.svelte`

> No unit test (presentational). Verify via typecheck + build.

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/drop-overlay.svelte`:

```svelte
<script lang="ts">
  import { MAX_FILE_MB } from "../lib/file-send";
</script>

<div
  class="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-bg/70 backdrop-blur-sm"
  style="animation: item-arrive 0.15s ease-out"
  aria-hidden="true"
>
  <div class="rounded-card border-2 border-dashed border-accent bg-surface/80 px-8 py-6 text-center glow-ring">
    <svg viewBox="0 0 24 24" fill="none" class="mx-auto mb-2 h-8 w-8 text-accent" aria-hidden="true">
      <path d="M12 16V4m0 0l-4 4m4-4l4 4M5 20h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <p class="font-display text-lg font-bold text-text">Drop to send</p>
    <p class="mt-0.5 text-xs text-muted">Encrypted end-to-end · max {MAX_FILE_MB} MB</p>
  </div>
</div>
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/drop-overlay.svelte
git commit -m "feat(web): drag-drop overlay component"
```

---

## Task 7: Web — `items-list` merges clips + transfers

**Files:**
- Modify: `apps/web/src/components/items-list.svelte`

> No unit test (presentational dispatch). Backward-compatible: `transfers` defaults to `[]` and the new callbacks are optional, so `room.svelte` (still passing only `items`) keeps compiling. Verify via typecheck + build.

- [ ] **Step 1: Rewrite to merge + dispatch**

Replace the contents of `apps/web/src/components/items-list.svelte`:

```svelte
<script lang="ts">
  import ItemRow from "./item-row.svelte";
  import TransferRow from "./transfer-row.svelte";
  import EmptyState from "./empty-state.svelte";
  import type { Item } from "../lib/persist";
  import type { TransferItem } from "../lib/transfers";

  type Entry = Item | TransferItem;

  let {
    items,
    transfers = [],
    syncing,
    onCopy,
    onDelete,
    onAccept = () => {},
    onDecline = () => {},
    onCancelTransfer = () => {},
  }: {
    items: Item[];
    transfers?: TransferItem[];
    syncing: boolean;
    onCopy: (text: string) => void;
    onDelete: (id: string) => void;
    onAccept?: (id: string) => void;
    onDecline?: (id: string) => void;
    onCancelTransfer?: (id: string) => void;
  } = $props();

  // One timeline, oldest→newest by ts; the render reverses to newest-first.
  const timeline = $derived<Entry[]>([...items, ...transfers].sort((a, b) => a.ts - b.ts));

  function isTransfer(e: Entry): e is TransferItem {
    return "state" in e && "fileId" in e;
  }
</script>

{#if timeline.length === 0}
  <EmptyState {syncing} />
{:else}
  <div class="space-y-2.5 pb-2">
    {#each timeline.slice().reverse() as entry (isTransfer(entry) ? entry.fileId : entry.id)}
      {#if isTransfer(entry)}
        <TransferRow item={entry} {onAccept} {onDecline} onCancel={onCancelTransfer} />
      {:else}
        <ItemRow item={entry} mine={!!entry.mine} {onCopy} {onDelete} />
      {/if}
    {/each}
  </div>
{/if}
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web build`
Expected: PASS (room.svelte still passes `items`/`syncing`/`onCopy`/`onDelete`; `transfers` defaults to `[]`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/items-list.svelte
git commit -m "feat(web): items-list merges clips + transfers into one timeline"
```

---

## Task 8: Web — wire transfers into `room.svelte` (send via attach, receive, accept/decline/cancel)

**Files:**
- Modify: `apps/web/src/routes/room.svelte`

> No unit test (route wiring; logic is in the already-tested `lib/transfers`/`lib/file-send`). Verify via typecheck + build; the Task 9 e2e exercises it end-to-end.

- [ ] **Step 1: Imports + state**

In `apps/web/src/routes/room.svelte` `<script>`, add imports:

```ts
  import {
    addOutgoing, applyOffer, applyProgress, applyReceived, applyError,
    applyCancel, removeTransfer, markTransferring, type TransferItem,
  } from "../lib/transfers";
  import { tooLarge, readFileBytes, MAX_FILE_MB } from "../lib/file-send";
```

(Import only `tooLarge, readFileBytes, MAX_FILE_MB` — the engine's returned `chunkCount` is authoritative, so `chunkCountOf` is not needed here and importing it would be an unused import.)

Add state near `let items`:

```ts
  let transfers = $state<TransferItem[]>([]);
```

- [ ] **Step 2: Wire the engine's file-* events**

In `onMount`, after the existing `c.on("error", …)` registration, add:

```ts
    c.on("file-offer", (o) => { transfers = applyOffer(transfers, o, Date.now()); });
    c.on("file-progress", (p) => { transfers = applyProgress(transfers, p); });
    c.on("file-received", (r) => { transfers = applyReceived(transfers, r); });
    c.on("file-error", (e) => {
      transfers = applyError(transfers, e);
      toast(`Transfer failed: ${e.code}`, "warn");
    });
    c.on("file-cancel", (cc) => { transfers = applyCancel(transfers, cc); });
```

- [ ] **Step 3: Send + accept/decline/cancel functions**

Add these functions (near `sendText`):

```ts
  async function sendFile(file: File) {
    if (!client) return;
    if (tooLarge(file)) {
      toast(`Too large to send (max ${MAX_FILE_MB} MB).`, "warn");
      return;
    }
    const bytes = await readFileBytes(file);
    const res = await client.sendFile({
      name: file.name,
      mime: file.type || "application/octet-stream",
      bytes,
    });
    if (!res) return; // engine early-rejected; file-error already toasted
    transfers = addOutgoing(
      transfers,
      { fileId: res.fileId, name: file.name, mime: file.type || "application/octet-stream", size: file.size, total: res.chunkCount },
      Date.now(),
    );
  }

  function acceptTransfer(fileId: string) {
    client?.acceptFile(fileId);
    transfers = markTransferring(transfers, fileId);
  }
  function declineTransfer(fileId: string) {
    client?.declineFile(fileId);
    transfers = removeTransfer(transfers, fileId);
  }
  function cancelTransfer(fileId: string) {
    client?.cancelFile(fileId);
    // engine emits file-cancel → applyCancel marks it cancelled
  }
```

- [ ] **Step 4: Pass props to ItemsList and both Composers**

Change the `<ItemsList … />` usage:

```svelte
      <ItemsList {items} {transfers} syncing={watching} onCopy={copy} {onDelete} onAccept={acceptTransfer} onDecline={declineTransfer} onCancelTransfer={cancelTransfer} />
```

Change BOTH `<Composer onSend={sendText} />` usages (desktop rail + mobile bar) to:

```svelte
        <Composer onSend={sendText} onSendFile={sendFile} />
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web build`
Expected: PASS. The attach → send → receive → display → download path now works end to end.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/room.svelte
git commit -m "feat(web): wire file transfers into room (attach send, receive, accept/decline/cancel)"
```

---

## Task 9: Web — paste-an-image + drag-and-drop

**Files:**
- Modify: `apps/web/src/routes/room.svelte`

> No unit test (DOM event wiring). Verify via typecheck + build.

- [ ] **Step 1: Import the overlay + add drag state**

Add the import:

```ts
  import DropOverlay from "../components/drop-overlay.svelte";
```

Add state (near `let transfers`):

```ts
  let dragDepth = $state(0); // dragenter/leave can fire on children; count to know when truly out
  const dragging = $derived(dragDepth > 0);
```

- [ ] **Step 2: Paste + drag handlers**

Add these functions:

```ts
  function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) {
          e.preventDefault(); // image paste → send; don't also paste into a field
          void sendFile(file);
          return;
        }
      }
    }
    // no image → let normal text paste proceed
  }

  function onDragEnter(e: DragEvent) {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      dragDepth += 1;
    }
  }
  function onDragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  }
  function onDragLeave() {
    if (dragDepth > 0) dragDepth -= 1;
  }
  function onDrop(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    dragDepth = 0;
    for (const file of Array.from(e.dataTransfer.files)) void sendFile(file);
  }
```

- [ ] **Step 3: Wire the handlers to the DOM**

Add a `<svelte:window onpaste={onPaste} />` near the top of the markup (or alongside any existing `<svelte:window>`). Attach the drag handlers to the root container. Drag-and-drop is a mouse-only enhancement (the attach button is the accessible path), so suppress the static-element-interaction a11y warning with a targeted `svelte-ignore` comment (matching the project's existing usage in `share-modal.svelte`) rather than a misleading `role`. Change the outer `<div class="flex min-h-[100dvh] flex-col">` opening tag to:

```svelte
<!-- Drag-and-drop is a pointer enhancement; the attach button is the keyboard-accessible path. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex min-h-[100dvh] flex-col"
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
```

And render the overlay just before the closing `</div>` of that container (after `<Toaster />`):

```svelte
  {#if dragging}
    <DropOverlay />
  {/if}
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/room.svelte
git commit -m "feat(web): paste-an-image and drag-and-drop to send files"
```

---

## Task 10: E2E — file transfer two-browser

**Files:**
- Create: `e2e/tests/file-transfer.spec.ts`

- [ ] **Step 1: Write the spec**

Create `e2e/tests/file-transfer.spec.ts` (models `backfill.spec.ts`; uses `setInputFiles` with buffers — small enough to create inline; a 1×1 PNG for the inline-image path and a ~300 KB octet-stream for the offer/accept path):

```ts
import { test, expect, chromium } from "@playwright/test";

// Minimal 1×1 transparent PNG.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("inline image is received automatically; a larger file uses offer→accept→download", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();
  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();
  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageB = await ctxB.newPage();
  await pageB.goto(roomUrl);
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // A sends a small PNG → inline image, auto-accepted on B → thumbnail + download.
  await pageA.setInputFiles('input[type="file"]', { name: "dot.png", mimeType: "image/png", buffer: PNG_1x1 });
  await expect(pageB.getByTestId("transfer-thumb")).toBeVisible({ timeout: 10_000 });
  await expect(pageB.getByTestId("transfer-download")).toBeVisible({ timeout: 10_000 });

  // A sends a ~300 KB non-image → B sees an offer card → Accept → Download appears.
  const big = Buffer.alloc(300 * 1024, 7);
  await pageA.setInputFiles('input[type="file"]', { name: "blob.bin", mimeType: "application/octet-stream", buffer: big });
  await expect(pageB.getByRole("button", { name: /^Accept$/ })).toBeVisible({ timeout: 10_000 });
  await pageB.getByRole("button", { name: /^Accept$/ }).click();
  await expect(pageB.getByTestId("transfer-download").last()).toBeVisible({ timeout: 15_000 });

  await browser.close();
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `pnpm test:e2e`
Expected: PASS — this spec plus all existing ones. (If port 3000/5173 is held by a stale dev server, free it first — Playwright boots its own servers.)

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/file-transfer.spec.ts
git commit -m "test(e2e): file transfer — inline image + offer/accept/download"
```

---

## Final verification

- [ ] **Whole unit suite + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS across all packages.

- [ ] **E2E**

Run: `pnpm test:e2e`
Expected: PASS.

- [ ] **Hand off** via superpowers:finishing-a-development-branch.

---

## Notes for the implementer
- **Transfers are session-only** — never written to `PersistedItems`. They live in the `transfers` `$state` array and vanish on reload (download-and-forget). Only text clips persist (unchanged).
- **`sendFile` correlation** — the engine now returns `{fileId, chunkCount}`; the UI keys its optimistic send item by that `fileId` so `file-progress(send)` updates the right bar.
- **Object URLs** — `transfer-row` creates an object URL for a received Blob and revokes it `onDestroy` to avoid leaks.
- **Inline vs offer** — an `inline` image offer is auto-accepted by the engine; `applyOffer` marks it `transferring` directly (no Accept card). Non-inline files show the Accept/Decline card.
- **Send "done" is inferred** from `file-progress(send)` reaching `sent === total` (the engine emits no explicit send-complete event — by design).
- **Svelte-check / Tailwind 4** — match existing patterns; trust `svelte-check`/`build` exit codes over IDE diagnostics (new-file watcher lag is common).
- **Don't import `chunkCountOf` in room.svelte** (the engine's returned `chunkCount` is authoritative) — it would be an unused import. It exists in `lib/file-send` for completeness/tests.
