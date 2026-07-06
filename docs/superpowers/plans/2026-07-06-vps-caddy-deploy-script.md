# Option-B VPS Deploy Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single bash script, `deploy/vps-caddy.sh`, that deploys the uniclip relay behind an existing Caddy (Option B) — detect → confirm → build → run → wire → verify — fully automating the Dockerized-Caddy case and guiding the host/systemd case.

**Architecture:** One bash file of sourceable functions plus a `main` guarded by a `BASH_SOURCE == $0` check (so functions are testable without running the flow). A `run()` wrapper gates every *mutating* command behind `--dry-run`; read-only detection (`docker ps`/`inspect`) always runs. The only non-trivial pure logic — the marker-delimited Caddyfile block upsert — has a committed assertion test (`deploy/vps-caddy.test.sh`).

**Tech Stack:** Bash (`set -euo pipefail`), Docker CLI, awk. No package/test framework — verification is `shellcheck` + `--dry-run` + the upsert test.

## Global Constraints

- **File:** `deploy/vps-caddy.sh`, `#!/usr/bin/env bash`, `set -euo pipefail`. House style matches `deploy/lan-https/setup.sh` (`command -v` guards, idempotent steps, boxed summary).
- **Invocation:** `sudo ./deploy/vps-caddy.sh <domain> [--dry-run] [--yes]`; domain also accepted via `DOMAIN=` env. Domain required.
- **`--dry-run`** prints every mutating action and makes NO changes. **`--yes`** accepts auto-detected container/network/Caddyfile without prompting.
- **Docker path is auto-edited with a safety net** (backup → validate → reload → rollback). **Host path is guided only** — build+run relay, then print the block + `systemctl reload caddy`; never edit host-managed files.
- **Relay run:** container name `uniclip`, image `uniclip:latest`, `-e ROOM_DB_PATH=/data/rooms.db -v uniclip_rooms:/data`. Docker path: `--network <caddy-net>`, no host port. Host path: `-p 127.0.0.1:3000:3000`.
- **Marker block** (exact):
  ```
  # >>> uniclip (managed by deploy/vps-caddy.sh) >>>
  <domain> {
      encode zstd gzip
      reverse_proxy <target>
  }
  # <<< uniclip <<<
  ```
  Docker target `uniclip:3000`; host target `127.0.0.1:3000`.
- **Default-`bridge` guard:** if Caddy's only network is `bridge`, abort with `docker network create`/`connect` guidance (no container-name DNS on the default bridge).
- **Idempotent:** re-running rebuilds the image, `rm -f`+re-runs the relay, and replaces the block between markers (never duplicates).
- Every task ends: `shellcheck deploy/vps-caddy.sh` clean (install `brew install shellcheck` if missing; floor is `bash -n`).

---

### Task 1: Skeleton — helpers, arg parsing, preflight, source guard

**Files:**
- Create: `deploy/vps-caddy.sh`

**Interfaces:**
- Produces (used by later tasks): globals `DRY_RUN` `ASSUME_YES` `DOMAIN` `SCRIPT_DIR` `REPO_ROOT`; helpers `log()` `warn()` `die()` `run()` `confirm()`; `parse_args()`; `preflight()`; `main()`; source guard.
- `run()` executes its args, or under `--dry-run` prints `[dry-run] <cmd>` and returns 0. Read-only detection must NOT be wrapped in `run()`.

- [ ] **Step 1: Write the script skeleton**

Create `deploy/vps-caddy.sh`:

