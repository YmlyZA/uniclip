# Self-hosted CLI installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `curl -O http://host:port/setup.sh && sh setup.sh` installs a working `uniclip` standalone binary (no Node/Bun/npm needed), built by `bun build --compile` and served by the relay.

**Architecture:** Additive. A new `bun build --compile` entry (`apps/cli/src/bin.ts`) produces per-OS/arch self-contained binaries; a build script writes them + checksums under `apps/cli/dist/dl/`. The relay serves the binaries (existing static handler) and a **dynamic `/setup.sh`** route that templates the base URL (from the request host) + per-artifact checksums into a POSIX install script. Docker builds the binaries into the image. The existing tsup `dist/cli.js` build is untouched.

**Tech Stack:** Bun (`bun build --compile`), TypeScript, Hono (relay), POSIX `sh`, Docker.

## Global Constraints
- **No change to CLI behavior or `client-core`/`protocol`/`crypto`.** Packaging + serving only; the binary runs the same `apps/cli` code.
- **Keep the tsup `dist/cli.js` build and its `cli.tsx` entry guard unchanged.** The binary uses a *separate* entry (`bin.ts`).
- **The compiled binary has no `package.json` on disk** — `--version` must read a build-time-embedded value (bundled JSON import), never a runtime file read.
- **`setup.sh` is POSIX `sh`** (no bash-isms); installs to `~/.local/bin` (no sudo); edits no shell rc files.
- **Targets (v1):** `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. Windows is out of scope.
- **The checksum the script verifies also guards the static handler's SPA-HTML fallback** (a missing `/dl/<bad>` returns `index.html` 200; it won't match the sha256).
- Relay tests run under **Bun** (`bun --bun vitest`); CLI tests under plain **Node vitest**. Repo uses `exactOptionalPropertyTypes: true`.
- **Verified:** a `bun build --compile` binary of the CLI runs werift + ws + Ink and syncs a clip P2P (feasibility probe). The two gotchas it surfaced — the `cli.tsx` argv guard and Ink's `react-devtools-core` — are handled in Task 1.

---

### Task 1: Binary-ready CLI — `bin.ts` entry, `--version`/`--help`, `react-devtools-core`

**Files:**
- Modify: `apps/cli/src/args.ts` (+ `apps/cli/src/args.test.ts`)
- Modify: `apps/cli/src/cli.tsx` (export `main`; handle `--help`/`--version`)
- Create: `apps/cli/src/bin.ts`
- Modify: `apps/cli/package.json` (add `react-devtools-core` devDep)
- Modify: `apps/cli/tsconfig.json` (ensure `resolveJsonModule`)

**Interfaces:**
- `parseArgs` gains `help: boolean` and `version: boolean`.
- `cli.tsx` exports `async function main()`.
- `bin.ts` is the `bun build --compile` entry.

- [ ] **Step 1: Write the failing `args` test** — add to `apps/cli/src/args.test.ts`:

```ts
it("parses --help/-h and --version/-v (default false)", () => {
  expect(parseArgs([]).help).toBe(false);
  expect(parseArgs([]).version).toBe(false);
  expect(parseArgs(["--help"]).help).toBe(true);
  expect(parseArgs(["-h"]).help).toBe(true);
  expect(parseArgs(["--version"]).version).toBe(true);
  expect(parseArgs(["-v"]).version).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails.** `cd apps/cli && pnpm exec vitest run src/args.test.ts` → FAIL (`help`/`version` undefined).

- [ ] **Step 3: Implement in `args.ts`** — add the fields + parsing:

```ts
export function parseArgs(argv: string[]): { roomUrl?: string; relay: string; name?: string; relayOnly: boolean; lan: boolean; help: boolean; version: boolean } {
  let roomUrl: string | undefined;
  let relay = process.env.UNICLIP_RELAY ?? "http://localhost:3000";
  let name: string | undefined;
  let relayOnly = false;
  let lan = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--relay") { relay = argv[++i] ?? relay; }
    else if (a === "--name") { name = argv[++i]; }
    else if (a === "--relay-only") { relayOnly = true; }
    else if (a === "--lan") { lan = true; }
    else if (a === "--help" || a === "-h") { help = true; }
    else if (a === "--version" || a === "-v") { version = true; }
    else if (!a.startsWith("-")) { roomUrl = a; }
  }
  return {
    ...(roomUrl !== undefined ? { roomUrl } : {}),
    relay,
    ...(name !== undefined ? { name } : {}),
    relayOnly,
    lan,
    help,
    version,
  };
}
```

- [ ] **Step 4: Run to verify it passes.** `cd apps/cli && pnpm exec vitest run src/args.test.ts` → PASS.

- [ ] **Step 5: Wire `--help`/`--version` + export `main` in `cli.tsx`.** Add the version import + USAGE near the top (after the existing imports):

```tsx
import pkg from "../package.json";

const USAGE = `uniclip — end-to-end-encrypted universal clipboard (CLI)

Usage:
  uniclip                     create a room (prints a QR to scan)
  uniclip <room-url>          join a room
  uniclip --lan               host an offline LAN room (no internet)
  uniclip <lan-token>         join an offline LAN room

Options:
  --relay <base>   relay base URL (env UNICLIP_RELAY, default http://localhost:3000)
  --name <name>    device name shown in the roster
  --relay-only     force relay transport (disable P2P)
  -h, --help       show this help
  -v, --version    show version`;
```

Change `async function main()` → `export async function main()`, and at the very top of `main()` (before the `lan` branch) add:

```tsx
  const { roomUrl: arg, relay, name, relayOnly, lan, help, version } = parseArgs(process.argv.slice(2));

  if (version) { console.log(pkg.version); return; }
  if (help) { console.log(USAGE); return; }
```

(Replace the existing `const { … } = parseArgs(...)` line — the destructure now also pulls `help`/`version`.) Leave the rest of `main()` and the bottom `if (process.argv[1] && /cli\.(tsx|js)$/.test(...)) void main();` guard unchanged.

- [ ] **Step 6: Create the binary entry `apps/cli/src/bin.ts`:**

```ts
// Dedicated entrypoint for the `bun build --compile` standalone binary. The
// tsup build keeps using cli.tsx (whose argv-guard only runs main() when argv[1]
// is cli.js); in a compiled binary argv[1] is the binary name, so that guard
// stays false and main() would never run — this entry calls it explicitly.
import { main } from "./cli";

void main();
```

- [ ] **Step 7: Add `react-devtools-core` devDep + ensure `resolveJsonModule`.**

Run: `cd apps/cli && pnpm add -D react-devtools-core`
Then confirm `apps/cli/tsconfig.json` has `"resolveJsonModule": true` (add it under `compilerOptions` if absent — required for the `import pkg from "../package.json"`). If `tsc` also complains the JSON is outside `rootDir`, add `"resolveJsonModule": true` is enough for `--noEmit`; do not change `include`.

- [ ] **Step 8: Verify typecheck + full CLI suite.** `cd apps/cli && pnpm typecheck && pnpm exec vitest run` → clean + all pass.

- [ ] **Step 9: Smoke-compile the binary for the host and run it** (proves the entry + react-devtools-core + JSON version):

Run:
```
cd apps/cli && bun build --compile src/bin.ts --outfile /tmp/uniclip-smoke && /tmp/uniclip-smoke --version && /tmp/uniclip-smoke --help | head -1 && rm -f /tmp/uniclip-smoke
```
Expected: prints the version (`0.0.0`) then the first usage line. (If `--version`/`--help` print nothing, the entry/guard wiring is wrong — fix before committing.)

- [ ] **Step 10: Commit**

```bash
git add apps/cli/src/args.ts apps/cli/src/args.test.ts apps/cli/src/cli.tsx apps/cli/src/bin.ts apps/cli/package.json apps/cli/tsconfig.json pnpm-lock.yaml
git commit -m "feat(cli): bin.ts compile entry + --version/--help; bundle react-devtools-core (installer task 1)"
```

---

### Task 2: `build-binaries.sh` — multi-target compile + checksums

**Files:**
- Create: `apps/cli/scripts/build-binaries.sh` (executable)

**Interfaces:**
- Produces `apps/cli/dist/dl/uniclip-<os>-<arch>` for the four targets + `apps/cli/dist/dl/checksums.txt` (`<sha256>  uniclip-<os>-<arch>`).

- [ ] **Step 1: Write the script** `apps/cli/scripts/build-binaries.sh`:

```sh
#!/bin/sh
# Cross-compile the uniclip CLI to standalone binaries (one per OS/arch) and
# write their SHA-256 checksums. Run from apps/cli (Bun fetches each target's
# runtime, so the build host needs network). TARGETS overridable for lean builds.
set -eu

TARGETS="${CLI_TARGETS:-darwin-arm64 darwin-x64 linux-x64 linux-arm64}"
OUT="dist/dl"
rm -rf "$OUT"
mkdir -p "$OUT"

for t in $TARGETS; do
  echo "building uniclip-$t…"
  bun build --compile --target="bun-$t" src/bin.ts --outfile "$OUT/uniclip-$t"
done

# Portable sha256 (sha256sum on Linux/alpine, shasum on macOS).
( cd "$OUT"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum uniclip-* > checksums.txt
  else
    shasum -a 256 uniclip-* > checksums.txt
  fi
)
echo "done → $OUT"
cat "$OUT/checksums.txt"
```

- [ ] **Step 2: Make it executable + host-target smoke test.**

Run:
```
cd apps/cli && chmod +x scripts/build-binaries.sh
CLI_TARGETS="$(bun -e 'console.log(`${process.platform==="darwin"?"darwin":"linux"}-${process.arch==="arm64"?"arm64":"x64"}`)')" ./scripts/build-binaries.sh
```
Expected: builds the single host-target binary, writes `dist/dl/checksums.txt` with a sha256 line; then verify the binary runs:
```
ls dist/dl/ && ./dist/dl/uniclip-* --version
```
Expected: the `dl/` dir lists the binary + `checksums.txt`, and `--version` prints `0.0.0`.

- [ ] **Step 3: Confirm `dist/dl` is gitignored** (it's build output). `apps/cli/.gitignore` (or the repo root) already ignores `dist/`; confirm `git status` does NOT show `apps/cli/dist/`. If it would be tracked, add `dist/` to `apps/cli/.gitignore`.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/scripts/build-binaries.sh
git commit -m "feat(cli): build-binaries.sh — multi-target bun compile + checksums (installer task 2)"
```

---

### Task 3: `renderSetupScript` — the templated POSIX installer

**Files:**
- Create: `apps/relay/src/installer.ts`
- Create: `apps/relay/src/installer.test.ts`

**Interfaces:**
- Produces `renderSetupScript(opts: { base: string; checksums: Record<string, string> }): string` — a POSIX `sh` script that detects the platform, downloads `<base>/dl/uniclip-<os>-<arch>`, verifies its embedded sha256, and installs to `~/.local/bin/uniclip`. `checksums` maps artifact filename → sha256.

- [ ] **Step 1: Write the failing test** `apps/relay/src/installer.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { renderSetupScript } from "./installer";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "uniclip-inst-")); tmps.push(d); return d; };
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const hostArtifact = () => {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `uniclip-${os}-${arch}`;
};

describe("renderSetupScript", () => {
  it("embeds the base URL and the checksums; is valid POSIX sh", () => {
    const s = renderSetupScript({ base: "http://h:3000", checksums: { "uniclip-linux-x64": "abc" } });
    expect(s).toContain("http://h:3000/dl/");
    expect(s).toContain("abc");
    // sh syntax check (no execution)
    const f = join(tmp(), "s.sh"); writeFileSync(f, s);
    expect(() => execFileSync("sh", ["-n", f])).not.toThrow();
  });

  it("downloads, checksum-verifies, and installs the host-platform binary", () => {
    // A fake 'binary' = a tiny shell script that echoes a marker.
    const serveDir = tmp();
    const dl = join(serveDir, "dl"); writeFileSync; // dir made below
    const fs = require("node:fs"); fs.mkdirSync(dl, { recursive: true });
    const artifact = hostArtifact();
    const fakeBin = "#!/bin/sh\necho INSTALLED_OK\n";
    writeFileSync(join(dl, artifact), fakeBin);
    const sum = createHash("sha256").update(fakeBin).digest("hex");

    // Serve serveDir over http on an ephemeral port (Node http).
    const http = require("node:http");
    const server = http.createServer((req: any, res: any) => {
      const p = join(serveDir, decodeURIComponent(req.url.replace(/^\/+/, "")));
      if (existsSync(p)) { res.end(readFileSync(p)); } else { res.statusCode = 404; res.end("nope"); }
    });
    const port: number = (server.listen(0).address()).port;
    try {
      const home = tmp();
      const script = renderSetupScript({ base: `http://127.0.0.1:${port}`, checksums: { [artifact]: sum } });
      const sf = join(tmp(), "setup.sh"); writeFileSync(sf, script);
      execFileSync("sh", [sf], { env: { ...process.env, HOME: home }, stdio: "pipe" });
      const installed = join(home, ".local", "bin", "uniclip");
      expect(existsSync(installed)).toBe(true);
      expect(execFileSync(installed, [], { encoding: "utf8" })).toContain("INSTALLED_OK");
    } finally {
      server.close();
    }
  });

  it("rejects a checksum mismatch (also catches the SPA-HTML fallback)", () => {
    const serveDir = tmp();
    const fs = require("node:fs"); fs.mkdirSync(join(serveDir, "dl"), { recursive: true });
    const artifact = hostArtifact();
    writeFileSync(join(serveDir, "dl", artifact), "#!/bin/sh\necho HI\n");
    const http = require("node:http");
    const server = http.createServer((req: any, res: any) => {
      const p = join(serveDir, decodeURIComponent(req.url.replace(/^\/+/, "")));
      res.end(existsSync(p) ? readFileSync(p) : "nope");
    });
    const port: number = (server.listen(0).address()).port;
    try {
      const home = tmp();
      const script = renderSetupScript({ base: `http://127.0.0.1:${port}`, checksums: { [artifact]: "deadbeef" } });
      const sf = join(tmp(), "setup.sh"); writeFileSync(sf, script);
      expect(() => execFileSync("sh", [sf], { env: { ...process.env, HOME: home }, stdio: "pipe" })).toThrow();
      expect(existsSync(join(home, ".local", "bin", "uniclip"))).toBe(false);
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `cd apps/relay && pnpm test installer` → FAIL (module missing).

- [ ] **Step 3: Implement `apps/relay/src/installer.ts`:**

```ts
// Renders the POSIX `sh` installer the relay serves at GET /setup.sh. The base
// URL and per-artifact sha256 checksums are templated in by the route, so the
// downloaded script knows where to fetch and can verify integrity (which also
// catches the static handler's SPA-HTML fallback for a wrong/missing artifact).
export function renderSetupScript(opts: { base: string; checksums: Record<string, string> }): string {
  // Emit a shell case mapping "<os>-<arch>" → expected sha256.
  const cases = Object.entries(opts.checksums)
    .map(([name, sum]) => `    ${name.replace(/^uniclip-/, "")}) want="${sum}" ;;`)
    .join("\n");
  return `#!/bin/sh
# uniclip installer — downloads a standalone binary and installs it to ~/.local/bin.
set -eu

BASE="${opts.base}"

os=$(uname -s); arch=$(uname -m)
case "$os" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "Unsupported OS: $os" >&2; exit 1 ;; esac
case "$arch" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo "Unsupported arch: $arch" >&2; exit 1 ;; esac
key="$os-$arch"

want=""
case "$key" in
${cases}
  *) echo "No uniclip binary for $key" >&2; exit 1 ;;
esac

art="uniclip-$key"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
echo "Downloading $art…"
curl -fSL "$BASE/dl/$art" -o "$tmp"

# Verify integrity (also rejects an HTML SPA-fallback served for a missing file).
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp" | cut -d' ' -f1)
else got=$(shasum -a 256 "$tmp" | cut -d' ' -f1); fi
if [ "$got" != "$want" ]; then echo "Checksum mismatch for $art (got $got, want $want) — aborting." >&2; exit 1; fi

dest="$HOME/.local/bin"
mkdir -p "$dest"
chmod +x "$tmp"
mv "$tmp" "$dest/uniclip"
trap - EXIT
echo "Installed $dest/uniclip"
case ":$PATH:" in *":$dest:"*) echo "Run: uniclip" ;; *) echo "Add to PATH:  export PATH=\\"$dest:\\$PATH\\"   then run: uniclip" ;; esac
`;
}
```

- [ ] **Step 4: Run to verify it passes.** `cd apps/relay && pnpm test installer` → PASS (3 tests). (The functional tests run a real `sh` + a local http server — they need `curl` + `sha256sum`/`shasum` on the machine, which CI has.)

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/installer.ts apps/relay/src/installer.test.ts
git commit -m "feat(relay): renderSetupScript — templated POSIX installer + checksum verify (installer task 3)"
```

---

### Task 4: Relay `GET /setup.sh` route

**Files:**
- Modify: `apps/relay/src/app.ts` (+ `apps/relay/src/app.test.ts` or a focused route test)

**Interfaces:**
- Consumes `renderSetupScript` (Task 3); reads `${STATIC_ROOT}/dl/checksums.txt`.
- Produces: `GET /setup.sh` → `text/x-shellscript` body, templated with the request's base URL + checksums.

- [ ] **Step 1: Write the failing route test** — add to `apps/relay/src/app.test.ts` (cast `res` per the relay's bun-types convention):

```ts
it("serves a templated /setup.sh with the request host + checksums", async () => {
  const root = mkdtempSync(join(tmpdir(), "uniclip-root-"));
  mkdirSync(join(root, "dl"), { recursive: true });
  writeFileSync(join(root, "dl", "checksums.txt"), "abc123  uniclip-linux-x64\ndef456  uniclip-darwin-arm64\n");
  const app = buildApp({ roomCount: () => 0, staticRoot: root });
  const res = await app.request("/setup.sh", { headers: { host: "myhost:3000" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("shell");
  const body = await res.text();
  expect(body).toContain("http://myhost:3000/dl/");
  expect(body).toContain("abc123");
  expect(body).toContain("def456");
  rmSync(root, { recursive: true, force: true });
});
```
(Add the needed `node:fs`/`node:os`/`node:path` imports to the test file. `buildApp` gains a `staticRoot?` dep — see Step 3.)

- [ ] **Step 2: Run to verify it fails.** `cd apps/relay && pnpm test app` → FAIL (no `/setup.sh` route / no `staticRoot` dep).

- [ ] **Step 3: Implement in `app.ts`.** Add to `AppDeps`: `staticRoot?: string;`. Add a parser + route (after the existing `/api/*` routes, before `return app`):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderSetupScript } from "./installer";

// "<sha256>  uniclip-<os>-<arch>" lines → { "uniclip-os-arch": "<sha256>" }.
function readChecksums(staticRoot: string): Record<string, string> {
  try {
    const txt = readFileSync(join(staticRoot, "dl", "checksums.txt"), "utf8");
    const out: Record<string, string> = {};
    for (const line of txt.split("\n")) {
      const m = line.trim().match(/^([0-9a-f]{64})\s+(\S+)$/i);
      if (m) out[m[2]!] = m[1]!;
    }
    return out;
  } catch { return {}; }
}

// …inside buildApp(deps), after the metrics route:
if (deps.staticRoot) {
  const staticRoot = deps.staticRoot;
  app.get("/setup.sh", (c) => {
    const host = c.req.header("host") ?? "localhost";
    const scheme = c.req.header("x-forwarded-proto") ?? "http";
    const script = renderSetupScript({ base: `${scheme}://${host}`, checksums: readChecksums(staticRoot) });
    return c.text(script, 200, { "content-type": "text/x-shellscript; charset=utf-8" });
  });
}
```

- [ ] **Step 4: Wire `staticRoot` from the server.** In `apps/relay/src/server.ts`, pass `process.env.STATIC_ROOT` into `buildApp` (it already reads `STATIC_ROOT` for `serveStatic`):

```ts
const app = buildApp({ /* …existing deps…, */ ...(process.env.STATIC_ROOT ? { staticRoot: process.env.STATIC_ROOT } : {}) });
```
(Match the exact `buildApp({...})` call shape already in `server.ts`.)

- [ ] **Step 5: Run to verify it passes + full relay suite + typecheck.** `cd apps/relay && pnpm test && pnpm typecheck` → all PASS (`res.json()`/text casts per `types: ["bun"]`).

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/app.ts apps/relay/src/app.test.ts apps/relay/src/server.ts
git commit -m "feat(relay): GET /setup.sh route — templated installer from request host + checksums (installer task 4)"
```

---

### Task 5: Docker build + README

**Files:**
- Modify: `Dockerfile`
- Modify: `README.md`

- [ ] **Step 1: Add a `cli-builder` stage to the `Dockerfile`** (after the `relay-builder` stage, before `runtime`):

```dockerfile
FROM oven/bun:1-alpine AS cli-builder
WORKDIR /repo
RUN apk add --no-cache nodejs npm && npm install -g pnpm@9.12.0
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY packages ./packages
COPY apps/cli ./apps/cli
RUN pnpm install --frozen-lockfile --filter @uniclip/cli... --filter @uniclip/cli
ARG CLI_TARGETS="darwin-arm64 darwin-x64 linux-x64 linux-arm64"
RUN cd apps/cli && CLI_TARGETS="$CLI_TARGETS" sh scripts/build-binaries.sh
```

- [ ] **Step 2: Copy the binaries into the static root in the `runtime` stage.** After the existing `COPY --from=web-builder /repo/apps/web/dist ./web` line, add:

```dockerfile
COPY --from=cli-builder /repo/apps/cli/dist/dl ./web/dl
```
(So `STATIC_ROOT=/app/web` serves `/dl/uniclip-*` + `/dl/checksums.txt`, and the `/setup.sh` route reads `/app/web/dl/checksums.txt`.)

- [ ] **Step 3: Build the image and verify end-to-end.**

Run:
```
docker build -t uniclip:installer . && docker run -d --rm -p 3000:3000 --name uc uniclip:installer
sleep 2
curl -fsS http://localhost:3000/setup.sh | head -5
curl -fsS -o /tmp/uc-bin "http://localhost:3000/dl/uniclip-$(uname -s | tr 'A-Z' 'a-z' | sed s/darwin/darwin/)-$(uname -m | sed 's/x86_64/x64/;s/arm64/arm64/;s/aarch64/arm64/')" && file /tmp/uc-bin
docker stop uc; rm -f /tmp/uc-bin
```
Expected: `/setup.sh` returns the templated script (starts with `#!/bin/sh`), and the host-matching binary downloads. (If the build host can't run a linux-arch binary natively, just confirm the download succeeds + `file` reports an executable; full run is the manual cross-device check.)

- [ ] **Step 4: Update `README.md`** — add an **Install the CLI** subsection under the CLI docs:

```markdown
### Install the CLI (no Node required)

From any running relay, install a standalone `uniclip` binary for your platform:

\`\`\`bash
curl -O http://<host>:<port>/setup.sh && sh setup.sh
\`\`\`

It downloads the right binary (macOS/Linux, arm64/x64), verifies its checksum, and installs it to `~/.local/bin/uniclip`. **Over plain HTTP this is MITM-able** — fine for a trusted/LAN relay, but use HTTPS (e.g. the `tailscale serve` setup above) for anything internet-exposed. For local dev without installing, `pnpm --filter @uniclip/cli dev` still works.
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile README.md
git commit -m "feat: build CLI binaries into the image + serve the installer; docs (installer task 5)"
```

---

## Final verification (after all tasks)
- [ ] **Repo gates:** `pnpm typecheck && pnpm test` → all packages green (CLI args/help; relay installer + /setup.sh route).
- [ ] **tsup build still works:** `pnpm --filter @uniclip/cli build` → `dist/cli.js` with shebang (the bin.ts entry didn't disturb it).
- [ ] **Image smoke** (from Task 5 Step 3) passed.
- [ ] **Update `CLAUDE.md`** — note the `apps/cli` binary build (`bin.ts` + `bun build --compile` via `scripts/build-binaries.sh`) and the relay's `GET /setup.sh` installer route; commit.

## Self-Review (completed during planning)
- **Spec coverage:** §2 binary build → T1 (`bin.ts`, `--version`/`--help`, react-devtools-core) + T2 (build script); §3 relay serving → T4 route (binaries via existing static handler); §4 setup.sh → T3 (`renderSetupScript`); §5 Docker → T5; §6 security (HTTP caveat) → README (T5) + the checksum verify (T3); §7 testing → each task's tests. Decomposition reordered vs spec §8 only so the script renderer (T3) precedes the route that consumes it (T4).
- **Placeholder scan:** none. The `require(...)` calls in the T3 test are deliberate (mixing CJS requires for the http server inside an ESM test is fine under vitest); the implementer may convert to imports.
- **Type consistency:** `parseArgs` return extended with `help`/`version`; `main` exported; `renderSetupScript({base, checksums})` and `AppDeps.staticRoot?` consistent across T3/T4; `checksums.txt` line format (`<sha256>  <name>`) matches between T2 (writer), T3 (script consumer), and T4 (`readChecksums` parser).
