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