```bash
#!/usr/bin/env bash
#
# Deploy the uniclip relay behind an EXISTING Caddy (Option B).
# Docker Caddy: fully automated (network attach + Caddyfile edit + reload).
# Host/systemd Caddy: builds+runs the relay, then prints the block to add.
# See docs/superpowers/specs/2026-07-06-vps-caddy-deploy-script-design.md
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=0
ASSUME_YES=0
DOMAIN="${DOMAIN:-}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Gate MUTATING commands so --dry-run can skip them. Read-only detection
# (docker ps/inspect) is deliberately NOT wrapped — it always runs.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\033[2m[dry-run]\033[0m %s\n' "$*"
    return 0
  fi
  "$@"
}

# confirm "question" -> 0 (yes) / 1 (no). Auto-yes under --yes.
confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  local reply
  printf '%s [y/N] ' "$1" >&2
  read -r reply || true
  case "$reply" in [yY] | [yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

usage() {
  cat <<'EOF'
Usage: deploy/vps-caddy.sh <domain> [--dry-run] [--yes]

Deploy the uniclip relay behind an EXISTING Caddy (Option B).
  <domain>     hostname to serve, e.g. clip.example.com (or set DOMAIN=)
  --dry-run    print every change without making it
  --yes, -y    accept auto-detected container/network/Caddyfile without prompting
  -h, --help   this help
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --yes | -y) ASSUME_YES=1 ;;
      -h | --help) usage; exit 0 ;;
      -*) usage; die "unknown flag: $1" ;;
      *) if [ -z "$DOMAIN" ]; then DOMAIN="$1"; else die "unexpected argument: $1"; fi ;;
    esac
    shift
  done
  [ -n "$DOMAIN" ] || { usage; die "domain is required"; }
}

preflight() {
  command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
  docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon (try sudo, or add your user to the docker group)"
  log "domain: $DOMAIN"
  log "repo:   $REPO_ROOT"
  [ "$DRY_RUN" -eq 1 ] && log "DRY RUN — no changes will be made"
}

main() {
  parse_args "$@"
  preflight
  # detection / build / run / inject / verify are added in later tasks
}

# Only run main when executed directly; sourcing (e.g. the test) just defines fns.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
```

- [ ] **Step 2: Make executable + shellcheck**

Run:
```bash
chmod +x deploy/vps-caddy.sh
shellcheck deploy/vps-caddy.sh    # or: bash -n deploy/vps-caddy.sh
```
Expected: no findings (exit 0).

- [ ] **Step 3: Exercise the skeleton**

Run:
```bash
deploy/vps-caddy.sh --help                 # prints usage, exit 0
deploy/vps-caddy.sh 2>&1 || true           # "error: domain is required" + usage
deploy/vps-caddy.sh clip.example.com --dry-run   # preflight prints domain/repo + DRY RUN, then exits 0
```
Expected: help prints; missing-domain errors clearly; the dry-run prints the two `==>` lines and the DRY RUN notice (requires Docker daemon reachable; if not, it dies at preflight with the daemon message — that is correct).

- [ ] **Step 4: Commit**

```bash
git add deploy/vps-caddy.sh
git commit -m "feat(deploy): vps-caddy.sh skeleton — args, preflight, dry-run/run helpers"
```

---

### Task 2: Detection & confirmation

**Files:**
- Modify: `deploy/vps-caddy.sh` (add detection functions; call them in `main`)

**Interfaces:**
- Consumes: `run()` (not used here — detection is read-only), `confirm()`, `die()`, `warn()`, `log()`, `ASSUME_YES`, `DOMAIN`.
- Produces: globals `CADDY_MODE` (`docker`|`host`), `CADDY_CONTAINER`, `CADDY_NET`, `CADDYFILE_HOST`, `CADDYFILE_CTR`; functions `pick_one()`, `detect_caddy()`, `detect_network()`, `detect_caddyfile()`, `confirm_plan()`.

- [ ] **Step 1: Add detection functions**

Insert these functions in `deploy/vps-caddy.sh` after `preflight()` (before `main()`):

