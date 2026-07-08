# uniclip — Full repository audit & remediation (2026-07-07)

A whole-repository review of architecture, correctness, security, reliability, and
operability, followed by a complete remediation. Every finding below was verified in
source; every fix shipped through a review-gated workflow and merged to `main`.

- **Scope:** `packages/{protocol,crypto,room-code,client-core}`, `apps/{relay,web,cli}`,
  `e2e/`, and the build/CI/deploy tooling (`Dockerfile`, `.github/workflows`, `deploy/`).
- **Method — audit:** five parallel reviewers, one per dimension (security; relay/protocol
  correctness; client-core/crypto/CLI; web app; architecture/build/CI/deploy). Findings were
  cross-checked against the actual code before being accepted.
- **Method — remediation:** subagent-driven execution — a fresh implementer per task under
  TDD, a spec + code-quality review after each task, and a broad whole-branch review before
  each merge. Critical/Important findings went through a fix → re-review loop. All gates
  (`pnpm typecheck`, the unit suites, and — for container/CSS changes — real `docker build` /
  Playwright e2e) were verified first-hand.

## Outcome at a glance

All code-correctness, security, reliability, and operability findings are fixed and merged
(**PRs #28–#32**, plus the follow-up batch F). The relay test suite grew from 92 to 105+
tests over the effort.

| Batch | PR | Theme | Headline fixes |
|---|---|---|---|
| B | [#28](https://github.com/YmlyZA/uniclip/pull/28) | Reliability | `signalLimiter` memory leak; reconnect storm; silent room-expiry strand |
| A | [#29](https://github.com/YmlyZA/uniclip/pull/29) | Security (2 High) | Encrypt file-offer metadata; CLI terminal-escape injection |
| C | [#30](https://github.com/YmlyZA/uniclip/pull/30) | Functional regressions | CLI synced delete; web pin/IME/clipboard; protocol-version enforcement |
| D | [#31](https://github.com/YmlyZA/uniclip/pull/31) | Infrastructure | Container healthcheck + bun pin; CI PR-docker check; relay observability; XFF rate-limit fix; dead-lint removal |
| E | [#32](https://github.com/YmlyZA/uniclip/pull/32) | Deferred follow-ups | Non-root relay container; client-core lifecycle hardening |
| F | (this branch) | Final fixes + docs | Tailwind off beta; `disconnect()` status; this record + docs refresh |

## Findings by severity

### High (security) — both fixed in PR #29

1. **File-transfer offer metadata was sent to the relay in plaintext.** `FileOfferSchema`
   carried `name`/`mime`/`size`/`chunkCount`/`hash` as cleartext; only the file *chunks* were
   encrypted. A zero-knowledge Mode-A room therefore leaked every file's exact name, size, and
   SHA-256 fingerprint to the relay. **Fix:** the offer metadata is now AES-GCM sealed (AAD
   `file-offer:${routingId}:${fileId}`, disjoint from the clip/chunk/presence/persist AADs);
   the wire frame is `{type,fileId,iv,ciphertext}`; the receiver re-validates the decrypted
   metadata with an equal-strength Zod schema and drops silently on any failure.
   `PROTOCOL_VERSION` was bumped 1→2 (intentional breaking wire change; text sync unaffected).

2. **CLI rendered peer-controlled text to the terminal without sanitization.** A room peer
   could embed terminal escape sequences in a clip or filename — notably **OSC-52 to silently
   overwrite the victim's OS clipboard**, or cursor/prompt spoofing. **Fix:** a display-only
   `stripTerminal()` (removes CSI/OSC/two-char-ESC sequences, then an unconditional C0/C1/DEL
   sweep that guarantees no ESC byte survives) is applied at every peer-text render site; the
   copy-to-clipboard and stored paths keep the raw text. The whole-branch review additionally
   caught that `error` frames were not gated to WS-only, letting a peer inject the same
   sequences over the P2P data channel — now gated like the other signaling frames.

### Medium

- **Rate limits keyed on the spoofable first `X-Forwarded-For` hop** (PR #31) let a client
  rotate the header to bypass per-IP limits on the authless relay. Now keyed on the **last**
  (trusted-proxy-appended) hop via a shared `clientIp()` helper.
- **`signalLimiter` was never swept** (PR #28) — one Map entry leaked per connection that ever
  sent WebRTC signaling (the default path) → unbounded relay memory growth. Now swept with the
  other limiters.
- **Max-age GC deleted rooms with live sockets** (PR #28), silently stranding both peers (every
  later frame dropped at `store.get()===undefined`, unrecoverable, no observability). GC now
  closes each socket with `ROOM_EXPIRED` (close code 4410) before deleting.
- **Reconnect backoff reset on the raw WS open** (PR #28): the relay accepts the upgrade then
  closes for a permanent condition, so backoff reset every attempt → a ~1s reconnect storm
  against a dead room. Backoff now resets on the protocol `hello`; terminal close codes
  (4404/4413/4410) stop reconnecting and surface an error.
- **Relay observability was one log line** (PR #31): added `unhandledRejection`/
  `uncaughtException` handlers, `uniclip_frames_dropped_total{reason}` +
  `uniclip_ws_closed_total{code}` metrics (incl. GC `ROOM_EXPIRED` closes), and gc-count logs.
- **Container ran as root, no healthcheck** (PR #31/#32): added a `/api/health` HEALTHCHECK,
  and made the relay run as non-root `bun` via a `su-exec` entrypoint that chowns the data dir
  first (handling the existing root-owned prod volume with no manual ops step).
- **Protocol version declared but unenforced** (PR #30): the client now compares
  `hello.protocolVersion` and emits an advisory `VERSION_MISMATCH`; the relay counts dropped
  frames.

### Functional regressions (PR #30)

- CLI never subscribed to the `delete` event → synced delete didn't work in the TUI (and CLI-
  authored items used a synthetic id, so peer deletes couldn't match — both fixed).
- Web live list evicted with a blind `slice(-50)` that dropped **pinned** items → now shares
  `evictOldestUnpinned` with the persisted store.
- Enter-to-send fired during IME composition, sending half-composed CJK text → guarded with
  `!isComposing`.
- `ClipboardWatcher.start()` never rejected → the "couldn't start sync" permission toast was
  dead code → now probes clipboard readability. (The whole-branch review caught a double-start
  race the probe introduced; closed with a generation counter.)

### Low / housekeeping (PRs #31, #32, F)

- Lint was a no-op giving false assurance → the dead `eslint-config` scaffolding was removed.
- CI didn't build the image on PRs → added a `docker-build-check` job; cached Playwright
  browsers; pinned bun to `1.3-alpine`; `.dockerignore` excludes key/cert material.
- `node.json` used the wrong `bun-types` reference → fixed to `["bun"]`.
- Tailwind was pinned to `^4.0.0-beta.3` → moved to stable `^4.3.2`.
- Client-core lifecycle: `openSocket()` now guards `disposed` as well as `terminated`;
  `connect()` throws when terminated; `onOffer()` closes a duplicate-`fileId` TOCTOU window;
  `disconnect()` emits `disconnected` even when the socket was already null.

## What the whole-branch reviews caught

The per-task reviews were clean, but the broad whole-branch pass found defects no single-task
review could see — the strongest evidence for that layer:

- **Batch A:** an `error`-frame path that bypassed the terminal-escape fix over P2P
  (Critical), and a relay test still built the old plaintext offer shape (Important, and the
  relay suite hadn't been run on that branch).
- **Batch C:** a clipboard `start()` double-start race introduced by the permission-probe fix
  (Important), and the CLI synced-delete feature being half-working because CLI-authored items
  used a synthetic id (Important).
- **Batch D:** the new observability didn't fully land — the GC close path wasn't counted and
  the gc log sat at `debug` (invisible under the prod `info` level).

## Known, accepted, or deferred

- **onOffer / disconnect double-emit notes:** benign, deduped by consumers; no action.
- **Docker image pins to `1.3-alpine` (minor), not an exact patch:** deliberate.
- **PR docker-build-check uses `CLI_TARGETS=none`:** the CLI cross-compile still runs only on
  the post-merge publish job — a documented speed tradeoff.
- Real cross-device UX (clipboard permissions, IME, terminal rendering across emulators) is
  best confirmed on physical devices; see `docs/cross-device-validation-runsheet.md`.

## Security invariants confirmed to hold

The audit re-verified and the changes preserve: Mode-A zero-knowledge (only `routingId`
reaches the relay; the secret lives only in the URL fragment); AAD domain separation across
wire / presence / file-offer / at-rest; backfill is Mode-A-only, memory-only, and cleared on
empty; `RoomDb` stores metadata only; single-sourced key derivation; zero-knowledge synced
delete; and the app-layer AES-GCM envelope sitting on top of DTLS so a malicious relay only
ever sees double-encrypted ciphertext.
