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

# Only run main when executed directly; sourcing (e.g. the test) just defines fns.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
