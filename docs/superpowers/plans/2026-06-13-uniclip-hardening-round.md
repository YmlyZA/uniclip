# Uniclip v0.1.x Hardening Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the foundation before the UI redesign: collapse duplicated key-derivation and local-item logic in `client-core` (which also fixes the reconnect-duplicate edge), add opt-in SQLite room-metadata persistence so URLs survive a relay restart, and clear two tech-debt items (Hono deprecation, modal a11y).

**Architecture:** Three groups. (1) `client-core` grows two exports — `deriveRoomKey(room)` and a `msgId`-carrying `clip` event / `send()` return — so the web layer stops re-deriving keys and minting parallel IDs; persist then dedups by frame `msgId`. (2) A new `RoomDb` (`bun:sqlite`) becomes the source of truth for room existence; `RoomStore`'s `Map` becomes a live cache that rehydrates from the DB on `get()`. (3) Migrate off the deprecated `createBunWebSocket` and fix `share-modal.svelte` accessibility.

**Tech Stack:** TypeScript, Bun + Hono (relay), Svelte 5 (web), `bun:sqlite`, Vitest, pnpm/Turborepo. Relay tests run under `bun --bun vitest`; web/package tests under Node Vitest.

**Spec:** `docs/superpowers/specs/2026-06-13-uniclip-hardening-round-design.md`

**Implementation order:** B3 → B2 (isolated, low-risk) → Section 1 (client-core boundary) → Section 2 (SQLite). All TDD.

---

## Task 1: B3 — `share-modal.svelte` accessibility

**Files:**
- Modify: `apps/web/src/components/share-modal.svelte`

Four svelte-check a11y warnings: the `role="dialog"` element lacks `tabindex`; two `<div>`s carry `onclick` without keyboard handlers. Fix by moving `role="dialog"` (with `aria-modal`, `tabindex="-1"`) to the inner panel, removing the inner panel's `stopPropagation` click handler (close only when the click target IS the backdrop), adding Escape-to-close via `<svelte:window>`, and marking the intentional backdrop click with `svelte-ignore`.

- [ ] **Step 1: Apply the accessible modal structure**

