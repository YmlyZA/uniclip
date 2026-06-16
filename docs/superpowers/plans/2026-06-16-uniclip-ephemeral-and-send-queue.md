# Ephemeral Rooms + Offline Send Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add (A) per-room *ephemeral* mode — no device persists history, relay backfill forced off, items auto-expire 60s after delivery — and (B) an offline *send queue* that buffers text typed while disconnected and flushes it on reconnect, with a per-item pending indicator.

**Architecture:** Ephemeral is one new relay metadata boolean (`ephemeral`), mirroring `backfillEnabled`: stored in `RoomDb`, echoed in the `hello` frame, and surfaced to the web app via the client's `room` event. The web app swaps its persistence layer for a no-op `EphemeralStore` and runs a local per-device `ExpiryScheduler`. The send queue lives entirely inside `UniclipClient` (in-memory, bounded, flushed on `hello`), exposing a new `sent` event and a `queued` flag on `send()`'s return so the web app can render pending items. The one cross-feature rule: a queued item's TTL starts at *delivery* (`sent`), never at composition.

**Tech Stack:** TypeScript monorepo (pnpm + Turborepo). Zod (protocol), Bun + `bun:sqlite` + Hono (relay, tests under `bun --bun vitest`), WebCrypto AES-GCM (crypto), Svelte 5 runes + Vite 6 + Tailwind 4 (web), Playwright (e2e). Vitest everywhere.

---

## File Structure

**Feature A — Ephemeral**
- `packages/protocol/src/index.ts` — add `ephemeral` to `HelloFrameSchema`.
- `apps/relay/src/room-db.ts` — `ephemeral` column (+ defensive migration for existing DBs).
- `apps/relay/src/rooms.ts` — `Room.ephemeral`; `create(mode, backfill, ephemeral)`; rehydrate in `get()`; force backfill off when ephemeral.
- `apps/relay/src/app.ts` — `CreateRoomBody.ephemeral`; pass to `create`.
- `apps/relay/src/ws-handlers.ts` — include `ephemeral` in the hello frame.
- `packages/client-core/src/client.ts` — `room` event payload becomes `{ backfill, ephemeral }`.
- `apps/web/src/lib/persist.ts` — extract `ItemStore` interface; add `EphemeralStore` (Null Object).
- `apps/web/src/lib/ephemeral.ts` (new) — `EPHEMERAL_TTL_MS`, `ExpiryScheduler`.
- `apps/web/src/routes/landing.svelte` — ephemeral creation toggle.
- `apps/web/src/routes/room.svelte` — store selection, ephemeral state, expiry wiring.
- `apps/web/src/components/header.svelte` — "Ephemeral · not saved" badge.

**Feature B — Send queue**
- `packages/client-core/src/client.ts` — in-memory bounded queue; `send()` returns `{ msgId, ts, queued }`; flush on `hello`; new `sent` event; `QUEUE_FULL` error.
- `apps/web/src/lib/persist.ts` — `Item.pending?: boolean`.
- `apps/web/src/routes/room.svelte` — thread `queued` into items; `sent` listener clears pending + (if ephemeral) schedules TTL.
- `apps/web/src/components/item-row.svelte` — pending appearance.

**Tests**
- `packages/protocol/src/index.test.ts`, `apps/relay/src/{room-db,rooms,app-or-ws}.test.ts`, `packages/client-core/src/client.test.ts`, `apps/web/src/lib/{persist,ephemeral}.test.ts`, `e2e/tests/{ephemeral,offline-queue}.spec.ts`.

---

## Task 1: Protocol — `ephemeral` on the hello frame

