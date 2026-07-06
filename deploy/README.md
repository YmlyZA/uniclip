# Deploying uniclip

uniclip ships as **one stateless container** (`../Dockerfile`) that serves the
SPA, the JSON API, and the WebSocket on a single port (`:3000`). The relay holds
no plaintext, no keys, and persists nothing — rooms live in memory and are
garbage-collected by idle timeout / max age.

> **HTTPS is mandatory off `localhost`.** The clipboard UI uses
> `navigator.clipboard`, which browsers only expose in a *secure context*:
> HTTPS, or `localhost`/`127.0.0.1`. Over plain `http://<vps-ip>` the page loads
> but the clipboard silently never reads. Both recipes below terminate TLS.

## Local smoke test (no TLS needed — localhost is a secure context)

```bash
# from the repo root
docker build -t uniclip:latest .
docker run --rm -p 3000:3000 uniclip:latest
# open http://localhost:3000
```

## VPS, option A — bundled relay + Caddy (auto HTTPS)

Use this when the host has **no** web server yet. Point your domain's A/AAAA
record at the host first, then:

```bash
# from this deploy/ directory
DOMAIN=clip.example.com docker compose up -d --build
```

Caddy obtains and auto-renews a Let's Encrypt cert for `$DOMAIN`. Certs persist
in the `caddy_data` volume across restarts. Files: `docker-compose.yml` +
`Caddyfile`.

## VPS, option B — you already run Caddy on the host

Use `Caddyfile.host-snippet`: run the relay bound to loopback and add one
`reverse_proxy` block to your existing host Caddy. See that file for the exact
`docker run` line and config block.

### Option B, automated (`vps-caddy.sh`)

For a Dockerized Caddy, `deploy/vps-caddy.sh` does Option B end to end — detects
the Caddy container, network, and Caddyfile; builds and runs the relay on that
network (room metadata persisted); inserts a marker-delimited site block with a
backup + `caddy validate` + reload + auto-rollback; then health-checks the relay
and the public URL.

```bash
sudo ./deploy/vps-caddy.sh clip.example.com            # deploy (or update — it's idempotent)
sudo ./deploy/vps-caddy.sh clip.example.com --dry-run  # preview every change, make none
```

Notes:
- If Caddy is on Docker's default `bridge` network the script stops with
  `docker network create`/`connect` guidance (the default bridge has no
  container-name DNS, so `reverse_proxy uniclip:3000` can't resolve).
- A **host/systemd** Caddy is detected too, but there the script builds+runs the
  relay on `127.0.0.1:3000` and prints the block + `systemctl reload caddy` for
  you to apply (it never edits host-managed files).
- Re-run to update; the block is replaced between its markers, never duplicated.

## Room persistence (surviving restarts)

By default the relay holds everything in memory, so a restart invalidates active
room URLs (clients reconnect, get `4404`, and must mint a new room). The compose
stack opts into durability by setting `ROOM_DB_PATH=/data/rooms.db` on a mounted
`room_data` volume. Only room **metadata** (`id`, `mode`, `expiresAt`,
`backfillEnabled`, `createdAt`) is stored — never clipboard frames, keys,
sockets, or the backfill buffer. After a redeploy, existing URLs stay valid and devices
reconnect automatically; history still exists only while a device is connected.

A bare `docker run` without `ROOM_DB_PATH` keeps the original in-memory behavior.

## Notes

- `reverse_proxy` forwards the `/ws/*` WebSocket upgrade automatically — no
  special directive needed.
- Scaling beyond one machine would require sticky sessions or a shared pub/sub
  bus: the relay fans out within a single process only. v0.1 is single-instance
  by design.