Replace the entire contents of `apps/web/src/components/share-modal.svelte` with:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { renderQrSvg } from "../lib/qr";

  let { url, onClose }: { url: string; onClose: () => void } = $props();
  let svg = $state("");
  onMount(async () => {
    svg = await renderQrSvg(url);
  });

  async function copy() {
    await navigator.clipboard.writeText(url);
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
  class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div
    class="w-full max-w-sm rounded bg-white p-6 dark:bg-gray-900"
    role="dialog"
    aria-modal="true"
    aria-label="Share this room"
    tabindex="-1"
  >
    <h2 class="mb-4 text-lg font-semibold">Share this room</h2>
    <div class="mb-3 grid place-items-center">{@html svg}</div>
    <div class="mb-3 break-all rounded bg-gray-100 p-2 font-mono text-xs dark:bg-gray-800">
      {url}
    </div>
    <div class="flex justify-end gap-2">
      <button class="rounded border px-3 py-1 text-sm" onclick={copy}>Copy link</button>
      <button class="rounded bg-black px-3 py-1 text-sm text-white" onclick={onClose}>Done</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Run svelte-check, expect zero a11y warnings**

Run: `pnpm --filter @uniclip/web typecheck`
Expected: PASS with no `a11y_*` warnings for `share-modal.svelte`. If a warning remains, its reported code differs from the two `svelte-ignore` lines — update the comment(s) to match the exact reported code (e.g. `a11y_no_static_element_interactions`) and re-run.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/share-modal.svelte
git commit -m "fix(web): make share modal keyboard-accessible (Escape, focusable dialog)"
```

---

## Task 2: B2 — migrate off deprecated `createBunWebSocket`

**Files:**
- Modify: `apps/relay/src/ws-handlers.ts:1-17`

Hono 4.12's `createBunWebSocket` carries `@deprecated Import upgradeWebSocket and websocket directly from hono/bun instead`. The handler already casts `ws.raw as ServerWebSocket<{ roomId: string }>`, so dropping the factory's generic loses no type safety.

- [ ] **Step 1: Run the relay suite first to establish green baseline**

Run: `pnpm --filter @uniclip/relay test`
Expected: PASS (all existing relay tests green) — this is the regression guard for the migration.

- [ ] **Step 2: Change the import and remove the factory call**

In `apps/relay/src/ws-handlers.ts`, change line 2 from:

```ts
import { createBunWebSocket } from "hono/bun";
```

to:

```ts
import { upgradeWebSocket, websocket } from "hono/bun";
```

Then delete this line inside `attachWebSocket` (currently line 15):

```ts
  const { upgradeWebSocket, websocket } = createBunWebSocket<{ roomId: string }>();
```

Leave everything else (the `frameLimiter`, `socketKeys`, the `app.get("/ws/:roomId", upgradeWebSocket(...))` block, and `return { websocket, fetch: app.fetch, frameLimiter }`) unchanged — `upgradeWebSocket` and `websocket` now resolve to the imported bindings.

- [ ] **Step 3: Typecheck the relay (deprecation must be gone)**

Run: `pnpm --filter @uniclip/relay typecheck`
Expected: PASS with no `createBunWebSocket is deprecated` (TS 6385) diagnostic.

- [ ] **Step 4: Run the relay suite to confirm WS still works**

Run: `pnpm --filter @uniclip/relay test`
Expected: PASS (ws / clip / backfill / health / metrics / room-create suites all green).

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/ws-handlers.ts
git commit -m "refactor(relay): import upgradeWebSocket/websocket directly (drop deprecated createBunWebSocket)"
```

---

## Task 3: Section 1a — single-source `deriveRoomKey` in `client-core`

**Files:**
- Create: `packages/client-core/src/room-key.ts`
- Create: `packages/client-core/src/room-key.test.ts`
- Modify: `packages/client-core/src/index.ts`
- Modify: `packages/client-core/src/client.ts:1-5,71-81`
- Modify: `apps/web/src/routes/room.svelte:1-14,35-40`

The Mode-A/B key-derivation branch is duplicated in `client.ts` and `room.svelte`. Extract it to one exported function. Home is `client-core` (already depends on both `crypto` and `room-code`), keeping `room-code` free of a crypto dependency.

- [ ] **Step 1: Write the failing test**

Create `packages/client-core/src/room-key.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { encrypt, decrypt } from "@uniclip/crypto";
import { parseRoomUrl } from "@uniclip/room-code";
import { deriveRoomKey } from "./room-key";

describe("deriveRoomKey", () => {
  it("derives a usable key for a Mode A room", async () => {
    const room = parseRoomUrl("https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr")!;
    const key = await deriveRoomKey(room);
    const env = await encrypt({ key, plaintext: "hi", aad: "qx7k2p:1" });
    const back = await decrypt({ key, iv: env.iv, ciphertext: env.ciphertext, aad: "qx7k2p:1" });
    expect(back).toBe("hi");
  });

  it("derives a usable key for a Mode B room", async () => {
    const room = parseRoomUrl("https://uniclip.app/r/ABC234")!;
    const key = await deriveRoomKey(room);
    const env = await encrypt({ key, plaintext: "yo", aad: "ABC234:1" });
    const back = await decrypt({ key, iv: env.iv, ciphertext: env.ciphertext, aad: "ABC234:1" });
    expect(back).toBe("yo");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @uniclip/client-core test room-key`
Expected: FAIL — `Cannot find module './room-key'`.

- [ ] **Step 3: Implement `deriveRoomKey`**

Create `packages/client-core/src/room-key.ts`:

```ts
import { deriveKey } from "@uniclip/crypto";
import { MODE_B_SALT, type ParsedRoom } from "@uniclip/room-code";

/**
 * The single source of truth for turning a parsed room into its AES key.
 * Mode A derives from the URL-fragment secret (relay never sees it); Mode B
 * derives from the routingId the server already knows. This MUST match the
 * relay's Mode-B derivation, or peers cannot decrypt each other.
 */
export function deriveRoomKey(room: ParsedRoom): Promise<CryptoKey> {
  return room.mode === "A"
    ? deriveKey({ secret: room.secret, salt: room.routingId })
    : deriveKey({ secret: room.routingId, salt: MODE_B_SALT });
}
```

- [ ] **Step 4: Export it from the package index**

In `packages/client-core/src/index.ts`, add a third line:

```ts
export * from "./client";
export * from "./backoff";
export * from "./room-key";
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `pnpm --filter @uniclip/client-core test room-key`
Expected: PASS (both cases).

- [ ] **Step 6: Use `deriveRoomKey` inside `UniclipClient`**

In `packages/client-core/src/client.ts`:

Change the crypto import (line 3) to drop `deriveKey`:

```ts
import { encrypt, decrypt, toBase64, fromBase64, ReplaySet } from "@uniclip/crypto";
```

Change the room-code import (line 4) to drop `MODE_B_SALT`:

```ts
import { parseRoomUrl, type ParsedRoom } from "@uniclip/room-code";
```

Add the new import after the backoff import (line 5):

```ts
import { deriveRoomKey } from "./room-key";
```

Replace the `connect()` body (lines 71-81) with:

```ts
  async connect(): Promise<void> {
    if (this.disposed) throw new Error("client disposed");
    if (!this.key) {
      this.key = await deriveRoomKey(this.room);
    }
    this.openSocket();
  }
```

- [ ] **Step 7: Use `deriveRoomKey` in the web room route**

In `apps/web/src/routes/room.svelte`:

Change the client-core import (line 3) to add `deriveRoomKey`:

```ts
  import { UniclipClient, deriveRoomKey } from "@uniclip/client-core";
```

Delete these two now-unused imports (lines 5-6):

```ts
  import { deriveKey } from "@uniclip/crypto";
  import { MODE_B_SALT } from "@uniclip/room-code";
```

Replace the key-derivation block in `onMount` (lines 36-39) with:

```ts
    const key = await deriveRoomKey(room);
```

- [ ] **Step 8: Typecheck both packages**

Run: `pnpm --filter @uniclip/client-core typecheck && pnpm --filter @uniclip/web typecheck`
Expected: PASS (no unused-import or missing-symbol errors).

- [ ] **Step 9: Run client-core's full suite (no regressions)**

Run: `pnpm --filter @uniclip/client-core test`
Expected: PASS (existing client tests still green — `connect()` behaves identically).

- [ ] **Step 10: Commit**

```bash
git add packages/client-core/src/room-key.ts packages/client-core/src/room-key.test.ts \
  packages/client-core/src/index.ts packages/client-core/src/client.ts \
  apps/web/src/routes/room.svelte
git commit -m "refactor(client-core): single-source deriveRoomKey; web + client share it"
```

---

## Task 4: Section 1b — `send()` returns `{ msgId, ts }` and `clip` carries `msgId`

**Files:**
- Modify: `packages/client-core/src/client.ts:9-24,57-69,126-146,148-167`
- Modify: `packages/client-core/src/client.test.ts` (add two tests)

Give the web layer the frame identity it needs: `send()` returns the minted `msgId`/`ts`, and the `clip` event carries the received frame's `msgId`. The frame's `ts` and the returned `ts` are the same `Date.now()` value, so a clip has identical `{ msgId, ts }` across sender, relay, and receiver.

- [ ] **Step 1: Write the failing tests**

In `packages/client-core/src/client.test.ts`, add these two tests inside the `describe("UniclipClient", ...)` block (after the existing last test, before the closing `});`):

```ts
  it("send() returns the minted msgId and ts matching the wire frame", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    const res = await client.send("x");
    const wire = JSON.parse(ws.sent[0]!);
    expect(res.msgId).toBe(wire.msgId);
    expect(res.ts).toBe(wire.ts);
  });

  it("emits the frame's msgId with 'clip' (for persist dedup)", async () => {
    const sender = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    const receiver = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await sender.connect();
    await receiver.connect();
    const senderWs = MockWebSocket.instances[0]!;
    const receiverWs = MockWebSocket.instances[1]!;
    senderWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    receiverWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });

    let gotMsgId = "";
    receiver.on("clip", (_text: string, _ts: number, msgId: string) => (gotMsgId = msgId));
    await sender.send("hi");
    const wire = JSON.parse(senderWs.sent[0]!);
    receiverWs.emit(wire);
    await waitFor(() => gotMsgId !== "");
    expect(gotMsgId).toBe(wire.msgId);
  });
