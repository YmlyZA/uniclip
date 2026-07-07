# Versioning + Update Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give uniclip a real semver identity (root `package.json` + build git sha), expose it on the relay API with a cached GitHub-releases update check, and display it in the web footer and CLI.

**Architecture:** Root `package.json` `version` is the single source; the short git sha rides in via a Docker `--build-arg GIT_SHA`. The relay reads both, serves `GET /api/version` `{version,gitSha,latest,updateAvailable,checkedAt}` (plus `version` on `/api/health`), and a stale-while-revalidate `UpdateChecker` (injectable fetch, opt-out env) compares the running version to the latest GitHub release. The web footer fetches `/api/version`; the CLI embeds version+sha at build.

**Tech Stack:** Bun+Hono relay (tests under Bun), Svelte 5 web (pure-fn node tests), Ink CLI (tsup + `bun build --compile`). No new runtime deps.

## Global Constraints

- **Single version source:** root `package.json` `version` (semver, `0.1.0`). Sub-packages stay `0.0.0`.
- **Git sha:** Docker `--build-arg GIT_SHA`; relay/CLI read it; fallback `"dev"` when unset. Displayed string `v{version} ({gitSha})`, or `v{version}` when sha is `dev`.
- **`GET /api/version`** → `{ version: string, gitSha: string, latest: string | null, updateAvailable: boolean, checkedAt: number | null }`. `/api/health` also gains a `version: string` field.
- **Update check:** server-side only; fetch `https://api.github.com/repos/${UPDATE_REPO}/releases/latest` (default `UPDATE_REPO=YmlyZA/uniclip`), `tag_name` → semver-compare. Cache TTL ~1h, stale-while-revalidate. Opt-out `UPDATE_CHECK` ∈ `{off,0,false}` → no fetch, `latest:null, updateAvailable:false`. Graceful on any failure (offline / non-2xx / no releases / parse error) → `updateAvailable:false`, never throws. Fetch is injectable so tests never hit the network.
- **Web footer** is at page bottom (not the header). Fetch failure → show version only, no error UI.
- **No CLI update check.** No one-click self-update (deferred).
- **Toolchain:** relay tests run under Bun (`pnpm --filter @uniclip/relay test <pattern>`), must cast `(await res.json()) as {...}`; if a new dep needs it, add to `vitest.config.ts` `deps.inline`. Web tests are pure-fn node (`import { describe, it, expect } from "vitest"`), no component tests, `vi.stubGlobal` for globals. `turbo test`/`typecheck` must not `dependOn ^build`.

---

### Task 1: Version model + build/deploy injection + `isNewer`

**Files:**
- Create: `apps/relay/src/version.ts`
- Create: `apps/relay/src/version.test.ts`
- Modify: `apps/relay/tsconfig.json` (ensure `resolveJsonModule`)
- Modify: `apps/relay/src/server.ts` (read root version + `UNICLIP_GIT_SHA`)
- Modify: `Dockerfile` (runtime stage `ARG GIT_SHA` + `ENV UNICLIP_GIT_SHA`)
- Modify: `deploy/vps-caddy.sh` (pass `--build-arg GIT_SHA`)
- Modify: `deploy/docker-compose.yml`, `deploy/lan-https/docker-compose.yml` (`build.args.GIT_SHA`)

**Interfaces:**
- Produces: `parseSemver(v: string): [number,number,number] | null`, `isNewer(latest: string, current: string): boolean` (in `apps/relay/src/version.ts`). Consumed by Task 2's `UpdateChecker`.

- [ ] **Step 1: Write the failing test for `isNewer`/`parseSemver`**

