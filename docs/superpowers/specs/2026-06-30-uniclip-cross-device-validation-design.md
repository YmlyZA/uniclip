# Uniclip — Real-hardware cross-device validation (diagnostics + runbook) — Design Spec

**Date:** 2026-06-30
**Status:** Approved (pending spec review)
**Scope:** Make the `docs/cross-device-validation.md` A–H matrix actually executable on two physical machines, and reduce friction to capture *why* something fails when it does. Everything in the automated suite runs on `127.0.0.1` (werift loopback, embedded LAN relay, mDNS) — the matrix has **never** run on real hardware. The human drives the two machines; this spec delivers the **tooling + runbook** that makes their runs legible. Bugs the runs surface are fixed separately (each its own systematic-debugging cycle), **not** in this spec.

## 1. Goals and non-goals

### Goals
1. Surface the transport state machine that today is invisible: ICE candidate types (host/srflx/relay), `RTCPeerConnection` connection-state transitions, datachannel open/close, signaling send/recv, decrypt failures, WS connect/reconnect — so a real-hardware failure is *attributable*, not a silent hang.
2. Make that visibility consumable on **both** ends every scenario needs: CLI `--verbose` (rows A/C/E/F/G are CLI↔CLI) and a Web debug overlay (row B / NAT uses a phone browser).
3. Turn `cross-device-validation.md` from a checklist into a **fillable record**: per-row expected diag trace + a structured result block + two capture channels (CLI `2> file`, Web Copy button).

### Non-goals / preserved invariants
- **No change to transport behavior.** Diagnostics *tap* existing seams (`peer-link.ts` already observes `pc.connectionState` and ICE candidates; `client.ts` already drives `transport`); they never alter routing, negotiation, or fallback.
- **No `doctor` command.** Environment reachability hints fold into `--verbose` output as warnings, not a separate gated preflight.
- **No fixing of bugs found** within this spec. The matrix run produces a results doc; each FAIL row is triaged on its own afterward.
- **Privacy unchanged.** Diagnostics are opt-in (off by default), and never include secret / plaintext / ciphertext / key material — only routingId, msgIds, candidate types, connection states. SDP bodies are not printed in full.

## 2. The `diag` event (the shared seam)

A new variant on `client-core`'s existing `ClientEvent` union, emitted via the existing `emit()`/`EventHandlers` machinery so both consumers attach identically:

```ts
type DiagPhase =
  | "ws"            // connect / open / reconnecting / close
  | "signal"        // sdp/ice sent or received (WS-only) — type + direction, no SDP body
  | "ice-candidate" // gathered candidate: typ host|srflx|relay|prflx + protocol
  | "pc-state"      // RTCPeerConnection connectionState transitions
  | "dc"            // datachannel open / close
  | "transport"     // p2p <-> relay switch (mirrors the existing coarse event)
  | "decrypt-fail"; // receive-side decrypt failed (msgId only)

interface DiagEvent {
  kind: "diag";
  phase: DiagPhase;
  level: "info" | "warn" | "error";
  detail: string;                            // one human-readable line
  data?: Record<string, string | number>;   // structured fields for the Web overlay / log parsing
}
```