```

- [ ] **Step 2: Run them to confirm failure**

Run: `pnpm --filter @uniclip/client-core test client`
Expected: FAIL — `res.msgId` is undefined (`send` returns `void`); the `clip` handler's 3rd arg is `undefined`.

- [ ] **Step 3: Add `msgId` to the clip event and handler types**

In `packages/client-core/src/client.ts`, change the `ClientEvent` clip variant (line 11):

```ts
  | { kind: "clip"; text: string; ts: number; msgId: string }
```

Change the `EventHandlers.clip` signature (line 20):

```ts
  clip: (text: string, ts: number, msgId: string) => void;
```

- [ ] **Step 4: Pass `msgId` through `emit`**

In the `emit` switch (line 63), change the `clip` case to:

```ts
        case "clip": (cb as EventHandlers["clip"])(evt.text, evt.ts, evt.msgId); break;
```

- [ ] **Step 5: Emit `msgId` from the receive path**

In `handleFrame`'s clip case, change the success emit (line 136) to:

```ts
          this.emit({ kind: "clip", text, ts: frame.ts, msgId: frame.msgId });
```

- [ ] **Step 6: Return identity from `send()`**

Replace `send()` (lines 148-167) with:

```ts
  async send(text: string): Promise<{ msgId: string; ts: number }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    if (!this.key) throw new Error("no key");
    const msgId = ulid();
    const ts = Date.now();
    const env = await encrypt({
      key: this.key,
      plaintext: text,
      aad: `${this.room.routingId}:${msgId}`,
    });
    const frame: ClientFrame = {
      type: "clip",
      msgId,
      iv: toBase64(env.iv),
      ciphertext: toBase64(env.ciphertext),
      ts,
    };
    this.ws.send(JSON.stringify(frame));
    return { msgId, ts };
  }
