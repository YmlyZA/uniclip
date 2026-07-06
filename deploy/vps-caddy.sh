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

main() {
  parse_args "$@"
  preflight
  # detection / build / run / inject / verify are added in later tasks
}

# Only run main when executed directly; sourcing (e.g. the test) just defines fns.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
