# Cross-device validation matrix

Everything in the automated suite runs on `127.0.0.1` — werift P2P, the embedded LAN relay, and mDNS have **never been exercised on two physical machines**. This checklist closes that gap. Run it on real hardware; record pass/fail + notes per row.

Legend: **Direct** = the UI/header shows the P2P (WebRTC) path is live; **Relayed** = content is going through the relay.

## Setup options

- **Web pairing** needs HTTPS off `localhost` (see README → "Testing across devices"): run the container and `tailscale serve`, or test two browser profiles on the host machine for same-machine cases.
- **CLI pairing** needs Node ≥ 22 on both machines: `pnpm --filter @uniclip/cli dev` (host, prints a QR) and `pnpm --filter @uniclip/cli dev <room-url-or-token>` (join).

## Enabling diagnostics

Turn these on so a failure is attributable instead of a silent hang.

- **CLI (rows A, C, E, F, G):** add `--verbose` and redirect stderr to a file on *each* end —
  `uniclip --verbose 2> host-<row>.log` and `uniclip <token-or-url> --verbose 2> join-<row>.log`.
  Verbose prints the transport state machine (ICE candidate types, pc-state, datachannel, signaling,
  transport switch) plus advisory hints (relay unreachable, P2P firewalled, mDNS multicast blocked).
- **Web (row B / phone):** append `?debug` to the room URL in the address bar (or press `?` on desktop).
  A bottom-right overlay shows the same stream + a host/srflx/relay summary. Tap **Copy** to grab the
  trace as text and paste it into the result doc.

### How to read a trace
- **Direct (P2P) success:** `ice-candidate host` → `pc-state … connected` → `dc open` → `transport relay -> p2p`.
- **Relay fallback:** no `dc open`; `transport` stays `relay`. Clips still sync — note it as Relayed, not a failure.
- **Candidate types:** `host` = LAN/direct, `srflx` = STUN-reflexive (NAT punched), `relay` = TURN.

## Matrix

| # | Scenario | Steps | Expected | Result |
|---|----------|-------|----------|--------|
| A | **LAN P2P, internet present** | Two machines on the same Wi-Fi. Host a room (CLI or web) on machine 1; join from machine 2. Send a text clip each way. | Both reach **Direct** within a few seconds; clips sync both directions. Confirms werift connects over real LAN host candidates (not just loopback). Expected diag: ice-candidate host → pc-state connected → dc open → transport p2p (Direct). | |
| B | **NAT traversal, different networks** | Machine 2 on a phone hotspot / different network. Pair via the public relay (room URL). Send clips both ways. | Either **Direct** (STUN punched through) or a clean fall back to **Relayed** — clips sync regardless. Note which path established. Confirms STUN + fallback across real NAT. Expected diag: a srflx candidate then dc open (Direct), OR a clean transport=relay with no dc open (Relayed) — both are passes; record which. | |
| C | **Zero-internet `--lan`** ⭐ | Disable internet (or point at an unreachable relay) on both machines, same LAN. `uniclip --lan` on machine 1; scan the `uniclip+lan://…` QR → `uniclip <token>` on machine 2. Send clips both ways. | Machine 2 discovers the host via mDNS, connects, reaches **Direct**, clips sync — with no internet at all. The headline offline test. Expected diag: host candidates ONLY (no srflx — proves no STUN/offline), yet dc open. Any srflx means internet wasn't actually cut. | |
| D | **Large file transfer (web)** | In the web app, drag-drop a ~10–50 MB file from machine 1; accept on machine 2. | Chunked transfer completes; received file matches the original (size + content/hash). Watch for stalls or memory spikes. | |
| E | **Reconnect resilience** | Mid-session, drop machine 2's Wi-Fi for ~15s, then restore. Queue a send while offline. | Status shows reconnecting → reconnected; queued clip flushes on reconnect; P2P re-establishes (or relays). | |
| F | **Multi-peer presence** | Three devices in one room. Watch the roster as each joins/leaves. | Roster lists all connected devices by name; updates on join within seconds and prunes on leave. | |
| G | **Cross-platform** | Repeat A and C with mixed OSes (macOS ↔ Linux/Windows) if available. | Same results; note any platform-specific mDNS/werift quirks (e.g., firewall prompts, multicast disabled). | |
| H | **Wrong-network negative** | `uniclip --lan` on machine 1; try to join from a machine on a *different* LAN/VLAN. | Discovery times out with the friendly "Couldn't find that room on this network" message — not a hang or crash. | |

## What to capture for any failure
- Which path was attempted (Direct vs Relayed) and where it stalled (no peer-joined / no datachannel open / decrypt fail).
- OS + network type (same Wi-Fi / hotspot / wired / VPN active).
- Any firewall/multicast prompts (mDNS and werift UDP can be blocked by host firewalls or guest-isolation Wi-Fi).
- Console/CLI error lines.

> Known environmental gotchas to rule out first: **guest-isolation / AP-isolation Wi-Fi** blocks both mDNS and peer UDP (kills C and often A); **corporate VPNs** can hijack the default route and break LAN candidates; **host firewalls** may prompt for UDP — allow it.
