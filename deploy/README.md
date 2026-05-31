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

## Notes

- `reverse_proxy` forwards the `/ws/*` WebSocket upgrade automatically — no
  special directive needed.
- Scaling beyond one machine would require sticky sessions or a shared pub/sub
  bus: the relay fans out within a single process only. v0.1 is single-instance
  by design.
