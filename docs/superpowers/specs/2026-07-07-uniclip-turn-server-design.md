# Uniclip — Self-hosted TURN (coturn) — Design Spec

**Date:** 2026-07-07
**Status:** Approved (pending spec review)
**Scope:** Add an **optional, self-hosted TURN relay** (coturn) so WebRTC peers behind symmetric NAT / CGNAT / cellular — which cannot hole-punch with STUN alone — still establish a **Direct** (P2P) data channel by relaying through TURN, instead of falling back to the app relay's content path. Opt-in via relay env; when unconfigured, behavior is unchanged. The `--lan` zero-internet path is never affected. Decoupled from the custom-typed-code feature (separate spec, plan, worktree).

## 1. Background (current state, from code)

- The browser's `RTCPeerConnection` `iceServers` defaults to **Google public STUN only**: `ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }]` (`packages/protocol/src/index.ts:94`), consumed via `UniclipClient` (`packages/client-core/src/client.ts:83`, `opts.iceServers ?? ICE_SERVERS`) and fed to `PeerLink` in `armPeer()` (`client.ts:379-397`). The web app never overrides it (`apps/web/src/routes/room.svelte:80-92`).
- The CLI's non-LAN path (`apps/cli/src/session.ts:37-44 makeClient()`) also passes no `iceServers`, inheriting the same default. Its werift adapter `toWeriftIceServers()` (`apps/cli/src/werift-peer.ts:15-24`) already forwards `username`/`credential` untouched — **TURN-credential-shaped already**.
- The `--lan` path hardcodes `iceServers: []` (`apps/cli/src/lan-session.ts:25-29,46-50`) → host-only candidates (guarded by the werift patch); this is the zero-internet guarantee and must stay TURN-free.
- The `transport: p2p|relay` state machine lives entirely in `UniclipClient` (`client.ts:372-404`); `PeerLink` only reports channel open/close. **TURN raises the P2P success rate but does not change this state machine** — it only changes what `iceServers` `armPeer()` supplies.
- Relay env idiom: optional paired vars enabled only when both set, e.g. `TLS_CERT`/`TLS_KEY` → `tls` object (`apps/relay/src/server.ts:64-67`); optional `AppDeps` fields spread in (`server.ts:33-42`); routes in `apps/relay/src/app.ts`.

## 2. Goals / non-goals

