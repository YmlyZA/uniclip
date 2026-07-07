# uniclip

End-to-end-encrypted universal clipboard. Copy on one device, paste on another — in your browser or your terminal — through a relay that **never sees your plaintext or your key**, and increasingly not at all: content travels **peer-to-peer**, and two CLIs can sync with **no internet whatsoever**.

- 🔒 **End-to-end encrypted** — AES-256-GCM, keys derived with PBKDF2; the secret never leaves your device.
- 🕳️ **Zero-knowledge relay** — the server only fans out opaque ciphertext and signaling; it stores no plaintext, keys, or frames.
- ⚡ **Peer-to-peer fast path** — content rides a WebRTC data channel directly between devices (LAN-direct where possible); the relay is just signaling + fallback. The app-layer envelope sits on top of DTLS, so clips stay opaque on every path. An optional self-hosted TURN server extends the Direct path to strict-NAT / cellular networks.
- 📋 **Text, files, and synced delete** — chunked binary file transfer (drag-and-drop in the web app) and deletes that propagate to every peer.
- 👥 **Named device roster** — see who's connected, via encrypted presence the relay can't read.
- 🔗 **Pair by link/QR or by code** — share a room and sync instantly.
- 🖥️ **Browser or CLI** — a zero-install web app, plus an Ink terminal client.
- 📡 **Zero-internet LAN mode** — `uniclip --lan` hosts an offline room discovered over mDNS; two CLIs sync with no relay and no internet at all.
- 🏠 **Self-hostable** — one container serves the API + SPA; deploy behind Caddy with automatic HTTPS and one-command updates, an optional self-hosted TURN, and built-in version/update detection.

> Status: E2EE text + files + synced delete, a WebRTC peer-to-peer fast path, a browser and a CLI client, and offline LAN sync. A hobby project, not an audited product.

## How it works

```
 Device A  ⇄  relay (Bun + Hono, in-memory)  ⇄  Device B
    │         · exchanges WebRTC signaling         │
    │         · forwards opaque ciphertext (fallback)
    └──────────── WebRTC data channel ─────────────┘
                  encrypted clips & files, LAN-direct
```

The relay's role is deliberately small: it pairs two devices, relays the WebRTC handshake, and — until the peer-to-peer channel opens, or if it never does — forwards opaque ciphertext. Once the data channel is up, clips and files travel **device-to-device** and the relay sees only that two opaque peers are talking. A `Direct` / `Relayed` indicator shows which path is live.

Two pairing modes:

- **Mode A — zero-knowledge (recommended).** The room link is `https://<host>/r/<routingId>#<secret>`. The `#secret` is the key material; browsers never send a URL fragment to the server, so the relay literally cannot decrypt your clips. Share via link or QR.
- **Mode B — typed code.** A short code you can read aloud — a random 6-character one, or **your own custom code**. The key is derived from the code, which the server sees, so it is **less secure**; because the code *is* the key, the create screen shows a strength meter and warns that anyone who guesses it can read the room. Convenient when you can't share a link.

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

### CLI