**Files:**
- Modify: `packages/protocol/src/index.ts:31-41`
- Test: `packages/protocol/src/index.test.ts:47-58`

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/index.test.ts` inside the `describe("ServerFrameSchema", …)` block:

```ts
  it("accepts hello with an ephemeral flag", () => {
    const f = ServerFrameSchema.parse({
      type: "hello",
      roomId: "qx7k2p",
      peerCount: 1,
      serverTime: 1717000000000,
      backfill: true,
      ephemeral: true,
    });
    expect(f).toMatchObject({ type: "hello", ephemeral: true });
  });

  it("defaults ephemeral to false when the field is absent (rolling-deploy compat)", () => {
    const f = ServerFrameSchema.parse({
      type: "hello",
      roomId: "qx7k2p",
      peerCount: 1,
      serverTime: 1717000000000,
      backfill: false,
    });
    expect(f).toMatchObject({ type: "hello", ephemeral: false });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/protocol test`
Expected: FAIL — the first test asserts `ephemeral: true` but the parsed object has no `ephemeral` key (and `.strict()` would reject the extra key on parse, throwing).

- [ ] **Step 3: Add the field**

In `packages/protocol/src/index.ts`, edit `HelloFrameSchema`:

```ts
export const HelloFrameSchema = z
  .object({
    type: z.literal("hello"),
    roomId: z.string(),
    peerCount: z.number().int().nonnegative(),
    serverTime: z.number().int().nonnegative(),
    // Whether this room backfills recent clips to late joiners. Always false
    // for Mode B (the relay only buffers ciphertext it cannot decrypt).
    backfill: z.boolean(),
    // Ephemeral rooms: no device persists history and items auto-expire on
    // screen. Optional-with-default so a new client tolerates an old relay's
    // hello (which lacks the field) during a rolling deploy.
    ephemeral: z.boolean().optional().default(false),
  })
  .strict();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/protocol test`
Expected: PASS (all protocol tests green).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @uniclip/protocol typecheck
git add packages/protocol/src/index.ts packages/protocol/src/index.test.ts
git commit -m "feat(protocol): add ephemeral flag to hello frame"
```

---

## Task 2: Relay — `ephemeral` column in RoomDb (with migration)

**Files:**
- Modify: `apps/relay/src/room-db.ts:4-18,28-62`
- Test: `apps/relay/src/room-db.test.ts` (add cases; create the file if absent — see Step 1)

- [ ] **Step 1: Write the failing test**

If `apps/relay/src/room-db.test.ts` does not exist, create it with this content; otherwise add the two `it(...)` blocks to the existing `describe`:

```ts
import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { RoomDb } from "./room-db";

describe("RoomDb ephemeral", () => {
  it("round-trips the ephemeral flag", () => {
    const db = new RoomDb(new Database(":memory:"));
    db.insert({ id: "qx7k2p", mode: "A", expiresAt: Date.now() + 1000, backfillEnabled: false, createdAt: Date.now(), ephemeral: true });
    expect(db.get("qx7k2p")?.ephemeral).toBe(true);
  });

  it("defaults ephemeral to false for rows created before the column existed", () => {
    const raw = new Database(":memory:");
    // Simulate a pre-ephemeral schema + row.
    raw.run(`CREATE TABLE rooms (id TEXT PRIMARY KEY, mode TEXT NOT NULL, expires_at INTEGER NOT NULL, backfill_enabled INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    raw.run(`INSERT INTO rooms VALUES ('old123', 'A', ${Date.now() + 1000}, 1, ${Date.now()})`);
    const db = new RoomDb(raw); // constructor must migrate the existing table
    expect(db.get("old123")?.ephemeral).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/relay test room-db`
Expected: FAIL — `RoomRecord` has no `ephemeral` (TS error in the test) and/or `get()` returns no `ephemeral` field; the migration test errors because `insert`/`get` reference a non-existent column.

- [ ] **Step 3: Add the column, migration, and mapping**

In `apps/relay/src/room-db.ts`:

Extend the interfaces:

```ts
export interface RoomRecord {
  id: string;
  mode: RoomMode;
  expiresAt: number;
  backfillEnabled: boolean;
  createdAt: number;
  ephemeral: boolean;
}

interface Row {
  id: string;
  mode: string;
  expires_at: number;
  backfill_enabled: number;
  created_at: number;
  ephemeral: number;
}
```

Update the constructor (fresh-table DDL + defensive migration for existing DBs):

```ts
  constructor(dbOrPath: Database | string = ":memory:") {
    this.db = typeof dbOrPath === "string" ? new Database(dbOrPath) : dbOrPath;
    this.db.run(
      `CREATE TABLE IF NOT EXISTS rooms (
         id               TEXT    PRIMARY KEY,
         mode             TEXT    NOT NULL,
         expires_at       INTEGER NOT NULL,
         backfill_enabled INTEGER NOT NULL,
         created_at       INTEGER NOT NULL,
         ephemeral        INTEGER NOT NULL DEFAULT 0
       )`,
    );
    // Defensive migration: a DB created before this column existed (a deployed
    // ROOM_DB_PATH file) won't get it from CREATE TABLE IF NOT EXISTS. Add it
    // with a default so existing rows read back as non-ephemeral.
    const cols = this.db.query(`PRAGMA table_info(rooms)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "ephemeral")) {
      this.db.run(`ALTER TABLE rooms ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0`);
    }
  }
```

Update `insert`:

```ts
  insert(rec: RoomRecord): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO rooms (id, mode, expires_at, backfill_enabled, created_at, ephemeral)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.mode,
        rec.expiresAt,
        rec.backfillEnabled ? 1 : 0,
        rec.createdAt,
        rec.ephemeral ? 1 : 0,
      );
  }
```

Update `get`'s return mapping (add the last field):

```ts
    return {
      id: row.id,
      mode: row.mode as RoomMode,
      expiresAt: row.expires_at,
      backfillEnabled: row.backfill_enabled === 1,
      createdAt: row.created_at,
      ephemeral: row.ephemeral === 1,
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/relay test room-db`
Expected: PASS (both new cases green).

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/room-db.ts apps/relay/src/room-db.test.ts
git commit -m "feat(relay): persist ephemeral flag in RoomDb with migration"
```

---

## Task 3: Relay — `Room.ephemeral` + `create()` + rehydrate

**Files:**
- Modify: `apps/relay/src/rooms.ts:19-32,63-88,121-145`
- Test: `apps/relay/src/rooms.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/relay/src/rooms.test.ts` inside `describe("RoomStore", …)`:

```ts
  it("create with ephemeral stores it and forces backfill off", () => {
    const s = new RoomStore();
    const r = s.create("A", true, true); // backfill requested true, but ephemeral
    expect(r.ephemeral).toBe(true);
    expect(r.backfillEnabled).toBe(false);
  });

  it("non-ephemeral Mode-A room keeps backfill (regression)", () => {
    const s = new RoomStore();
    const r = s.create("A", true, false);
    expect(r.ephemeral).toBe(false);
    expect(r.backfillEnabled).toBe(true);
  });

  it("rehydrates ephemeral from the DB on a Map miss", () => {
    const db = new Database(":memory:");
    const s1 = new RoomStore({ db });
    const r = s1.create("A", false, true);
    const s2 = new RoomStore({ db }); // fresh cache, same DB → forces a rehydrate
    const got = s2.get(r.id);
    expect(got?.ephemeral).toBe(true);
  });
```

(The `Database` import already exists at the top of `rooms.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/relay test rooms`
Expected: FAIL — `create` takes only `(mode, backfill)`, `Room` has no `ephemeral`, and `get()` does not rehydrate it.

- [ ] **Step 3: Implement**

In `apps/relay/src/rooms.ts`:

Add to the `Room` interface (after `tombstones`):

```ts
  // Ephemeral rooms: no device persists history; items auto-expire client-side.
  // Stored as metadata only — the relay never sees plaintext regardless.
  ephemeral: boolean;
```

Replace `create`:

```ts
  create(mode: RoomMode, backfill = true, ephemeral = false): Room {
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
      tombstones: [],
      // Mode B can be decrypted by the relay, so it never buffers regardless of
      // the requested flag. Ephemeral rooms buffer nothing either — they retain
      // no history anywhere, so backfill is forced off.
      backfillEnabled: mode === "A" && backfill && !ephemeral,
      ephemeral,
    };
    this.rooms.set(id, room);
    this.roomDb.insert({
      id,
      mode,
      expiresAt: now + this.maxAgeMs,
      backfillEnabled: room.backfillEnabled,
      createdAt: now,
      ephemeral,
    });
    return room;
  }
```

In `get()`, add `ephemeral` to the rehydrated room object (after `backfillEnabled: rec.backfillEnabled,`):

```ts
      backfillEnabled: rec.backfillEnabled,
      ephemeral: rec.ephemeral,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/relay test rooms`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/rooms.ts apps/relay/src/rooms.test.ts
git commit -m "feat(relay): RoomStore ephemeral flag, forces backfill off"
```

---

## Task 4: Relay — accept `ephemeral` on create, echo it in hello

**Files:**
- Modify: `apps/relay/src/app.ts:16-20,47`
- Modify: `apps/relay/src/ws-handlers.ts:35-41`
- Test: `apps/relay/src/app.test.ts` (add a case) and `apps/relay/src/ws-handlers.test.ts` or the integration test that asserts the hello frame (see Step 1).

- [ ] **Step 1: Write the failing test**

Find the relay test that POSTs `/api/room` and/or asserts the `hello` frame. Add an assertion that an ephemeral room is created and the hello carries `ephemeral: true`. If there is an integration test that opens a WS and reads the first `hello` (search: `rg -n "type.*hello|/api/room" apps/relay/src/*.test.ts`), add a case there. A minimal app-level test:

```ts
  it("POST /api/room with ephemeral:true creates an ephemeral room", async () => {
    // Build the app with a real store (mirror the existing app.test setup).
    const store = new RoomStore();
    const app = buildApp({ roomCount: () => store.count, store });
    const res = await app.request("/api/room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "A", ephemeral: true }),
    });
    const body = (await res.json()) as { roomId: string };
    expect(store.get(body.roomId)?.ephemeral).toBe(true);
    expect(store.get(body.roomId)?.backfillEnabled).toBe(false);
  });
```

Match the existing `app.test.ts` import/setup style (it already constructs `buildApp` and a `RoomStore`; cast `res.json()` per the bun-types convention).

For the hello echo, add to the WS integration test (the one that boots `Bun.serve` and reads `hello`):

```ts
    // a room created ephemeral must report ephemeral:true in its hello
    expect(hello).toMatchObject({ type: "hello", ephemeral: true });
```

(Create the ephemeral room in that test's setup via `store.create("A", false, true)` or the POST, matching how the test currently makes its room.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/relay test`
Expected: FAIL — `CreateRoomBody` rejects/ignores `ephemeral`, `create` is called with 2 args, and the hello frame lacks `ephemeral`.

- [ ] **Step 3: Implement**

In `apps/relay/src/app.ts`, extend the body schema and the create call:

```ts
const CreateRoomBody = z.object({
  mode: z.enum(["A", "B"]),
  // Whether late joiners get recent clips. Defaults on; forced off for Mode B.
  backfill: z.boolean().optional(),
  // Ephemeral rooms persist nothing on any device and auto-expire items.
  ephemeral: z.boolean().optional(),
});
```

```ts
    const room = deps.store.create(
      parsed.data.mode,
      parsed.data.backfill ?? true,
      parsed.data.ephemeral ?? false,
    );
```

In `apps/relay/src/ws-handlers.ts`, add `ephemeral` to the hello send:

```ts
          send(raw, {
            type: "hello",
            roomId,
            peerCount: room.sockets.size,
            serverTime: Date.now(),
            backfill: room.backfillEnabled,
            ephemeral: room.ephemeral,
          });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/relay test`
Expected: PASS (whole relay suite green).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @uniclip/relay typecheck
git add apps/relay/src/app.ts apps/relay/src/ws-handlers.ts apps/relay/src/app.test.ts apps/relay/src/*.test.ts
git commit -m "feat(relay): accept ephemeral on create, echo it in hello"
```

---

## Task 5: Client-core — `room` event carries `{ backfill, ephemeral }`

**Files:**
- Modify: `packages/client-core/src/client.ts:10-27,62-75,119-123`
- Modify (consumer, keep typecheck green): `apps/web/src/routes/room.svelte:47`
- Test: `packages/client-core/src/client.test.ts:160-171` (update) + new case

- [ ] **Step 1: Update + add the failing test**

In `packages/client-core/src/client.test.ts`, replace the existing `"emits 'room' with the backfill flag from hello"` test and add an ephemeral case:

```ts
  it("emits 'room' with backfill + ephemeral from hello", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    let info: { backfill: boolean; ephemeral: boolean } | null = null;
    client.on("room", (i: { backfill: boolean; ephemeral: boolean }) => (info = i));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: true, ephemeral: true });
    expect(info).toEqual({ backfill: true, ephemeral: true });
  });
```

Also: this task does **not** require editing the other hello emits in this file — `ephemeral` is optional-with-default in the schema, so existing `ws.emit({ … backfill: false })` calls still parse (defaulting `ephemeral` to false).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/client-core test`
Expected: FAIL — the `room` handler is typed `(backfill: boolean)`, so `info` is a boolean, not `{ backfill, ephemeral }`.

- [ ] **Step 3: Implement**

In `packages/client-core/src/client.ts`:

Change the `ClientEvent` `room` variant:

```ts
  | { kind: "room"; backfill: boolean; ephemeral: boolean }
```

Change the `EventHandlers` `room` signature:

```ts
  room: (info: { backfill: boolean; ephemeral: boolean }) => void;
```

Change the `emit` switch `room` case:

```ts
        case "room": (cb as EventHandlers["room"])({ backfill: evt.backfill, ephemeral: evt.ephemeral }); break;
```

Change the `hello` case in `handleFrame`:

```ts
      case "hello":
        this.emit({ kind: "status", value: "connected" });
        this.emit({ kind: "peer", count: frame.peerCount });
        this.emit({ kind: "room", backfill: frame.backfill, ephemeral: frame.ephemeral });
        return;
```

- [ ] **Step 4: Keep the web consumer compiling**

In `apps/web/src/routes/room.svelte`, update the `room` handler (full ephemeral wiring lands in Task 8 — here just adapt to the new shape so `svelte-check` stays green):

```ts
    c.on("room", (info) => (backfillOn = info.backfill));
```

- [ ] **Step 5: Run tests + typecheck to verify pass**

Run: `pnpm --filter @uniclip/client-core test && pnpm --filter @uniclip/client-core typecheck && pnpm --filter @uniclip/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/client-core/src/client.ts packages/client-core/src/client.test.ts apps/web/src/routes/room.svelte
git commit -m "feat(client-core): room event carries ephemeral alongside backfill"
```

---

## Task 6: Web — `ItemStore` interface, `EphemeralStore`, `ExpiryScheduler`

**Files:**
- Modify: `apps/web/src/lib/persist.ts:3-26`
- Create: `apps/web/src/lib/ephemeral.ts`
- Test: `apps/web/src/lib/persist.test.ts` (add a case), `apps/web/src/lib/ephemeral.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/lib/persist.test.ts` (the `localStorage` stub in `beforeEach` already exists):

```ts
  it("EphemeralStore never touches localStorage", async () => {
    const { EphemeralStore } = await import("./persist");
    let writes = 0;
    const real = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = (...a: [string, string]) => { writes++; return real(...a); };
    const s = new EphemeralStore();
    await s.add({ id: "1", text: "secret", ts: 1 });
    await s.remove("1");
    s.clear();
    expect(await s.load()).toEqual([]);
    expect(writes).toBe(0);
  });
```

Create `apps/web/src/lib/ephemeral.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EPHEMERAL_TTL_MS, ExpiryScheduler } from "./ephemeral";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ExpiryScheduler", () => {
  it("fires onExpire after EPHEMERAL_TTL_MS", () => {
    const expired: string[] = [];
    const s = new ExpiryScheduler(EPHEMERAL_TTL_MS, (id) => expired.push(id));
    s.schedule("a");
    vi.advanceTimersByTime(EPHEMERAL_TTL_MS - 1);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual(["a"]);
  });

  it("is idempotent per msgId (one timer per id)", () => {
    const expired: string[] = [];
    const s = new ExpiryScheduler(1000, (id) => expired.push(id));
    s.schedule("a");
    s.schedule("a");
    vi.advanceTimersByTime(1000);
    expect(expired).toEqual(["a"]);
  });

  it("cancel() and clear() stop pending timers", () => {
    const expired: string[] = [];
    const s = new ExpiryScheduler(1000, (id) => expired.push(id));
    s.schedule("a");
    s.schedule("b");
    s.cancel("a");
    s.clear();
    vi.advanceTimersByTime(2000);
    expect(expired).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uniclip/web test persist ephemeral`
Expected: FAIL — `EphemeralStore` and `./ephemeral` do not exist.

- [ ] **Step 3: Implement the interface + EphemeralStore**

In `apps/web/src/lib/persist.ts`, add the interface above `PersistedItems` and make `PersistedItems implements ItemStore`, then add `EphemeralStore` at the end of the file:

```ts
/** Storage contract shared by the persisting and ephemeral implementations. */
export interface ItemStore {
  load(): Promise<Item[]>;
  add(item: Item): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): void;
}
```

```ts
export class PersistedItems implements ItemStore {
```

```ts
/**
 * No-op store for ephemeral rooms: items live only in the in-memory `items`
 * list (held by room.svelte), so nothing is ever written to localStorage.
 */
export class EphemeralStore implements ItemStore {
  async load(): Promise<Item[]> {
    return [];
  }
  async add(_item: Item): Promise<void> {
    /* intentionally not persisted */
  }
  async remove(_id: string): Promise<void> {
    /* intentionally not persisted */
  }
  clear(): void {
    /* nothing to clear */
  }
}
```

- [ ] **Step 4: Implement `lib/ephemeral.ts`**

Create `apps/web/src/lib/ephemeral.ts`:

```ts
/** How long an item stays on screen in an ephemeral room before auto-removal. */
export const EPHEMERAL_TTL_MS = 60_000;

/**
 * Schedules per-item expiry for ephemeral rooms. One timer per msgId; firing it
 * invokes `onExpire(msgId)`. Timers are reaped via cancel()/clear() (e.g. on
 * component destroy) so a stale timer can't fire after navigation.
 */
export class ExpiryScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ttlMs: number,
    private readonly onExpire: (msgId: string) => void,
  ) {}

  schedule(msgId: string): void {
    if (this.timers.has(msgId)) return;
    const t = setTimeout(() => {
      this.timers.delete(msgId);
      this.onExpire(msgId);
    }, this.ttlMs);
    this.timers.set(msgId, t);
  }

  cancel(msgId: string): void {
    const t = this.timers.get(msgId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(msgId);
    }
  }

  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
```

- [ ] **Step 5: Run tests + typecheck to verify pass**

Run: `pnpm --filter @uniclip/web test persist ephemeral && pnpm --filter @uniclip/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/persist.ts apps/web/src/lib/ephemeral.ts apps/web/src/lib/persist.test.ts apps/web/src/lib/ephemeral.test.ts
git commit -m "feat(web): ItemStore interface, EphemeralStore, ExpiryScheduler"
```

---

## Task 7: Web — ephemeral creation toggle on the landing page

**Files:**
- Modify: `apps/web/src/routes/landing.svelte:10-22,131-143`

> No unit test: `landing.svelte` is a presentational route with no extracted logic. The toggle's effect (an ephemeral room with no persistence) is covered by the Task 11 e2e. Verify via build + typecheck + the e2e.

- [ ] **Step 1: Add the state and include it in the POST body**

In the `<script>` of `apps/web/src/routes/landing.svelte`, add state after `let backfill`:

```ts
  let ephemeral = $state(false);
```

Update the POST body in `startRoom()` (ephemeral applies to both modes; backfill is meaningless when ephemeral, so send false then):

```ts
        body: JSON.stringify({
          mode,
          backfill: mode === "A" && !ephemeral ? backfill : false,
          ephemeral,
        }),
```

- [ ] **Step 2: Add the toggle UI**

Replace the `{#if mode === "A"} … {/if}` backfill block (lines ~131-143) with a block that disables backfill when ephemeral and adds the ephemeral toggle below it:

```svelte
      {#if mode === "A"}
        <label class="mt-3 flex cursor-pointer items-start gap-2.5 rounded-field border border-border bg-surface-2 p-3 text-sm {ephemeral ? 'opacity-50' : ''}">
          <input
            type="checkbox"
            bind:checked={backfill}
            disabled={ephemeral}
            class="mt-0.5 h-4 w-4 accent-[var(--accent)]"
          />
          <span>
            <span class="font-medium text-text">Share recent items with late joiners</span>
            <span class="mt-0.5 block text-xs text-muted">Devices that join later receive the recent clips, while at least one device stays connected.</span>
          </span>
        </label>
      {/if}

      <label class="mt-2 flex cursor-pointer items-start gap-2.5 rounded-field border border-border bg-surface-2 p-3 text-sm">
        <input
          type="checkbox"
          bind:checked={ephemeral}
          class="mt-0.5 h-4 w-4 accent-[var(--accent)]"
        />
        <span>
          <span class="font-medium text-text">Ephemeral — don't save anything</span>
          <span class="mt-0.5 block text-xs text-muted">Nothing is written to disk on any device, and items vanish 60s after they arrive. Good for passwords and one-time codes.</span>
        </span>
      </label>
```

- [ ] **Step 3: Verify it builds and typechecks**

Run: `pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web build`
Expected: PASS (svelte-check 0 errors, build succeeds).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/landing.svelte
git commit -m "feat(web): ephemeral room creation toggle"
```

---

## Task 8: Web — room.svelte ephemeral behavior + header badge

**Files:**
- Modify: `apps/web/src/routes/room.svelte:1-79,131-140`
- Modify: `apps/web/src/components/header.svelte:7-23,44-47`

> No unit test (Svelte route wiring; logic lives in the already-tested `EphemeralStore`/`ExpiryScheduler`). Covered by the Task 11 e2e + typecheck/build.

- [ ] **Step 1: Import the new pieces and add ephemeral state**

In `apps/web/src/routes/room.svelte` `<script>`, update imports and state:

```ts
  import { PersistedItems, EphemeralStore, type Item, type ItemStore } from "../lib/persist";
  import { EPHEMERAL_TTL_MS, ExpiryScheduler } from "../lib/ephemeral";
```

Change the `persist` field type and add ephemeral state + the scheduler:

```ts
  let ephemeralOn = $state(false);
  let persist: ItemStore | null = null;
  let expiry: ExpiryScheduler | null = null;
```

(Change the old `let persist: PersistedItems | null = null;` line to the `ItemStore` type above, and add the two new lines.)

- [ ] **Step 2: Swap to the ephemeral store on the first hello**

Keep the existing load-before-connect ordering: `onMount` still constructs a `PersistedItems` and loads history *before* connecting (so a normal room behaves exactly as today, with no race against incoming clips). Only the `room` handler changes — when the first hello reports `ephemeral`, swap `persist` to an `EphemeralStore`, wire the expiry scheduler, and clear the (empty) loaded list. The `ephemeralOn` guard makes a reconnect's repeat hello a no-op.

The top of `onMount` keeps its current shape:

```ts
  onMount(async () => {
    const key = await deriveRoomKey(room);
    // Default to persisting; an ephemeral room swaps this out on its first hello.
    persist = new PersistedItems({ roomId: room.routingId, key, cap: 50 });
    items = await persist.load();

    const c = new UniclipClient({ roomUrl, relayBase });
    client = c;
    c.on("status", (s) => (status = s));
    c.on("peer", (n) => (peerCount = n));
```

Replace the `room` handler (from Task 5's `c.on("room", (info) => (backfillOn = info.backfill));`) with:

```ts
    c.on("room", (info) => {
      backfillOn = info.backfill;
      if (info.ephemeral && !ephemeralOn) {
        // Switch to no-persist + TTL. A room created ephemeral has no prior
        // persisted history, so resetting items is just belt-and-suspenders.
        ephemeralOn = true;
        persist = new EphemeralStore();
        expiry = new ExpiryScheduler(EPHEMERAL_TTL_MS, (msgId) => {
          items = items.filter((i) => i.id !== msgId);
        });
        items = [];
      }
    });
```

Update the `delete` handler to also cancel a pending expiry timer:

```ts
    c.on("delete", async (msgId) => {
      items = items.filter((i) => i.id !== msgId);
      expiry?.cancel(msgId);
      await persist?.remove(msgId);
    });
```

(The `clip`, `error`, `await c.connect()`, and `watcher.on(...)` parts of `onMount` are unchanged in this step.)

- [ ] **Step 3: Schedule expiry on delivery**

Replace `addItem`:

```ts
  async function addItem(text: string, ts: number, msgId: string, mine: boolean) {
    if (items.some((i) => i.id === msgId)) return;
    const item: Item = { id: msgId, text, ts, mine };
    items = [...items, item].slice(-50);
    await persist?.add(item);
    // Ephemeral: each delivered item starts its TTL now (delivery time).
    if (ephemeralOn) expiry?.schedule(msgId);
  }
```

Update `onDelete` and `clearHistory` to cancel timers:

```ts
  async function onDelete(id: string) {
    items = items.filter((i) => i.id !== id);
    expiry?.cancel(id);
    await persist?.remove(id);
    client?.delete(id);
  }

  function clearHistory() {
    items = [];
    expiry?.clear();
    persist?.clear();
    toast("History cleared", "info", 1200);
  }
```

Update `onDestroy` to reap timers:

```ts
  onDestroy(() => {
    watcher.stop();
    expiry?.clear();
    client?.disconnect();
  });
```

- [ ] **Step 4: Pass the badge flag to Header**

In the `<Header … />` usage, add the prop:

```svelte
  <Header
    roomId={room.routingId}
    mode={room.mode}
    {peerCount}
    {status}
    ephemeral={ephemeralOn}
    onShare={() => (showShare = true)}
    onClear={clearHistory}
    onEnd={endRoom}
  />
```

- [ ] **Step 5: Render the badge in Header**

In `apps/web/src/components/header.svelte`, add `ephemeral` to the props type and a default:

```ts
  let {
    roomId,
    mode,
    peerCount,
    status,
    ephemeral = false,
    onShare,
    onClear,
    onEnd,
  }: {
    roomId: string;
    mode: "A" | "B";
    peerCount: number;
    status: "connecting" | "connected" | "reconnecting" | "disconnected";
    ephemeral?: boolean;
    onShare: () => void;
    onClear: () => void;
    onEnd: () => void;
  } = $props();
```

Add the badge right after the room-code `<span>` (after line ~47):

```svelte
    {#if ephemeral}
      <span
        class="inline-flex items-center gap-1 rounded-field border border-warn/40 bg-warn-soft px-2 py-1 text-[11px] font-semibold text-warn"
        title="Nothing is saved on any device; items vanish after 60s"
      >
        <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true">
          <path d="M7 4h10M7 20h10M8 4c0 5 8 5 8 0M8 20c0-5 8-5 8 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Ephemeral · not saved
      </span>
    {/if}
```

- [ ] **Step 6: Verify build + typecheck**

Run: `pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/room.svelte apps/web/src/components/header.svelte
git commit -m "feat(web): ephemeral room behavior (no-persist + 60s TTL) and badge"
```

---

## Task 9: Client-core — offline send queue

**Files:**
- Modify: `packages/client-core/src/client.ts:10-27,40-44,108-123,166-187`
- Test: `packages/client-core/src/client.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/client-core/src/client.test.ts` inside `describe("UniclipClient", …)`:

```ts
  it("send() while the socket is not OPEN enqueues and returns queued:true", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.readyState = MockWebSocket.CLOSED; // offline, without triggering reconnect
    const res = await client.send("queued while offline");
    expect(res.queued).toBe(true);
    expect(ws.sent).toHaveLength(0);
  });

  it("flushes queued frames in order on the next hello, emitting 'sent'", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.readyState = MockWebSocket.CLOSED;
    const a = await client.send("one");
    const b = await client.send("two");
    expect(ws.sent).toHaveLength(0);

    const sentIds: string[] = [];
    client.on("sent", (id: string) => sentIds.push(id));
    ws.readyState = MockWebSocket.OPEN; // socket back
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });

    expect(ws.sent).toHaveLength(2);
    expect(JSON.parse(ws.sent[0]!).msgId).toBe(a.msgId);
    expect(JSON.parse(ws.sent[1]!).msgId).toBe(b.msgId);
    expect(JSON.parse(ws.sent[0]!).ts).toBe(a.ts); // ts frozen at composition
    expect(sentIds).toEqual([a.msgId, b.msgId]);
  });

  it("bounds the queue to MAX_QUEUE (drops oldest, emits QUEUE_FULL)", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
    });
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.readyState = MockWebSocket.CLOSED;

    let queueFull = 0;
    client.on("error", (e: { code: string }) => { if (e.code === "QUEUE_FULL") queueFull++; });

    const first = await client.send("oldest");
    for (let i = 0; i < 100; i++) await client.send(`m${i}`); // 101 enqueued, one overflow

    expect(queueFull).toBe(1);
    ws.readyState = MockWebSocket.OPEN;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });

    expect(ws.sent).toHaveLength(100); // capped at MAX_QUEUE
    expect(ws.sent.some((s) => JSON.parse(s).msgId === first.msgId)).toBe(false); // oldest dropped
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @uniclip/client-core test`
Expected: FAIL — `send()` throws `"not connected"` when the socket isn't OPEN; there is no `queued`, no `sent` event, and no queue bound.

- [ ] **Step 3: Implement the queue**

In `packages/client-core/src/client.ts`:

Add a module-level constant near the top (after imports):

```ts
const MAX_QUEUE = 100;
```

Add to the `ClientEvent` union:

```ts
  | { kind: "sent"; msgId: string }
```

Add to `EventHandlers`:

```ts
  sent: (msgId: string) => void;
```

Add the `sent` case to the `emit` switch:

```ts
        case "sent": (cb as EventHandlers["sent"])(evt.msgId); break;
```

Add a queue field to the class (near `private replay = …`):

```ts
  private queue: string[] = [];
```

In `handleFrame`, call `flushQueue()` from the `hello` case (after the existing emits):

```ts
      case "hello":
        this.emit({ kind: "status", value: "connected" });
        this.emit({ kind: "peer", count: frame.peerCount });
        this.emit({ kind: "room", backfill: frame.backfill, ephemeral: frame.ephemeral });
        this.flushQueue();
        return;
```

Add the `flushQueue` method (e.g. just below `handleClose`):

```ts
  private flushQueue(): void {
    while (this.queue.length > 0) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return; // remainder stays queued
      const payload = this.queue.shift()!;
      this.ws.send(payload);
      const { msgId } = JSON.parse(payload) as ClientFrame;
      this.emit({ kind: "sent", msgId });
    }
  }
