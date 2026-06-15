# LAN HTTPS for cross-device testing

Test uniclip across phones/laptops on your local network with real, trusted
HTTPS — no Tailscale, no public domain. Clipboard APIs require a secure context
(HTTPS or `localhost`), so `http://<lan-ip>` cannot sync; this gives every LAN
device a green-lock HTTPS pointed at the relay container.

It uses [mkcert](https://github.com/FiloSottile/mkcert): a local certificate
authority you trust once per device. The relay serves TLS natively (Bun.serve,
gated on `TLS_CERT`/`TLS_KEY`) — no extra proxy container.

> This is a **dev/testing** path. Production still terminates TLS at Caddy with a
> public Let's Encrypt cert (see `../README.md` and `../docker-compose.yml`).
> The relay defaults to plain HTTP; TLS only turns on when both env vars are set.

## Prerequisites

```bash
brew install mkcert nss   # nss = Firefox trust; omit if you don't use Firefox
# Docker with Compose v2 (`docker compose`). The image is built by compose — no
# manual `docker build` needed.
```

## 1. Generate the cert, then bring it up with Compose

```bash
cd deploy/lan-https
./setup.sh                       # once: mkcert CA + a cert for your LAN IP -> ./certs
docker compose up --build -d     # rebuild image + run over HTTPS on :3443
```

`setup.sh` runs `mkcert -install`, writes `certs/relay.{crt,key}` (with the LAN
IP in the SAN), and prints the root-CA path plus your URL. Then Compose builds
the image and runs it with native TLS + a persistent room-metadata volume.

Day-to-day:

```bash
docker compose up --build -d     # after code changes — rebuilds and restarts
docker compose logs -f           # tail logs
docker compose restart           # e.g. after re-running setup.sh on an IP change
docker compose down              # stop (the room_data volume persists)
```

Port is `3443` (override: `HTTPS_PORT=8443 docker compose up --build -d`).
`certs/` is gitignored (`*.crt`/`*.key`) — the private key never leaves your Mac.

## 2. Trust the root CA on each test device (once per device)

The root CA lives at the path the script prints (`$(mkcert -CAROOT)/rootCA.pem`).
Get that file onto each device and trust it:

- **This Mac** — already trusted by `mkcert -install`. Nothing to do.
- **Another Mac** — copy `rootCA.pem` over, double-click → Keychain Access →
  System → set the mkcert cert to **Always Trust**. (Or run `mkcert -install`
  there if mkcert is installed.)
- **iPhone / iPad** — AirDrop `rootCA.pem` to the device → Settings → *Profile
  Downloaded* → Install. Then **Settings → General → About → Certificate Trust
  Settings** and toggle the mkcert root **ON**. (Both steps are required — the
  toggle is easy to miss.)
- **Android** — Settings → Security → *Encryption & credentials* → *Install a
  certificate* → *CA certificate* → pick `rootCA.pem`.

## 3. Open on every device

```
https://<lan-ip>:3443
```

Green lock, no warning, clipboard works.

## Notes

- **IP changed?** DHCP may reassign the Mac's LAN IP. Re-run `./setup.sh` and
  restart the container; the cert's SAN must match the IP in the URL.
- **WebSocket** upgrades to `wss://` automatically (the SPA derives its relay URL
  from `window.location.origin`), so no client config is needed.
- **Persistence** is included in the printed command (`ROOM_DB_PATH` on the
  `uniclip_rooms` volume) so room URLs survive a container rebuild — drop those
  two flags for ephemeral `:memory:` behavior.
- **Firewall** — if devices can't reach the Mac, allow incoming connections for
  Docker / the chosen port in System Settings → Network → Firewall.
