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

### Testing across devices

`localhost` is a secure context, so the clipboard works on the machine running the dev server. **Other devices need HTTPS** — `navigator.clipboard` is unavailable over plain `http://<lan-ip>`, so clips silently won't sync there. The simplest way to get a trusted cert without configuring each device is [Tailscale](https://tailscale.com) `serve`:

```bash
# build + run the production container (SPA + relay on one port)
docker build -t uniclip:dev .
docker run -d --rm -p 3000:3000 --name uniclip uniclip:dev

# expose it over your tailnet with automatic HTTPS (tailnet-only, not public)
tailscale serve --bg 3000
# → open https://<machine>.<tailnet>.ts.net on any device signed into the tailnet
```

- **If another service already holds `:443`** on the host, pick a free port: `tailscale serve --bg --https=8443 3000` → `https://<machine>.<tailnet>.ts.net:8443`. A custom HTTPS port is still a secure context.
- **`tailscale serve` needs a cert** from Let's Encrypt; on a network that can't reach it, provision once through a tailnet exit node with clean egress (`tailscale set --exit-node=<node>`, then `tailscale cert <machine>.<tailnet>.ts.net`, then clear it) — the cert is cached afterward.
- The SPA is origin-relative, so **no `VITE_RELAY_BASE` is needed** — it connects back to whatever host served it (`http→ws`, `https→wss`).
- Stop with `tailscale serve --https=<port> off`.

## Production (single container)

The multi-stage `Dockerfile` builds the SPA and the relay, then serves both from one Bun process:

```bash
docker build -t uniclip:dev .
docker run --rm -p 3000:3000 uniclip:dev
# → http://localhost:3000 serves the API, the SPA, and /api/metrics
```

For a self-hosted VPS, see [`deploy/`](deploy/README.md): a `docker-compose.yml` that puts the relay behind [Caddy](https://caddyserver.com) for automatic HTTPS, plus a standalone Caddyfile snippet for hosts already running Caddy. **HTTPS is required off `localhost`** — the clipboard API only works in a secure context. CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, and the Playwright e2e on every push; deployment is manual.

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