```

Replace `send`:

```ts
  async send(text: string): Promise<{ msgId: string; ts: number; queued: boolean }> {
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
    const payload = JSON.stringify(frame);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return { msgId, ts, queued: false };
    }
    // Offline: queue for flush on the next hello. ts is frozen at composition.
    this.queue.push(payload);
    if (this.queue.length > MAX_QUEUE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE);
      this.emit({
        kind: "error",
        code: "QUEUE_FULL",
        message: "offline queue full — oldest unsent items dropped",
      });
    }
    return { msgId, ts, queued: true };
  }
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `pnpm --filter @uniclip/client-core test && pnpm --filter @uniclip/client-core typecheck`
Expected: PASS (including the pre-existing `send() returns the minted msgId and ts` test — `send` still returns `msgId`/`ts`, now plus `queued`).

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/client.ts packages/client-core/src/client.test.ts
git commit -m "feat(client-core): in-memory offline send queue with flush-on-hello"
```

---

## Task 10: Web — pending item state wired to the queue

**Files:**
- Modify: `apps/web/src/lib/persist.ts:3-9` (Item type)
- Modify: `apps/web/src/routes/room.svelte` (addItem signature, send paths, `sent` listener)
- Modify: `apps/web/src/components/item-row.svelte:1-14,34-68`

> No unit test (Svelte wiring); covered by the Task 11 offline-queue e2e + typecheck/build.

- [ ] **Step 1: Add `pending` to the Item type**

In `apps/web/src/lib/persist.ts`:

```ts
export interface Item {
  id: string;
  text: string;
  ts: number;
  /** True when this device sent the item; false/undefined when received. */
  mine?: boolean;
  /** True while a sent item is still queued (offline) and not yet delivered. */
  pending?: boolean;
}
```

- [ ] **Step 2: Thread `queued` through addItem and the send paths; add the `sent` listener**

In `apps/web/src/routes/room.svelte`:

Update `addItem` to accept `queued` and apply the delivery-time TTL rule (do **not** schedule expiry for a still-pending item):

```ts
  async function addItem(text: string, ts: number, msgId: string, mine: boolean, queued = false) {
    if (items.some((i) => i.id === msgId)) return;
    const item: Item = { id: msgId, text, ts, mine, pending: queued };
    items = [...items, item].slice(-50);
    await persist?.add(item);
    // Ephemeral TTL starts at DELIVERY. A queued item is not delivered yet, so
    // its timer is scheduled later in the `sent` handler, not here.
    if (ephemeralOn && !queued) expiry?.schedule(msgId);
  }