```

- [ ] **Step 7: Run the client-core suite**

Run: `pnpm --filter @uniclip/client-core test client`
Expected: PASS — the two new tests plus all existing ones (existing `clip` handlers that take fewer args remain valid).

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @uniclip/client-core typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/client-core/src/client.ts packages/client-core/src/client.test.ts
git commit -m "feat(client-core): send() returns {msgId,ts}; clip event carries msgId"
```

---

## Task 5: Section 1c + A3 — persist dedup by `msgId` and `room.svelte` `addItem` helper

**Files:**
- Modify: `apps/web/src/lib/persist.ts:26-33`
- Modify: `apps/web/src/lib/persist.test.ts` (add one test)
- Modify: `apps/web/src/routes/room.svelte:43-81`

Make the frame `msgId` the item identity end-to-end: `PersistedItems.add` dedups by `id`, and `room.svelte` uses one `addItem(text, ts, msgId)` helper with `id = msgId`. This removes the local-item triplication (A2) and the reconnect-duplicate edge (A3): backfill replaying a device's own sent frames now no-ops in both the in-memory list and persist.

- [ ] **Step 1: Write the failing persist test**

In `apps/web/src/lib/persist.test.ts`, add this test inside `describe("PersistedItems", ...)`:

```ts
  it("dedups by id (duplicate frame is a no-op)", async () => {
    const key = await deriveKey({ secret: "abcdefghijklmnopqr", salt: "qx7k2p" });
    const p = new PersistedItems({ roomId: "qx7k2p", key, cap: 50 });
    await p.add({ id: "m1", text: "hello", ts: 1 });
    await p.add({ id: "m1", text: "hello", ts: 1 }); // replayed on reconnect
    const loaded = await p.load();
    expect(loaded).toHaveLength(1);
  });
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm --filter @uniclip/web test persist`
Expected: FAIL — `loaded` has length 2 (no dedup yet).

- [ ] **Step 3: Add the dedup guard to `add`**

In `apps/web/src/lib/persist.ts`, replace the `add` method (lines 26-33) with:

```ts
  async add(item: Item): Promise<void> {
    if (!this.loaded) await this.load();
    if (this.items.some((i) => i.id === item.id)) return; // dedup by frame identity
    this.items.push(item);
    if (this.items.length > this.opts.cap) {
      this.items.splice(0, this.items.length - this.opts.cap);
    }
    await this.save();
  }
```

- [ ] **Step 4: Run the persist suite**

Run: `pnpm --filter @uniclip/web test persist`
Expected: PASS (new dedup test + existing round-trip/cap/clear tests).

- [ ] **Step 5: Collapse `room.svelte` to one `addItem` helper using `msgId`**

In `apps/web/src/routes/room.svelte`, replace the receive handler + `watcher.on` block in `onMount` (current lines 47-63) with:

```ts
    c.on("room", (b) => (backfillOn = b));
    c.on("clip", (text, ts, msgId) => addItem(text, ts, msgId));
    c.on("error", (e) => toast(`${e.code}: ${e.message}`, "warn"));
    await c.connect();

    watcher.on(async (text) => {
      try {
        const { msgId, ts } = await c.send(text);
        await addItem(text, ts, msgId);
      } catch {}
    });
```

Replace `sendNow` (current lines 71-81) with:

```ts
  async function sendNow() {
    try {
      const text = await readClipboardText();
      if (!client) return;
      const { msgId, ts } = await client.send(text);
      await addItem(text, ts, msgId);
    } catch {
      toast("Clipboard read failed — permission?", "warn");
    }
  }
```

Add this `addItem` helper just below `sendNow` (before `toggleWatch`):

```ts
  async function addItem(text: string, ts: number, msgId: string) {
    if (items.some((i) => i.id === msgId)) return; // mirror persist's dedup for the live list
    const item: Item = { id: msgId, text, ts };
    items = [...items, item].slice(-50);
    await persist!.add(item);
  }
```

- [ ] **Step 6: Typecheck the web app**

Run: `pnpm --filter @uniclip/web typecheck`
Expected: PASS — `c.on("clip", ...)` now matches the 3-arg handler; `send()` returns `{ msgId, ts }`; no unused `ulid` import remains **only if** `ulid` is still used elsewhere in the file. If svelte-check reports `ulid` as unused, remove its import line (`import { ulid } from "ulid";`).