`apps/cli` is an [Ink](https://github.com/vadimdemedes/ink) terminal client (Node ≥ 22) that joins the same Mode-A rooms and syncs text and files, with the same end-to-end encryption and real peer-to-peer transport (via the pure-TypeScript [werift](https://github.com/shinyoshiaki/werift-webrtc) WebRTC stack). It builds to an `npx`-able `uniclip` bin; from the repo, run it through the dev script:

```bash
# create a room (prints a QR to scan from another device)
pnpm --filter @uniclip/cli dev

# join an existing room
pnpm --filter @uniclip/cli dev <room-url>

# zero-internet: host an offline LAN room (no relay, no internet) …
pnpm --filter @uniclip/cli dev -- --lan
# … then join it from another terminal on the same network
pnpm --filter @uniclip/cli dev <lan-token>
```

In `--lan` mode the host mints a room locally, runs a tiny embedded relay, advertises it over mDNS, and shows a `uniclip+lan://…` pairing QR. A joiner discovers the host on the LAN and connects — syncing peer-to-peer with no internet at all. The secret rides only in the QR, never in the mDNS advert. (CLI↔CLI only: a browser can't run an mDNS responder, and LAN-HTTP isn't a secure context.)

### Install the CLI (no Node required)

From any running relay, install a standalone `uniclip` binary for your platform:

```bash
curl -O http://<host>:<port>/setup.sh && sh setup.sh
```

It downloads the right binary (macOS/Linux, arm64/x64), verifies its checksum, and installs it to `~/.local/bin/uniclip`. **Over plain HTTP this is MITM-able** — fine for a trusted/LAN relay, but use HTTPS (e.g. the `tailscale serve` setup above) for anything internet-exposed. For local dev without installing, `pnpm --filter @uniclip/cli dev` still works.

### Testing across devices (browser)

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

For two devices on the **same LAN with no internet**, skip all of this and use the CLI's `--lan` mode above.

## Self-hosting

uniclip is built to be self-hosted and disposable. The multi-stage `Dockerfile` builds the SPA and the relay and serves both from one Bun process:

```bash
docker build -t uniclip:dev .
docker run --rm -p 3000:3000 uniclip:dev
# → http://localhost:3000 serves the API, the SPA, /api/metrics, and /setup.sh
```

**Behind a reverse proxy (recommended).** [`deploy/`](deploy/README.md) has a VPS setup behind [Caddy](https://caddyserver.com) with automatic HTTPS — a self-contained `docker-compose.yml` (relay + Caddy) for a fresh host, and `vps-caddy.sh` to slot the relay into a Caddy you already run. **HTTPS is required off `localhost`** (the clipboard API needs a secure context). The relay derives its per-IP `/api/room` rate limit from `x-forwarded-for`, so **run it behind a proxy that sets a trustworthy client IP** (the provided Caddy config does); exposed directly, the header is spoofable.

**One-command updates.** After the first deploy, update with `docker compose -f deploy/docker-compose.relay.yml up -d --build` (a one-time `docker rm -f uniclip` hands the container off from the first run-based deploy). BuildKit caching keeps rebuilds fast. Room URLs survive — only room *metadata* is persisted, on a volume. `vps-caddy.sh --update` is a run-based fallback (don't alternate the two). See [deploy/README.md → Updating](deploy/README.md#updating-a-running-deploy).

**Optional self-hosted TURN.** For Direct (peer-to-peer) connections across strict NAT / CGNAT / cellular, run coturn from [`docker-compose.turn.yml`](docker-compose.turn.yml) and set `TURN_URLS` + `TURN_SECRET` on the relay; it then mints short-lived credentials at `GET /api/ice`. Unset, clients use public STUN and TURN is simply off — nothing else changes. TURN only ever relays encrypted DTLS, so it stays zero-knowledge. See [deploy/README.md → Self-hosted TURN](deploy/README.md#self-hosted-turn-optional).

**Versioning & update detection.** Each instance reports its version at `GET /api/version` and shows it in the footer; the relay can check GitHub Releases for a newer tag (`UPDATE_CHECK`, `UPDATE_REPO`) and the UI flags when an update is available. CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, and the Playwright e2e on every push; deployment is manual.

## Repository layout

| Path | What |
|---|---|
| `packages/protocol` | Zod wire-frame schemas (single source of truth) |
| `packages/crypto` | AES-GCM envelope, PBKDF2 key derivation, replay protection |
| `packages/room-code` | Room-URL parsing + Mode A/B code generation |
| `packages/client-core` | `UniclipClient` — connect, encrypt/decrypt, reconnect, WebRTC transport, file transfer, presence |
| `apps/relay` | Bun + Hono relay: WebSocket fan-out, WebRTC signaling, rate limits, metrics, static SPA |
| `apps/web` | Svelte 5 + Vite + Tailwind front end |
| `apps/cli` | Node + Ink terminal client: real P2P (werift), zero-internet LAN mode |
| `e2e` | Playwright two-browser sync test |

## Development

```bash
pnpm typecheck        # all packages
pnpm test             # unit tests (excludes e2e)
pnpm test:e2e         # Playwright two-browser test
pnpm lint
```

Relay tests run under Bun; the rest under Node. See [`CLAUDE.md`](./CLAUDE.md) for architecture details and toolchain notes. Design specs and implementation plans live under `docs/superpowers/`.

## Security model

The relay holds no keys and stores no plaintext, ciphertext, or frames; clips are encrypted client-side and bound to their room and message id (AES-GCM AAD) to prevent cross-room replay. When content travels peer-to-peer, the same app-layer envelope rides on top of WebRTC's DTLS, so it stays opaque on the direct path too. WebRTC signaling and encrypted presence are forwarded but never buffered or persisted. For the strongest guarantee use **Mode A**, where the secret never leaves your device — including the CLI's offline LAN mode, where it lives only in the pairing QR. This is a hobby project, not an audited product — review the code before trusting it with sensitive data.