```

Update the two own-send paths to pass `queued`:

`sendText`:

```ts
  async function sendText(text: string) {
    try {
      if (!client) return;
      const { msgId, ts, queued } = await client.send(text);
      await addItem(text, ts, msgId, true, queued);
    } catch {
      toast("Send failed", "warn");
    }
  }
```

The `watcher.on` handler inside `onMount`:

```ts
    watcher.on(async (text) => {
      try {
        const { msgId, ts, queued } = await c.send(text);
        await addItem(text, ts, msgId, true, queued);
      } catch {}
    });
```

Add a `sent` listener in `onMount` (alongside the other `c.on(...)` registrations). When a queued frame is finally delivered, clear pending and — if ephemeral — start its TTL now:

```ts
    c.on("sent", (msgId) => {
      items = items.map((i) => (i.id === msgId ? { ...i, pending: false } : i));
      if (ephemeralOn) expiry?.schedule(msgId);
    });
```

- [ ] **Step 3: Render the pending appearance in item-row**

In `apps/web/src/components/item-row.svelte`, the component already receives the full `item` (which now carries `pending`). Add a dimmed style + a small clock badge while pending.

On the clip button element, add `pending` dimming to the class expression (append inside the existing `class="…"`):

```svelte
    class="relative min-w-0 max-w-[88%] flex-1 overflow-hidden rounded-card border px-3.5 py-2.5 text-left transition
      {item.pending ? 'opacity-60' : ''}
      {mine
      ? 'border-accent/30 bg-accent-soft'
      : 'border-border bg-surface hover:border-border-strong'}"
