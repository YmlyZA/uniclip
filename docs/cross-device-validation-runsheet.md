# Cross-device validation — run sheet (macOS + Linux + Android/Chrome + iPhone/Safari)

A concrete, command-exact checklist for THIS hardware set. Pairs with the generic matrix
(`cross-device-validation.md`) and the result template (`cross-device-validation-results-template.md`).
Tick each box as you go; paste diag evidence into the result slots. Report tests one at a time.

**Diagnostics are the point:** CLI uses `--verbose` (writes the transport state machine to stderr →
redirect to a file); Web uses the `?debug` overlay (Copy button → paste back). Every test captures one.

## Device roles
- **macOS** — CLI + browser (also runs the relay / Docker for web tests)
- **Linux** — CLI + browser
- **Android / Chrome** — browser only (no CLI: needs Node)
- **iPhone / Safari** — browser only

## Prereqs
- [ ] macOS: repo cloned, `pnpm install`, `node -v` ≥ 22 (have: v22.22)
- [ ] Linux: repo cloned, `pnpm install`, `node -v` ≥ 22
      (fallback if no repo: on macOS `bun build --compile --target=bun-linux-x64 apps/cli/src/bin.ts --outfile uniclip-linux`, scp to Linux, run directly)
- [ ] macOS LAN IP noted — re-check now: `ipconfig getifaddr en0` (was `192.168.20.32`; replace `<MAC_IP>` below)
- [ ] (Part 2 only) Tailscale app installed + logged into the same tailnet on macOS / Linux / Android / iPhone

---

## PART 1 — CLI tests (macOS ↔ Linux). Do first; Test 1 needs no relay/HTTPS/Tailscale.

### ⭐ Test 1 — Row C: zero-internet `--lan` (headline)
Fully offline: mDNS + embedded relay, no external relay, no internet.

- [ ] macOS (host): `cd apps/cli && pnpm dev --lan --verbose 2> ~/uniclip-C-macos.log`
      → shows a QR of a `uniclip+lan://<routingId>#<secret>` token. **Scan the QR with iPhone/Android camera** to read the token text.
- [ ] Linux (join): `cd apps/cli && pnpm dev "uniclip+lan://<paste-token>" --verbose 2> ~/uniclip-C-linux.log`
- [ ] Type a line on one end, press Enter → appears on the other.
- [ ] (bonus) Cut internet on both (keep them on the same router/switch) → should still sync.

**Expected diag (both logs):** `ice-candidate host` only (**no srflx** — proves no STUN / truly offline) → `pc-state … connected` → `dc open` → `transport … p2p`. Header shows **Direct**.

Result:
- Result: PASS / FAIL · Path: Direct / Relayed
- Devices + network:
- Logs attached: `~/uniclip-C-macos.log` + `~/uniclip-C-linux.log`
- Notes:

### Test 2 — Row A: LAN P2P via relay (also covers Row G cross-platform)
macOS runs the relay; both CLIs point at it over the LAN (`ws://`, no HTTPS needed for CLI).

- [ ] macOS terminal 1 (relay): `PORT=3000 pnpm --filter @uniclip/relay dev`
- [ ] macOS terminal 2 (client A, create): `cd apps/cli && pnpm dev --relay http://<MAC_IP>:3000 --verbose 2> ~/uniclip-A-macos.log`
      → shows room URL `http://<MAC_IP>:3000/r/<id>#<secret>` (text + QR).
- [ ] Linux (client B, join): `cd apps/cli && pnpm dev "http://<MAC_IP>:3000/r/<id>#<secret>" --verbose 2> ~/uniclip-A-linux.log`
- [ ] Send clips both ways.
- [ ] Allow the macOS firewall / local-network prompt (UDP) if it appears.

**Expected diag:** `ice-candidate host` → `pc-state connected` → `dc open` → `transport p2p` (Direct). A stuck `Relayed` (no `dc open`) is still a pass — record which. If stuck Relayed, the log will carry the `no STUN/relay candidates — P2P may be firewalled` hint.

