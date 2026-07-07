# Custom Typed Code (Mode B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user choose their own memorable Mode-B room code at creation, with guardrails: a frozen canonicalize/validate/strength contract in `room-code`, a collision **409** on create (killing the silent `INSERT OR REPLACE` hijack), a per-IP **WS-connect rate-limit** (429), and a landing-page custom-code input with a live strength meter + "this code is your key" warning.

**Architecture:** Because Mode B derives the AES key directly from the routingId (`deriveRoomKey`), the custom code **is** the key — so `canonicalizeCode` must be byte-identical client and server (frozen + unit-tested). New pure helpers live in `packages/room-code`; the relay enforces validation + collision + connect-throttle; the web UI surfaces the tradeoff. Key derivation is unchanged.

**Tech Stack:** TypeScript `room-code` (node vitest), Bun + Hono relay (`bun --bun vitest`, cast `res.json()`), Svelte 5 + Tailwind 4 web.

## Global Constraints

- **The canonical code is the only client/server coupling** — `canonicalizeCode(raw) = raw.trim().toUpperCase()`. It is both the stored routingId and the PBKDF2 secret; changing it changes derived keys. Freeze it with tests asserting exact outputs.
- **Validation:** `isValidCustomCode` on the canonical form — charset `^[A-Z0-9-]+$`, length **4–64**, not solely hyphens.
- **Strength:** `estimateCodeBits(canonical): number`; `strengthBand(bits): "very-weak" | "weak" | "ok"` with bands `<28` / `28–47` / `≥48`.
- **Collision → 409, never overwrite.** `RoomStore.create` must reject a custom id that already exists (in memory OR DB) with a `RoomConflictError` → relay `409 { error: "code_taken" }`.
- **Mode A ignores `customCode`.** Only `mode === "B"` honors it.
- **WS-connect limit:** `WS_CONNECT_IP_LIMIT` (default `30` per `10_000` ms), per-IP sliding window, checked before the room lookup; over-limit closes `CLOSE_CODES.RATE_LIMIT` (4429).
- **No change to key derivation, Mode A, or the random `generateModeBCode()` default.** No shipped wordlist.
- **Relay tests** run under Bun; cast `res.json()`. **Gates:** `pnpm --filter @uniclip/room-code test`; `pnpm --filter @uniclip/relay test` + `typecheck`; `pnpm --filter @uniclip/web typecheck` + `build`.

---

### Task 1: `room-code` custom-code contract

**Files:**
- Create: `packages/room-code/src/custom-code.ts`
- Create: `packages/room-code/src/custom-code.test.ts`
- Modify: `packages/room-code/src/index.ts` (export)

**Interfaces:**
- Produces: `canonicalizeCode(raw: string): string`, `isValidCustomCode(raw: string): boolean`, `estimateCodeBits(canonical: string): number`, `strengthBand(bits: number): "very-weak"|"weak"|"ok"`, consts `CUSTOM_CODE_MIN = 4`, `CUSTOM_CODE_MAX = 64`. Consumed by Tasks 2 & 4.

- [ ] **Step 1: Write the failing test**

Create `packages/room-code/src/custom-code.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  canonicalizeCode, isValidCustomCode, estimateCodeBits, strengthBand,
} from "./custom-code";

describe("canonicalizeCode", () => {
  it("trims and uppercases; is idempotent", () => {
    expect(canonicalizeCode("  tiger ")).toBe("TIGER");
    expect(canonicalizeCode("PIZZA-42")).toBe("PIZZA-42");
    const once = canonicalizeCode(" Cobalt-7 ");
    expect(canonicalizeCode(once)).toBe(once);
  });
});

describe("isValidCustomCode", () => {
  it("enforces charset and 4–64 length", () => {
    expect(isValidCustomCode("abc")).toBe(false);      // too short (3)
    expect(isValidCustomCode("abcd")).toBe(true);       // 4, canonicalized
    expect(isValidCustomCode("PIZZA-42")).toBe(true);
    expect(isValidCustomCode("A".repeat(64))).toBe(true);
    expect(isValidCustomCode("A".repeat(65))).toBe(false);
    expect(isValidCustomCode("----")).toBe(false);      // solely hyphens
    expect(isValidCustomCode("bad code")).toBe(false);  // space
    expect(isValidCustomCode("café")).toBe(false);      // non-charset
  });
});

describe("estimateCodeBits + strengthBand", () => {
  it("rates a short code very weak and a long mixed code ok", () => {
    expect(strengthBand(estimateCodeBits(canonicalizeCode("ab12")))).toBe("very-weak");
    expect(strengthBand(estimateCodeBits(canonicalizeCode("k7pm2qx9rtab")))).toBe("ok");
  });
  it("penalizes low variety", () => {
    expect(estimateCodeBits("AAAA")).toBeLessThan(estimateCodeBits("AB12"));
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `pnpm --filter @uniclip/room-code test custom-code`
Expected: FAIL — cannot resolve `./custom-code`.

- [ ] **Step 3: Implement `custom-code.ts`**

Create `packages/room-code/src/custom-code.ts`:

```ts
// A user-chosen Mode-B code. In Mode B the code IS the encryption key material
// (see client-core deriveRoomKey), so canonicalization MUST be byte-identical on
// client and relay or peers derive different keys. Frozen + unit-tested.
export const CUSTOM_CODE_MIN = 4;
export const CUSTOM_CODE_MAX = 64;
const CUSTOM_CODE_RE = /^[A-Z0-9-]+$/;