```

In the metadata row (after the `{mine ? "You" : "Peer"}` span and the `· {ago…}` span), add a pending marker:

```svelte
      {#if item.pending}
        <span class="inline-flex items-center gap-1 text-warn" title="Queued — will send when reconnected">
          <svg viewBox="0 0 24 24" fill="none" class="h-3 w-3" aria-hidden="true">
            <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8" />
            <path d="M12 8v4l2.5 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Queued
        </span>
      {/if}
```

- [ ] **Step 4: Verify build + typecheck**

Run: `pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/persist.ts apps/web/src/routes/room.svelte apps/web/src/components/item-row.svelte
git commit -m "feat(web): pending item state for queued offline sends"
```

---

## Task 11: E2E — ephemeral no-persist + offline queue

**Files:**
- Create: `e2e/tests/ephemeral.spec.ts`
- Create: `e2e/tests/offline-queue.spec.ts`

- [ ] **Step 1: Write the ephemeral e2e**

Create `e2e/tests/ephemeral.spec.ts` (models the `backfill.spec.ts` flow; asserts no-persist via reload — no 60s wait):

```ts
import { test, expect, chromium } from "@playwright/test";

test("ephemeral room: peers sync live, nothing persists on reload", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();

  // A creates a Mode-A room with the Ephemeral toggle ON.
  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByText(/Ephemeral — don't save anything/i).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();

  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  // The ephemeral badge confirms hello carried the flag.
  await expect(pageA.getByText(/Ephemeral · not saved/i)).toBeVisible({ timeout: 5_000 });

  // A sends a clip; B joins and receives it live.
  await pageA.getByRole("textbox").fill("ephemeral secret");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageA.getByText("ephemeral secret")).toBeVisible({ timeout: 5_000 });

  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageB = await ctxB.newPage();
  await pageB.goto(roomUrl);
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("ephemeral secret")).toBeVisible({ timeout: 5_000 });

  // Reload B: an ephemeral room persists nothing, so its history is empty.
  // (Backfill is forced off for ephemeral rooms, so the relay replays nothing
  // either.) We assert the clip is gone after reload — no 60s TTL wait needed.
  await pageB.reload();
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("ephemeral secret")).toHaveCount(0);

  await browser.close();
});
```

- [ ] **Step 2: Write the offline-queue e2e**

Create `e2e/tests/offline-queue.spec.ts`. Drop A's WebSocket via Playwright route interception, type while offline (asserting the Queued marker), then restore and assert delivery to B:

```ts
import { test, expect, chromium } from "@playwright/test";