Result:
- Result: PASS / FAIL · Path: Direct / Relayed
- Devices + network:
- Logs attached: `~/uniclip-A-macos.log` + `~/uniclip-A-linux.log`
- Notes:

### Test 3 — Row E: reconnect resilience (continue Test 2's session)
- [ ] On Linux: drop Wi-Fi / unplug for ~15s. **While offline**, type a clip (should show Queued).
- [ ] Restore the network.

**Expected:** status reconnecting → connected; the queued clip flushes on reconnect and macOS receives it; diag shows `ws closed → connecting → open`, then P2P/relay re-establishes.

Result:
- Result: PASS / FAIL · Queued-then-flushed: yes / no · P2P re-established: yes / no
- Log attached: `~/uniclip-A-linux.log` (around the drop)
- Notes:

---

## PART 2 — Web tests (one-time HTTPS setup first)

### Web setup (on macOS, once)
- [ ] `docker build -t uniclip:dev .`
- [ ] `docker run --rm -p 3000:3000 uniclip:dev`
- [ ] new terminal: `tailscale serve --bg 3000` → note the printed `https://<mac>.<tailnet>.ts.net`
      (if `:443` is taken: `tailscale serve --bg --https=8443 3000`, URL ends `:8443`)
- [ ] Confirm Android / iPhone / Linux are on the same tailnet (Tailscale app on).

**Opening the overlay:** desktop → press `?`. Phone → put `?debug` right before the `#` in the address bar (e.g. `.../r/<id>?debug#<secret>`). After the test, tap **Copy** in the overlay and send the text.

### Test 4 — Row D: large file transfer (Web, two browsers)
- [ ] macOS browser: open `https://<mac>.<tailnet>.ts.net` → create a **Zero-knowledge** room → press `?` → copy the share link.
- [ ] Linux browser (or a second browser): open the share link, press `?`.
- [ ] Drag-drop a 10–50 MB file on macOS; accept on the other end; verify received size/content matches.

Result:
- Result: PASS / FAIL · Path: Direct / Relayed · File intact (size/content): yes / no
- Overlay Copy text (both ends):
- Notes (stalls / memory):

### Test 5 — Row B: cross-network NAT (phone on cellular ↔ macOS browser)
- [ ] iPhone/Safari: turn Wi-Fi OFF (use **cellular**; keep Tailscale on) → open the share link (address bar `?debug` before `#`).
- [ ] macOS browser: create the room, share the link to the phone. Exchange clips both ways.
- [ ] (better) Repeat with Android/Chrome on cellular.

**Expected:** a `srflx` candidate (STUN punched → Direct), or a clean `transport relay` fallback (Relayed) — both pass; record which.
> Note: Tailscale overlays the network, so this isn't a pure public-NAT test, but it exercises cross-network + STUN/relay fallback.

Result:
- Result: PASS / FAIL · Path: Direct (srflx) / Relayed
- Phone overlay Copy text:
- Network (carrier):
- Notes:

### (optional) Test 6 — Row F: multi-peer presence
- [ ] macOS CLI + Linux CLI + iPhone browser all join one relay room (Test 2's room or a web room). Watch the roster on join/leave.

Result:
- Result: PASS / FAIL · Roster correct on join/leave: yes / no
- Notes:

---

## Reporting format (per test)
```
Test N (Row X): PASS / FAIL
Path: Direct / Relayed
Devices + network: <e.g. macOS 15 ↔ Ubuntu 24, same Wi-Fi>
diag: <paste the CLI log file, or the Web overlay Copy text>
Notes: <anything odd / stalls / firewall prompts>
```

## Triage boundary
FAIL rows are triaged one at a time as their own systematic-debugging cycles (small → direct fix; large → new spec). Not part of the diagnostics spec that shipped this run sheet.
