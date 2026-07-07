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
UPDATE=0
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
Usage: deploy/vps-caddy.sh <domain> [--update] [--dry-run] [--yes]

Deploy the uniclip relay behind an EXISTING Caddy (Option B).
  <domain>     hostname to serve, e.g. clip.example.com (or set DOMAIN=)
  --update     routine update: rebuild the image + recreate the relay only,
               skipping the Caddyfile edit (Caddy config untouched; the network
               is still detected so the relay rejoins it). Use after the first
               full deploy. (Or use docker-compose.relay.yml.)
  --dry-run    print every change without making it
  --yes, -y    accept auto-detected container/network/Caddyfile without prompting
  -h, --help   this help
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --update) UPDATE=1 ;;
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
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY RUN — no changes will be made"; fi
}

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
  case "$sel" in *[!0-9]* | '') sel=1 ;; esac
  { [ "$sel" -ge 1 ] && [ "$sel" -le "${#arr[@]}" ]; } || sel=1
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

build_image() {
  # BuildKit caches deps + the CLI cross-compile, so a rebuild that doesn't touch
  # packages/ or apps/cli is fast. Set CLI_TARGETS="" to force-skip the CLI
  # cross-compile (fast relay build; /dl binaries stay empty until a full build).
  log "building uniclip:latest (a cold build cross-compiles the CLI binaries — slow; cached rebuilds are fast)"
  run docker build \
    --build-arg GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
    --build-arg CLI_TARGETS="${CLI_TARGETS-darwin-arm64 darwin-x64 linux-x64 linux-arm64}" \
    -t uniclip:latest "$REPO_ROOT"
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
  # blk is passed via ENVIRON (not -v) because macOS's /usr/bin/awk (BWK awk)
  # rejects a literal newline inside a -v string assignment ("newline in
  # string"); ENVIRON is read verbatim by both BWK awk and gawk.
  UNICLIP_BLK="$block" awk -v b="$UNICLIP_BEGIN" -v e="$UNICLIP_END" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; replaced = 1; print ENVIRON["UNICLIP_BLK"]; next }
    skip { next }
    { print }
    END { if (!replaced) { print ""; print ENVIRON["UNICLIP_BLK"] } }
  ' "$file"
}

inject_caddy() {
  local backup updated
  backup="$CADDYFILE_HOST.bak-$(date +%Y%m%d-%H%M%S)"
  log "backing up Caddyfile -> $backup"
  run cp -p "$CADDYFILE_HOST" "$backup" || die "backup failed ($CADDYFILE_HOST -> $backup); aborting before any change"

  updated="$(caddyfile_upsert "$CADDYFILE_HOST" "uniclip:3000")"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\033[2m[dry-run]\033[0m would write updated Caddyfile:\n%s\n' "$updated"
  else
    printf '%s\n' "$updated" >"$CADDYFILE_HOST" || {
      run cp -p "$backup" "$CADDYFILE_HOST" 2>/dev/null || true
      die "writing $CADDYFILE_HOST failed; last-known-good config is backed up at $backup (Caddy keeps serving the previous config until reloaded)"
    }
  fi

  log "validating Caddy config"
  if ! run docker exec "$CADDY_CONTAINER" caddy validate --config "$CADDYFILE_CTR" --adapter caddyfile; then
    warn "validate failed — restoring backup"
    run cp -p "$backup" "$CADDYFILE_HOST" || die "CRITICAL: automatic restore also failed; last-known-good backup is at $backup — restore it manually"
    die "Caddy config invalid; original restored from $backup"
  fi

  log "reloading Caddy"
  if ! run docker exec "$CADDY_CONTAINER" caddy reload --config "$CADDYFILE_CTR" --adapter caddyfile; then
    warn "reload failed — restoring backup and reloading the original"
    run cp -p "$backup" "$CADDYFILE_HOST" || die "CRITICAL: automatic restore also failed; last-known-good backup is at $backup — restore it manually"
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
  # Only after a full deploy (docker mode) did we detect + back up the Caddyfile;
  # in --update mode CADDYFILE_HOST is empty and no backup was taken.
  [ "$CADDY_MODE" = "docker" ] && [ -n "$CADDYFILE_HOST" ] &&
    printf '  Caddyfile:   %s (backup saved alongside as .bak-*)\n' "$CADDYFILE_HOST"
  cat <<EOF

  Update later: git pull, then either
                  sudo ./deploy/vps-caddy.sh $DOMAIN --update
                or  GIT_SHA=\$(git rev-parse --short HEAD) CADDY_NET=${CADDY_NET:-<net>} \\
                      docker compose -f deploy/docker-compose.relay.yml up -d --build
  Logs:         docker logs -f uniclip
──────────────────────────────────────────────────────────────
EOF
}

main() {
  parse_args "$@"
  preflight
  detect_caddy
  if [ "$CADDY_MODE" = "docker" ]; then
    detect_network
    [ "$UPDATE" -eq 1 ] || detect_caddyfile
  fi
  # Routine update: the Caddyfile block is already in place from the first
  # deploy, so rebuild the image + recreate the relay only (run_relay already
  # removes-and-recreates), and skip the Caddyfile edit entirely.
  if [ "$UPDATE" -eq 1 ]; then
    # --update assumes a prior full deploy wired Caddy. If there's no 'uniclip'
    # container yet, updating would run the relay but leave Caddy unconfigured.
    docker ps -a --format '{{.Names}}' | grep -qx uniclip ||
      die "no existing 'uniclip' container — run a full deploy first:
    sudo ./deploy/vps-caddy.sh $DOMAIN   (without --update)"
    log "update mode: rebuilding image + recreating the relay (Caddy and Caddyfile untouched)"
    build_image
    run_relay
    verify
    summary
    return
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

# Only run main when executed directly; sourcing (e.g. the test) just defines fns.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