- [ ] **Step 7: Run the full web suite**

Run: `pnpm --filter @uniclip/web test`
Expected: PASS.

- [ ] **Step 8: Run the e2e backfill flow (verifies the wiring end-to-end)**

Run: `pnpm test:e2e`
Expected: PASS (`2 passed`) — `two-browser` and `backfill` specs both green; the `addItem`/`msgId` rewiring did not regress live sync or backfill.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/persist.ts apps/web/src/lib/persist.test.ts apps/web/src/routes/room.svelte
git commit -m "fix(web): key items by frame msgId + dedup (no reconnect duplicates); collapse add paths"
```

---

## Task 6: Section 2 — `RoomDb` (`bun:sqlite`) persistence module

**Files:**
- Create: `apps/relay/src/room-db.ts`
- Create: `apps/relay/src/room-db.test.ts`

A thin wrapper over `bun:sqlite` storing **only** room metadata — never frames, keys, sockets, or the backfill ring. Accepts an injected `Database` (or path) so tests stay isolated and a restart can be simulated by sharing one handle.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/src/room-db.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { RoomDb } from "./room-db";

describe("RoomDb", () => {
  it("inserts and reads back a room record", () => {
    const d = new RoomDb(new Database(":memory:"));
    d.insert({ id: "qx7k2p", mode: "A", expiresAt: 100, backfillEnabled: true, createdAt: 0 });
    expect(d.get("qx7k2p")).toEqual({
      id: "qx7k2p",
      mode: "A",
      expiresAt: 100,
      backfillEnabled: true,
      createdAt: 0,
    });
  });

  it("returns undefined for an unknown id", () => {
    const d = new RoomDb(new Database(":memory:"));
    expect(d.get("nope12")).toBeUndefined();
  });

  it("delete removes a record", () => {
    const d = new RoomDb(new Database(":memory:"));
    d.insert({ id: "a", mode: "B", expiresAt: 100, backfillEnabled: false, createdAt: 0 });
    d.delete("a");
    expect(d.get("a")).toBeUndefined();
  });

  it("deleteExpired removes rows at or before the cutoff", () => {
    const d = new RoomDb(new Database(":memory:"));
    d.insert({ id: "old", mode: "A", expiresAt: 50, backfillEnabled: true, createdAt: 0 });
    d.insert({ id: "new", mode: "A", expiresAt: 150, backfillEnabled: true, createdAt: 0 });
    d.deleteExpired(100);
    expect(d.get("old")).toBeUndefined();
    expect(d.get("new")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm --filter @uniclip/relay test room-db`
Expected: FAIL — `Cannot find module './room-db'`.

- [ ] **Step 3: Implement `RoomDb`**

Create `apps/relay/src/room-db.ts`:

```ts
import { Database } from "bun:sqlite";
import type { RoomMode } from "./rooms";

export interface RoomRecord {
  id: string;
  mode: RoomMode;
  expiresAt: number;
  backfillEnabled: boolean;
  createdAt: number;
}

interface Row {
  id: string;
  mode: string;
  expires_at: number;
  backfill_enabled: number;
  created_at: number;
}

/**
 * Durable store of room *metadata only* — never frames, keys, sockets, or the
 * backfill ring. Lets room URLs survive a relay restart without retaining
 * anything the relay must not hold.
 */
export class RoomDb {
  private readonly db: Database;

  constructor(dbOrPath: Database | string = ":memory:") {
    this.db = typeof dbOrPath === "string" ? new Database(dbOrPath) : dbOrPath;
    this.db.run(
      `CREATE TABLE IF NOT EXISTS rooms (
         id               TEXT    PRIMARY KEY,
         mode             TEXT    NOT NULL,
         expires_at       INTEGER NOT NULL,
         backfill_enabled INTEGER NOT NULL,
         created_at       INTEGER NOT NULL
       )`,
    );
  }

  insert(rec: RoomRecord): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO rooms (id, mode, expires_at, backfill_enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(rec.id, rec.mode, rec.expiresAt, rec.backfillEnabled ? 1 : 0, rec.createdAt);
  }

  get(id: string): RoomRecord | undefined {
    const row = this.db.query(`SELECT * FROM rooms WHERE id = ?`).get(id) as Row | null;
    if (!row) return undefined;
    return {
      id: row.id,
      mode: row.mode as RoomMode,
      expiresAt: row.expires_at,
      backfillEnabled: row.backfill_enabled === 1,
      createdAt: row.created_at,
    };
  }

  delete(id: string): void {
    this.db.query(`DELETE FROM rooms WHERE id = ?`).run(id);
  }

  deleteExpired(now: number): void {
    this.db.query(`DELETE FROM rooms WHERE expires_at <= ?`).run(now);
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @uniclip/relay test room-db`
Expected: PASS (all four cases).