```bash
CADDY_MODE=""      # "docker" | "host"
CADDY_CONTAINER="" # docker path
CADDY_NET=""       # docker path
CADDYFILE_HOST=""  # host path to edit (docker path)
CADDYFILE_CTR=""   # path inside the container for validate/reload

# pick_one "label" "space/newline-separated list" -> echoes the chosen value.
# One item -> that item. --yes -> first. Else prompts (prompt to stderr).
pick_one() {
  local label="$1" list="$2" arr sel i=1
  # shellcheck disable=SC2206
  arr=($list)
  if [ "${#arr[@]}" -le 1 ]; then printf '%s' "${arr[0]:-}"; return; fi
  if [ "$ASSUME_YES" -eq 1 ]; then printf '%s' "${arr[0]}"; return; fi
  printf 'Multiple %s found:\n' "$label" >&2
  for x in "${arr[@]}"; do printf '  %d) %s\n' "$i" "$x" >&2; i=$((i + 1)); done
  printf 'Pick %s [1]: ' "$label" >&2
  read -r sel || true
  sel="${sel:-1}"
  printf '%s' "${arr[$((sel - 1))]}"
}

detect_caddy() {
  local cands
  cands="$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /caddy/ {print $1}')"
  if [ -n "$cands" ]; then
    CADDY_MODE="docker"
    CADDY_CONTAINER="$(pick_one "Caddy container" "$cands")"
    log "Caddy: docker container '$CADDY_CONTAINER'"
    return
  fi
  if command -v caddy >/dev/null 2>&1 && systemctl is-active --quiet caddy 2>/dev/null; then
    CADDY_MODE="host"
    log "Caddy: host (systemd)"
    return
  fi
  die "no running Caddy found (no caddy container, no active systemd caddy).
For a host with no proxy yet, use Option A instead: deploy/docker-compose.yml (see deploy/README.md)."
}

detect_network() {
  local nets
  nets="$(docker inspect "$CADDY_CONTAINER" \
    --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | grep -v '^$' || true)"
  CADDY_NET="$(pick_one "Caddy network" "$nets")"
  [ -n "$CADDY_NET" ] || die "could not determine $CADDY_CONTAINER's Docker network"
  if [ "$CADDY_NET" = "bridge" ]; then
    die "Caddy is on Docker's default 'bridge' network — it has no container-name DNS,
so 'reverse_proxy uniclip:3000' can't resolve. Put both on a user-defined network first:
    docker network create uniclip-net
    docker network connect uniclip-net $CADDY_CONTAINER
then re-run this script (it will attach the relay to uniclip-net)."
  fi
  log "Caddy network: $CADDY_NET"
}

detect_caddyfile() {
  local line src dst
  while IFS= read -r line; do
    src="${line%%::*}"; dst="${line##*::}"
    case "$dst" in
      /etc/caddy/Caddyfile | */Caddyfile | *.caddy)
        CADDYFILE_HOST="$src"; CADDYFILE_CTR="$dst"; break ;;
    esac
  done < <(docker inspect "$CADDY_CONTAINER" \
    --format '{{range .Mounts}}{{.Source}}::{{.Destination}}{{"\n"}}{{end}}')
  if [ -z "$CADDYFILE_HOST" ]; then
    warn "couldn't detect the Caddyfile from $CADDY_CONTAINER's mounts."
    printf 'Enter the HOST path to the Caddyfile Caddy uses: ' >&2
    read -r CADDYFILE_HOST || true
    [ -n "$CADDYFILE_HOST" ] || die "no Caddyfile path given"
    CADDYFILE_CTR="/etc/caddy/Caddyfile"
    warn "assuming container path $CADDYFILE_CTR (edit the script if different)"
  fi
  [ -f "$CADDYFILE_HOST" ] || die "Caddyfile not found on host: $CADDYFILE_HOST"
  log "Caddyfile: $CADDYFILE_HOST (container: $CADDYFILE_CTR)"
}

confirm_plan() {
  cat >&2 <<EOF

Plan:
  mode:       $CADDY_MODE
  container:  ${CADDY_CONTAINER:-n/a}
  network:    ${CADDY_NET:-n/a}
  Caddyfile:  ${CADDYFILE_HOST:-n/a}
  domain:     $DOMAIN
  relay:      image uniclip:latest, container 'uniclip', volume 'uniclip_rooms'
EOF
  confirm "Proceed?" || die "aborted by user"
}
```

- [ ] **Step 2: Wire detection into `main`**

Replace the `main()` body's comment line with the detection calls:

```bash
main() {
  parse_args "$@"
  preflight
  detect_caddy
  if [ "$CADDY_MODE" = "docker" ]; then
    detect_network
    detect_caddyfile
  fi
  confirm_plan
  # build / run / inject / verify are added in later tasks
}
```

- [ ] **Step 3: shellcheck + exercise**

Run:
```bash
shellcheck deploy/vps-caddy.sh
deploy/vps-caddy.sh clip.example.com --dry-run --yes
```
Expected: shellcheck clean. The dry-run: if a Caddy container exists it prints the detected container/network/Caddyfile and the Plan block, then (no build yet) exits after `confirm_plan` (auto-yes). If no Caddy is present it dies with the "no running Caddy" guidance — both are correct outcomes.

- [ ] **Step 4: Commit**

```bash
git add deploy/vps-caddy.sh
git commit -m "feat(deploy): detect+confirm Caddy container/network/Caddyfile (bridge guard)"
```

---

### Task 3: Build & run the relay

**Files:**
- Modify: `deploy/vps-caddy.sh` (add `build_image()`, `run_relay()`; call in `main`)

**Interfaces:**
- Consumes: `run()`, `log()`, `CADDY_MODE`, `CADDY_NET`, `REPO_ROOT`.
- Produces: `build_image()`, `run_relay()`. Leaves a running container named `uniclip` (image `uniclip:latest`).

