# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> `AGENTS.md` is a symlink to this file (one source of truth for Claude Code and Codex). Edit `CLAUDE.md`; the other follows automatically.

## What this is

`uniclip` is an end-to-end-encrypted "universal clipboard": a web SPA syncs clipboard text between devices through a relay that **never sees plaintext or keys**. pnpm + Turborepo monorepo, TypeScript everywhere. v0.1 is text-only.

## Commands

```bash
pnpm install                         # bootstrap the workspace
pnpm typecheck                       # turbo: tsc --noEmit (svelte-check for web) across all packages
pnpm test                            # turbo: unit tests for all packages EXCEPT e2e
pnpm test:e2e                        # Playwright two-browser test (boots relay + web dev servers itself)
pnpm lint                            # turbo: eslint

# single package / single test file (vitest name pattern)
pnpm --filter @uniclip/crypto test envelope
pnpm --filter @uniclip/relay test rooms     # same name-pattern arg, routed through Bun
pnpm --filter @uniclip/relay typecheck

# local dev (split origin: web on :5173 talks to relay on :3000)
PORT=3000 pnpm --filter @uniclip/relay dev          # bun run --hot
VITE_RELAY_BASE=http://localhost:3000 pnpm --filter @uniclip/web dev

# production image: one container serves API + SPA on :3000
docker build -t uniclip:dev . && docker run --rm -p 3000:3000 uniclip:dev

# test across real devices: clipboard needs a secure context (HTTPS or localhost),
# so http://<lan-ip> won't sync. Expose the container over HTTPS with Tailscale:
tailscale serve --bg 3000      # or --https=8443 3000 if :443 is taken on the host
```

**`pnpm test` deliberately excludes `@uniclip/e2e`** (`--filter=!@uniclip/e2e`): Playwright must run after `playwright install`, and booting its dev servers starves the unit suite's async-timing tests. Run e2e only via `pnpm test:e2e`. The `@uniclip/e2e` package lives in the **top-level `e2e/` dir** (a standalone workspace entry beside `apps/*` and `packages/*`), not under either of them.

## Architecture

