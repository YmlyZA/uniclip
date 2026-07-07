# Uniclip — Custom typed code (Mode B) with guardrails — Design Spec

**Date:** 2026-07-07
**Status:** Approved (pending spec review)
**Scope:** Let a user **choose their own memorable Mode-B room code** at creation, with guardrails that make the security cost explicit and bounded: charset/length validation, a live **strength meter**, a prominent "this code is your key" warning, a **collision check (409)** on create, and a **per-IP rate-limit on WS connect** to blunt code enumeration. Decoupled from the TURN feature (separate spec, plan, worktree).

## 1. Background (current state, from code) — why this is a crypto decision

- **Mode B derives the AES key directly from the routingId** the relay assigns and sees: `deriveRoomKey` = `deriveKey({ secret: room.routingId, salt: MODE_B_SALT /* "uniclip-v1" */ })`, PBKDF2-SHA256 200k → AES-256-GCM (`packages/client-core/src/room-key.ts:10-14`, `packages/crypto/src/key.ts:20-41`). Mode A instead uses the URL-fragment secret (never sent to the server). **So in Mode B the code *is* the key material** — a weak/guessable code is a direct cryptographic weakening, not just a naming choice. The UI already labels Mode B "less secure" (`landing.svelte:160-161`, `room.svelte:417-421`).
- **`isValidModeBCode` exists but is dead code** (`packages/room-code/src/mode-b.ts:15-19`) — a ready validation hook not currently wired anywhere.
- **The server always chooses the id today** — `CreateRoomBody` has no id field (`apps/relay/src/app.ts:40-46`); `RoomStore.create` sets `id = generateModeBCode()` and does `INSERT OR REPLACE` (`apps/relay/src/rooms.ts:66-94`, `room-db.ts:51-67`) with **no collision check** — a colliding id would silently clobber/hijack an existing room's metadata.
- **No rate-limit on `GET /ws/:roomId` connect** (`apps/relay/src/ws-handlers.ts:31-56`) — only `POST /api/room` is IP-limited. Guessable codes make connection-attempt enumeration materially more effective.
- Web: `landing.svelte` has the Mode A/B toggle and create flow (`:16-40`); `join()` (`:42-56`) treats a bare string as a Mode-B code and navigates **without validating**; the only URL builder is `router.ts navigateToRoom` (`:13-14`).

## 2. Goals / non-goals

### Goals
1. A user can type a **custom Mode-B code** at creation; it becomes the routingId and (via the unchanged derivation) the key.
2. **Canonicalization is byte-identical on client and server** so both derive the same key and address the same room.
3. The security cost is **surfaced, not hidden** — live strength meter + explicit "the code is your key; anyone who guesses it can read this room" warning.
4. **Collision-safe create** — reserving an existing code returns **409**, never a silent overwrite.
5. **Enumeration hardening** — per-IP sliding-window limit on WS connect (`429` on exceed).

