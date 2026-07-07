#!/usr/bin/env sh
#
# Zero-config relay update via docker compose. Reads CADDY_NET from
# deploy/relay.env (written by vps-caddy.sh on the first deploy) and computes
# GIT_SHA, so a routine update is just:
#
#   git pull && sudo ./deploy/update.sh
#
# Skip the slow CLI cross-compile (served /dl binaries stay empty until a full
# build):  CLI_TARGETS="" sudo ./deploy/update.sh
#
# This is the recommended (docker-compose) update path — see deploy/README.md.
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"   # deploy/
ROOT="$(cd "$DIR/.." && pwd)"          # repo root

if [ ! -f "$DIR/relay.env" ]; then
  echo "error: $DIR/relay.env not found." >&2
  echo "Run the first deploy once (sudo ./deploy/vps-caddy.sh <domain>), which writes it," >&2
  echo "or create it with a single line:  CADDY_NET=<your-caddy-docker-network>" >&2
  exit 1
fi

# Baked into /api/version. Compose reads it from the shell env at build time.
GIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
export GIT_SHA

exec docker compose --env-file "$DIR/relay.env" -f "$DIR/docker-compose.relay.yml" up -d --build