Create `apps/relay/src/version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSemver, isNewer } from "./version";

describe("parseSemver", () => {
  it("parses x.y.z with optional leading v and trailing metadata", () => {
    expect(parseSemver("v0.1.0")).toEqual([0, 1, 0]);
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("v0.2.0-rc.1")).toEqual([0, 2, 0]);
    expect(parseSemver("nope")).toBeNull();
  });
});

describe("isNewer", () => {
  it("is true only when latest > current", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("v0.1.1", "0.1.0")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
  });
  it("returns false (never throws) on unparseable input", () => {
    expect(isNewer("garbage", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — must fail (module missing)**

Run: `pnpm --filter @uniclip/relay test version`
Expected: FAIL — cannot resolve `./version`.

- [ ] **Step 3: Implement `version.ts` (the helper half)**

Create `apps/relay/src/version.ts`:

```ts
// Semver parse/compare (major.minor.patch; pre-release/build metadata ignored
// for comparison) — small enough to avoid a dependency.
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number);
  }
  return false;
}
```

- [ ] **Step 4: Run it — must pass**

Run: `pnpm --filter @uniclip/relay test version`
Expected: PASS.

- [ ] **Step 5: Read root version + git sha in `server.ts`**

In `apps/relay/src/server.ts`, add near the top imports:

```ts
import rootPkg from "../../../package.json";
```

Add after the existing const declarations (before `buildApp(...)`):

```ts
const version = rootPkg.version;
const gitSha = process.env.UNICLIP_GIT_SHA ?? "dev";
```

Then extend the `buildApp({...})` call to pass them (add these two lines inside the object literal):

```ts
  version,
  gitSha,
```

In `apps/relay/src/app.ts`, extend `AppDeps` — **`version`/`gitSha` are OPTIONAL with a `"dev"` default**. This is deliberate: `buildApp({...})` is called in ~10 existing test files with only `roomCount`; making these required would break every one. `server.ts` always passes real values; tests that don't care omit them.

```ts
export interface AppDeps {
  roomCount: () => number;
  store?: RoomStore;
  metrics?: Metrics;
  ipLimiter?: { allow: (ip: string) => boolean };
  staticRoot?: string;
  version?: string;
  gitSha?: string;
}
```

And add `version` to the health response (default `"dev"`):

```ts
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      version: deps.version ?? "dev",
      rooms: deps.roomCount(),
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );
```

(`health.test.ts` asserts fields individually, not a strict `toEqual`, so the added `version` field does not break it. No existing test file needs changes.)

- [ ] **Step 6: Ensure `resolveJsonModule`**

In `apps/relay/tsconfig.json`, confirm `compilerOptions.resolveJsonModule` is `true`; add it if absent. Then:

Run: `pnpm --filter @uniclip/relay typecheck`
Expected: no errors (the `../../../package.json` import resolves; `server.ts` compiles).

> If typecheck errors that `package.json` is not under `rootDir`, add `"rootDir": "."` is NOT correct — instead ensure the tsconfig `include` covers `src` only and `resolveJsonModule` is set; the import of a file outside `src` is allowed for JSON module resolution. If it still errors, fall back to reading the version via `--build-arg`/env like the CLI does (define `process.env.UNICLIP_VERSION`) and set `const version = process.env.UNICLIP_VERSION ?? "dev"`. Prefer the import; use the fallback only if tsc blocks it.

- [ ] **Step 7: Dockerfile — accept + expose the git sha**

In `Dockerfile`, in the **runtime** stage (the final `FROM oven/bun:1-alpine AS runtime` block), add after `WORKDIR /app`:

```dockerfile
ARG GIT_SHA=dev
ENV UNICLIP_GIT_SHA=$GIT_SHA
```

- [ ] **Step 8: Deploy entrypoints pass `GIT_SHA`**

In `deploy/vps-caddy.sh`, find the `build_image()` function's `run docker build -t uniclip:latest "$REPO_ROOT"` line and change it to:

```bash
  run docker build --build-arg GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)" -t uniclip:latest "$REPO_ROOT"
```

In `deploy/docker-compose.yml` and `deploy/lan-https/docker-compose.yml`, under the relay service's `build:` block, add:

```yaml
    build:
      context: ..            # (keep the existing context/dockerfile lines as they are)
      args:
        GIT_SHA: ${GIT_SHA:-unknown}