### Goals
1. When configured, peers that can't STUN-punch get a **Direct** connection via self-hosted TURN (coturn), improving the cellular/CGNAT path; when TURN fails, the existing relay fallback still applies.
2. **Zero-knowledge preserved** — TURN relays only the encrypted DTLS/SRTP transport; coturn never holds DTLS keys, and uniclip's AES-GCM envelope sits above DTLS. coturn sees only doubly-encrypted bytes.
3. **Opt-in, no regression** — `TURN_URLS`+`TURN_SECRET` unset ⇒ `/api/ice` returns today's Google-STUN default; set ⇒ returns self-hosted STUN + ephemeral TURN. **`--lan` never fetches ICE config.**
4. **No static client secret** — clients receive short-lived REST credentials (coturn `static-auth-secret` HMAC scheme), scoped by an expiry.
5. Ship a **`docker-compose.turn.yml` + documented manual setup**; no automation into `deploy/vps-caddy.sh` this cycle (the wide-UDP-port/firewall part isn't for most users).

### Non-goals / deferred
- No managed/third-party TURN (Cloudflare/Twilio/metered) — self-hosted only.
- No coturn automation in `deploy/vps-caddy.sh`; no firewall automation.
- No mid-session credential rotation logic — a long default TTL (24h, ≥ room max-age) covers session length; clients fetch once at construction. (Re-fetch-in-`armPeer` noted as a future enhancement.)
- No change to the `transport` state machine or `PeerLink`.

## 3. Credential scheme (coturn REST / static-auth-secret)

coturn is configured with `use-auth-secret` + `static-auth-secret=<TURN_SECRET>` and a `realm`. The relay mints **time-limited credentials** the standard way:

- `username = "<unixExpiry>"` (unix seconds when the credential expires; optionally `"<unixExpiry>:uniclip"`).
- `credential = base64( HMAC_SHA1( TURN_SECRET, username ) )`.
- `expiry = now + TURN_TTL` (default `86400` s).

The relay returns an `iceServers` array containing the self-hosted STUN and one or more TURN entries (UDP/TCP `turn:` and TLS `turns:`), each carrying that `{username, credential}`. coturn validates the HMAC without any shared per-user state.

## 4. Components & data flow

Flow: **client → relay `GET /api/ice` → `{ iceServers }` → `new UniclipClient({ iceServers })` → `PeerLink` → coturn (STUN/TURN)**.

- **coturn service** — `docker-compose.turn.yml` (a compose service, runnable standalone or merged) + `deploy/coturn/turnserver.conf` template: `listening-port=3478`, `tls-listening-port=5349`, `use-auth-secret`, `static-auth-secret=${TURN_SECRET}`, `realm=${TURN_REALM}`, `min-port`/`max-port` relay range, `no-cli`, `fingerprint`, `no-multicast-peers`. Documented ports to open (3478 udp/tcp, 5349 tcp, relay UDP range) in `deploy/README.md`.
- **`apps/relay/src/turn.ts`** (new) — `mintIceCredentials(cfg, now): { iceServers: RTCIceServer[] }` where `cfg = { urls: string[], secret: string, realm: string, ttlSeconds: number }`. Pure + `now`-injectable (testable HMAC). Uses Node/Bun `crypto` HMAC-SHA1.
- **`apps/relay/src/app.ts`** — `AppDeps` gains optional `turn?: { urls: string[]; secret: string; realm: string; ttlSeconds: number }`. New route **`GET /api/ice`**: if `deps.turn` set → `mintIceCredentials(deps.turn, Date.now())`; else → `{ iceServers: DEFAULT_ICE_SERVERS }` (the current Google-STUN default, exported from `protocol`). Light per-IP rate-limit (reuse the existing limiter idiom; cheap endpoint).
- **`apps/relay/src/server.ts`** — read `TURN_URLS` (comma-separated `turn:`/`turns:` URLs), `TURN_SECRET`, `TURN_REALM`, `TURN_TTL` (default `86400`); include `turn` in `AppDeps` only when `TURN_URLS`+`TURN_SECRET` both present (the `TLS_CERT`/`TLS_KEY` pattern).
- **`packages/client-core/src/ice.ts`** (new) — `fetchIceServers(relayBase: string, fetchImpl?): Promise<RTCIceServer[]>`: `GET ${relayBase}/api/ice`, returns `iceServers`; on any error returns the built-in `ICE_SERVERS` default (never throws). Keeps `UniclipClient` construction able to stay synchronous — the caller awaits this first.
- **`apps/web/src/routes/room.svelte`** — before `new UniclipClient(...)` (line ~80), `const iceServers = await fetchIceServers(httpBase)` and pass it in.
- **`apps/cli/src/session.ts`** — `makeClient()` becomes async: `await fetchIceServers(relayBase)` (relay base already via `relayBaseFromUrl`), pass `iceServers`. **`lan-session.ts` is untouched** (stays `iceServers: []`).
- **werift caveat** — werift's `parseIceServers` matches `turn:` but not `turns:` (substring quirk). The relay advertises a plain `turn:host:3478` entry (picked up by the CLI) *and* a `turns:host:5349` entry (used by the browser on restrictive networks). No werift patch change needed; `--lan`'s empty array stays host-only.

## 5. Security model

- **TURN is not a trust boundary** — coturn relays encrypted DTLS; the AES-GCM app envelope is above it. Even a compromised coturn sees only doubly-encrypted traffic and never keys/plaintext. This holds for both Mode A and Mode B.
- **No static credential in clients** — only short-lived HMAC creds; `TURN_SECRET` lives only on the relay+coturn (never sent to clients, never logged).
- **`--lan` invariant intact** — the LAN path never calls `fetchIceServers`; zero-internet guarantee unchanged (the `werift-hostonly` regression test still holds).
- **Abuse bounds** — `/api/ice` is IP-rate-limited; credential TTL bounds replay; coturn `no-multicast-peers` + a scoped relay-port range limit misuse.
- **Privacy** — when TURN is configured, clients use **self-hosted STUN** (coturn) instead of Google, ending the phone-home for those deployments (the chosen "STUN only when TURN configured" behavior).

## 6. Testing

- **`apps/relay` `turn.test.ts`** — `mintIceCredentials`: username = expiry format, credential = expected `base64(HMAC-SHA1(secret, username))` against a known vector, expiry = `now + ttl`, multiple URLs each carry the creds, STUN entry present.
- **`apps/relay` app test** — `GET /api/ice` disabled (no `turn` dep) → returns default STUN only; enabled → returns TURN entries with creds; IP-limit path.
- **`packages/client-core` `ice.test.ts`** — `fetchIceServers` returns server `iceServers` on 200; returns the built-in default on network error / non-200 / malformed JSON (never throws), via an injected `fetchImpl`.
- **CLI** — `werift-hostonly.test.ts` still passes (unchanged); confirm the non-LAN `makeClient` passes fetched `iceServers` through (unit with injected fetch), and `--lan` does not fetch.
- Relay tests run under Bun (`bun --bun vitest`), cast `res.json()` per the repo gotcha.

## 7. Decomposition (for the plan)

1. **`apps/relay/src/turn.ts` + test** — `mintIceCredentials` (HMAC REST creds), TDD.
2. **Relay wiring** — `DEFAULT_ICE_SERVERS` export in `protocol`; `AppDeps.turn`; `GET /api/ice`; `server.ts` env; app test.
3. **`packages/client-core/src/ice.ts` + test** — `fetchIceServers` with fallback.
4. **Client wiring** — web `room.svelte` + CLI `session.ts` await `fetchIceServers` (LAN untouched); typecheck/build.
5. **Ops** — `docker-compose.turn.yml`, `deploy/coturn/turnserver.conf` template, `deploy/README.md` TURN section (ports, env, secret generation, verify with `turnutils_uclient`/Trickle ICE).

Order 1→5. Each ends with its package's test + typecheck green.