test("offline send queues, shows pending, and flushes on reconnect", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();

  // A creates a normal (non-ephemeral) Mode-A room.
  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();
  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // B joins so it can receive the flushed clip later.
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageB = await ctxB.newPage();
  await pageB.goto(roomUrl);
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // Force A offline by closing its WebSocket from the page context and blocking
  // reconnect attempts. We toggle a flag the page can't see; simplest is to make
  // the browser drop the socket: evaluate a close on the active WS is unreliable,
  // so instead we go offline via the context.
  await ctxA.setOffline(true);
  await expect(pageA.getByText(/reconnecting|disconnected/i)).toBeVisible({ timeout: 10_000 });

  // Type while offline → optimistic item with a Queued marker, nothing delivered.
  await pageA.getByRole("textbox").fill("sent while offline");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageA.getByText("sent while offline")).toBeVisible({ timeout: 5_000 });
  await expect(pageA.getByText(/Queued/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("sent while offline")).toHaveCount(0);

  // Back online → client reconnects, flushes the queue on hello.
  await ctxA.setOffline(false);
  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 15_000 });

  // The queued clip is delivered: A's marker clears and B receives it.
  await expect(pageA.getByText(/Queued/i)).toHaveCount(0, { timeout: 10_000 });
  await expect(pageB.getByText("sent while offline")).toBeVisible({ timeout: 10_000 });

  await browser.close();
});
```

> If `ctxA.setOffline(true)` does not sever the already-open WebSocket in your Playwright/Chromium version, fall back to route-blocking the WS upgrade before it reconnects: `await ctxA.route("**/ws/**", (r) => r.abort());` and trigger a close by evaluating `window` socket teardown. Prefer `setOffline` first — it is the simplest reliable lever and exercises the real reconnect/backoff path.

- [ ] **Step 3: Run the e2e suite**

Run: `pnpm test:e2e`
Expected: PASS — both new specs plus the existing ones. (E2E boots the relay + web dev servers itself.)

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/ephemeral.spec.ts e2e/tests/offline-queue.spec.ts
git commit -m "test(e2e): ephemeral no-persist + offline send queue"
```