export function canonicalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidCustomCode(raw: string): boolean {
  const c = canonicalizeCode(raw);
  if (c.length < CUSTOM_CODE_MIN || c.length > CUSTOM_CODE_MAX) return false;
  if (!CUSTOM_CODE_RE.test(c)) return false;
  if (/^-+$/.test(c)) return false; // not solely hyphens
  return true;
}

// Rough entropy estimate (bits) from length × log2(effective charset), with a
// penalty for low character variety (e.g. "AAAA"). Not a security guarantee —
// it drives the strength meter that nudges users toward stronger codes.
export function estimateCodeBits(canonical: string): number {
  if (!canonical) return 0;
  let charset = 0;
  if (/[A-Z]/.test(canonical)) charset += 26;
  if (/[0-9]/.test(canonical)) charset += 10;
  if (/-/.test(canonical)) charset += 1;
  const perChar = Math.log2(Math.max(charset, 2));
  const variety = new Set(canonical).size / canonical.length; // (0,1]
  return Math.round(canonical.length * perChar * (0.4 + 0.6 * variety));
}

export type StrengthBand = "very-weak" | "weak" | "ok";
export function strengthBand(bits: number): StrengthBand {
  if (bits < 28) return "very-weak";
  if (bits < 48) return "weak";
  return "ok";
}
```

- [ ] **Step 4: Export it**

In `packages/room-code/src/index.ts`, add:

```ts
export * from "./custom-code";
```

- [ ] **Step 5: Run — must pass**

Run: `pnpm --filter @uniclip/room-code test custom-code && pnpm --filter @uniclip/room-code typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/room-code/src/custom-code.ts packages/room-code/src/custom-code.test.ts packages/room-code/src/index.ts
git commit -m "feat(room-code): custom-code canonicalize/validate/strength contract"
```

---

### Task 2: Relay create path — customCode + collision 409

**Files:**
- Modify: `apps/relay/src/rooms.ts` (`RoomConflictError`, `create(…, customId?)`)
- Modify: `apps/relay/src/app.ts` (`CreateRoomBody.customCode`, validate + 400/409)
- Test: `apps/relay/test/custom-code-room.test.ts`

**Interfaces:**
- Consumes: `canonicalizeCode`, `isValidCustomCode` (Task 1).
- Produces: `RoomStore.create(mode, backfill?, ephemeral?, customId?)`; `export class RoomConflictError`. `POST /api/room` accepts `customCode`.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/custom-code-room.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";

function app() {
  const store = new RoomStore();
  return buildApp({ roomCount: () => store.count, store });
}
const post = (a: ReturnType<typeof app>, body: unknown) =>
  a.request("/api/room", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/room customCode", () => {
  it("creates a Mode-B room at the canonical custom code", async () => {
    const res = await post(app(), { mode: "B", customCode: " pizza-42 " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roomId: string };
    expect(body.roomId).toBe("PIZZA-42");
  });

  it("rejects an invalid custom code with 400", async () => {
    const res = await post(app(), { mode: "B", customCode: "ab" });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the code is already taken", async () => {
    const a = app();
    expect((await post(a, { mode: "B", customCode: "TWINS-9" })).status).toBe(200);
    const dup = await post(a, { mode: "B", customCode: "twins-9" });
    expect(dup.status).toBe(409);
    expect((await dup.json()) as { error: string }).toEqual({ error: "code_taken" });
  });

  it("ignores customCode for Mode A", async () => {
    const res = await post(app(), { mode: "A", customCode: "SHOULD-IGNORE" });
    const body = (await res.json()) as { roomId: string };
    expect(body.roomId).not.toBe("SHOULD-IGNORE");
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `pnpm --filter @uniclip/relay test custom-code-room`
Expected: FAIL — `customCode` not parsed / no collision handling.

- [ ] **Step 3: Add `RoomConflictError` + `customId` to `rooms.ts`**

In `apps/relay/src/rooms.ts`, add after the imports (before `export type RoomMode`):

```ts
export class RoomConflictError extends Error {
  constructor(public readonly id: string) {
    super(`room code already in use: ${id}`);
    this.name = "RoomConflictError";
  }
}
```

Change the `create` signature + body (rooms.ts:66-68) so it accepts an optional `customId` and rejects a collision. Replace:

```ts
  create(mode: RoomMode, backfill = true, ephemeral = false): Room {
    const id =
      mode === "A" ? generateModeARoom().routingId : generateModeBCode();
```

with:

```ts
  create(mode: RoomMode, backfill = true, ephemeral = false, customId?: string): Room {
    const id = customId ?? (mode === "A" ? generateModeARoom().routingId : generateModeBCode());
    if (customId && (this.rooms.has(id) || this.roomDb.get(id))) {
      throw new RoomConflictError(id);
    }
```

(The rest of `create` — building `room`, `this.rooms.set`, `this.roomDb.insert` — is unchanged.)

- [ ] **Step 4: Wire validation + 409 into `app.ts`**

In `apps/relay/src/app.ts`, add an import:

```ts
import { canonicalizeCode, isValidCustomCode } from "@uniclip/room-code";
import { RoomConflictError } from "./rooms";
```

Add `customCode` to `CreateRoomBody` (app.ts:40-46):

```ts
  customCode: z.string().optional(),
```

Replace the create call block (app.ts:82-88) with canonicalization, validation, and conflict handling:

```ts
    let customId: string | undefined;
    if (parsed.data.mode === "B" && parsed.data.customCode !== undefined) {
      customId = canonicalizeCode(parsed.data.customCode);
      if (!isValidCustomCode(customId)) return c.json({ error: "invalid code" }, 400);
    }
    try {
      const room = deps.store.create(
        parsed.data.mode,
        parsed.data.backfill ?? true,
        parsed.data.ephemeral ?? false,
        customId,
      );
      const expiresAt = new Date(room.createdAt + 24 * 3600_000).toISOString();
      return c.json({ roomId: room.id, expiresAt });
    } catch (e) {
      if (e instanceof RoomConflictError) return c.json({ error: "code_taken" }, 409);
      throw e;
    }
```

- [ ] **Step 5: Run — must pass**

Run: `pnpm --filter @uniclip/relay test custom-code-room && pnpm --filter @uniclip/relay typecheck`
Expected: PASS (4 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/rooms.ts apps/relay/src/app.ts apps/relay/test/custom-code-room.test.ts
git commit -m "feat(relay): custom Mode-B code on create — validate (400) + collision (409)"
```

---

### Task 3: WS-connect per-IP rate-limit

**Files:**
- Modify: `apps/relay/src/ws-handlers.ts` (accept limiter, check on connect)
- Modify: `apps/relay/src/server.ts` (env + wire + sweep)
- Test: `apps/relay/test/ws-connect-limit.test.ts`

**Interfaces:**
- Consumes: `SlidingWindowLimiter`, `CLOSE_CODES`.
- Produces: `attachWebSocket(app, store, metrics?, wsConnectLimiter?)`.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/ws-connect-limit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";
import { attachWebSocket } from "../src/ws-handlers";
import { SlidingWindowLimiter } from "../src/rate-limit";
import { CLOSE_CODES } from "@uniclip/protocol";

function boot(connectLimit: number) {
  const store = new RoomStore();
  const app = buildApp({ roomCount: () => store.count, store });
  const limiter = new SlidingWindowLimiter(connectLimit, 10_000);
  const { websocket, fetch } = attachWebSocket(app, store, undefined, limiter);
  const server = Bun.serve({ port: 0, fetch, websocket });
  return { server, url: `ws://localhost:${server.port}` };
}

function closeCode(url: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url}/ws/NOROOM`);
    ws.onclose = (e) => resolve(e.code);
  });
}

describe("WS connect rate-limit", () => {
  it("closes over-limit connection attempts with RATE_LIMIT", async () => {
    const { server, url } = boot(2);
    const c1 = await closeCode(url); // under limit → ROOM_NOT_FOUND
    const c2 = await closeCode(url);
    const c3 = await closeCode(url); // over limit → RATE_LIMIT
    expect(c1).toBe(CLOSE_CODES.ROOM_NOT_FOUND);
    expect(c2).toBe(CLOSE_CODES.ROOM_NOT_FOUND);
    expect(c3).toBe(CLOSE_CODES.RATE_LIMIT);
    server.stop(true);
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `pnpm --filter @uniclip/relay test ws-connect-limit`
Expected: FAIL — `attachWebSocket` ignores a 4th arg; the 3rd connect returns ROOM_NOT_FOUND, not RATE_LIMIT.

- [ ] **Step 3: Accept + enforce the limiter in `ws-handlers.ts`**

Change the `attachWebSocket` signature (ws-handlers.ts:19) to accept the limiter:

```ts
export function attachWebSocket(
  app: Hono,
  store: RoomStore,
  metrics?: Metrics,
  wsConnectLimiter?: SlidingWindowLimiter,
) {
```

Inside the `upgradeWebSocket((c) => { ... })` factory (ws-handlers.ts:33-35), compute the per-IP verdict once per connection, right after `const roomId = ...`:

```ts
      const roomId = c.req.param("roomId") ?? "";
      const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      const connBlocked = wsConnectLimiter ? !wsConnectLimiter.allow(ip) : false;
```

At the very top of `onOpen`, before `const room = store.get(roomId)` (ws-handlers.ts:37), reject blocked attempts:

```ts
        onOpen(_ev, ws) {
          const raw = ws.raw as ServerWebSocket<{ roomId: string }> | undefined;
          if (!raw) return;
          if (connBlocked) {
            raw.close(CLOSE_CODES.RATE_LIMIT, "RATE_LIMIT");
            return;
          }
          const room = store.get(roomId);
```

(Delete the now-duplicated `const raw = ...; if (!raw) return;` that followed `const room` in the original onOpen — the `raw` lookup moves to the top. The rest of `onOpen` is unchanged.)

- [ ] **Step 4: Wire env + sweep in `server.ts`**

In `apps/relay/src/server.ts`, add near the other limiter setup (after the `ipLimiter` block, server.ts:31):

```ts
const wsConnectLimit = Number(process.env.WS_CONNECT_IP_LIMIT ?? 30) || 30;
const wsConnectLimiter = new SlidingWindowLimiter(wsConnectLimit, 10_000);
```

Pass it into `attachWebSocket` (server.ts:43):

```ts
const { websocket, fetch, frameLimiter, chunkLimiter } = attachWebSocket(
  app,
  store,
  metrics,
  wsConnectLimiter,
);
```

Add its sweep to the existing sweep interval (server.ts:50-54), alongside the others:

```ts
  wsConnectLimiter.sweep();
```

- [ ] **Step 5: Run — must pass**

Run: `pnpm --filter @uniclip/relay test ws-connect-limit && pnpm --filter @uniclip/relay typecheck`
Expected: PASS; typecheck clean. Also run the full relay suite to confirm no existing WS test regressed: `pnpm --filter @uniclip/relay test`.

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/ws-handlers.ts apps/relay/src/server.ts apps/relay/test/ws-connect-limit.test.ts
git commit -m "feat(relay): per-IP WS-connect rate-limit (blunts code enumeration)"
```

---

### Task 4: Web landing — custom-code input, strength meter, warning

**Files:**
- Modify: `apps/web/src/routes/landing.svelte`

**Interfaces:**
- Consumes: `canonicalizeCode`, `isValidCustomCode`, `estimateCodeBits`, `strengthBand` (Task 1); the relay's `409 { error: "code_taken" }` (Task 2).

- [ ] **Step 1: Import the helpers + add state**

In `apps/web/src/routes/landing.svelte`, extend the room-code import (line 3):

```ts
  import {
    generateModeARoom,
    canonicalizeCode, isValidCustomCode, estimateCodeBits, strengthBand,
  } from "@uniclip/room-code";
```

Add state + derivations after `let creating = $state(false);` (line 14):

```ts
  let customCode = $state("");
  const canonical = $derived(canonicalizeCode(customCode));
  const codeValid = $derived(isValidCustomCode(customCode));
  const band = $derived(strengthBand(estimateCodeBits(canonical)));
```

- [ ] **Step 2: Guard + send `customCode`; handle 409 in `startRoom`**

At the top of `startRoom` (inside `try`, before the `fetch`), block an invalid custom code:

```ts
      if (mode === "B" && customCode.trim() && !isValidCustomCode(customCode)) {
        toast("Code must be 4–64 chars: letters, numbers, hyphens.", "warn");
        return;
      }
```

Add `customCode` to the POST body (landing.svelte:22-26):

```ts
        body: JSON.stringify({
          mode,
          backfill: mode === "A" && !ephemeral ? backfill : false,
          ephemeral,
          ...(mode === "B" && customCode.trim() ? { customCode: canonical } : {}),
        }),
```

Extend the `!res.ok` branch (landing.svelte:28-30) to surface 409:

```ts
      if (!res.ok) {
        toast(
          res.status === 429 ? "Too many rooms — try again shortly"
          : res.status === 409 ? "That code is taken — pick another"
          : "Couldn't create room",
          "warn",
        );
        return;
      }
```

- [ ] **Step 3: Validate the bare join code in `join()`**

Replace the `else` branch of `join()` (landing.svelte:52-55):

```ts
    } else {
      const code = canonicalizeCode(raw);
      if (!isValidCustomCode(code)) {
        toast("That doesn't look like a valid code.", "warn");
        return;
      }
      navigateToRoom(code);
    }
```

- [ ] **Step 4: Add the custom-code UI block**

In the markup, immediately after the mode-buttons grid `</div>` (landing.svelte:134, the `</div>` closing `class="grid gap-2.5 sm:grid-cols-2"`) and before the `{#if mode === "A"}` block, insert:

```svelte
      {#if mode === "B"}
        <div class="mt-3 rounded-field border border-border bg-surface-2 p-3">
          <label class="block text-sm font-medium text-text" for="customcode">Choose your own code (optional)</label>
          <input
            id="customcode"
            class="mt-2 w-full rounded-field border border-border bg-surface px-3 py-2 font-mono text-sm uppercase text-text placeholder:text-faint focus:border-accent focus:outline-none"
            placeholder="e.g. PIZZA-42"
            bind:value={customCode}
            maxlength={64}
          />
          {#if customCode.trim()}
            <div class="mt-2 flex items-center gap-2">
              <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                <div class="h-full transition-all
                  {band === 'ok' ? 'w-full bg-[var(--ok)]' : band === 'weak' ? 'w-2/3 bg-[var(--warn)]' : 'w-1/3 bg-[var(--danger)]'}"></div>
              </div>
              <span class="text-xs font-medium
                {band === 'ok' ? 'text-[var(--ok)]' : band === 'weak' ? 'text-[var(--warn)]' : 'text-[var(--danger)]'}">
                {band === 'ok' ? 'Strong' : band === 'weak' ? 'Weak' : 'Very weak'}
              </span>
            </div>
            {#if !codeValid}
              <p class="mt-1 text-xs text-[var(--danger)]">4–64 chars, letters/numbers/hyphens only.</p>
            {/if}
          {/if}
          <p class="mt-2 text-xs font-medium text-warn">
            This code is your encryption key — anyone who can guess it can read this room. Longer &amp; mixed is stronger.
          </p>
        </div>
      {/if}
```

- [ ] **Step 5: Verify — typecheck + build**

Run: `pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web build`
Expected: svelte-check clean; build succeeds. (No web unit test asserts on this markup; run `pnpm --filter @uniclip/web test` to confirm the suite still passes.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/landing.svelte
git commit -m "feat(web): custom Mode-B code input with strength meter + key warning"
```

---

## Final verification (after all tasks)

- [ ] `pnpm --filter @uniclip/room-code test` + `pnpm --filter @uniclip/relay test` green; repo `pnpm typecheck` clean; `pnpm --filter @uniclip/web build` succeeds.
- [ ] Whole-branch review (opus): `canonicalizeCode` is the single frozen coupling (client == server) — a custom code created on the relay derives the same key the web client derives from the same typed string; collision returns 409 (no `INSERT OR REPLACE` hijack for custom ids); the WS-connect limiter fires before the room lookup and closes 4429; Mode A and the random default are untouched; the warning copy is present and the meter maps bands correctly.
- [ ] Manual (user): create a room with a custom code, open it on a second device by typing the same code (case-insensitively) → they sync (same derived key); creating the same code twice shows "code is taken".
