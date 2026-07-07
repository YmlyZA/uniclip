#!/usr/bin/env sh
#
# Zero-config relay update. Reads CADDY_NET from deploy/relay.env (written by
# vps-caddy.sh on the first deploy) so you never re-type it.
#
#   sudo ./deploy/update.sh          build from source on the host (docker-compose.relay.yml)
#   sudo ./deploy/update.sh --pull   pull the prebuilt image from GHCR (docker-compose.ghcr.yml) — fastest
#
# Skip the slow CLI cross-compile on a source build (served /dl binaries stay
# empty until a full build):  CLI_TARGETS=none sudo ./deploy/update.sh
# (CLI_TARGETS="" works too — it's normalized to the robust `none` sentinel below,
#  since empty build-args don't reliably propagate through all Docker versions.)
#
# See deploy/README.md.
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"   # deploy/
ROOT="$(cd "$DIR/.." && pwd)"          # repo root

MODE=build
case "${1:-}" in
  "") ;;
  --pull) MODE=pull ;;
  *) echo "usage: update.sh [--pull]" >&2; exit 2 ;;
esac

if [ ! -f "$DIR/relay.env" ]; then
  echo "error: $DIR/relay.env not found." >&2
  echo "Run the first deploy once (sudo ./deploy/vps-caddy.sh <domain>), which writes it," >&2
  echo "or create it with a single line:  CADDY_NET=<your-caddy-docker-network>" >&2
  exit 1
fi

if [ "$MODE" = "pull" ]; then
  # Prebuilt image from GHCR — no build, no GIT_SHA (it's baked in CI).
  exec docker compose --env-file "$DIR/relay.env" -f "$DIR/docker-compose.ghcr.yml" up -d --pull always
fi

# Normalize an explicitly-empty CLI_TARGETS to the robust `none` sentinel — an
# empty-string build-arg doesn't reliably propagate through all Docker/BuildKit
# versions (some fall back to the ARG default and cross-compile anyway).
if [ "${CLI_TARGETS+set}" = "set" ] && [ -z "$CLI_TARGETS" ]; then
  CLI_TARGETS=none
  export CLI_TARGETS
fi

# Build from source. GIT_SHA is baked into /api/version; compose reads it from
# the shell env at build time.
GIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
export GIT_SHA
exec docker compose --env-file "$DIR/relay.env" -f "$DIR/docker-compose.relay.yml" up -d --build