- [ ] **Step 5: Typecheck the relay**

Run: `pnpm --filter @uniclip/relay typecheck`
Expected: PASS (`bun:sqlite` resolves under the relay's `"types": ["bun"]`).

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/room-db.ts apps/relay/src/room-db.test.ts
git commit -m "feat(relay): RoomDb — bun:sqlite store for room metadata only"
```

---

## Task 7: Section 2 — wire `RoomDb` into `RoomStore` (DB = truth, Map = live cache)

**Files:**
- Modify: `apps/relay/src/rooms.ts:1-7,25-91`
- Modify: `apps/relay/src/rooms.test.ts` (add tests; update the idle-GC test for new semantics)
- Modify: `apps/relay/src/server.ts:9` (inject the DB path)

`create` writes both DB and Map. `get` rehydrates from the DB on a Map miss (this is what makes URLs survive restart). Idle GC evicts the Map entry but keeps the DB row until `expires_at`; max-age GC deletes from both. The default DB is an isolated `:memory:`, so unconfigured behavior is unchanged.

> **Behavior change (intended, per spec §3):** previously an idle room (0 sockets > 5 min) became permanently unreachable. Now idle reclaims memory only — the room rehydrates from the DB until its 24h max-age. The idle-GC test is updated to assert this.

- [ ] **Step 1: Write the failing tests**

In `apps/relay/src/rooms.test.ts`, add `import { Database } from "bun:sqlite";` below the existing imports (after line 3). Then add these tests inside `describe("RoomStore", ...)`:

```ts
  it("get() rehydrates a room from the DB after the in-memory Map is gone (restart)", () => {
    const db = new Database(":memory:");
    const s1 = new RoomStore({ db });
    const r = s1.create("A");
    const s2 = new RoomStore({ db }); // fresh process over the same DB
    const got = s2.get(r.id);
    expect(got).toBeDefined();
    expect(got!.mode).toBe("A");
    expect(got!.sockets.size).toBe(0);
    expect(got!.recent).toHaveLength(0);
    expect(got!.backfillEnabled).toBe(true);
  });

  it("get() does not rehydrate an expired DB row and removes it", () => {
    const db = new Database(":memory:");
    const s1 = new RoomStore({ db, maxAgeMs: 1_000 });
    const r = s1.create("A");
    vi.advanceTimersByTime(2_000);
    const s2 = new RoomStore({ db, maxAgeMs: 1_000 });
    expect(s2.get(r.id)).toBeUndefined();
  });

  it("defaults to an isolated in-memory DB (no persistence across instances)", () => {
    const a = new RoomStore();
    const r = a.create("A");
    const b = new RoomStore();
    expect(b.get(r.id)).toBeUndefined();
  });
```

Then **replace** the existing test `it("GC drops rooms with 0 sockets idle > 5 min", ...)` (current lines 48-55) with:

```ts
  it("idle GC evicts from memory but the room rehydrates from the DB (survives to max-age)", () => {
    const s = new RoomStore({ idleTimeoutMs: 5 * 60_000, maxAgeMs: 24 * 3600_000 });
    const r = s.create("A");
    expect(s.count).toBe(1);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    s.gc();
    expect(s.count).toBe(0); // evicted from the live Map
    const got = s.get(r.id);
    expect(got).toBeDefined(); // still reachable: rehydrated from the DB row
    expect(got!.sockets.size).toBe(0);
  });
```

And **replace** the existing test `it("GC drops rooms older than maxAge regardless of activity", ...)` (current lines 66-73) with:

```ts
  it("max-age GC drops the room from both memory and the DB", () => {
    const db = new Database(":memory:");
    const s = new RoomStore({ db, idleTimeoutMs: 5 * 60_000, maxAgeMs: 1_000 });
    const r = s.create("A");
    s.get(r.id)!.sockets.add({} as never);
    vi.advanceTimersByTime(2_000);
    s.gc();
    expect(s.get(r.id)).toBeUndefined(); // gone from Map AND DB (no rehydrate)
  });
```

- [ ] **Step 2: Run the tests to confirm failure**

Run: `pnpm --filter @uniclip/relay test rooms`
Expected: FAIL — `RoomStore` does not accept `{ db }`, has no DB rehydrate, and idle GC still deletes outright.

- [ ] **Step 3: Add the DB to `RoomStore`**

In `apps/relay/src/rooms.ts`, add imports after line 5:

```ts
import type { Database } from "bun:sqlite";
import { RoomDb } from "./room-db";
```

Add `db` to the options interface (replace lines 25-28):

```ts
export interface RoomStoreOptions {
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  db?: Database | string;
}
```

Add a `roomDb` field and initialize it in the constructor (replace lines 30-38):

```ts
export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly idleTimeoutMs: number;
  private readonly maxAgeMs: number;
  private readonly roomDb: RoomDb;

  constructor(opts: RoomStoreOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
    this.maxAgeMs = opts.maxAgeMs ?? 24 * 3600_000;
    this.roomDb = new RoomDb(opts.db ?? ":memory:");
  }
```

- [ ] **Step 4: Persist on `create`**

Replace `create` (current lines 44-61) with:

```ts
  create(mode: RoomMode, backfill = true): Room {
    const id =
      mode === "A" ? generateModeARoom().routingId : generateModeBCode();
    const now = Date.now();
    const room: Room = {
      id,
      mode,
      sockets: new Set(),
      createdAt: now,
      lastActivityAt: now,
      recent: [],
      // Mode B can be decrypted by the relay, so it never buffers regardless of
      // the requested flag — keeping retained data to ciphertext-only (Mode A).
      backfillEnabled: mode === "A" && backfill,
    };
    this.rooms.set(id, room);
    this.roomDb.insert({
      id,
      mode,
      expiresAt: now + this.maxAgeMs,
      backfillEnabled: room.backfillEnabled,
      createdAt: now,
    });
    return room;
  }
```

- [ ] **Step 5: Rehydrate on `get`**

Replace `get` (current lines 74-76) with:

```ts
  get(id: string): Room | undefined {
    const live = this.rooms.get(id);
    if (live) return live;
    // Map miss: the room may still exist in the DB (survived a restart, or was
    // evicted from memory while idle). Rehydrate it — empty sockets/recent;
    // history only ever lives in memory while a device is connected.
    const rec = this.roomDb.get(id);
    if (!rec) return undefined;
    if (rec.expiresAt <= Date.now()) {
      this.roomDb.delete(id);
      return undefined;
    }
    const room: Room = {
      id: rec.id,
      mode: rec.mode,
      sockets: new Set(),
      createdAt: rec.createdAt,
      lastActivityAt: Date.now(),
      recent: [],
      backfillEnabled: rec.backfillEnabled,
    };
    this.rooms.set(id, room);
    return room;
  }
```

- [ ] **Step 6: Split idle vs max-age in `gc`**

Replace `gc` (current lines 83-90) with:

```ts
  gc(): void {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      const aged = now - room.createdAt > this.maxAgeMs;
      const idle =
        room.sockets.size === 0 && now - room.lastActivityAt > this.idleTimeoutMs;
      if (aged) {
        this.rooms.delete(id);
        this.roomDb.delete(id); // gone for good
      } else if (idle) {
        this.rooms.delete(id); // reclaim memory; DB row survives to max-age
      }
    }
    // Sweep DB rows whose rooms expired while evicted from the Map.
    this.roomDb.deleteExpired(now);
  }
