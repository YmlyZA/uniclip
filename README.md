# uniclip

End-to-end-encrypted universal clipboard. Copy text on one device, paste it on another — through your browser, with a relay that **never sees your plaintext or your key**.

- 🔒 **End-to-end encrypted** — AES-256-GCM, keys derived with PBKDF2 in your browser.
- 🕳️ **Zero-knowledge relay** — the server only fans out opaque ciphertext and stores nothing.
- 🔗 **Pair by link/QR or by code** — share a room and sync instantly between two browser windows.
- 🧩 **Just a web app** — no install, works across any OS with a modern browser.

> Status: **v0.1**, text-only.

## How it works

```
 Browser A ──encrypt──▶  relay (Bun + Hono, in-memory)  ──▶ decrypt── Browser B
            WebSocket        forwards opaque ciphertext        WebSocket
```

Two pairing modes:

- **Mode A — zero-knowledge (recommended).** The room link is `https://<host>/r/<routingId>#<secret>`. The `#secret` is the key material; browsers never send a URL fragment to the server, so the relay literally cannot decrypt your clips. Share via link or QR.
- **Mode B — typed code.** A short 6-character code you can read aloud. The key is derived from the code, which the server sees, so it is **less secure** (the UI says so). Convenient when you can't share a link.

The relay also serves the built SPA, so a single deployment hosts both the API and the front end.

## Quick start (local)

Requires [pnpm](https://pnpm.io) 9, [Node](https://nodejs.org) 22, and [Bun](https://bun.sh) 1.

```bash
pnpm install

# terminal 1 — relay (API + WebSocket) on :3000
PORT=3000 pnpm --filter @uniclip/relay dev

# terminal 2 — web dev server on :5173, pointed at the relay
VITE_RELAY_BASE=http://localhost:3000 pnpm --filter @uniclip/web dev
```

Open <http://localhost:5173> in two browser windows: click **Start** in the first, copy the room link into the second, then **Send clipboard** in one and watch it appear in the other.

## Production (single container)

The multi-stage `Dockerfile` builds the SPA and the relay, then serves both from one Bun process:

```bash
docker build -t uniclip:dev .
docker run --rm -p 3000:3000 uniclip:dev
# → http://localhost:3000 serves the API, the SPA, and /api/metrics
```

Deploy to [Fly.io](https://fly.io) with the included `fly.toml` (`fly launch` / `fly deploy`). CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, and the Playwright e2e on every push, and deploys `main` to Fly when `FLY_API_TOKEN` is set.

## Repository layout

| Path | What |
|---|---|
| `packages/protocol` | Zod wire-frame schemas (single source of truth) |
| `packages/crypto` | AES-GCM envelope, PBKDF2 key derivation, replay protection |
| `packages/room-code` | Room-URL parsing + Mode A/B code generation |
| `packages/client-core` | `UniclipClient` — connect, encrypt/decrypt, reconnect |
| `apps/relay` | Bun + Hono relay: WebSocket fan-out, rate limits, metrics, static SPA |
| `apps/web` | Svelte 5 + Vite + Tailwind front end |
| `e2e` | Playwright two-browser sync test |

## Development

```bash
pnpm typecheck        # all packages
pnpm test             # unit tests (excludes e2e)
pnpm test:e2e         # Playwright two-browser test
pnpm lint
```

See [`CLAUDE.md`](./CLAUDE.md) for architecture details and toolchain notes. The design spec and implementation plan live under `docs/superpowers/`.

## Security model

The relay holds no keys and stores nothing; clips are encrypted client-side and bound to their room and message id (AES-GCM AAD) to prevent cross-room replay. For the strongest guarantee use **Mode A**, where the secret never leaves your browser. This is a v0.1 hobby project, not an audited product — review the code before trusting it with sensitive data.
