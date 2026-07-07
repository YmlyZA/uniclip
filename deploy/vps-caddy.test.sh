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
# (exported: read via $DOMAIN inside vps-caddy.sh's sourced functions; the
# source=/dev/null directive above hides that use from the linter, which
# would otherwise flag this as an unused assignment.)
export DOMAIN="clip.example.com"
out="$(caddyfile_upsert "$tmp" "uniclip:3000")"
[ "$(printf '%s\n' "$out" | grep -c '>>> uniclip')" -eq 1 ] || fail "block not appended exactly once"
printf '%s\n' "$out" | grep -q 'other.example.com' || fail "existing site block was dropped"
printf '%s\n' "$out" | grep -q 'reverse_proxy uniclip:3000' || fail "proxy target missing"

# Second upsert (changed domain) REPLACES in place — still exactly one block.
printf '%s\n' "$out" >"$tmp"
export DOMAIN="clip2.example.com"
out2="$(caddyfile_upsert "$tmp" "uniclip:3000")"
[ "$(printf '%s\n' "$out2" | grep -c '>>> uniclip')" -eq 1 ] || fail "re-run duplicated the block"
[ "$(printf '%s\n' "$out2" | grep -c 'clip.example.com')" -eq 0 ] || fail "old domain not replaced"
printf '%s\n' "$out2" | grep -q 'clip2.example.com {' || fail "new domain not written"

printf 'PASS: upsert appends once and replaces idempotently\n'

# --- --update flow: rebuild + recreate the relay, never touch the Caddyfile. ---
# Stub the heavy/side-effecting functions with recorders and drive the real
# main() + parse_args control flow with --update.
CALLS=""
preflight()       { :; }
detect_caddy()    { CADDY_MODE="docker"; }
detect_network()  { CADDY_NET="uniclip-net"; }
detect_caddyfile(){ CALLS="$CALLS detect_caddyfile"; }
confirm_plan()    { CALLS="$CALLS confirm_plan"; }
build_image()     { CALLS="$CALLS build_image"; }
run_relay()       { CALLS="$CALLS run_relay"; }
inject_caddy()    { CALLS="$CALLS inject_caddy"; }
verify()          { CALLS="$CALLS verify"; }
summary()         { CALLS="$CALLS summary"; }
# The --update precondition guard calls `docker ps -a`; pretend the container exists.
docker()          { [ "${1:-} ${2:-}" = "ps -a" ] && echo uniclip; return 0; }

DOMAIN=""; UPDATE=0   # reset: parse_args rejects a second positional if DOMAIN is set
main clip.example.com --update >/dev/null 2>&1

case "$CALLS" in *build_image*) ;; *) fail "--update did not build_image" ;; esac
case "$CALLS" in *run_relay*)   ;; *) fail "--update did not run_relay" ;; esac
case "$CALLS" in *verify*)      ;; *) fail "--update did not verify" ;; esac
case "$CALLS" in *summary*)     ;; *) fail "--update did not print summary" ;; esac
case "$CALLS" in *detect_caddyfile*) fail "--update must not read the Caddyfile" ;; esac
case "$CALLS" in *inject_caddy*)     fail "--update must not edit Caddy (config must stay untouched)" ;; esac
case "$CALLS" in *confirm_plan*)     fail "--update should skip the full-deploy confirm" ;; esac

printf 'PASS: --update rebuilds the relay without touching Caddy\n'
