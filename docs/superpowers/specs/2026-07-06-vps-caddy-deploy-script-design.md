# Uniclip — Option-B VPS deploy script (`deploy/vps-caddy.sh`) — Design Spec

**Date:** 2026-07-06
**Status:** Approved (pending spec review)
**Scope:** A single script that automates the "Option B" VPS deploy — the uniclip relay behind an **existing** reverse proxy — packaging the manual steps into a detect → confirm → build → run → wire → verify flow. It fully automates the **Dockerized Caddy** case (the target environment) and **guides** the host/systemd Caddy case. Reference material already exists: `deploy/docker-compose.yml` (Option A, bundled Caddy), `deploy/Caddyfile.host-snippet` (Option B reference block), `deploy/lan-https/setup.sh` (style precedent).

## 1. Goals and non-goals

### Goals
1. One command stands up (or updates) the relay behind an existing Caddy and serves it at a domain over the existing Caddy's HTTPS, with room-metadata persistence.
2. Detect the environment (Caddy install method, container, network, Caddyfile location) and **confirm with the user** before making changes.
3. Edit the production Caddy config **safely**: backup, idempotent marker-delimited block, `caddy validate`, reload, auto-rollback on failure.
4. Verify end to end (relay reachable from Caddy's network + public HTTPS health) and print a clear summary.
5. Re-runnable: a second run updates in place (rebuild image, recreate relay, update the block between markers) without duplicating config.

### Non-goals / preserved invariants
- **No change to the relay or app.** This is deploy tooling; the container is the same `Dockerfile` image.
- **No Option-A behavior.** This script never runs its own Caddy or binds host 80/443; it assumes an existing proxy owns those.
- **Host/systemd Caddy is guided, not auto-edited.** The script builds + runs the relay and *prints* the site block + `systemctl reload caddy` for that path (it never edits host-managed files). Only the Docker-Caddy path auto-edits config.
- **No multi-host / scaling.** Single relay container, matching the relay's single-process fan-out.
- **No secret handling.** The relay is zero-knowledge; the script deals only with domain, container, and network names — never keys or room content.

## 2. Invocation

```bash
sudo ./deploy/vps-caddy.sh <domain>            # e.g. clip.example.com  (or DOMAIN=<domain> env)
sudo ./deploy/vps-caddy.sh <domain> --dry-run  # print every action; make NO changes
sudo ./deploy/vps-caddy.sh <domain> --yes      # skip interactive confirmations (assume detected values)
```

- Bash, `#!/usr/bin/env bash`, `set -euo pipefail`. House style matches `lan-https/setup.sh` (`command -v` guards, idempotent steps, a boxed summary at the end).
- Domain is required (positional arg or `DOMAIN` env); missing → usage error.
- `sudo`/root may be needed for the Caddyfile edit and Docker access; the script checks Docker reachability up front and errors clearly if not.
- `--dry-run` prints the exact commands/edits it *would* run and exits having changed nothing (validated locally as the primary test path).
- `--yes` accepts the auto-detected container/network/Caddyfile without prompting (for non-interactive re-runs); default is interactive confirmation.

## 3. Detection & confirmation

1. **Preflight:** `docker` present and daemon reachable; domain provided; repo root resolved from the script location (`$(cd "$(dirname "$0")/.." && pwd)`).
2. **Caddy install method:**
   - Look for a running **Caddy container**: `docker ps` filtered to images matching `caddy`. If ≥1 → **Docker path** (if >1, list and prompt the user to pick).
   - Else probe the **host**: `command -v caddy` and `systemctl is-active caddy` → **host path**.
   - Neither → error referencing `deploy/README.md` (they may want Option A instead).
3. **Docker path — detect + confirm each** (skip prompts under `--yes`, using the detected value):
   - **Network:** `docker inspect <caddy> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'`. One → propose it; multiple → prompt to pick. **Guard:** if the only network is the default `bridge`, abort with guidance (container-name DNS doesn't work on the default bridge; user must attach both to a user-defined network — print the `docker network create` + `docker network connect` commands).
   - **Caddyfile location:** from `docker inspect <caddy> --format '{{range .Mounts}}{{.Source}}::{{.Destination}}{{"\n"}}{{end}}'`, pick the mount whose Destination is a Caddyfile (`/etc/caddy/Caddyfile`, or ends in `Caddyfile`/`.caddy`). Record **host path** (Source, to edit) and **container path** (Destination, for `caddy validate`/`reload`). Ambiguous/none → prompt for the host path.
   - Print a summary of all detected values and ask to proceed (unless `--yes`).

## 4. Build & run the relay (safe, reversible)

- **Build:** `docker build -t uniclip:latest "$REPO_ROOT"`.
- **Run (idempotent):** if a container named `uniclip` exists, `docker rm -f uniclip` first (update path), then:
  - **Docker path:** `docker run -d --name uniclip --restart=unless-stopped --network <net> -e ROOM_DB_PATH=/data/rooms.db -v uniclip_rooms:/data uniclip:latest` — no published host port; only Caddy reaches it over the shared network.
  - **Host path:** same but `-p 127.0.0.1:3000:3000` and no `--network`.
- Room metadata persists in the `uniclip_rooms` volume across restarts (metadata only — never frames/keys/history).

## 5. Caddy config injection (Docker path: auto-edit + safety net)

- **Backup:** copy the host Caddyfile to `<caddyfile>.bak-<timestamp>` (timestamp from `date +%Y%m%d-%H%M%S`) before touching it.
- **Block** (marker-delimited so re-runs update in place, never duplicate):
  ```caddyfile
  # >>> uniclip (managed by deploy/vps-caddy.sh) >>>
  <domain> {
      encode zstd gzip
      reverse_proxy uniclip:3000
  }
  # <<< uniclip <<<
  ```
- **Idempotent write:** if the `>>> uniclip` / `<<< uniclip` markers exist, replace everything between them (handles a changed domain); else append the block. Implemented with `awk` (delete old block by markers, then append) — no reliance on the block's inner content.
- **Validate:** `docker exec <caddy> caddy validate --config <container-path> --adapter caddyfile`. On failure → **restore the backup** and abort with the validate output.
- **Reload:** `docker exec <caddy> caddy reload --config <container-path> --adapter caddyfile`. On failure → restore the backup and `caddy reload` the old config, then abort.
- **Host path:** after build + run (loopback), **print** the same block (with `reverse_proxy 127.0.0.1:3000`) and the `systemctl reload caddy` steps for the user to apply. No host-file edits.

## 6. Verify (both paths)

- **Internal reachability:** `docker exec <caddy> wget -qO- http://uniclip:3000/api/health` (Docker path) → expect `{"ok":true...}`; proves Caddy can resolve+reach the relay over the network.
- **Public HTTPS:** `curl -fsS https://<domain>/api/health`, retried a handful of times with a short sleep (first-issue cert lag) → expect `{"ok":true...}`.
- **Cert log:** grep the Caddy log (`docker logs <caddy> --tail 50`) for the issued cert / any ACME error, and surface it.
- **Summary:** a boxed final report — the live URL, the relay container name, the network, the Caddyfile edited + its backup path, and the room-persistence volume. On any failure, a clear message with the failing step and (for config edits) confirmation the backup was restored.

## 7. Idempotency, failure handling, testing

- **Re-run = update:** rebuild image, `rm -f` + re-run the relay, replace the marker block, re-validate/reload. No duplication, no manual cleanup between runs.
- **Failure isolation:** build/run failures abort before touching Caddy config; config-edit failures always restore the backup before exiting non-zero.
- **`--dry-run`** prints each command/edit and exits with no side effects — the primary local test path.
- **Testing:** `shellcheck` clean; `--dry-run` exercised locally against fabricated `docker inspect` output where feasible; the real end-to-end run is on the user's VPS. No unit-test framework for shell in this repo — the safety net (backup/validate/rollback/dry-run) is the correctness guarantee.

## 8. Deliverables

1. `deploy/vps-caddy.sh` — the script (single file, sections mirroring §3–§6).
2. `deploy/README.md` — a short "Option B, automated" subsection pointing at the script, its flags, and the default-bridge caveat.

## 9. Decomposition (for the plan)

1. **Skeleton + args + preflight** — shebang, `set -euo pipefail`, arg/flag parsing (`<domain>`, `--dry-run`, `--yes`, `DOMAIN` env), Docker reachability + repo-root resolution, usage/errors. A `run()` wrapper that echoes-only under `--dry-run`.
2. **Detection** — Caddy method (docker/host/none), container pick, network detect + bridge guard, Caddyfile host/container path detect, confirmation prompt.
3. **Build & run relay** — build image; idempotent `rm -f` + `run` for docker (network) and host (loopback) wiring.
4. **Caddy injection + safety net** — backup, awk marker upsert, validate, reload, rollback (docker path); print guided block (host path).
5. **Verify + summary + README** — internal + public health checks with retry, cert-log grep, boxed summary; README subsection.

Order 1→5; each step is independently runnable/observable via `--dry-run`.
