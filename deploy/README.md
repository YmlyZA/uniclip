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

### Updating a running deploy

After the first deploy the Caddyfile block is already in place, so updates only
rebuild the image and recreate the relay — Caddy is never touched. The first
deploy writes the detected Caddy network to `deploy/relay.env` (git-ignored), so
updates are **zero-config**:

```bash
git pull && sudo ./deploy/update.sh
```

`update.sh` reads `CADDY_NET` from `deploy/relay.env`, computes `GIT_SHA`, and
runs the relay-only compose stack — declarative and idempotent (it recreates the
container only when the image actually changed). The equivalent explicit command,
if you prefer plain `docker compose`:

```bash
GIT_SHA=$(git rev-parse --short HEAD) \
  docker compose --env-file deploy/relay.env -f deploy/docker-compose.relay.yml up -d --build
```

`docker-compose.relay.yml` is relay-only and attaches to your **existing** Caddy
network (unlike `docker-compose.yml`, which bundles its own Caddy for a fresh
host). If `deploy/relay.env` is missing (a manual setup that never ran the
script), create it with one line — `CADDY_NET=<your-caddy-docker-network>` — or
set `CADDY_NET` in the shell. Find the network in the first deploy's summary
(`network: ...`) or via `docker inspect <caddy> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'`.

**One-time handoff (first switch to compose).** The first deploy created the
`uniclip` container with `docker run`, which compose won't adopt. Do this once:

```bash
docker rm -f uniclip   # metadata lives in the uniclip_rooms VOLUME, not the container — nothing is lost
```

then run the compose command above. Every later update is just that one command.

> **Don't mix run-based and compose-based updates.** Container names are globally
> unique, so a `docker run`-managed `uniclip` and a compose-managed one conflict.
> Once you've handed off to compose, stick with it.

**Fallback — `vps-caddy.sh --update`.** If you haven't handed off yet, or want the
script to health-check the deploy for you, `sudo ./deploy/vps-caddy.sh <domain>
--update` also rebuilds + recreates the relay (run-based) and skips the Caddyfile
edit. It's the `docker run` path — don't alternate it with the compose command above.

Both preserve the `uniclip_rooms` volume, so room URLs survive. `/api/version`
reflects the new build (set `GIT_SHA` for an accurate sha).

**Build speed.** The image build uses BuildKit dependency caching and a
manifest-first layer order, so a rebuild that doesn't change `packages/` reuses
the cached `pnpm install` and CLI stages — only the changed part rebuilds. The
slowest step is the 4-platform CLI cross-compile (it refreshes the downloadable
`/setup.sh` binaries); to skip it for a quick update, pass an empty `CLI_TARGETS`
— the served `/dl` binaries then stay empty until a full build:

```bash
CLI_TARGETS="" sudo ./deploy/update.sh
```

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

## Releasing

Versions are semver from the root `package.json`; the deployed instance's update
check compares against the **latest GitHub release**.

To cut a release:
```bash
# 1. bump the root version
npm version --no-git-tag-version <major|minor|patch>   # edits package.json only
# 2. commit, tag, push
git commit -am "chore: release vX.Y.Z"
git tag vX.Y.Z && git push && git push --tags
# 3. publish the GitHub release (this is what instances compare against)
gh release create vX.Y.Z --title vX.Y.Z --generate-notes
```

The running version shows in the web footer and `uniclip --version` as
`vX.Y.Z (<git-sha>)`. An instance polls `https://api.github.com/repos/YmlyZA/uniclip/releases/latest`
hourly (server-side); disable with `UPDATE_CHECK=off`, or point at a fork with
`UPDATE_REPO=owner/name`.

## Self-hosted TURN (optional)

By default, uniclip clients use Google's STUN server (for NAT traversal) and fall
back to the relay for media. To fully control media routing and enable peer-to-peer
connectivity on restricted networks, deploy a self-hosted TURN server (coturn).

### Setup

1. **Generate a shared secret:**
   ```bash
   openssl rand -hex 32
   ```
   Save the output (e.g. `abc123def456...`).

2. **Configure coturn:**
   - Edit `deploy/coturn/turnserver.conf`
   - Replace `REPLACE_WITH_TURN_SECRET` with your secret from step 1
   - Replace `REPLACE_WITH_DOMAIN` with your domain (e.g. `turn.example.com`)
   - For TLS support (`turns:`), uncomment and update the cert/key paths

3. **Start coturn:**
   ```bash
   docker compose -f docker-compose.turn.yml up -d
   ```

4. **Configure the relay:**
   Set these environment variables on the relay:
   - `TURN_SECRET=<your-secret-from-step-1>`
   - `TURN_URLS=turn:<domain>:3478,turns:<domain>:5349,stun:<domain>:3478`
   - Optionally: `TURN_TTL=86400` (default, credential lifetime in seconds)

5. **Open firewall ports:**
   - UDP `3478` (STUN/TURN)
   - UDP `49160–49200` (TURN media relay range)
   - TCP `5349` (TURNS/TLS, if enabled)

6. **Verify:**
   - Use [Trickle-ICE](https://webrtc.github.io/samples/web/content/trickleice/) (webrtc.github.io/samples) to test candidate gathering — you should see a `relay` candidate.
   - Or test with coturn's built-in tool:
     ```bash
     turnutils_uclient -v -t -u <username> -w <credential> <domain>
     ```
     where username and credential come from `GET /api/ice` on the relay.

### Notes

- If `TURN_*` env vars are unset, clients default to Google STUN (no regression).
- `TURN_SECRET` is never logged or returned by the relay.
- TURN credentials are time-limited (default `TURN_TTL=86400`, one day); the relay
  mints fresh credentials per `GET /api/ice` call using the REST auth scheme.
- TURN relays encrypted DTLS only — it never sees plaintext or keys.
