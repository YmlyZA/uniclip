# Uniclip — Self-hosted CLI installer (`curl … | setup.sh`) — Design Spec

**Date:** 2026-06-27
**Status:** Approved (pending spec review)
**Scope:** Let a user install the `uniclip` CLI from a running relay with no Node, npm, or build step: `curl -O http://host:port/setup.sh && sh setup.sh` detects the platform, downloads a **standalone binary** the relay serves, and installs it so `uniclip` runs directly. The binary is produced by **`bun build --compile`** (Bun is already the relay's runtime/toolchain). An alternative to npm publish (`npx uniclip`), which remains deferred.

**Feasibility verified during brainstorming:** a Bun-compiled binary ran the embedded LAN relay + two `UniclipClient`s + werift and synced a clip P2P — so werift/ws/Ink and the full transport work under Bun's compiled runtime.

## 1. Goals and non-goals

### Goals
1. `curl -O http://host:port/setup.sh && sh setup.sh` installs a working `uniclip` on macOS/Linux with **no prerequisite runtime** (no Node, no Bun, no npm).
2. The relay serves the installer and the per-platform binaries; the binaries are built in the Docker image.
3. The installed binary is the full CLI (text + files, P2P, `--lan` zero-internet) — same code as the tsup build, just packaged as a self-contained executable.

### Non-goals / preserved invariants
- **No change to CLI behavior or `client-core`/`protocol`/`crypto`.** This is packaging + serving; the binary runs the same `apps/cli` code.
- **Keep the existing tsup `dist/cli.js`** build (for `pnpm --filter @uniclip/cli dev` and a future npm publish). The compiled binary is an *additional* target.
- **No Windows** in v1 (CLI clipboard/mDNS less tested there) — `setup.sh` errors clearly on unsupported platforms; Windows is a later addition.
- **No auto-update, no telemetry, no PATH mutation of shell rc files** — `setup.sh` installs the binary and *prints* a PATH hint; it does not edit `~/.bashrc` etc.

## 2. The binary build (`apps/cli`)

`bun build --compile` bundles everything (incl. `werift`/`ws`/`bonjour-service`/`ink`/`react`) into one self-contained executable per target. Two issues the feasibility probe surfaced, both addressed here:

- **Entry guard.** `cli.tsx` runs `main()` only when `process.argv[1]` matches `/cli\.(tsx|js)$/`, which is false in a compiled binary (argv[1] is the binary name), so `main()` never runs. Fix: **export `main` from `cli.tsx`** and add a dedicated compile entry **`apps/cli/src/bin.ts`** (`import { main } from "./cli"; void main();`) that always runs it. The tsup `dist/cli.js` entry (and its guard) is unchanged.
- **`react-devtools-core`.** Ink statically pulls this dev-only dependency; the compile fails to resolve it (pnpm layout) and a `--external` binary then crashes at startup trying to load it. Fix: add **`react-devtools-core` as a `devDependency` of `apps/cli`** so it bundles into the binary (inert — Ink only uses it when `DEV=true`).
- **`--version` / `--help`.** Add a minimal flag handler to `args.ts` so the installed binary has a discoverable surface and a smoke-test handle: `uniclip --help` prints usage (create/join/`--lan`/`--relay-only`/`--name`); `uniclip --version` prints the version. **The version must be embedded at compile time** (a bundled `import { version } from "../package.json"` — Bun inlines the JSON) — a compiled binary has no `package.json` on disk, so a runtime file read would fail. (The package version is currently `0.0.0`; real versioning rides with the deferred publish.)

**Targets (v1):** `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` (glibc). A script **`apps/cli/scripts/build-binaries.sh`** loops them:
```
for t in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  bun build --compile --target=bun-$t src/bin.ts --outfile dist/dl/uniclip-$t
done
```
and writes `dist/dl/checksums.txt` (`<sha256>  uniclip-<os>-<arch>` per line). Cross-compilation from the alpine build host works (Bun fetches each target's runtime at build time — the Docker build has network).

## 3. Relay: serving the installer

- **Binaries + checksums** live under `STATIC_ROOT/dl/` and are served by the existing static handler (`static.ts`) as `application/octet-stream` — no new serving code, path-traversal already guarded.
- **`setup.sh` is a dynamic route, not a static file**, so it can fill in the base URL and checksums at request time. Add **`app.get("/setup.sh", …)`** to `apps/relay/src/app.ts` (or a small `installer.ts`): it returns the shell script (content-type `text/x-shellscript`) templated with:
  - `BASE` = `${scheme}://${host}` derived from the request (`Host` header; scheme from `x-forwarded-proto`, default `http`), so the downloaded script fetches from the same origin it came from — no host argument for the user;
  - the **per-artifact SHA-256** read from `${STATIC_ROOT}/dl/checksums.txt`, embedded so the script verifies integrity.
- The static handler's `index.html` fallback means a *missing* `/dl/<bad>` path returns the SPA HTML (200), not 404 — the script's checksum check catches this (HTML won't match), failing loudly instead of installing a non-binary.

## 4. `setup.sh` (POSIX `sh`)

Templated and served by the relay; pure POSIX (no bash-isms). Steps:
1. **Detect platform** — `os` from `uname -s` (`Darwin`→`darwin`, `Linux`→`linux`); `arch` from `uname -m` (`arm64`/`aarch64`→`arm64`, `x86_64`/`amd64`→`x64`). Unsupported → print a clear message + exit 1.
2. **Download** — `curl -fSL "$BASE/dl/uniclip-$os-$arch" -o "$tmp"` (a temp file).
3. **Verify** the embedded `sha256` for that artifact (`shasum -a 256` / `sha256sum`); mismatch → error + exit (guards a tampered binary *and* the SPA-HTML-fallback case).
4. **Install** — `chmod +x`, move to `~/.local/bin/uniclip` (`mkdir -p` first; no sudo). 
5. **PATH hint** — if `~/.local/bin` is not on `$PATH`, print one line telling the user how to add it (don't edit rc files). Print `Installed — run: uniclip`.

## 5. Docker

- New **`cli-builder` stage** (`oven/bun:1-alpine`): install `apps/cli` deps (+ `react-devtools-core`), run `build-binaries.sh` → `apps/cli/dist/dl/`.
- **Runtime stage** copies `apps/cli/dist/dl/*` into `${STATIC_ROOT}/dl/`.
- **Image-size note:** each binary is ~50–90 MB; 4 targets add a few hundred MB. Acceptable for a self-hosted relay; if a lean image is wanted, a `--build-arg CLI_TARGETS=…` can limit which targets are built (default all four).

## 6. Security model
- **Plain HTTP is MITM-able.** Downloading and executing a script + binary over `http://` can be intercepted; the embedded checksum only protects the *binary download* if the *script itself* wasn't tampered. For a **trusted / LAN / self-hosted** relay this is an accepted risk and matches the intended use. For an **internet-exposed** relay, **HTTPS is the mitigation** — the existing `tailscale serve` / Caddy deployments already provide it; the spec and `setup.sh` output state this plainly.
- **No privilege escalation:** installs to `~/.local/bin` (no sudo), edits no system files, mutates no shell rc.
- **No new room/relay attack surface:** the installer routes are unauthenticated static/templated GETs serving public artifacts; they expose nothing about rooms, keys, or content. The CLI binary is the same audited code.

## 7. Testing
- **`setup.sh`** — `shellcheck` clean; a test that serves a temp `dl/` dir (a fake "binary" + its real sha256) over a local HTTP server, runs the templated script with `BASE` pointed at it, and asserts: the right artifact name is chosen for the host platform, the checksum is verified (and a corrupted artifact is rejected), and the file lands executable in a temp install dir.
- **`/setup.sh` route** (relay test, Bun): asserts the response is a shell script templated with the request host and that it embeds the checksums from a fixture `dl/checksums.txt`; a wrong scheme/host header is reflected correctly.
- **`--version`/`--help`** (`args.ts` unit test): flags parse and produce the version/usage strings.
- **Build smoke test** — `build-binaries.sh` for the *host* target compiles, and the resulting binary runs `uniclip --version` (proves the entry/`react-devtools-core`/werift packaging). (The full werift-under-Bun transport is already proven; this guards regressions.) Heavy cross-target builds are not run in unit CI.

## 8. Decomposition (for the plan)
1. **CLI binary-ready** — `src/bin.ts` entry + export `main`; `react-devtools-core` devDep; `--version`/`--help` in `args.ts` (+ tests). Proves a host-target binary runs.
2. **`build-binaries.sh`** — multi-target compile + `checksums.txt` (+ host-target smoke test).
3. **`/setup.sh` relay route** — templated script (host + checksums) (+ relay test).
4. **`setup.sh` content** — platform detect / download / verify / install (+ shellcheck + local-serve test).
5. **Docker + docs** — `cli-builder` stage, copy `dl/*` into `STATIC_ROOT`, README install section.

Order 1→5; (1)(2) make the artifact, (3)(4) serve+install it, (5) wires the image and documents it.
