# Uniclip — Version management + update detection — Design Spec

**Date:** 2026-07-07
**Status:** Approved (pending spec review)
**Scope:** Give uniclip a real version identity and let a self-hosted instance tell its operator when a newer version exists. Adopt semver sourced from the root `package.json`, inject it (plus the build's git sha) at build time, expose it on the relay API, display it in the web UI (footer) and the CLI, and have the relay check GitHub Releases for a newer version. Feature 2 (mobile UI polish) is a separate later cycle.

## 1. Goals and non-goals

### Goals
1. One canonical version (semver) for the project, shown truthfully by every artifact (relay API, web UI, CLI).
2. A deployed instance displays its running version **and** whether a newer release is available, so the operator knows to update.
3. Zero user-data exposure: the update check is a server-side (relay) metadata-only GET to GitHub, opt-out-able, and never done from user browsers.

### Non-goals / deferred
- **One-click self-update** (trigger a `git pull` + docker-compose rebuild + restart from the UI) — explicitly **deferred to a follow-up cycle**. It has real security weight (a web action causing a rebuild/RCE needs auth + confirmation design) and is out of scope here. This spec only *detects and reports* an available update; applying it stays manual (re-run `deploy/vps-caddy.sh`, or `git pull && docker compose up -d --build`).
- **CLI update detection** — the CLI is not "the instance"; it connects to relays. It displays its own build version but does not check for updates.
- **Auto-update / telemetry / phone-home beyond the single GitHub GET.**
- No change to the zero-knowledge model: version/update metadata is public and carries no room, key, or content data.

## 2. Version model & build injection

- **Single source of truth:** the root `package.json` `version` field (semver, currently `0.1.0`). The workspace sub-packages keep their meaningless `0.0.0` (never published individually).
- **Release = ** bump root `version` → `git tag vX.Y.Z` (tag mirrors the version) → GitHub release for that tag.
- **Build identity:** the short git sha of the build, passed as a Docker `--build-arg GIT_SHA` (so `.git` need not be in the build context / image). The composed runtime string is `{version} ({gitSha})` — e.g. `0.1.0 (a730078)`. When the sha is unset (local `bun run` dev, `docker build` without the arg), it falls back to `dev`.
- **Injection paths:**
  - **Relay:** reads `version` from the bundled root `package.json` (inlined by `bun build` via an import) and `gitSha` from the `UNICLIP_GIT_SHA` env (Docker sets it from the `GIT_SHA` build-arg).
  - **CLI:** embeds root `version` + git sha at compile — `bun build --compile --define` in `build-binaries.sh` for the standalone binaries, and the tsup dev build. (Replaces the current `apps/cli/package.json` `0.0.0`.)
  - **Web:** does **not** bake a version in; it fetches it from the relay's `/api/version` at runtime (single source, no duplication, correct even if the SPA is cached).
- **Deploy wiring:** `deploy/docker-compose.yml`, `deploy/lan-https/docker-compose.yml`, and `deploy/vps-caddy.sh` pass `GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)` into the build.

## 3. Relay: `/api/version` + update check

- **New endpoint `GET /api/version`** → `{ version: string, gitSha: string, latest: string | null, updateAvailable: boolean, checkedAt: number | null }`. CORS same as the other `/api/*` routes.
- **`/api/health`** gains a `version` string field (ops-friendly for `curl`); the full detail stays in `/api/version`.
- **Update check:** a cached background check fetches `https://api.github.com/repos/${UPDATE_REPO}/releases/latest` (default `UPDATE_REPO=YmlyZA/uniclip`), reads `tag_name` (e.g. `v0.2.0`), strips a leading `v`, semver-compares to the running `version`, and caches `{ latest, updateAvailable, checkedAt }`.
  - **Cadence:** lazy on first `/api/version` request if the cache is empty or older than the TTL (default ~1h), refreshed in the background; never blocks the request longer than a short timeout (stale-while-revalidate — return the cached value, refresh async).
  - **Opt-out:** `UPDATE_CHECK=off` (also `0`/`false`) → no outbound call ever; `latest:null, updateAvailable:false, checkedAt:null`. Suits air-gapped / `--lan`-style deployments.
  - **Graceful failure:** offline, GitHub rate-limited/5xx, no releases yet, or an unparseable tag → `updateAvailable:false, latest:null`, cache the attempt time, never throw or crash the relay.
  - The fetch is an **injectable function** (`fetchLatestRelease`) so relay tests never hit the network.
- **Semver compare:** a small internal `isNewer(latest, current)` that parses `x.y.z` (ignoring pre-release/build metadata for the compare) — no new dependency.

## 4. Web footer

- A small **`footer`** at the bottom of the page rendering `v{version} ({gitSha})`. On mount it fetches `/api/version` from the relay base (same origin when the relay serves the SPA; the configured `VITE_RELAY_BASE` in split-origin dev).
- When `updateAvailable`, the footer shows a subtle **"Update available: v{latest}"** as a link to `https://github.com/${UPDATE_REPO}/releases`. Otherwise just the version string.
- Unobtrusive and low-contrast; deliberately **not** in the header (preserves mobile header space for Feature 2). Fetch failure → show only the (unknown-latest) version string, no error UI.

## 5. CLI version

- `uniclip --version` prints `{version} ({gitSha})` sourced from the **root** version + embedded sha (was `0.0.0`). The Ink TUI header shows the version too (small, right-aligned). No update check.

## 6. Release process + first release

- Deliver a short **"Releasing" section** (in `deploy/README.md` or a `RELEASING.md`): bump root `version` → `git tag vX.Y.Z` → `git push --tags` → `gh release create vX.Y.Z`. Note that the deployed instance's update check compares against the **latest GitHub release**.
- **Cut the first release `v0.1.0`** (tag + GitHub release) so update-detection has a baseline — until at least one release exists, `latest` stays null and `updateAvailable` is false.

## 7. Testing

- **Relay (Bun):** `isNewer` (`0.2.0 > 0.1.0` true; equal false; `0.1.0` vs malformed → false, no throw); the update-check logic with `fetchLatestRelease` stubbed (releases JSON → `latest`/`updateAvailable`); `UPDATE_CHECK=off` short-circuits (no fetch); graceful failure (stub throws → `updateAvailable:false`, no crash); `/api/version` response shape; `version` present in `/api/health`. (Relay tests must cast `res.json()` and run under Bun per repo conventions.)
- **Web:** the footer's pure logic (format `v{version} ({gitSha})`; `updateAvailable` → link text + href) as a `lib/` function unit-tested in node (matches the web test style; no component test).
- **CLI:** `args`/`--version` prints the embedded version string.
- Not tested: the live GitHub fetch (injected/stubbed everywhere) and the real Docker build-arg threading (verified by a build, not a unit test).

## 8. Decomposition (for the plan)

1. **Version model + build/deploy injection** — root version as source; relay reads `version` + `UNICLIP_GIT_SHA`; `Dockerfile` `ARG GIT_SHA`/`ENV`; the three deploy entrypoints pass `GIT_SHA`. Includes the `isNewer` helper + its tests.
2. **Relay `/api/version` + update check** — endpoint, injectable `fetchLatestRelease`, cached stale-while-revalidate check, `UPDATE_CHECK`/`UPDATE_REPO` envs, graceful failure; `version` added to `/api/health` (+ tests).
3. **Web footer** — `lib/` version-format logic (+ test) and a `footer` component fetching `/api/version`, wired into the app shell.
4. **CLI version** — embed root version + git sha (`build-binaries.sh` `--define` + tsup); `--version` + TUI header (+ args test).
5. **Release process + first `v0.1.0` release** — releasing docs; bump/tag/`gh release create v0.1.0`.

Order 1→5: (1) makes the version real and injected, (2) exposes it + the update check, (3)(4) display it, (5) establishes the release baseline the check compares against.