- [ ] **Step 1: Add build/run functions**

Insert after `confirm_plan()`:

```bash
build_image() {
  log "building uniclip:latest (first build cross-compiles the CLI binaries — slow)"
  run docker build -t uniclip:latest "$REPO_ROOT"
}

run_relay() {
  if docker ps -a --format '{{.Names}}' | grep -qx uniclip; then
    log "removing existing 'uniclip' container (idempotent update)"
    run docker rm -f uniclip
  fi
  log "starting relay container 'uniclip'"
  if [ "$CADDY_MODE" = "docker" ]; then
    run docker run -d --name uniclip --restart=unless-stopped \
      --network "$CADDY_NET" \
      -e ROOM_DB_PATH=/data/rooms.db -v uniclip_rooms:/data \
      uniclip:latest
  else
    run docker run -d --name uniclip --restart=unless-stopped \
      -p 127.0.0.1:3000:3000 \
      -e ROOM_DB_PATH=/data/rooms.db -v uniclip_rooms:/data \
      uniclip:latest
  fi
}
```

- [ ] **Step 2: Wire into `main`**

Update `main()` — add after `confirm_plan`:

```bash
  confirm_plan
  build_image
  run_relay
  # inject / verify are added in later tasks
```

- [ ] **Step 3: shellcheck + exercise**

Run:
```bash
shellcheck deploy/vps-caddy.sh
deploy/vps-caddy.sh clip.example.com --dry-run --yes
```
Expected: shellcheck clean; the dry-run now also prints `[dry-run] docker build -t uniclip:latest …` and the `[dry-run] docker run -d --name uniclip …` line with `--network <net>` (docker Caddy present) — no container is actually created.

- [ ] **Step 4: Commit**

```bash
git add deploy/vps-caddy.sh
git commit -m "feat(deploy): build image + idempotent relay run (network attach / loopback)"
```

---

### Task 4: Caddy injection + safety net (+ upsert test)

**Files:**
- Modify: `deploy/vps-caddy.sh` (block + upsert + inject + host guidance; call in `main`)
- Create: `deploy/vps-caddy.test.sh` (asserts the upsert is idempotent)

**Interfaces:**
- Consumes: `run()`, `log()`, `warn()`, `die()`, `DRY_RUN`, `DOMAIN`, `CADDY_MODE`, `CADDY_CONTAINER`, `CADDYFILE_HOST`, `CADDYFILE_CTR`.
- Produces: `UNICLIP_BEGIN`, `UNICLIP_END`, `uniclip_block(target)`, `caddyfile_upsert(file, target)` (reads file, writes result to stdout — pure), `inject_caddy()`, `print_host_guidance()`.

- [ ] **Step 1: Write the failing upsert test**

Create `deploy/vps-caddy.test.sh`:

```bash
#!/usr/bin/env bash
# Assertion test for vps-caddy.sh's Caddyfile block upsert (idempotent replace).
# Run: bash deploy/vps-caddy.test.sh   (not part of `pnpm test` — deploy-only)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/vps-caddy.sh"   # defines functions; main() is source-guarded

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf 'other.example.com {\n\trespond "hi"\n}\n' >"$tmp"

# First upsert appends the block once.
DOMAIN="clip.example.com"
out="$(caddyfile_upsert "$tmp" "uniclip:3000")"
[ "$(printf '%s\n' "$out" | grep -c '>>> uniclip')" -eq 1 ] || fail "block not appended exactly once"
printf '%s\n' "$out" | grep -q 'other.example.com' || fail "existing site block was dropped"
printf '%s\n' "$out" | grep -q 'reverse_proxy uniclip:3000' || fail "proxy target missing"

# Second upsert (changed domain) REPLACES in place — still exactly one block.
printf '%s\n' "$out" >"$tmp"
DOMAIN="clip2.example.com"
out2="$(caddyfile_upsert "$tmp" "uniclip:3000")"
[ "$(printf '%s\n' "$out2" | grep -c '>>> uniclip')" -eq 1 ] || fail "re-run duplicated the block"
[ "$(printf '%s\n' "$out2" | grep -c 'clip.example.com')" -eq 0 ] || fail "old domain not replaced"
printf '%s\n' "$out2" | grep -q 'clip2.example.com {' || fail "new domain not written"

printf 'PASS: upsert appends once and replaces idempotently\n'
```