```

- [ ] **Step 7: Run the relay `rooms` suite**

Run: `pnpm --filter @uniclip/relay test rooms`
Expected: PASS — new restart/expired/isolation/idle/max-age tests plus the unchanged create/count/touch/socket-keep/backfill tests.

- [ ] **Step 8: Inject the configured DB path in `server.ts`**

In `apps/relay/src/server.ts`, change line 9 from:

```ts
const store = new RoomStore();
```

to:

```ts
const store = new RoomStore({ db: process.env.ROOM_DB_PATH ?? ":memory:" });
```

- [ ] **Step 9: Run the full relay suite + typecheck**

Run: `pnpm --filter @uniclip/relay test && pnpm --filter @uniclip/relay typecheck`
Expected: PASS (no suite regressed; `server.ts` typechecks).

- [ ] **Step 10: Commit**

```bash
git add apps/relay/src/rooms.ts apps/relay/src/rooms.test.ts apps/relay/src/server.ts
git commit -m "feat(relay): DB-backed rooms — URLs survive restart; Map is a live cache"
```

---

## Task 8: Section 2 — deploy config + docs for persistent room DB

**Files:**
- Modify: `deploy/docker-compose.yml`
- Modify: `deploy/README.md`

Opt the production compose stack into persistence: set `ROOM_DB_PATH` and mount a volume for it. Without these (e.g. the bare `docker run`), the relay defaults to `:memory:` and behaves exactly as before.

- [ ] **Step 1: Add env + volume to the relay service**

In `deploy/docker-compose.yml`, replace the `relay` service's `environment` block:

```yaml
    environment:
      PORT: "3000"
      LOG_LEVEL: info