### Non-goals / deferred
- **No change to Mode A** or to the key-derivation formula (the canonical custom code flows through the existing Mode-B branch unchanged).
- **No wordlist/diceware generator** — we chose fully-custom-with-guardrails, not auto-generated passphrases. (The random `generateModeBCode()` default stays for users who don't customize.)
- **No dictionary-based strength scoring** (no shipped wordlist this cycle) — the meter estimates from length × effective charset + a repetition penalty; the warning copy carries the "your key" point regardless.
- No account/ownership model — the trusted-room model is unchanged (any peer can still delete; codes aren't authenticated).

## 3. Canonicalization, validation & strength (the shared contract)

New pure helpers in **`packages/room-code`** (single source, imported by relay + web so the rules can't drift):

- `canonicalizeCode(raw: string): string` — `raw.trim().toUpperCase()`. (Case-insensitive: "Tiger" and "TIGER" address the same room / derive the same key. No other transformation, so the canonical string is exactly what feeds PBKDF2 and what's stored as routingId.)
- `isValidCustomCode(raw: string): boolean` — on the canonical form: charset `^[A-Z0-9-]+$`, length **4–64**, and not solely hyphens. (Hyphen allowed as a memorability separator, e.g. `PIZZA-42`; it's a valid URL path char.)
- `estimateCodeBits(canonical: string): number` — `length × log2(effectiveCharsetSize)` where the charset size is inferred from the classes present (26 upper / 10 digit / +1 hyphen), minus a small penalty for single-character-class or highly-repetitive/sequential strings. Returns an entropy estimate in bits.
- `strengthBand(bits: number): "very-weak" | "weak" | "ok"` — the meter's band mapping: `< 28` bits = **very weak** (red), `28–47` = **weak** (amber), `≥ 48` = **ok** (green). (At the 4-char floor over `[A-Z0-9]` ≈ 21 bits → red, nudging users toward ≥ 8–10 chars.)

## 4. Components & data flow

### Relay
- **`CreateRoomBody`** (`app.ts:40-46`) gains `customCode?: string` (zod optional string).
- **`POST /api/room`** handler: if `mode === "B"` and `customCode` present → `const id = canonicalizeCode(customCode)`; if `!isValidCustomCode(id)` → **400**; pass the desired id to `store.create`. Mode A ignores `customCode`.
- **`RoomStore.create(mode, backfill, ephemeral, customId?)`** (`rooms.ts:66-94`): when `customId` given, use it as the id **after a collision check** — `if (this.rooms.has(id) || this.roomDb.get(id)) throw new RoomConflictError()`; otherwise mint as today. The handler maps `RoomConflictError` → **409** `{ error: "code_taken" }`. (Auto-generated ids keep today's path; optionally also guard them behind the same check for safety.)
- **WS-connect rate-limit** — `server.ts` reads `WS_CONNECT_IP_LIMIT` (default `30` per `10_000` ms); a `SlidingWindowLimiter` is passed into the WS layer; `GET /ws/:roomId` (`ws-handlers.ts:31-56`) checks the per-IP bucket **before upgrade** → `429`/close on exceed. Reuses the existing `SlidingWindowLimiter` class.

### Web (`apps/web`)
- **`landing.svelte` create flow** — when Mode B ("Typed code") is selected, reveal an optional **"choose your own code"** text input: live `canonicalizeCode` preview, `isValidCustomCode` gating the Create button, a **strength meter** (new small component driven by `estimateCodeBits` bands), and a prominent warning: *"This code is your encryption key — anyone who can guess it can read this room. Longer + mixed is stronger."* On create, POST `{ mode:"B", customCode }`; a **409** surfaces inline as "that code is taken, pick another."
- **`join()`** (`:42-56`) — validate a bare typed code with `isValidCustomCode` (after canonicalize) before navigating, instead of failing later at WS-connect.
- **Key derivation is unchanged** — `deriveRoomKey` receives the canonical code as `routingId`.

### Key-derivation invariant
The canonical code is the *only* coupling point: server stores it as the routingId; client derives the key from the same canonical string. Any change to `canonicalizeCode` changes derived keys, so it is frozen in `room-code` with tests asserting exact outputs.

## 5. Security model

- **The code is the key (Mode B, by design).** Custom codes can only *lower* entropy vs. the random default, so the meter + warning make the tradeoff explicit and the user's informed choice (the approved "fully-custom with guardrails" stance). Mode A remains the zero-knowledge option and is unchanged.
- **Canonicalization must be identical** client/server or peers derive different keys / address different rooms — frozen + unit-tested.
- **Collision → 409, never overwrite** — closes the `INSERT OR REPLACE` silent-hijack gap for user-chosen ids.
- **Enumeration is throttled** — per-IP WS-connect limit bounds online guessing of guessable codes (offline guessing is irrelevant since the relay never stores ciphertext beyond the Mode-A-only backfill, which Mode B never uses).
- **Confusable characters** (`0/O`, `1/I`) are permitted for custom codes (the user communicates the code out-of-band); the random default keeps its confusable-free alphabet.
- No new persisted content; `RoomDb` still stores metadata only.

## 6. Testing

- **`packages/room-code`** (pure, node): `canonicalizeCode` idempotent + case-folding + trim; `isValidCustomCode` charset/length bounds (3 rejects, 64 ok, 65 rejects, hyphen-only rejects, valid mixed accepts); `estimateCodeBits` band boundaries (a 4-char alnum → red band; a strong 12-char → green).
- **`apps/relay`** (Bun vitest, cast `res.json()`): `POST /api/room` with valid `customCode` → room created at that id; invalid → 400; **duplicate → 409**; Mode A ignores `customCode`. WS-connect limiter → `429` after N attempts from one IP within the window; under the limit connects normally.
- **`apps/web`** — any extracted pure helpers (e.g. a `strengthBand(bits)` mapper) unit-tested; `svelte-check` + `vite build` clean. The create/join UI is markup — final gate is the standard build + a manual create-with-custom-code smoke.
- Existing room-code / relay / web suites must still pass.

## 7. Decomposition (for the plan)

1. **`room-code` helpers + tests** — `canonicalizeCode`, `isValidCustomCode`, `estimateCodeBits` + `strengthBand` (TDD, pure).
2. **Relay create path** — `RoomConflictError` + collision check in `RoomStore.create(…, customId?)`; `CreateRoomBody.customCode`; `POST /api/room` validate/400/409; app tests.
3. **WS-connect rate-limit** — `WS_CONNECT_IP_LIMIT` env + limiter wired into `GET /ws/:roomId` → 429; test.
4. **Web create/join** — custom-code input + strength meter component + warning in `landing.svelte`; `join()` validation; wire the 409 inline error; typecheck/build.

Order 1→4: the frozen canonicalization/validation contract first, then relay enforcement, then the enumeration limiter, then the UI. Each ends with its package's tests + typecheck green.