- [ ] **Step 2: Run it — must fail (functions not defined yet)**

Run: `bash deploy/vps-caddy.test.sh`
Expected: FAIL — `caddyfile_upsert: command not found` / unbound, because the functions don't exist yet.

- [ ] **Step 3: Add the block + upsert + inject functions**

Insert after `run_relay()`:

```bash
UNICLIP_BEGIN="# >>> uniclip (managed by deploy/vps-caddy.sh) >>>"
UNICLIP_END="# <<< uniclip <<<"

# Emit the Caddy site block for $DOMAIN proxying to $1 (uniclip:3000 or 127.0.0.1:3000).
uniclip_block() {
  local target="$1"
  cat <<EOF
$UNICLIP_BEGIN
$DOMAIN {
    encode zstd gzip
    reverse_proxy $target
}
$UNICLIP_END
EOF
}

# Upsert the marker-delimited block into a Caddyfile: replace between markers if
# present, else append. Reads $1, writes the result to stdout. Pure/testable.
caddyfile_upsert() {
  local file="$1" target="$2" block
  block="$(uniclip_block "$target")"
  awk -v b="$UNICLIP_BEGIN" -v e="$UNICLIP_END" -v blk="$block" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; replaced = 1; print blk; next }
    skip { next }
    { print }
    END { if (!replaced) { print ""; print blk } }
  ' "$file"
}

inject_caddy() {
  local backup updated
  backup="$CADDYFILE_HOST.bak-$(date +%Y%m%d-%H%M%S)"
  log "backing up Caddyfile -> $backup"
  run cp -p "$CADDYFILE_HOST" "$backup"

  updated="$(caddyfile_upsert "$CADDYFILE_HOST" "uniclip:3000")"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\033[2m[dry-run]\033[0m would write updated Caddyfile:\n%s\n' "$updated"
  else
    printf '%s\n' "$updated" >"$CADDYFILE_HOST"
  fi

  log "validating Caddy config"
  if ! run docker exec "$CADDY_CONTAINER" caddy validate --config "$CADDYFILE_CTR" --adapter caddyfile; then
    warn "validate failed — restoring backup"
    run cp -p "$backup" "$CADDYFILE_HOST"
    die "Caddy config invalid; original restored from $backup"
  fi

  log "reloading Caddy"
  if ! run docker exec "$CADDY_CONTAINER" caddy reload --config "$CADDYFILE_CTR" --adapter caddyfile; then
    warn "reload failed — restoring backup and reloading the original"
    run cp -p "$backup" "$CADDYFILE_HOST"
    run docker exec "$CADDY_CONTAINER" caddy reload --config "$CADDYFILE_CTR" --adapter caddyfile || true
    die "Caddy reload failed; original restored from $backup"
  fi
}

print_host_guidance() {
  cat <<EOF

──────────────────────────────────────────────────────────────
Host Caddy detected — the relay is running on 127.0.0.1:3000. Apply manually:

1) Add this block to your Caddyfile (e.g. /etc/caddy/Caddyfile):

$(uniclip_block "127.0.0.1:3000")

2) Reload:  sudo systemctl reload caddy
──────────────────────────────────────────────────────────────
EOF
}
```

- [ ] **Step 4: Run the upsert test — must pass**

Run: `bash deploy/vps-caddy.test.sh`
Expected: `PASS: upsert appends once and replaces idempotently`.

- [ ] **Step 5: Wire into `main`**

Update `main()` — after `run_relay`:

```bash
  build_image
  run_relay
  if [ "$CADDY_MODE" = "docker" ]; then
    inject_caddy
  else
    print_host_guidance
  fi
  # verify / summary added in Task 5
```

- [ ] **Step 6: shellcheck + dry-run**

Run:
```bash
shellcheck deploy/vps-caddy.sh deploy/vps-caddy.test.sh
deploy/vps-caddy.sh clip.example.com --dry-run --yes
```
Expected: shellcheck clean on both; the dry-run (docker Caddy present) prints the backup line, the "would write updated Caddyfile" preview containing the marker block for `clip.example.com`, and `[dry-run] docker exec … caddy validate` / `reload` lines — nothing written.

- [ ] **Step 7: Commit**

```bash
git add deploy/vps-caddy.sh deploy/vps-caddy.test.sh
git commit -m "feat(deploy): Caddyfile block upsert + backup/validate/reload/rollback (+test)"
```

---