```

with (add `ROOM_DB_PATH` and a `volumes` mount):

```yaml
    environment:
      PORT: "3000"
      LOG_LEVEL: info
      ROOM_DB_PATH: /data/rooms.db # persists room URLs across restarts (metadata only)
    volumes:
      - room_data:/data # room metadata DB — never holds frames, keys, or history
```

Then add `room_data` to the top-level `volumes:` block at the end of the file:

```yaml
volumes:
  caddy_data:
  caddy_config:
  room_data:
```

- [ ] **Step 2: Update the compose-file header comment**

In `deploy/docker-compose.yml`, replace the header sentence:

```
# The relay is in-memory and stateless (rooms GC by idle/age, nothing is
# persisted), so this two-service stack is the entire deployment.
```

with:

```
# The relay keeps clipboard frames/keys/history only in memory; it persists just
# room *metadata* ({id, mode, expiresAt}) to a small SQLite file on the room_data
# volume so room URLs survive a redeploy. GC by idle/age still applies.
```

- [ ] **Step 3: Validate the compose file parses**

Run: `cd deploy && DOMAIN=clip.example.com docker compose config >/dev/null && cd ..`
Expected: exit 0, no YAML/scheme error (prints nothing). If `docker` is unavailable in the environment, skip with a note and visually confirm indentation matches the surrounding 4-space style.

- [ ] **Step 4: Document persistence in the deploy README**

In `deploy/README.md`, add this subsection (place it after the compose/Caddy section; match the file's existing heading style):

```markdown
## Room persistence (surviving restarts)

By default the relay holds everything in memory, so a restart invalidates active
room URLs (clients reconnect, get `4404`, and must mint a new room). The compose
stack opts into durability by setting `ROOM_DB_PATH=/data/rooms.db` on a mounted
`room_data` volume. Only room **metadata** (`id`, `mode`, `expiresAt`,
`backfillEnabled`) is stored — never clipboard frames, keys, sockets, or the
backfill buffer. After a redeploy, existing URLs stay valid and devices
reconnect automatically; history still exists only while a device is connected.

A bare `docker run` without `ROOM_DB_PATH` keeps the original in-memory behavior.
```

- [ ] **Step 5: Commit**

```bash
git add deploy/docker-compose.yml deploy/README.md
git commit -m "docs(deploy): opt compose into persistent room metadata DB (ROOM_DB_PATH + volume)"
```

---

## Final verification

- [ ] **Step 1: Full typecheck across the monorepo**

Run: `pnpm typecheck`
Expected: PASS for every package (relay, web/svelte-check, crypto, protocol, room-code, client-core).

- [ ] **Step 2: Full unit suite**

Run: `pnpm test`
Expected: PASS — including the new `room-key`, `room-db`, persist-dedup, and DB-backed `rooms` tests.

- [ ] **Step 3: E2E two-browser + backfill**

Run: `pnpm test:e2e`
Expected: `2 passed`.

- [ ] **Step 4: Update CLAUDE.md architecture notes**

In `CLAUDE.md`:
- In the data-flow paragraph, note that the relay now persists room **metadata** (not frames/keys) to an optional SQLite DB so URLs survive restart; the backfill buffer remains memory-only.
- In the `apps/relay` bullet, mention `room-db.ts` (`RoomDb`, `bun:sqlite`, metadata-only) and that `RoomStore.get` rehydrates from the DB (`ROOM_DB_PATH`, default `:memory:`).
- In the security-model section, add: persistence stores only `{id, mode, expiresAt, backfillEnabled}` — never frames, keys, or the backfill ring; idle GC reclaims memory but a room survives to its 24h max-age.

Then commit:

```bash
git add CLAUDE.md
git commit -m "docs: note DB-backed room metadata + client-core boundary in architecture"
```

- [ ] **Step 5: Push**

```bash
git push origin main
```
(Confirm with the user before pushing if they prefer to push themselves.)

---

## Notes for the implementer

- **Relay tests run under Bun** (`bun --bun vitest`), which is why `bun:sqlite` works in `room-db.ts`/`rooms.ts` and `room-db.test.ts`. Do not move these to Node Vitest.
- **`@types/bun` types `.get()`/`.json()` as loose** — the `as Row | null` cast in `RoomDb.get` is required, mirroring the existing `(await res.json()) as {...}` casts in relay tests.
- **Never reassign `raw.data`** in `ws-handlers.ts` (Task 2 keeps the existing `raw.data.roomId` mutation pattern — Hono's bun adapter owns `ws.data`).
- **Key-derivation parity:** `deriveRoomKey` (Task 3) must stay byte-for-byte equivalent to the relay's Mode-B derivation and to what every peer computes. It now has exactly one definition; do not reintroduce a second.
- **Backfill ring stays memory-only** — Task 6/7 persist room metadata only. Never add `recent` to `RoomDb`.
```