**Emission points** (tap, don't change behavior):

- **`client.ts`** emits directly:
  - `ws`: connect initiated / `open` / `reconnecting` (with attempt count) / `close` (with code)
  - `signal`: each `sdp`/`ice` sent or received — record `type` + direction only, **never the SDP body**
  - `decrypt-fail`: on a receive-side decrypt throw — record `msgId`, **never ciphertext/plaintext**
  - `transport`: emit one `info` diag alongside the existing `setTransport` switch
- **`peer-link.ts`** gains an injectable `onDiag?(e: DiagEvent)` callback (same style as its existing `signal`/`onOpen`/`onClose` opts); `client.ts` wires it into its own `emit`:
  - `ice-candidate`: parse `typ` (`/ typ (\w+)/`) + protocol from the candidate string → `data: {typ, protocol}`
  - `pc-state`: `onconnectionstatechange` → `data: {state}`
  - `dc`: datachannel `open` / `close`

**Privacy invariant (load-bearing):** diag carries metadata only. ICE candidates include the machine's own LAN IP — acceptable on the user's own stderr (local diagnostic); SDP bodies are not logged in full. A regression test asserts `decrypt-fail` detail contains no plaintext.

## 3. CLI `--verbose` consumer + environment hints

- **Flag:** `args.ts` gains `--verbose` / `-V` (uppercase, to avoid clashing with `-v` = version, following the existing `--version`/`--help` parsing). `UNICLIP_VERBOSE=1` is equivalent.
- **Consumer** (`diag-log.ts`, wired in `cli.tsx`): when verbose, subscribe to `client.on("diag")` and print each as one line to **stderr** — Ink's TUI renders to stdout, so diagnostics never corrupt the UI and `2> session.log` cleanly captures them. Format: relative-seconds timestamp + phase + detail; `warn`/`error` prefixed (`!` / `✗`). Timestamps are **relative to session start** (elapsed time localizes the stall; absolute wall-clock is noise).

  ```
  [12.483s] ice-candidate  host    udp 192.168.1.20      (gathered)
  [13.112s] pc-state       connecting -> connected
  [13.150s] dc             open                          Direct
  [13.150s] transport      relay -> p2p
  ```

- **Environment reachability hints** (warnings folded into the diag stream, never gating):
  - relay mode: first WS connect not `open` within ~3s → `warn` `relay unreachable at <url> — check network/URL`.
  - `--lan` join: mDNS browse resolves no host for the routingId within ~5s → keep the existing friendly "Couldn't find that room on this network", and under `--verbose` add a `warn` flagging **suspected multicast block** (guest/AP-isolation Wi-Fi — the most common row-C environment trap).
  - P2P not up: no `connected` `pc-state` within ~10s and no srflx/relay candidate → `warn` `no STUN/relay candidates — P2P may be firewalled, will use relay`.

## 4. Web debug overlay

- **Mount:** `room.svelte` adds `c.on("diag", …)` pushing into a **bounded ring** `$state` (~200 entries; long-session memory guard, fits use-and-discard).
- **Component** `debug-overlay.svelte`:
  - **Hidden by default** (no subscribe/render cost until opened). Toggle via `?debug` query param (phone-friendly — append in the address bar after scanning, no keyboard shortcut) **or** the `?` key (desktop).
  - Bottom-right semi-transparent fixed overlay, monospace, scrollable: same rows as the CLI (relative timestamp + phase + detail; `warn`/`error` color-coded). A header line summarizes current `transport` (Direct/Relayed) + candidate-type counts (host/srflx/relay) — one glance at "how far traversal got".
  - **Copy button**: serializes the whole diag buffer to plain text — the Web capture channel for row B (a phone has no `2> file`), paste back for triage.
- **Reuse:** the overlay only reads the diag stream; the existing header Direct/Relayed badge is untouched.
- **Tailwind caveat** (`tailwind4-safari-colormix-backdrop` memory): overlay background uses plain `rgba(...)` + `-webkit-`-prefixed blur, **not** `bg-black/NN` — old iOS/Safari renders `color-mix` as transparent, and mobile Safari *is* the row-B test surface.

## 5. Runbook tightening + result template

Upgrade `docs/cross-device-validation.md` from a checklist to a fillable record:

1. **"Enabling diagnostics" section** at the top: CLI both ends `--verbose 2> <machine>-<row>.log` (host + join each a file); Web add `?debug` or press `?`, then Copy when done. State the two capture channels plainly.
2. **Per-row "how to read diag"** on the transport rows, so the operator judges pass/fail on the spot:
   - **A (LAN P2P):** expect `ice-candidate host` → `pc-state … connected` → `dc open` → `transport … p2p`. `transport p2p` = Direct.
   - **C (zero-internet `--lan`):** expect **host candidates only, no srflx** (no STUN) yet still `dc open`. Any srflx means it isn't truly offline.
   - **B (NAT):** expect `srflx` (STUN punched → Direct) or a clean `transport relay` fallback (no `dc open`).
3. **Structured result block** replacing each empty `| Result |` cell (see template below).

**New file** `docs/cross-device-validation-results-YYYY-MM-DD.md` — copied from a blank template (included in full in this spec / the plan) and filled during a run, keeping the reusable runbook separate from a dated result archive.

Blank per-row block:

```
### Row A — LAN P2P, internet present
- Result: PASS / FAIL
- Path reached: Direct / Relayed
- OS + network: <e.g. macOS 15 <-> Ubuntu 24, same Wi-Fi>
- diag excerpt / attached log: <key lines, or host-A.log + join-A.log>
- Notes:
```

**Boundary:** this section ships **docs + template only**. Each FAIL row is triaged separately afterward.

## 6. Testing

The matrix itself is manual; the *tooling* is code and must be tested so it doesn't lie on real hardware.

1. **`client-core` unit** (vitest, injectable `createConnection`):
   - Drive the injected peer; assert transitions emit the right diag: datachannel open → `{phase:"dc", detail~/open/}`; `connectionState` change → `pc-state`; candidate string `typ host`/`srflx`/`relay` → `data.typ` parsed correctly.
   - `decrypt-fail`: feed a wrong-key/bad-AAD frame, assert `{phase:"decrypt-fail"}` emits **and detail contains no plaintext/ciphertext** (privacy regression lock).
   - Extend `peerlink-werift.test.ts` / `werift-loopback.test.ts`: a real werift handshake should produce an ordered `ice-candidate` → `pc-state connected` → `dc open` trace — asserting the sequence validates the diag vocabulary against real WebRTC.
2. **CLI consumer unit** (`apps/cli`, ink-testing-library):
   - `args.ts`: `--verbose`/`-V`/`UNICLIP_VERBOSE` → `verbose:true`.
   - `diag-log.ts`: a fake diag event formats to **stderr** with relative timestamp + phase + detail; `warn`/`error` marked; stdout (Ink TUI) uncorrupted.
3. **Web overlay unit** (`apps/web`, `vi.stubGlobal`):
   - `debug-overlay` hidden by default; renders fed diag rows after `?debug` / `?`; Copy yields plain text of the full buffer; ring buffer drops oldest past the cap.

**Not tested:** real cross-machine connectivity (untestable beyond loopback — that's the manual matrix). Tests lock only "diagnostics faithfully reflect the state machine". Toolchain: relay suite untouched (no relay change); client-core/cli under Node vitest; web uses `vi.stubGlobal`.

## 7. Decomposition (for the plan)

1. **`diag` event in client-core** — union variant + `peer-link.ts` `onDiag` + emission at all seven phases (+ unit tests incl. the werift-loopback trace and the decrypt-fail privacy lock).
2. **CLI `--verbose`** — `args.ts` flag + `diag-log.ts` stderr formatter + environment hints (+ tests).
3. **Web debug overlay** — `debug-overlay.svelte` + `room.svelte` wiring + ring buffer + Copy + toggle (+ tests).
4. **Runbook + result template** — rewrite `cross-device-validation.md` (enabling diagnostics, per-row expected trace, result blocks) + the blank `…-results-` template file. Docs only.

Order 1→4: (1) makes the data, (2)(3) surface it on each end, (4) tells the operator how to drive and record. After merge, the human runs the matrix; FAIL rows become their own debugging cycles.