### Task 5: Verify, summary, README

**Files:**
- Modify: `deploy/vps-caddy.sh` (`verify()`, `summary()`; call in `main`)
- Modify: `deploy/README.md` (add an "Option B, automated" subsection)

**Interfaces:**
- Consumes: `log()`, `warn()`, `DRY_RUN`, `CADDY_MODE`, `CADDY_CONTAINER`, `CADDY_NET`, `CADDYFILE_HOST`, `DOMAIN`.
- Produces: `verify()`, `summary()`.

- [ ] **Step 1: Add verify + summary**

Insert after `print_host_guidance()`:

```bash
verify() {
  if [ "$DRY_RUN" -eq 1 ]; then log "dry-run: skipping health checks"; return; fi
  if [ "$CADDY_MODE" = "docker" ]; then
    log "checking Caddy -> relay reachability"
    if docker exec "$CADDY_CONTAINER" wget -qO- http://uniclip:3000/api/health >/dev/null 2>&1; then
      log "  ok: Caddy reaches the relay over '$CADDY_NET'"
    else
      warn "  Caddy could not reach http://uniclip:3000 — check the shared network"
    fi
  fi
  log "checking public https://$DOMAIN/api/health (retrying for cert issuance)"
  local i
  for i in 1 2 3 4 5 6; do
    if curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1; then
      log "  ok: public HTTPS is live"
      return
    fi
    sleep 5
  done
  warn "  public health check hasn't passed yet — the cert may still be issuing.
  Check: docker logs ${CADDY_CONTAINER:-<caddy>} | grep -i certificate"
}

summary() {
  cat <<EOF

──────────────────────────────────────────────────────────────
uniclip deployed behind Caddy.

  URL:         https://$DOMAIN
  Relay:       container 'uniclip' (network: ${CADDY_NET:-loopback:3000})
  Persistence: volume 'uniclip_rooms' (room metadata only — never keys/frames)
EOF
  [ "$CADDY_MODE" = "docker" ] && printf '  Caddyfile:   %s (backup saved alongside as .bak-*)\n' "$CADDYFILE_HOST"
  cat <<EOF

  Update later: re-run this script (rebuilds + updates the block in place).
  Logs:         docker logs -f uniclip
──────────────────────────────────────────────────────────────
EOF
}
```

- [ ] **Step 2: Finalize `main`**

The complete `main()`:

```bash
main() {
  parse_args "$@"
  preflight
  detect_caddy
  if [ "$CADDY_MODE" = "docker" ]; then
    detect_network
    detect_caddyfile
  fi
  confirm_plan
  build_image
  run_relay
  if [ "$CADDY_MODE" = "docker" ]; then
    inject_caddy
  else
    print_host_guidance
  fi
  verify
  summary
}
```

- [ ] **Step 3: Add the README subsection**

In `deploy/README.md`, immediately after the "## VPS, option B — you already run Caddy on the host" section, add:

```markdown
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
```

- [ ] **Step 4: shellcheck + full dry-run**

Run:
```bash
shellcheck deploy/vps-caddy.sh deploy/vps-caddy.test.sh
bash deploy/vps-caddy.test.sh
deploy/vps-caddy.sh clip.example.com --dry-run --yes
```
Expected: shellcheck clean; upsert test PASS; the dry-run walks the whole flow (detect → plan → build → run → backup/preview/validate/reload → "dry-run: skipping health checks" → boxed summary) with no changes made.

- [ ] **Step 5: Commit**

```bash
git add deploy/vps-caddy.sh deploy/README.md
git commit -m "feat(deploy): health verify + summary + README (Option B automated)"
```

---

## Final verification (after all tasks)

- [ ] `shellcheck deploy/vps-caddy.sh deploy/vps-caddy.test.sh` — clean.
- [ ] `bash deploy/vps-caddy.test.sh` — PASS (upsert idempotent).
- [ ] `deploy/vps-caddy.sh clip.example.com --dry-run --yes` on a host WITH a Docker Caddy — walks the full flow, changes nothing.
- [ ] `deploy/vps-caddy.sh --help` and the missing-domain error read cleanly.
- [ ] Whole-branch review before merge: confirm the safety net (backup before any write; validate/reload failures always restore) and that no read-only detection is wrapped in `run()` (else detection would be skipped under `--dry-run`).
- [ ] Real end-to-end run is the user's VPS: `sudo ./deploy/vps-caddy.sh <domain>` — not part of this plan's automated checks.