---

## Final verification

- [ ] **Run the whole unit suite + typecheck across the workspace**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (all packages; `pnpm test` excludes e2e by design).

- [ ] **Run e2e once more**

Run: `pnpm test:e2e`
Expected: PASS.

- [ ] **Hand off** via superpowers:finishing-a-development-branch.

---

## Notes for the implementer

- **Relay tests run under Bun** (`bun --bun vitest`), need Bun ≥ 1.3, and must cast `res.json()` (`(await res.json()) as {...}`) because `@types/bun` types it as `unknown`. Don't reassign `raw.data` in `ws-handlers.ts` — only mutate `raw.data.roomId`.
- **`ephemeral` is optional-with-default in the protocol** precisely so that adding it does not turn existing client-core/relay hello fixtures red. You should not need to touch hello emits that omit it.
- **Packages are consumed as TS source** — no build step before test. Ignore stale "cannot find module" IDE warnings right after creating `lib/ephemeral.ts`; trust the vitest/svelte-check exit codes.
- **The store is built in the `room` event, not `onMount`**, because the ephemeral flag arrives with `hello`. The guard `if (persist) return;` makes a reconnect's repeat hello a no-op for store construction.
- **Delivery-time TTL is the one cross-feature correctness point** (Task 10 Step 2): never schedule expiry for a `queued` item at add — only on `sent`.