Data flow: **web SPA ⇄ relay (WebSocket) ⇄ web SPA**. The relay is a pure in-memory fan-out — it validates frame *shape* and forwards opaque ciphertext; it holds no key and persists no plaintext, ciphertext, or frames. It optionally persists **room metadata only** (`{id, mode, expiresAt, backfillEnabled, createdAt}`, via `ROOM_DB_PATH`, default `:memory:`) to a SQLite file so room URLs survive a relay restart. The one piece of retained *content* state is the **Mode-A backfill buffer**: a bounded (`RECENT_CAP`) in-memory ring of recent ciphertext frames per room, replayed to late joiners and cleared the instant the room empties (never written to disk). It exists only for Mode A (where the relay provably can't decrypt) and is opt-out per room at creation.

Packages (`packages/`) are consumed as **TypeScript source** (`main` → `src/index.ts`), not built artifacts — bundlers/vitest resolve `.ts` directly. The `build` task (`tsc -p`) emits in place and is essentially vestigial; those `.js`/`.d.ts` are gitignored under `packages/*/src`.

- **`protocol`** — Zod wire schemas; the single source of truth for frame shapes. `ClientFrameSchema` is a discriminated union of `clip` (type/msgId/iv/ciphertext/ts) and `delete` (type/msgId — the msgId to remove; no plaintext). `ServerFrameSchema` (discriminated union incl. clip and delete), `CLOSE_CODES` (4404/4429/4413), `MAX_FRAME_BYTES`. Client and relay both validate against these.
- **`crypto`** — AES-256-GCM envelope over WebCrypto. `deriveKey` (PBKDF2-SHA256, 200k iters) is **non-extractable by default** (pass `extractable: true` only in tests). Encryption is bound by AAD; a bounded `ReplaySet` dedups by msgId.
- **`room-code`** — pairing. `parseRoomUrl` is the shared URL contract: `/r/<routingId>#<secret>` → Mode A, `/r/<routingId>` (no fragment) → Mode B.
- **`client-core`** — `UniclipClient`: derives the key, connects (`/ws/<routingId>` — **only the routingId is ever sent**), encrypts on send, and on receive runs shape→replay→decrypt before emitting. Exponential backoff reconnect.
- **`apps/relay`** — Bun + Hono. `RoomStore` is a live cache over `room-db.ts`/`RoomDb` (a `bun:sqlite` store of room *metadata only*, the source of truth for room existence); `get()` rehydrates a room from the DB on a Map miss so URLs survive restart. GC: max-age deletes from both DB+Map, idle evicts the Map only (rooms live to their 24h max-age); per-room `recent`/`backfillEnabled` for Mode-A backfill via `pushRecent`/`removeRecent`. `count` is live-Map size; `totalCount` (DB) backs `/api/health` + metrics. WS handlers (hello/peer-joined/peer-left/clip fan-out; delete frames are fanned out to all peers and the matching entry is pruned from the backfill ring via `removeRecent`; on join replays `recent` to the newcomer only, clears it when sockets hit 0), per-socket + per-IP sliding-window rate limits, Prometheus `/api/metrics`, static SPA fallback (`STATIC_ROOT`), CORS on `/api/*`.
- **`apps/web`** — Svelte 5 (runes) + Vite 6 + Tailwind 4. Path-based router (relies on the relay's SPA fallback for `/r/*`), `ClipboardWatcher` polling, encrypted-at-rest history in localStorage.

### Security model (don't break these invariants)
- **Mode A is zero-knowledge**: the secret lives only in the URL fragment, is generated client-side, and is never put in any request — only `routingId` reaches the relay. Mode B derives the key from the routingId (which the server sees) and is labelled "less secure" in the UI.
- **AAD domain separation**: wire frames use `${routingId}:${msgId}`; at-rest persistence uses `persist:${roomId}`. Keep them disjoint so a stored blob can't be replayed as a live frame.
- **Backfill is Mode-A-only by construction**: `RoomStore.create` forces `backfillEnabled = mode === "A" && backfill`. Never buffer Mode-B clips — the relay can derive that key, so retaining Mode-B ciphertext would mean retaining readable history. The buffer must stay memory-only and clear on empty (history lives only while a device is connected).
- **Persistence is metadata-only**: `RoomDb` (`bun:sqlite`) stores only `{id, mode, expiresAt, backfillEnabled, createdAt}` — never frames, keys, sockets, or the backfill ring. `ROOM_DB_PATH` defaults to `:memory:` (no cross-restart persistence unless configured). Adding any content column would break the zero-knowledge boundary.
- **Key derivation is single-sourced** in `client-core`'s `deriveRoomKey(room)` — both `UniclipClient` and `apps/web/src/routes/room.svelte` call it, so the Mode-A/B mapping has exactly one definition and stays identical across peers (the relay never derives keys). Don't reintroduce a second copy.
- **Synced delete is zero-knowledge**: a delete frame carries only the msgId (no plaintext or ciphertext); the relay fans it out and prunes the backfill ring without learning any content. The relay is authless, so any peer in the room can delete any item — this is acceptable for the trusted-room model.

## Toolchain gotchas (these will bite you)

- **Relay tests run under Bun, not Node** — and need **Bun ≥ 1.3** (1.1.x crashes vitest's tinypool worker teardown with "Cannot access 'dispose' before initialization"; CI pins 1.3.14). Its `test` script is `bun --bun vitest run`, and `apps/relay/vitest.config.ts` sets `server.deps.inline: [/zod/, /hono/, /ulid/]` (without it Bun's loader + vitest's transform produce two module copies and `z.object` is undefined) plus `pool: forks, singleFork: true` (one worker minimises the tinypool spawn/teardown surface). The integration tests need real `Bun.serve`. If a new relay test imports another CJS/ESM dep that comes back with undefined exports, add it to `inline`.
- **In `apps/relay/src/ws-handlers.ts`, mutate `raw.data.roomId` — never reassign `raw.data`.** Hono's bun adapter owns `ws.data` (`{events,url,protocol}`); reassigning it breaks `onClose`/`onMessage` dispatch.
- **Relay tsconfig uses `"types": ["bun"]`** (the `@types/bun` reference name), not `"bun-types"`. Its `typecheck` includes `test/`, and `@types/bun` types `Response.json()` as `unknown`, so relay tests must cast: `(await res.json()) as {...}`.
- **`apps/web` needs `@sveltejs/vite-plugin-svelte` v5** (for Vite 6). v4 makes the dev server resolve Svelte's *server* build → `mount()` throws → blank page. The `vite build` still succeeds, so only the dev server / E2E catches it.
- **`apps/web` tests mock browser globals with `vi.stubGlobal`**, not `Object.assign(globalThis, …)` — `navigator` is a getter-only global in this Node and `Object.assign` throws.
- Helpers feeding WebCrypto return `Uint8Array<ArrayBuffer>` (not bare `Uint8Array`) so they satisfy `BufferSource` under TS 5.7's generic `Uint8Array`.

## Conventions

- TDD: write the failing test, confirm it fails, implement, confirm green. Commits are small and scoped (`feat(pkg): …`, `fix(pkg): …`).
- Trust `tsc --noEmit` / `svelte-check` / `vitest` exit codes over IDE diagnostics — stale "cannot find module" warnings are common right after creating a file; the file watcher lags writes.
- Spec and plan live in `docs/superpowers/{specs,plans}/`.
