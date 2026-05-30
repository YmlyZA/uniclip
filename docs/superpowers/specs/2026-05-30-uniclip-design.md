# Uniclip — Design Spec (v0.1)

**Date:** 2026-05-30
**Status:** Approved for implementation planning
**Scope:** v0.1 — Web-only, E2EE, text-only clipboard sync via an ephemeral relay

---

## 1. Goal and non-goals

### Goal

Let any two (or more) browsers share a live clipboard channel: copy on one device, paste on another. No accounts, no apps to install, no plaintext ever stored on a server. Pairing is by URL (QR / link) or short typed code.

### Non-goals for v0.1

- Accounts, login, persistent device list
- Images, files, or rich content (text only)
- Long-term server-side history
- Native desktop / mobile clients (the monorepo prepares for them; we don't build them)
- Sharing rooms with more than 2 people in a polished UX (protocol supports N, UI is built for 2)
- Server-side search, OCR, previews
- Multi-region or multi-process scaling
- Anything that requires the server to read clipboard content

These are valid v0.2+ work; they are explicitly out of scope here.

---

## 2. Architecture overview

Three actors: **Browser A**, **Browser B**, **Relay**.

```
   Browser A                   Relay (Bun + Hono)             Browser B
   ─────────                   ──────────────────              ─────────
1. POST /api/room          →  create room, return { roomId, expiresAt }
2. (share URL/code A→B out of band)
3. WS /ws/:roomId          →  add to roomMap[roomId].sockets
4.                              ←  WS /ws/:roomId from B
5. read OS clipboard
   K = derive(secret)
   ciphertext = AES-GCM(K, text)
   send frame              →  fan-out to other sockets   →   receive
                                                              decrypt with K
                                                              show in list
                                                              user clicks Copy
```

**Server state, in full:**

```ts
type Room = {
  id: string;
  sockets: Set<ServerWebSocket>;
  createdAt: number;
  lastActivityAt: number;
};
const rooms = new Map<string, Room>();
```

No database. No Redis. No disk. Restart = all rooms gone (accepted trade-off; see §11).

---

## 3. Pairing modes

Two modes, both supported, user chooses per-room.

### Mode A — Zero-knowledge (default)

- URL form: `https://uniclip.app/r/<routingId>#<secret>`
- `routingId`: 6 lowercase chars `[a-z2-9]`, server-generated, used purely for routing
- `secret`: 18 chars of `[A-Za-z0-9_-]` (108 bits of entropy), client-generated, **never sent to server** (lives in the URL fragment)
- Pairing UX: scan QR code or paste full URL on second device
- Key derivation: `PBKDF2-SHA256(secret, salt=routingId, 200_000 iter, 32 bytes)`
- Security: server is a true zero-knowledge relay. Even a malicious relay operator cannot decrypt frames.

### Mode B — Typed code (convenience)

- URL form: `https://uniclip.app/r/<CODE>` (no fragment)
- `CODE`: 6 chars from `[A-Z2-9]` minus look-alikes `O` and `I` (32-char alphabet, 0 and 1 already excluded); 30 bits of entropy
- Pairing UX: user reads code aloud / types it on the second device
- Key derivation: `PBKDF2-SHA256(CODE, salt="uniclip-v1", 200_000 iter, 32 bytes)`
- Security: encrypted against passive network observers and other clients, but **the relay operator can decrypt** (the server sees `CODE` for routing). UI clearly labels this mode as "less secure: server can decrypt."

Both modes share the wire protocol and AES-GCM envelope — only the input to PBKDF2 differs.

---

## 4. Cryptographic envelope

| Field | Value |
|---|---|
| Cipher | AES-256-GCM (via `SubtleCrypto.encrypt`) |
| IV / nonce | 12 random bytes per frame (`crypto.getRandomValues`); never reused |
| Auth tag | 16 bytes appended to ciphertext (GCM default) |
| Associated data (AAD) | UTF-8 bytes of `roomId \|\| ":" \|\| msgId` |
| Anti-replay | Receiver keeps a bounded `Set<msgId>` of the last 256 received IDs; duplicates dropped silently |
| Key derivation | PBKDF2-SHA256, 200 000 iterations, 32-byte output |
| Key lifetime | Derived once per room-open in the browser; held in memory only |

**Why AAD includes `roomId`:** prevents a malicious server from replaying a ciphertext from one room into a different room — the GCM tag would verify with `aad=roomA:msgId` but the receiver in `roomB` builds `aad=roomB:msgId` and rejects.

**Why msgIds are ULIDs:** time-ordered, 26 chars, cheap to validate, naturally sortable, collision-free in practice.

---

## 5. Wire protocol

### HTTP

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/api/room` | `{ "mode": "A" \| "B" }` | `{ roomId, expiresAt }` |
| `GET` | `/api/health` | — | `{ ok: true, rooms, uptime }` |
| `GET` | `/api/metrics` | — | Prometheus text format |
| `GET` | `/*` | — | Static SPA (apps/web build) |

### WebSocket

Endpoint: `GET /ws/:roomId` → upgrade.
Encoding: JSON frames (ciphertext fields are base64-encoded).

**Client → server:**

```ts
type ClipboardFrame = {
  type: "clip";
  msgId: string;        // ULID, 26 chars
  iv: string;           // base64, 12 bytes
  ciphertext: string;   // base64, AES-GCM output (ct || tag)
  ts: number;           // sender epoch ms (informational)
};
```

**Server → client:**

```ts
type ServerFrame =
  | { type: "hello"; roomId: string; peerCount: number; serverTime: number }
  | { type: "peer-joined"; peerCount: number }
  | { type: "peer-left"; peerCount: number }
  | { type: "clip"; msgId: string; iv: string; ciphertext: string; ts: number }
  | { type: "error"; code: "ROOM_EXPIRED" | "RATE_LIMIT" | "TOO_LARGE"; message: string };
```

### Server-enforced rules

1. Frame size ≤ 64 KiB
2. Per-socket rate limit: 20 `clip` frames per sliding 10 s window
3. Per-IP room-creation limit: 10 rooms per hour (in-memory token bucket)
4. `msgId` must match `^[0-9A-HJKMNP-TV-Z]{26}$` (ULID Crockford alphabet)
5. Server **does not** echo a `clip` back to its sender; fan-out is `room.sockets \ {sender}`
6. WS close codes: `4404 ROOM_NOT_FOUND`, `4429 RATE_LIMIT`, `4413 TOO_LARGE`

Schemas live in `packages/protocol` as Zod definitions, imported by both client and server.

---

## 6. Relay server design

### Stack

Bun 1.x + Hono + Bun's built-in WebSocket. No `ws` library. No DB.

### Endpoints

See §5 HTTP table. Single Bun process; static SPA serving is bundled into the same process for the v0.1 deploy.

### Lifecycle

| Event | Action |
|---|---|
| `POST /api/room` | Mint `roomId` per chosen mode, insert into `rooms`, return `{ roomId, expiresAt: now + 24h }` |
| WS upgrade | If room missing → close `4404`. Else add socket, send `hello`, broadcast `peer-joined` |
| `clip` frame | Validate envelope; bump `lastActivityAt`; fan-out to other sockets |
| Socket close | Remove from set; broadcast `peer-left`; if empty + idle > 5 min, schedule GC |
| GC sweep (60 s) | Drop rooms with `sockets.size === 0 && now - lastActivityAt > 5 min`; drop any room older than 24 h |

### Heartbeats

Server sends WebSocket protocol-level `ping` every 25 s; browser auto-`pongs`. Dead sockets detected within ~60 s, closed.

### Logging and metrics

- Structured JSON logs via `pino` to stdout (Fly captures)
- `/api/metrics` exposes: `rooms_total` (gauge), `sockets_total` (gauge), `frames_in_total` (counter), `frames_out_total` (counter), `errors_total{code}` (counter)
- **Never** logs frame bodies, IPs in production builds (only counted), or room IDs

---

## 7. Web client design

### Framework

Svelte 5 + Vite + Tailwind 4. Chosen for small bundle (audit-friendly for an E2EE tool) and minimal toolchain.

### Browser clipboard constraints (drive the UX)

- `clipboard.readText()` requires `clipboard-read` permission + user activation; Safari requires activation every call
- No native "clipboard changed" event exists; we must poll while a tab is foregrounded with permission granted
- `clipboard.writeText()` requires recent user activation — cannot fire from a background timer

### UX consequences

- **Inbound (remote → here):** received items appear in a list; user clicks per-item **Copy** button to write to the local clipboard (one click per item, due to gesture requirement)
- **Outbound (here → remote):** two modes the user toggles
  - **Manual send:** explicit "Send clipboard" button — reads clipboard on click, sends
  - **Watch:** after permission grant, poll every 1 s while tab is visible; on change, send

### UI layout

```
┌─────────────────────────────────────────────────────┐
│  uniclip          Room: QX7K2P  (2 devices online)  │
│                   [Share] [QR] [End room]           │
├─────────────────────────────────────────────────────┤
│  [ Send clipboard ]  [ Watch: ON ]  [ Paste here ]  │
├─────────────────────────────────────────────────────┤
│  ▼ Received                                         │
│  ┌───────────────────────────────────────────────┐  │
│  │ "sk-ant-api03-..."         12s ago   [Copy]   │  │
│  │ "https://github.com/..."   1m ago    [Copy]   │  │
│  │ "let me brainstorm with..."  3m ago  [Copy]   │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Item persistence

Last 50 received items are kept in `localStorage`, encrypted under the room key (same AES-GCM envelope, AAD = `"persist:" || roomId`). Refresh keeps the list. Closing the room or "End room" clicks clears it.

### Reconnect

Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s cap, ±20% jitter. Reset to 1s on `hello`. Visible reconnect indicator in header.

### `client-core` package boundary

Framework-agnostic sync engine in `packages/client-core`:

```ts
export class UniclipClient {
  constructor(opts: { roomUrl: string; relayBase: string });
  connect(): Promise<void>;
  send(text: string): Promise<void>;
  on(event: "clip" | "peer" | "status" | "error", cb: (...) => void): void;
  disconnect(): void;
}
```

It uses `packages/protocol` and `packages/crypto`. The Svelte app is ~200 lines of UI calling `client.send(...)` and rendering events. Future Electron/Tauri/CLI clients consume the same `client-core`.

### Routing

Single-page app, two routes:
- `/` — landing page: "Start a room" and "Join with code" buttons
- `/r/:routingId[#secret]` — room view; reads `location.hash` for Mode A secret

---

## 8. Monorepo layout

```
uniclip/
  apps/
    web/                # Svelte 5 + Vite, browser SPA
    relay/              # Bun + Hono server (also serves SPA in prod)
  packages/
    protocol/           # Zod schemas + TS types for all frames
    crypto/             # AES-GCM envelope, PBKDF2 key derivation
    room-code/          # generate / validate Mode A and Mode B codes
    client-core/        # framework-agnostic UniclipClient
    tsconfig/           # shared tsconfig presets
    eslint-config/      # shared ESLint config
  docs/
    superpowers/specs/  # this file lives here
  .github/workflows/    # CI: install → build → test → deploy
  Dockerfile            # multi-stage: build web + relay, ship one image
  fly.toml              # Fly.io deploy config
  pnpm-workspace.yaml
  turbo.json
  package.json
```

Tooling: **pnpm workspaces + Turborepo**. TypeScript everywhere.

Package boundaries:
- `protocol` depends on nothing
- `crypto` depends on nothing
- `room-code` depends on nothing
- `client-core` depends on `protocol`, `crypto`
- `apps/relay` depends on `protocol`, `room-code`
- `apps/web` depends on `client-core`, `protocol`, `room-code`

---

## 9. Error handling

| Failure | Detection | User behavior |
|---|---|---|
| Server unreachable | `fetch` reject / WS `onerror` | Banner: "Reconnecting…" + backoff timer; sends queued (last 10) and replayed on reconnect |
| Room expired / not found | WS close `4404` | Modal: "Room expired — start a new one" |
| Rate-limited | `RATE_LIMIT` error then close `4429` | Toast: "Slow down — retry in a few seconds"; auto-resume in 10 s |
| Frame too large | `TOO_LARGE` error | Toast: "Item too large (max 64 KB)"; item not added to list |
| AES-GCM decrypt fails | `decrypt()` throws | Silently drop frame, console-warn (wrong key / tamper / replay) |
| Clipboard permission denied | Permission API state `denied` | Watch toggle disabled; tooltip explains how to grant |
| Permission revoked mid-session | Read throws | Auto-disable Watch; one-time inline notice |
| `localStorage` quota exceeded | Caught on write | Drop oldest items until write succeeds; no user notice |
| WS dies in backgrounded tab | Heartbeat miss | Reconnect on next `visibilitychange` |

---

## 10. Testing strategy

### Unit (Vitest)

- `packages/crypto`: known-answer encrypt tests; 1000-case roundtrip fuzz; AAD-mismatch must reject; tampered ciphertext must reject; IV reuse detection in test harness
- `packages/protocol`: Zod schemas accept all valid frame shapes; reject malformed (extra fields, wrong types, oversize)
- `packages/room-code`: no look-alike chars in Mode B; uniform distribution; correct length and alphabet for both modes

### Integration (Vitest)

- `apps/relay`: spin up real Bun server on an ephemeral port, open multiple `WebSocket` clients, assert end-to-end routing, rate-limit enforcement, room GC, error frames

### E2E (Playwright)

- Two-browser scenario: mint room in context A, open room URL in context B, simulate clipboard write in A, assert encrypted frame appears in B, decrypts to the original text
- Runs against built artifacts in CI

### Out of scope for v0.1

- Load testing
- Full browser matrix (Chromium-only in CI; Firefox/Safari smoke only)
- Mutation testing

---

## 11. Deploy

- **Host:** Fly.io single region (initial: `iad`)
- **Container:** multi-stage Dockerfile, final stage `oven/bun:1-alpine` with relay binary + built SPA
- **TLS:** Fly edge
- **Secrets:** none (no DB, no API keys — by design)
- **Observability:** stdout JSON logs (Fly captures), Fly's CPU/memory/request metrics, `/api/metrics` for optional Prometheus scrape
- **CI/CD:** GitHub Actions on push to `main` — `pnpm install` → `turbo run build test` → `fly deploy`

### Known wart: rooms die on restart

Since rooms live only in memory, a deploy or crash invalidates all active room URLs. Clients see disconnect, attempt reconnect, get `4404`, and must mint a new room. Accepted for v0.1; mitigation path is a tiny SQLite file persisting only `{ roomId, mode, expiresAt }` (no socket state, no frames) — defer to v0.2 if deploy frequency makes this painful.

---

## 12. Security model summary

What the relay operator can do:

| Mode A (URL fragment) | Mode B (typed code) |
|---|---|
| Count rooms, count sockets per room | Same |
| See frame sizes and timing | Same |
| See ciphertext (cannot decrypt) | See ciphertext **and** the typed code → **can decrypt** |
| Correlate IPs to rooms (if logging IPs) | Same |
| Replay ciphertext within the same room (defeated by anti-replay set) | Same |
| Replay ciphertext into a different room (defeated by AAD binding) | Same |

What the relay operator cannot do in **either** mode:

- Read content from past rooms (no storage)
- Inject content into a room without breaking AES-GCM auth tag
- Cross-room ciphertext smuggling (AAD binds to `roomId`)

What we promise users:

- In Mode A, the relay cannot read clipboard content. Period.
- In Mode B, anyone with the code can read — including the relay operator. We label this clearly in the UI.

---

## 13. Open questions for v0.2+ (not blocking v0.1)

- Encrypted server-side ring buffer for "live tail with last N items" UX
- Image / file support (binary frames, chunking, larger size cap)
- Account-tier persistent rooms (stable URLs that survive restarts and idle GC)
- Native clients: Tauri desktop (Rust shell + same `client-core`), CLI (`bun` + same `client-core`), mobile via Capacitor
- Multi-region relay with sticky routing by `roomId` hash
- SPAKE2/PAKE-based pairing to give Mode B true zero-knowledge property