```

(Only add the `args:` key; leave `context`/`dockerfile` unchanged. Operators export `GIT_SHA=$(git rev-parse --short HEAD)` before `docker compose up --build`, else it's `unknown`.)

- [ ] **Step 9: Verify + commit**

Run: `pnpm --filter @uniclip/relay test && pnpm --filter @uniclip/relay typecheck`
Expected: PASS / no errors.

```bash
git add apps/relay/src/version.ts apps/relay/src/version.test.ts apps/relay/src/app.ts apps/relay/src/server.ts apps/relay/tsconfig.json Dockerfile deploy/vps-caddy.sh deploy/docker-compose.yml deploy/lan-https/docker-compose.yml
git commit -m "feat(relay): version source (root pkg + GIT_SHA build-arg) + isNewer; version on /api/health"
```

---

### Task 2: Relay `/api/version` + update check

**Files:**
- Modify: `apps/relay/src/version.ts` (add `UpdateChecker` + `fetchLatestRelease`)
- Modify: `apps/relay/src/version.test.ts` (UpdateChecker tests)
- Modify: `apps/relay/src/app.ts` (`AppDeps.updateStatus`, `GET /api/version`)
- Modify: `apps/relay/src/app.test.ts` (or the relay test that builds the app) — assert `/api/version` shape
- Modify: `apps/relay/src/server.ts` (construct `UpdateChecker`, pass `updateStatus`)

**Interfaces:**
- Consumes: `isNewer` (Task 1).
- Produces:
  - `interface UpdateSnapshot { latest: string | null; updateAvailable: boolean; checkedAt: number | null }`
  - `class UpdateChecker` with `constructor(opts: { current: string; enabled: boolean; ttlMs: number; fetchLatest: () => Promise<string | null>; now?: () => number })`, `snapshot(): UpdateSnapshot`, `refresh(): Promise<void>`.
  - `fetchLatestRelease(repo: string): Promise<string | null>`.
  - `AppDeps.updateStatus?: () => UpdateSnapshot`.

- [ ] **Step 1: Write failing UpdateChecker tests**

Add to `apps/relay/src/version.test.ts`:

```ts
import { UpdateChecker } from "./version";

