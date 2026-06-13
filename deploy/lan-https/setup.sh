#!/usr/bin/env bash
#
# LAN HTTPS for cross-device testing (macOS host).
#
# Clipboard APIs only work in a secure context (HTTPS or localhost), so plain
# http://<lan-ip> can't sync. This generates a locally-trusted cert with mkcert
# for the host's LAN IP and prints how to run the relay container with native
# TLS. Install the printed root CA on each test device ONCE (see README.md);
# after that every device gets a green-lock HTTPS over the LAN.
#
# Usage:
#   ./setup.sh            # auto-detect LAN IP (en0/en1)
#   ./setup.sh 192.168.1.50   # or pass it explicitly
#
set -euo pipefail

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert is required. Install it with:  brew install mkcert nss" >&2
  exit 1
fi

CERT_DIR="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$CERT_DIR"

# 1. Local CA — idempotent; trusts mkcert's root in this Mac's system store.
mkcert -install

# 2. LAN IP — arg wins, else first non-loopback IPv4 on en0/en1.
LAN_IP="${1:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)}"
if [ -z "$LAN_IP" ]; then
  echo "Could not auto-detect a LAN IP. Re-run with it explicitly: $0 <lan-ip>" >&2
  exit 1
fi

# 3. Leaf cert for the LAN IP (+ localhost) — mkcert puts the IP in the SAN.
mkcert -cert-file "$CERT_DIR/relay.crt" -key-file "$CERT_DIR/relay.key" \
  "$LAN_IP" localhost 127.0.0.1

CAROOT="$(mkcert -CAROOT)"
PORT="${LAN_HTTPS_PORT:-3443}"

cat <<EOF

──────────────────────────────────────────────────────────────────────
LAN HTTPS ready.

  Cert:     $CERT_DIR/relay.crt   (SAN: $LAN_IP, localhost, 127.0.0.1)
  Root CA:  $CAROOT/rootCA.pem    <- install this on every test device

Run the relay container with native TLS + room persistence:

  docker rm -f uniclip 2>/dev/null
  docker run -d --rm -p $PORT:3000 \\
    -e TLS_CERT=/certs/relay.crt -e TLS_KEY=/certs/relay.key \\
    -e ROOM_DB_PATH=/data/rooms.db -v uniclip_rooms:/data \\
    -v "$CERT_DIR":/certs:ro \\
    --name uniclip uniclip:dev

Then open on EVERY device (after installing the root CA — see README.md):

  https://$LAN_IP:$PORT

If the Mac's LAN IP changes (DHCP), re-run this script and restart the container.
──────────────────────────────────────────────────────────────────────
EOF
