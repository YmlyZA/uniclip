# Uniclip UI Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add synced item delete, a QR/Link toggle in the share modal, and an editable send composer.

**Architecture:** A new minimal `delete` wire frame (msgId only — stays zero-knowledge) flows clip-like: the client sends it, the relay broadcasts it to peers and drops the msgId from the backfill ring, and each client removes the item locally. The share modal and the manual send path are web-only UI changes (QR/Link tabs; a textarea composer replacing one-tap send). No identity/permissions — anyone in the room can delete (the relay is authless by design).

**Tech Stack:** Zod (protocol), Bun + Hono (relay), Svelte 5 + Tailwind 4 (web), Vitest, Playwright. Relay tests run under `bun --bun vitest`.

**Spec:** `docs/superpowers/specs/2026-06-15-uniclip-ui-followups-design.md`

**Order:** protocol → relay → client-core → web wiring (Item 1, TDD backend-first), then share tabs (Item 2), then composer (Item 3), then e2e.

---

## Task 1: protocol — `delete` frame

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/protocol/src/index.test.ts`, update the import line to also import the new symbols:

```ts
import {
  ClipboardFrameSchema,
  ClientFrameSchema,
  DeleteFrameSchema,
  ServerFrameSchema,
  ULID_REGEX,
  MAX_FRAME_BYTES,
} from "./index";
```

Then add this describe block at the end of the file (before the final newline):

```ts
describe("DeleteFrameSchema", () => {
  const valid = { type: "delete" as const, msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" };

  it("accepts a valid delete frame", () => {
    expect(DeleteFrameSchema.parse(valid)).toEqual(valid);
  });
  it("rejects extra fields", () => {
    expect(() => DeleteFrameSchema.parse({ ...valid, extra: 1 })).toThrow();
  });
  it("rejects a malformed msgId", () => {
    expect(() => DeleteFrameSchema.parse({ ...valid, msgId: "short" })).toThrow();
  });
});

describe("ClientFrameSchema", () => {
  it("accepts a clip frame", () => {
    expect(
      ClientFrameSchema.parse({
        type: "clip",
        msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        iv: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAA",
        ts: 1717000000000,
      }),
    ).toBeDefined();
  });
  it("accepts a delete frame", () => {
    expect(
      ClientFrameSchema.parse({ type: "delete", msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    ).toBeDefined();
  });
  it("rejects an unknown frame type", () => {
    expect(() => ClientFrameSchema.parse({ type: "nope", msgId: "x" })).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm --filter @uniclip/protocol test`
Expected: FAIL — `DeleteFrameSchema` / `ClientFrameSchema` are not exported (ClientFrameSchema is currently an alias of ClipboardFrameSchema, so "accepts a delete frame" and "rejects unknown type" fail).

- [ ] **Step 3: Add the delete frame and widen the unions**

In `packages/protocol/src/index.ts`, add `DeleteFrameSchema` immediately after the `ClipboardFrame` type export (after the line `export type ClipboardFrame = z.infer<typeof ClipboardFrameSchema>;`):

```ts
export const DeleteFrameSchema = z
  .object({
    type: z.literal("delete"),
    msgId: z.string().regex(ULID_REGEX),
  })
  .strict();

export type DeleteFrame = z.infer<typeof DeleteFrameSchema>;
```

Add `DeleteFrameSchema` to the `ServerFrameSchema` union — change it to:

```ts
export const ServerFrameSchema = z.discriminatedUnion("type", [
  HelloFrameSchema,
  PeerJoinedFrameSchema,
  PeerLeftFrameSchema,
  ClipboardFrameSchema,
  DeleteFrameSchema,
  ErrorFrameSchema,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
```

Replace the `ClientFrameSchema` alias (currently `export const ClientFrameSchema = ClipboardFrameSchema;`) with a union:

```ts
export const ClientFrameSchema = z.discriminatedUnion("type", [
  ClipboardFrameSchema,
  DeleteFrameSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;
```

- [ ] **Step 4: Run the protocol suite to confirm it passes**

Run: `pnpm --filter @uniclip/protocol test`
Expected: PASS (new delete/client-frame tests + all existing clip/hello/error tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @uniclip/protocol typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/src/index.test.ts
git commit -m "feat(protocol): add delete frame; ClientFrame is now clip|delete"
```

---

## Task 2: relay — `RoomStore.removeRecent`

**Files:**
- Modify: `apps/relay/src/rooms.ts`
- Modify: `apps/relay/src/rooms.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/relay/src/rooms.test.ts`, add inside `describe("RoomStore", ...)`:

```ts
  it("removeRecent drops a clip from the backfill ring by msgId", () => {
    const s = new RoomStore();
    const r = s.create("A");
    const f1 = frame();
    const f2 = frame();
    s.pushRecent(r.id, f1);
    s.pushRecent(r.id, f2);
    s.removeRecent(r.id, f1.msgId);
    const buf = s.get(r.id)!.recent;
    expect(buf.map((f) => f.msgId)).toEqual([f2.msgId]);
  });
```

(The existing `frame()` helper at the top of the file already returns `{ type, msgId, iv, ciphertext, ts }`.)

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm --filter @uniclip/relay test rooms`
Expected: FAIL — `s.removeRecent is not a function`.

- [ ] **Step 3: Implement `removeRecent`**

In `apps/relay/src/rooms.ts`, add this method directly after `pushRecent` (after its closing brace, before `get(id)`):

```ts
  // Drop a clip from the backfill ring (e.g. when it's deleted) so late joiners
  // don't receive an item that no longer exists.
  removeRecent(id: string, msgId: string): void {
    const r = this.rooms.get(id);
    if (!r) return;
    const i = r.recent.findIndex((f) => f.msgId === msgId);
    if (i >= 0) r.recent.splice(i, 1);
  }
```

- [ ] **Step 4: Run the rooms suite to confirm it passes**

Run: `pnpm --filter @uniclip/relay test rooms`
Expected: PASS (new test + all existing).

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/rooms.ts apps/relay/src/rooms.test.ts
git commit -m "feat(relay): RoomStore.removeRecent — drop a clip from the backfill ring"
```

---

## Task 3: relay — broadcast `delete` frames + prune the ring

**Files:**
- Modify: `apps/relay/src/ws-handlers.ts:1-12,86,107-114`
- Create: `apps/relay/test/delete.test.ts`

The `onMessage` handler currently validates only `ClipboardFrameSchema` and always `pushRecent`s. Validate the `ClientFrameSchema` union instead, then branch: clip → broadcast + `pushRecent`; delete → broadcast + `removeRecent`.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/delete.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";
import { attachWebSocket } from "../src/ws-handlers";
import { ulid } from "ulid";

let server: ReturnType<typeof Bun.serve> | null = null;
let baseHttp = "";
let baseWs = "";
let store: RoomStore;

beforeEach(() => {
  store = new RoomStore();
  const app = buildApp({ roomCount: () => store.count, store });
  const { websocket, fetch } = attachWebSocket(app, store);
  server = Bun.serve({ port: 0, fetch, websocket });
  baseHttp = `http://localhost:${server.port}`;
  baseWs = `ws://localhost:${server.port}`;
});

afterEach(() => {
  server?.stop(true);
  server = null;
});

async function mintRoom(): Promise<string> {
  const res = await fetch(`${baseHttp}/api/room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "A" }),
  });
  return ((await res.json()) as { roomId: string }).roomId;
}

function makeClip() {
  return { type: "clip", msgId: ulid(), iv: "AAAAAAAAAAAAAAAA", ciphertext: "QUFBQQ==", ts: Date.now() };
}

function open(id: string, sink: any[]): Promise<WebSocket> {
  const ws = new WebSocket(`${baseWs}/ws/${id}`);
  ws.onmessage = (e) => sink.push(JSON.parse(e.data as string));
  return new Promise((r) => (ws.onopen = () => r(ws)));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("delete frame fan-out", () => {
  it("broadcasts a delete to peers but not back to the sender", async () => {
    const id = await mintRoom();
    const aMsgs: any[] = [];
    const bMsgs: any[] = [];
    const a = await open(id, aMsgs);
    const b = await open(id, bMsgs);
    const clip = makeClip();
    a.send(JSON.stringify(clip));
    await wait(30);
    a.send(JSON.stringify({ type: "delete", msgId: clip.msgId }));
    await wait(30);

    expect(bMsgs.filter((m) => m.type === "delete").map((m) => m.msgId)).toEqual([clip.msgId]);
    expect(aMsgs.filter((m) => m.type === "delete")).toHaveLength(0);
    a.close();
    b.close();
  });

  it("removes the deleted clip from the backfill ring (late joiner won't get it)", async () => {
    const id = await mintRoom();
    const aMsgs: any[] = [];
    const a = await open(id, aMsgs);
    const f1 = makeClip();
    const f2 = makeClip();
    a.send(JSON.stringify(f1));
    a.send(JSON.stringify(f2));
    await wait(30);
    a.send(JSON.stringify({ type: "delete", msgId: f1.msgId }));
    await wait(30);

    const cMsgs: any[] = [];
    const c = await open(id, cMsgs);
    await wait(30);
    const got = cMsgs.filter((m) => m.type === "clip").map((m) => m.msgId);
    expect(got).toEqual([f2.msgId]); // f1 was deleted from the ring
    a.close();
    c.close();
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm --filter @uniclip/relay test delete`
Expected: FAIL — the relay validates only `ClipboardFrameSchema`, so the delete frame is dropped (B receives no delete; the late joiner still gets f1).

- [ ] **Step 3: Validate the union and branch on type**

In `apps/relay/src/ws-handlers.ts`, change the protocol import (the block importing from `@uniclip/protocol`, currently importing `ClipboardFrameSchema`) to import `ClientFrameSchema` instead:

```ts
import {
  CLOSE_CODES,
  ClientFrameSchema,
  MAX_FRAME_BYTES,
  type ServerFrame,
} from "@uniclip/protocol";
```

Change the parse line (currently `const result = ClipboardFrameSchema.safeParse(parsed);`) to:

```ts
          const result = ClientFrameSchema.safeParse(parsed);
```

Replace the broadcast + buffer block at the end of `onMessage` (currently the `metrics?.inc("uniclip_frames_in_total"); store.touch(...); broadcast(...); store.pushRecent(...)` lines) with:

```ts
          metrics?.inc("uniclip_frames_in_total");
          store.touch(room.id);
          broadcast(room.sockets, raw, result.data, () =>
            metrics?.inc("uniclip_frames_out_total"),
          );
          if (result.data.type === "clip") {
            // Buffer for late joiners (no-op unless Mode A + backfill enabled).
            store.pushRecent(room.id, result.data);
          } else {
            // delete: drop it from the ring so a late joiner won't get it back.
            store.removeRecent(room.id, result.data.msgId);
          }
```

- [ ] **Step 4: Run the delete suite to confirm it passes**

Run: `pnpm --filter @uniclip/relay test delete`
Expected: PASS (both cases).

- [ ] **Step 5: Run the full relay suite (no regressions)**

Run: `pnpm --filter @uniclip/relay test && pnpm --filter @uniclip/relay typecheck`
Expected: PASS (clip/backfill/ws/rooms/etc. all green; `result.data` now typed as the union, `broadcast` accepts a `ClipboardFrame | DeleteFrame` which is assignable to `ServerFrame`).

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/ws-handlers.ts apps/relay/test/delete.test.ts
git commit -m "feat(relay): fan out delete frames and prune the backfill ring"
```

---

## Task 4: client-core — `delete(msgId)` + `delete` event

**Files:**
- Modify: `packages/client-core/src/client.ts:10-25,60-72,115-157,160-188`
- Modify: `packages/client-core/src/client.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/client-core/src/client.test.ts`, add inside `describe("UniclipClient", ...)`:

```ts
  it("delete(msgId) writes a delete frame", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    client.delete("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "delete", msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
  });

  it("emits 'delete' with the msgId when a delete frame arrives", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    let got = "";
    client.on("delete", (msgId: string) => (got = msgId));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.emit({ type: "delete", msgId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    await waitFor(() => got !== "");
    expect(got).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });
```

- [ ] **Step 2: Run them to confirm failure**

Run: `pnpm --filter @uniclip/client-core test client`
Expected: FAIL — `client.delete` is not a function; the `delete` event never fires.

- [ ] **Step 3: Add the `delete` event to the types**

In `packages/client-core/src/client.ts`, add a `delete` variant to `ClientEvent` (after the `clip` variant):

```ts
  | { kind: "delete"; msgId: string }
```

Add to `EventHandlers` (after `clip`):

```ts
  delete: (msgId: string) => void;
```

- [ ] **Step 4: Dispatch it in `emit`**

In the `emit` switch, add after the `clip` case:

```ts
        case "delete": (cb as EventHandlers["delete"])(evt.msgId); break;
```

- [ ] **Step 5: Emit it from the receive path**

In `handleFrame`, add a `delete` case after the `clip` case's closing `}` (before `case "error":`):

```ts
      case "delete":
        this.emit({ kind: "delete", msgId: frame.msgId });
        return;
```

- [ ] **Step 6: Add the `delete` method**

In `packages/client-core/src/client.ts`, add this method directly after `send()` (before `disconnect()`):

```ts
  delete(msgId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const frame: ClientFrame = { type: "delete", msgId };
    this.ws.send(JSON.stringify(frame));
  }
```

- [ ] **Step 7: Run the client-core suite**

Run: `pnpm --filter @uniclip/client-core test`
Expected: PASS (the two new tests + all existing).

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @uniclip/client-core typecheck`
Expected: PASS (`{ type: "delete", msgId }` is a valid `ClientFrame`; `frame.msgId` in the delete case is typed via the `ServerFrameSchema` union).

- [ ] **Step 9: Commit**

```bash
git add packages/client-core/src/client.ts packages/client-core/src/client.test.ts
git commit -m "feat(client-core): delete(msgId) sends a delete frame; emit 'delete' on receive"
```

---

## Task 5: web — wire synced delete into the room

**Files:**
- Modify: `apps/web/src/routes/room.svelte` (the `onMount` handlers + `onDelete`)

- [ ] **Step 1: Send a delete frame when the user deletes**

In `apps/web/src/routes/room.svelte`, replace the `onDelete` function with:

```ts
  async function onDelete(id: string) {
    items = items.filter((i) => i.id !== id);
    await persist?.remove(id);
    client?.delete(id);
  }
```

- [ ] **Step 2: Remove items when a peer deletes**

In `onMount`, add this handler next to the other `c.on(...)` registrations (e.g. right after the `c.on("clip", ...)` block):

```ts
    c.on("delete", async (msgId) => {
      items = items.filter((i) => i.id !== msgId);
      await persist?.remove(msgId);
    });
```

- [ ] **Step 3: Typecheck the web app**

Run: `pnpm --filter @uniclip/web typecheck`
Expected: PASS (the `delete` handler matches `EventHandlers["delete"]`).

- [ ] **Step 4: Run the web unit suite (no regressions)**

Run: `pnpm --filter @uniclip/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/room.svelte
git commit -m "feat(web): synced delete — broadcast on delete, remove on peer delete"
```

---

## Task 6: web — share modal QR / Link toggle

**Files:**
- Modify: `apps/web/src/components/share-modal.svelte`

Add a segmented control (QR | Link); QR is the default view. Preserve the Escape/backdrop/focus accessibility and the Mode-A/B hint.

- [ ] **Step 1: Replace the modal body with tabs**

Replace the entire contents of `apps/web/src/components/share-modal.svelte` with:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { renderQrSvg } from "../lib/qr";

  let { url, mode, onClose }: { url: string; mode: "A" | "B"; onClose: () => void } = $props();
  let svg = $state("");
  let tab = $state<"qr" | "link">("qr");
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  onMount(async () => {
    svg = await renderQrSvg(url);
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 1600);
    } catch {}
  }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<!-- Backdrop click-to-close is a convenience; keyboard users close via Escape
     (window handler above) or the Done button. -->
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
    class="w-full max-w-sm overflow-hidden rounded-card border border-border bg-elevated shadow-[var(--shadow-card)]"
    role="dialog"
    aria-modal="true"
    aria-label="Share this room"
    tabindex="-1"
  >
    <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
      <h2 class="font-display text-base font-bold text-text">Share this room</h2>
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

    <!-- segmented QR / Link toggle -->
    <div class="flex gap-1 p-3 pb-0">
      <button
        type="button"
        onclick={() => (tab = "qr")}
        class="flex-1 rounded-field px-3 py-1.5 text-sm font-medium transition {tab === 'qr'
          ? 'bg-accent-soft text-accent'
          : 'text-muted hover:text-text'}"
        aria-pressed={tab === "qr"}
      >
        QR code
      </button>
      <button
        type="button"
        onclick={() => (tab = "link")}
        class="flex-1 rounded-field px-3 py-1.5 text-sm font-medium transition {tab === 'link'
          ? 'bg-accent-soft text-accent'
          : 'text-muted hover:text-text'}"
        aria-pressed={tab === "link"}
      >
        Link
      </button>
    </div>

    <div class="p-5">
      {#if tab === "qr"}
        <div class="mx-auto grid w-fit place-items-center rounded-card border border-border bg-white p-3">
          {@html svg}
        </div>
        <p class="mt-3 text-center text-xs text-muted">Scan with another device's camera.</p>
      {:else}
        <div class="mb-3 break-all rounded-field border border-border bg-surface-2 p-2.5 font-mono text-xs text-muted">
          {url}
        </div>
        <button
          type="button"
          onclick={copy}
          class="flex w-full items-center justify-center gap-2 rounded-field bg-accent px-4 py-2.5 text-sm font-bold text-accent-fg transition hover:bg-accent-bright"
        >
          {#if copied}
            <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
              <path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            Copied to clipboard
          {:else}
            Copy link
          {/if}
        </button>
      {/if}

      <p class="mt-3 flex items-start gap-2 text-xs leading-snug text-muted">
        <svg viewBox="0 0 24 24" fill="none" class="mt-px h-3.5 w-3.5 shrink-0 {mode === 'A' ? 'text-accent' : 'text-warn'}" aria-hidden="true">
          <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="1.7" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.7" />
        </svg>
        {#if mode === "A"}
          The decryption secret rides in the link's <span class="font-mono">#fragment</span> — anyone with this link (or QR) can read the room, but the server can't.
        {:else}
          This is a <span class="font-medium text-warn">less secure</span> room: the server can decrypt. Share over a trusted channel.
        {/if}
      </p>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Typecheck (svelte-check)**

Run: `pnpm --filter @uniclip/web typecheck`
Expected: PASS, 0 a11y warnings for `share-modal.svelte`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/share-modal.svelte
git commit -m "feat(web): share modal QR | Link toggle (QR default for scanning)"
```

---

## Task 7: web — editable send composer

**Files:**
- Create: `apps/web/src/components/composer.svelte`
- Modify: `apps/web/src/routes/room.svelte` (replace the two send buttons + add `sendText`; drop `sendNow` and the `readClipboardText` import)

- [ ] **Step 1: Create the composer component**

Create `apps/web/src/components/composer.svelte`:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { readClipboardText } from "../lib/clipboard";

  let { onSend }: { onSend: (text: string) => void } = $props();
  let text = $state("");
  let area = $state<HTMLTextAreaElement>();

  onMount(async () => {
    // Best-effort prefill from the clipboard (works on desktop; mobile needs the
    // explicit fill button or a paste gesture).
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
    onSend(text);
    text = "";
    area?.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="flex items-end gap-2 rounded-card border border-border bg-surface p-2">
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
    class="max-h-32 min-h-9 flex-1 resize-none bg-transparent py-1.5 font-mono text-sm text-text placeholder:font-sans placeholder:text-faint focus:outline-none"
  ></textarea>

  <button
    type="button"
    onclick={send}
    disabled={!text.trim()}
    class="grid h-9 w-9 shrink-0 place-items-center rounded-field bg-accent text-accent-fg transition hover:bg-accent-bright disabled:opacity-40"
    title="Send"
    aria-label="Send"
  >
    <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
      <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
</div>
```

- [ ] **Step 2: Add `sendText` and import the composer in room.svelte**

In `apps/web/src/routes/room.svelte`:

Add `Composer` to the component imports (next to the other `import ... from "../components/..."` lines):

```ts
  import Composer from "../components/composer.svelte";
```

Change the clipboard-lib import (currently `import { readClipboardText, writeClipboardText, ClipboardWatcher } from "../lib/clipboard";`) to drop `readClipboardText` (now used only inside the composer):

```ts
  import { writeClipboardText, ClipboardWatcher } from "../lib/clipboard";
```

Replace the `sendNow` function with `sendText`:

```ts
  async function sendText(text: string) {
    try {
      if (!client) return;
      const { msgId, ts } = await client.send(text);
      await addItem(text, ts, msgId, true);
    } catch {
      toast("Send failed", "warn");
    }
  }
```

- [ ] **Step 3: Swap the desktop send button for the composer**

In the desktop control rail (`<aside ...>`), replace the `<button ... onclick={sendNow}>…Send clipboard now…</button>` block with:

```svelte
        <Composer onSend={sendText} />
```

- [ ] **Step 4: Swap the mobile send button for the composer**

In the mobile bottom bar (`<div class="fixed inset-x-0 bottom-0 ...">`), replace the trailing send `<button ... aria-label="Send clipboard now" ...>…</button>` with the composer, and let it take the remaining width. The bar's inner row should read:

```svelte
    <div class="mx-auto flex max-w-5xl items-stretch gap-2">
      <div class="min-w-0 flex-1">
        <SyncToggle on={watching} onToggle={toggleWatch} hint={syncHint} />
      </div>
      <div class="min-w-0 flex-1">
        <Composer onSend={sendText} />
      </div>
    </div>
```

- [ ] **Step 5: Typecheck (svelte-check)**

Run: `pnpm --filter @uniclip/web typecheck`
Expected: PASS, 0 errors/0 warnings. If svelte-check flags an unused symbol (e.g. a leftover reference to `sendNow`), remove it.

- [ ] **Step 6: Run the web unit suite**

Run: `pnpm --filter @uniclip/web test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/composer.svelte apps/web/src/routes/room.svelte
git commit -m "feat(web): editable send composer (clipboard prefill + fill button, Enter to send)"
```

---

## Task 8: e2e — synced delete + full verification

**Files:**
- Create: `e2e/tests/synced-delete.spec.ts`

- [ ] **Step 1: Write the e2e test**

Create `e2e/tests/synced-delete.spec.ts`:

```ts
import { test, expect, chromium } from "@playwright/test";

test("deleting an item removes it on the other device", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();
  await pageB.goto(roomUrl);
  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // A sends a clip; both see it.
  await pageA.evaluate(() => navigator.clipboard.writeText("delete me"));
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageA.getByText("delete me")).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("delete me")).toBeVisible({ timeout: 5_000 });

  // A deletes it → it disappears on B too.
  await pageA.getByRole("button", { name: /Delete item/i }).first().click();
  await expect(pageA.getByText("delete me")).toHaveCount(0, { timeout: 5_000 });
  await expect(pageB.getByText("delete me")).toHaveCount(0, { timeout: 5_000 });

  await browser.close();
});
```

Note: the composer's Send button has `aria-label="Send"`, matched by `/^Send$/i`. The item-row delete button has `aria-label="Delete item"`. If the accessible names changed during Task 6/7, update these matchers to the actual labels.

- [ ] **Step 2: Run the full e2e suite**

Run: `pnpm test:e2e`
Expected: PASS — `two-browser`, `backfill`, `key-mismatch`, and `synced-delete` all green. If the new test flakes on cold-start, retry once.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/synced-delete.spec.ts
git commit -m "test(e2e): synced delete removes the item on the other device"
```

---

## Final verification

- [ ] **Step 1: Full typecheck + unit suites**

Run: `pnpm typecheck && pnpm test`
Expected: PASS across all packages (protocol, crypto, room-code, client-core, relay, web).

- [ ] **Step 2: Full e2e**

Run: `pnpm test:e2e`
Expected: 4 passed.

- [ ] **Step 3: Update CLAUDE.md**

In `CLAUDE.md`:
- `protocol` bullet: note `ClientFrameSchema` is now `clip | delete` and the `delete` frame (msgId only) is in `ServerFrameSchema`.
- `apps/relay` bullet: note delete frames are fanned out and pruned from the backfill ring (`removeRecent`).
- A line under the security model: synced delete is by msgId only (no plaintext, stays zero-knowledge); the relay is authless, so any peer can delete — acceptable for trusted rooms.

Then:

```bash
git add CLAUDE.md
git commit -m "docs: note delete frame, synced delete, and its zero-knowledge boundary"
```

- [ ] **Step 4: Push (confirm with the user first)**

```bash
git push origin main
```

---

## Notes for the implementer

- **Relay tests run under Bun** (`bun --bun vitest`); `apps/relay/test/delete.test.ts` needs real `Bun.serve` + `WebSocket`, mirroring `apps/relay/test/backfill.test.ts`.
- **The delete frame carries only `msgId`** (a ULID already sent in the clear with every clip). Never add plaintext or anything key-derived to it — that would break the zero-knowledge boundary.
- **`removeRecent` must run on every delete** (Task 3), or a late joiner re-receives a deleted item via backfill — the one easy-to-miss consistency point.
- **Composer clipboard prefill is best-effort** — never block send on it; mobile may legitimately have an empty field until the user taps fill or pastes.