describe("UpdateChecker", () => {
  it("reports an available update after a refresh finds a newer tag", async () => {
    const c = new UpdateChecker({
      current: "0.1.0", enabled: true, ttlMs: 1000,
      fetchLatest: async () => "v0.2.0", now: () => 1000,
    });
    await c.refresh();
    expect(c.snapshot()).toEqual({ latest: "v0.2.0", updateAvailable: true, checkedAt: 1000 });
  });
  it("reports no update when latest equals current", async () => {
    const c = new UpdateChecker({ current: "0.1.0", enabled: true, ttlMs: 1000, fetchLatest: async () => "v0.1.0", now: () => 1 });
    await c.refresh();
    expect(c.snapshot().updateAvailable).toBe(false);
  });
  it("never fetches when disabled", async () => {
    let called = 0;
    const c = new UpdateChecker({ current: "0.1.0", enabled: false, ttlMs: 1000, fetchLatest: async () => { called++; return "v9.9.9"; } });
    c.snapshot(); await c.refresh();
    expect(called).toBe(0);
    expect(c.snapshot()).toEqual({ latest: null, updateAvailable: false, checkedAt: null });
  });
  it("stays graceful when the fetch throws (no crash, no update)", async () => {
    const c = new UpdateChecker({ current: "0.1.0", enabled: true, ttlMs: 1000, fetchLatest: async () => { throw new Error("offline"); }, now: () => 5 });
    await c.refresh();
    expect(c.snapshot()).toEqual({ latest: null, updateAvailable: false, checkedAt: 5 });
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `pnpm --filter @uniclip/relay test version`
Expected: FAIL — `UpdateChecker` not exported.

- [ ] **Step 3: Implement `UpdateChecker` + `fetchLatestRelease`**

Append to `apps/relay/src/version.ts`:

```ts
export interface UpdateSnapshot {
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
}

// Cached, stale-while-revalidate check. snapshot() returns the cache immediately
// and kicks off an async refresh when the cache is empty or older than ttlMs.
// Any fetch failure is swallowed — the relay must never crash on the update check.
export class UpdateChecker {
  private latest: string | null = null;
  private checkedAt: number | null = null;
  private refreshing = false;
  constructor(
    private readonly opts: {
      current: string;
      enabled: boolean;
      ttlMs: number;
      fetchLatest: () => Promise<string | null>;
      now?: () => number;
    },
  ) {}

  private nowMs(): number {
    return (this.opts.now ?? Date.now)();
  }

  snapshot(): UpdateSnapshot {
    if (this.opts.enabled && this.isStale()) void this.refresh();
    return {
      latest: this.latest,
      updateAvailable: this.latest ? isNewer(this.latest, this.opts.current) : false,
      checkedAt: this.checkedAt,
    };
  }

  private isStale(): boolean {
    return this.checkedAt === null || this.nowMs() - this.checkedAt >= this.opts.ttlMs;
  }

  async refresh(): Promise<void> {
    if (!this.opts.enabled || this.refreshing) return;
    this.refreshing = true;
    try {
      const tag = await this.opts.fetchLatest();
      if (tag) this.latest = tag;
    } catch {
      /* graceful: keep any previously-known latest */
    } finally {
      this.checkedAt = this.nowMs();
      this.refreshing = false;
    }
  }
}

// Real GitHub Releases fetch. Returns the latest release tag (e.g. "v0.2.0") or
// null on any non-2xx / missing tag. Short timeout so a hung request can't wedge.
export async function fetchLatestRelease(repo: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "uniclip" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { tag_name?: string };
  return body.tag_name ?? null;
}
```

- [ ] **Step 4: Run — must pass**

Run: `pnpm --filter @uniclip/relay test version`
Expected: PASS (helper + UpdateChecker tests).

- [ ] **Step 5: Add `/api/version` route + `AppDeps.updateStatus`**

In `apps/relay/src/app.ts`, import the type and extend `AppDeps`:

```ts
import type { UpdateSnapshot } from "./version";
```
```ts
  // (version?/gitSha? were added in Task 1; add updateStatus here)
  updateStatus?: () => UpdateSnapshot;
```

Add the route right after the `/api/health` handler (same `"dev"` default as health):

```ts
  app.get("/api/version", (c) =>
    c.json({
      version: deps.version ?? "dev",
      gitSha: deps.gitSha ?? "dev",
      ...(deps.updateStatus?.() ?? { latest: null, updateAvailable: false, checkedAt: null }),
    }),
  );
```

- [ ] **Step 6: Write the failing `/api/version` route test**

Add to the relay app test (`apps/relay/src/app.test.ts`; if that file doesn't exist, find the test that calls `buildApp` and add there):

```ts
it("GET /api/version returns version + gitSha + update fields", async () => {
  const app = buildApp({
    roomCount: () => 0,
    version: "0.1.0",
    gitSha: "abc1234",
    updateStatus: () => ({ latest: "v0.2.0", updateAvailable: true, checkedAt: 123 }),
  });
  const res = await app.request("/api/version");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    version: string; gitSha: string; latest: string | null; updateAvailable: boolean; checkedAt: number | null;
  };
  expect(body).toEqual({ version: "0.1.0", gitSha: "abc1234", latest: "v0.2.0", updateAvailable: true, checkedAt: 123 });
});

it("GET /api/version defaults the update fields when no checker is wired", async () => {
  const app = buildApp({ roomCount: () => 0, version: "0.1.0", gitSha: "dev" });
  const body = (await (await app.request("/api/version")).json()) as { latest: null; updateAvailable: boolean };
  expect(body.latest).toBeNull();
  expect(body.updateAvailable).toBe(false);
});
```

> `version`/`gitSha` are optional (Task 1), so existing `buildApp({...})` calls in `app.test.ts` and the `test/` suite need NO changes. Only the two new tests above pass explicit values.

- [ ] **Step 7: Run — must pass**

Run: `pnpm --filter @uniclip/relay test app`
Expected: PASS (new version-route tests + existing app tests with the added `version`/`gitSha`).

- [ ] **Step 8: Wire the real UpdateChecker in `server.ts`**

In `apps/relay/src/server.ts`, add imports:

```ts
import { UpdateChecker, fetchLatestRelease } from "./version";
```

Add after the `version`/`gitSha` consts:

```ts
const updateEnabled = !/^(off|0|false)$/i.test((process.env.UPDATE_CHECK ?? "").trim());
const updateRepo = process.env.UPDATE_REPO ?? "YmlyZA/uniclip";
const updateChecker = new UpdateChecker({
  current: version,
  enabled: updateEnabled,
  ttlMs: 3_600_000,
  fetchLatest: () => fetchLatestRelease(updateRepo),
});
```

Add `updateStatus: () => updateChecker.snapshot(),` to the `buildApp({...})` object.

- [ ] **Step 9: Verify + commit**

Run: `pnpm --filter @uniclip/relay test && pnpm --filter @uniclip/relay typecheck`
Expected: PASS / no errors.

```bash
git add apps/relay/src/version.ts apps/relay/src/version.test.ts apps/relay/src/app.ts apps/relay/src/app.test.ts apps/relay/src/server.ts
git commit -m "feat(relay): GET /api/version + cached GitHub-releases update check (opt-out, graceful)"
```

---

### Task 3: Web footer

**Files:**
- Create: `apps/web/src/lib/version.ts`
- Create: `apps/web/src/lib/version.test.ts`
- Create: `apps/web/src/components/footer.svelte`
- Modify: `apps/web/src/app.svelte` (render `<Footer />`)

**Interfaces:**
- Consumes: the relay `GET /api/version` shape `{ version, gitSha, latest, updateAvailable, checkedAt }`.
- Produces (pure lib): `formatVersion(v: { version: string; gitSha: string }): string`, `updateLabel(v: { updateAvailable: boolean; latest: string | null }): string | null`, `releasesUrl(repo?: string): string`.

- [ ] **Step 1: Write the failing lib test**

Create `apps/web/src/lib/version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatVersion, updateLabel, releasesUrl } from "./version";

describe("formatVersion", () => {
  it("includes the git sha unless it is 'dev'", () => {
    expect(formatVersion({ version: "0.1.0", gitSha: "a730078" })).toBe("v0.1.0 (a730078)");
    expect(formatVersion({ version: "0.1.0", gitSha: "dev" })).toBe("v0.1.0");
    expect(formatVersion({ version: "0.1.0", gitSha: "" })).toBe("v0.1.0");
  });
});

describe("updateLabel", () => {
  it("is null unless an update is available, else names the latest with a v prefix", () => {
    expect(updateLabel({ updateAvailable: false, latest: "v0.2.0" })).toBeNull();
    expect(updateLabel({ updateAvailable: true, latest: null })).toBeNull();
    expect(updateLabel({ updateAvailable: true, latest: "v0.2.0" })).toBe("Update available: v0.2.0");
    expect(updateLabel({ updateAvailable: true, latest: "0.2.0" })).toBe("Update available: v0.2.0");
  });
});

describe("releasesUrl", () => {
  it("defaults to the uniclip repo", () => {
    expect(releasesUrl()).toBe("https://github.com/YmlyZA/uniclip/releases");
    expect(releasesUrl("fork/x")).toBe("https://github.com/fork/x/releases");
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `pnpm --filter @uniclip/web test version`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/version.ts`**

Create `apps/web/src/lib/version.ts`:

```ts
// Pure formatting for the footer (tested in node; the .svelte shell just renders these).
export function formatVersion(v: { version: string; gitSha: string }): string {
  return v.gitSha && v.gitSha !== "dev" ? `v${v.version} (${v.gitSha})` : `v${v.version}`;
}

export function updateLabel(v: { updateAvailable: boolean; latest: string | null }): string | null {
  if (!v.updateAvailable || !v.latest) return null;
  const tag = v.latest.startsWith("v") ? v.latest : `v${v.latest}`;
  return `Update available: ${tag}`;
}

export function releasesUrl(repo = "YmlyZA/uniclip"): string {
  return `https://github.com/${repo}/releases`;
}
```

- [ ] **Step 4: Run — must pass**

Run: `pnpm --filter @uniclip/web test version`
Expected: PASS.

- [ ] **Step 5: Create the footer component**

Create `apps/web/src/components/footer.svelte`:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { formatVersion, updateLabel, releasesUrl } from "../lib/version";

  type VersionInfo = { version: string; gitSha: string; latest: string | null; updateAvailable: boolean };
  let info = $state<VersionInfo | null>(null);

  const relayBase = import.meta.env.VITE_RELAY_BASE ?? window.location.origin;

  onMount(async () => {
    try {
      const res = await fetch(`${relayBase}/api/version`);
      if (res.ok) info = (await res.json()) as VersionInfo;
    } catch {
      /* offline / relay down — footer simply doesn't render */
    }
  });

  const label = $derived(info ? updateLabel(info) : null);
</script>

{#if info}
  <footer style="text-align:center;padding:10px;font-size:11px;opacity:0.55;">
    <span>{formatVersion(info)}</span>
    {#if label}
      · <a href={releasesUrl()} target="_blank" rel="noopener" style="color:inherit;">{label}</a>
    {/if}
  </footer>
{/if}
```

- [ ] **Step 6: Render the footer in the app shell**

In `apps/web/src/app.svelte`, add the import and render `<Footer />` after the route block:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { currentRoute, type Route } from "./lib/router";
  import Landing from "./routes/landing.svelte";
  import Room from "./routes/room.svelte";
  import Footer from "./components/footer.svelte";

  let route: Route = $state(currentRoute());

  onMount(() => {
    const onPop = () => (route = currentRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });
</script>

{#if route.name === "landing"}
  <Landing />
{:else if route.name === "room"}
  <Room room={route.room} />
{/if}

<Footer />
```

- [ ] **Step 7: Verify + commit**

Run: `pnpm --filter @uniclip/web test && pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web build`
Expected: tests PASS, svelte-check clean, build succeeds.

```bash
git add apps/web/src/lib/version.ts apps/web/src/lib/version.test.ts apps/web/src/components/footer.svelte apps/web/src/app.svelte
git commit -m "feat(web): footer shows version + update-available link (fetches /api/version)"
```

---

### Task 4: CLI version display

**Files:**
- Create: `apps/cli/src/version.ts`
- Create: `apps/cli/src/version.test.ts`
- Modify: `apps/cli/src/cli.tsx` (`--version` prints the version string)
- Modify: `apps/cli/src/components/Header.tsx` (show the version)
- Modify: `apps/cli/scripts/build-binaries.sh` (`--define` version + sha)
- Modify: `Dockerfile` (`cli-builder` stage `ARG GIT_SHA`, pass to the build script)

**Interfaces:**
- Produces: `VERSION`, `GIT_SHA`, `versionString(): string` (in `apps/cli/src/version.ts`).

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fmtVersion } from "./version";

describe("fmtVersion", () => {
  it("appends the sha unless it is 'dev'", () => {
    expect(fmtVersion("0.1.0", "a730078")).toBe("0.1.0 (a730078)");
    expect(fmtVersion("0.1.0", "dev")).toBe("0.1.0");
    expect(fmtVersion("dev", "dev")).toBe("dev");
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `pnpm --filter @uniclip/cli test version`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `version.ts`**

Create `apps/cli/src/version.ts`:

```ts
// Version + git sha are injected at build via `bun build --define` (see
// scripts/build-binaries.sh) and tsup; both default to "dev" for local runs.
export const VERSION = process.env.UNICLIP_VERSION ?? "dev";
export const GIT_SHA = process.env.UNICLIP_GIT_SHA ?? "dev";

export function fmtVersion(version: string, sha: string): string {
  return version !== "dev" && sha && sha !== "dev" ? `${version} (${sha})` : version;
}

export const versionString = (): string => fmtVersion(VERSION, GIT_SHA);
```

- [ ] **Step 4: Run — must pass**

Run: `pnpm --filter @uniclip/cli test version`
Expected: PASS.

- [ ] **Step 5: Use it in `cli.tsx`**

In `apps/cli/src/cli.tsx`, replace the `import pkg from "../package.json";` line with:

```ts
import { versionString } from "./version";
```

Change the version branch (currently `if (version) { console.log(pkg.version); return; }`) to:

```ts
  if (version) { console.log(versionString()); return; }
```

- [ ] **Step 6: Show the version in the TUI header**

In `apps/cli/src/components/Header.tsx`, import and render the version (small, right side). Add the import:

```tsx
import { versionString } from "../version";
```

Add a dim version label to the header row (append inside the header's top `<Box>`, following the existing status/peer elements):

```tsx
      <Text dimColor> v{versionString()}</Text>
```

(Place it so it reads e.g. `… peers: 2  v0.1.0 (a730078)`. Match the file's existing `<Box>`/`<Text>` layout; if the header is a single row, append this `<Text>` at its end.)

- [ ] **Step 7: Inject version + sha into the binary build**

In `apps/cli/scripts/build-binaries.sh`, before the build loop compute the version, and add the two `--define`s to the `bun build --compile` line:

```bash
VERSION="$(node -p "require('../../package.json').version" 2>/dev/null || echo dev)"
GIT_SHA="${GIT_SHA:-dev}"
```
and change the compile line to:
```bash
  bun build --compile --target="bun-$t" \
    --define "process.env.UNICLIP_VERSION=\"$VERSION\"" \
    --define "process.env.UNICLIP_GIT_SHA=\"$GIT_SHA\"" \
    src/bin.ts --outfile "$OUT/uniclip-$t"
```

> `node -p require('../../package.json')` resolves the ROOT package.json relative to `apps/cli/` (the script's cwd when invoked as `cd apps/cli && sh scripts/build-binaries.sh`). If `node` is unavailable in the build image, read it with `grep`: `VERSION="$(grep -m1 '"version"' ../../package.json | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')"`.

- [ ] **Step 8: Pass `GIT_SHA` into the `cli-builder` Docker stage**

In `Dockerfile`, in the `FROM oven/bun:1-alpine AS cli-builder` stage, add `ARG GIT_SHA=dev` (near its `WORKDIR`), and change the build-run line to pass it through:

```dockerfile
ARG GIT_SHA=dev
```
and:
```dockerfile
RUN cd apps/cli && CLI_TARGETS="$CLI_TARGETS" GIT_SHA="$GIT_SHA" sh scripts/build-binaries.sh
```

- [ ] **Step 9: Verify + commit**

Run: `pnpm --filter @uniclip/cli test && pnpm --filter @uniclip/cli typecheck`
Expected: PASS / no errors.
Run: `pnpm --filter @uniclip/cli exec tsx src/cli.tsx --version`
Expected: prints `dev` (no `--define` in a plain tsx run — that's correct; the real version is embedded only in the built binary).

```bash
git add apps/cli/src/version.ts apps/cli/src/version.test.ts apps/cli/src/cli.tsx apps/cli/src/components/Header.tsx apps/cli/scripts/build-binaries.sh Dockerfile
git commit -m "feat(cli): --version + TUI header show embedded version (root pkg + git sha)"
```

---

### Task 5: Release process docs

**Files:**
- Modify: `deploy/README.md` (add a "Releasing" section)

No code, no tests — documentation. The actual first `v0.1.0` tag + GitHub release is cut by the controller after merge (it's an outward-facing action), not in this task.

- [ ] **Step 1: Add the "Releasing" section**

Append to `deploy/README.md`:

```markdown
## Releasing

Versions are semver from the root `package.json`; the deployed instance's update
check compares against the **latest GitHub release**.

To cut a release:
```bash
# 1. bump the root version
npm version --no-git-tag-version <major|minor|patch>   # edits package.json only
# 2. commit, tag, push
git commit -am "chore: release vX.Y.Z"
git tag vX.Y.Z && git push && git push --tags
# 3. publish the GitHub release (this is what instances compare against)
gh release create vX.Y.Z --title vX.Y.Z --generate-notes
```

The running version shows in the web footer and `uniclip --version` as
`vX.Y.Z (<git-sha>)`. An instance polls `https://api.github.com/repos/YmlyZA/uniclip/releases/latest`
hourly (server-side); disable with `UPDATE_CHECK=off`, or point at a fork with
`UPDATE_REPO=owner/name`.
```

- [ ] **Step 2: Commit**

```bash
git add deploy/README.md
git commit -m "docs: releasing process (semver + git tag + gh release)"
```

---

## Final verification (after all tasks)

- [ ] `pnpm typecheck` — all packages clean.
- [ ] `pnpm test` — all suites pass (relay version + /api/version; web footer lib; cli version; existing suites with the new required `version`/`gitSha` deps).
- [ ] Live check: `docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t uniclip:dev . && docker run --rm -p 3000:3000 uniclip:dev`, then `curl -s localhost:3000/api/version` shows `{version:"0.1.0", gitSha:"<sha>", ...}` and the web footer renders the version.
- [ ] Whole-branch review (opus): confirm no user-facing phone-home (update check is relay-only + opt-out + graceful), the version single-source holds, and nothing outside the versioning scope changed.
- [ ] After merge (controller, outward-facing): tag `v0.1.0` on main + `gh release create v0.1.0` via the `YmlyZA` account, so the update check has its baseline (running `0.1.0` vs latest `v0.1.0` → up to date).
